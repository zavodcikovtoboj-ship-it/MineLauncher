'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const { Progress, downloadFile, runPool } = require('./net');
const { collectLibraries, rulesAllow } = require('./libraries');
const { ensureAssets } = require('./assets');
const { detectJava, downloadRuntime } = require('./java');
const { resolveVersion } = require('./version');
const { parseTarget } = require('./loaders');

const LAUNCHER_NAME = 'MineLauncher';
const LAUNCHER_VERSION = require('../../package.json').version;

/**
 * Loader profiles repeat some libraries from the vanilla parent. Java uses the
 * first matching class on the classpath, so keep the child (loader) version of
 * each group:artifact:classifier and drop the parent duplicate.
 */
function dedupeClasspath(classpath, librariesDir) {
  const root = path.resolve(librariesDir);
  const result = [];
  const positions = new Map();

  for (const entry of classpath) {
    const resolved = path.resolve(entry);
    let key = null;
    if (resolved.startsWith(root + path.sep)) {
      const rel = path.relative(root, resolved).split(path.sep).join('/');
      const parts = rel.split('/');
      if (parts.length >= 4) {
        const file = parts[parts.length - 1];
        const version = parts[parts.length - 2];
        const artifact = parts[parts.length - 3];
        const group = parts.slice(0, parts.length - 3).join('/');
        const prefix = `${artifact}-${version}`;
        const classifier =
          file.startsWith(prefix) && file.endsWith('.jar')
            ? file.slice(prefix.length, -4)
            : `:${file}`;
        key = `${group}:${artifact}${classifier}`;
      }
    }

    if (key && positions.has(key)) {
      result[positions.get(key)] = resolved;
    } else {
      if (key) positions.set(key, result.length);
      result.push(resolved);
    }
  }
  return result;
}

function substitute(value, vars) {
  return String(value).replace(/\$\{([^}]+)\}/g, (full, key) => {
    const v = vars[key];
    return v === undefined || v === null ? full : String(v);
  });
}

function flattenArgs(list, vars, features) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(substitute(item, vars));
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (!rulesAllow(item.rules, features)) continue;
    const values = Array.isArray(item.value) ? item.value : [item.value];
    for (const value of values) out.push(substitute(value, vars));
  }
  return out;
}

function splitArgs(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(line || ''))) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

function logFileLine(gameDir, line) {
  try {
    const dir = path.join(gameDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'launcher.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // logging must never break a launch
  }
}

// Minecraft 1.21.2+ prints log4j XML events to stdout; turn them back into lines.
function parseLog4jEvent(xml) {
  const level = xml.match(/level="([^"]+)"/)?.[1] || 'INFO';
  const thread = xml.match(/thread="([^"]+)"/)?.[1] || '';
  const stamp = Number(xml.match(/timestamp="(\d+)"/)?.[1] || 0);
  const message = xml.match(/<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/)?.[1];
  const throwable = xml.match(/<log4j:Throwable><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Throwable>/)?.[1];
  if (message === undefined && throwable === undefined) return null;

  let time = '';
  if (stamp) {
    const date = new Date(stamp);
    time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')} `;
  }
  const head = `[${time}${thread ? `${thread}/` : ''}${level}]`;
  const body = (message || '').trim();
  const stack = throwable ? `\n${throwable.trim()}` : '';
  return `${head} ${body}${stack}`.trim();
}

class Launcher {
  constructor({ config, mojang, send, loaders = null, modpacks = null, targets = null, stats = null }) {
    this.config = config;
    this.mojang = mojang;
    this.send = send;
    this.loaders = loaders;
    this.modpacks = modpacks;
    this.targets = targets;
    this.stats = stats;
    this.child = null;
    this.abort = null;
    this.running = false;
  }

  log(line) {
    const text = String(line);
    this.send('log', text);
    logFileLine(this.config.get('gameDir'), text);
  }

  progressReporter() {
    const progress = new Progress((payload) => this.send('progress', payload));
    return progress;
  }

  cancel() {
    if (!this.child) return false;
    const pid = this.child.pid;
    try {
      spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      try {
        this.child.kill();
      } catch {
        // already gone
      }
    }
    this.abort?.abort();
    return true;
  }

  async launch({ versionId, account }) {
    if (this.running) throw new Error('Игра уже запущена.');
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const progress = this.progressReporter();
    const startedAt = Date.now();
    let sessionId = null;
    let spawned = false;

    try {
      const gameDir = this.config.get('gameDir');
      await fsp.mkdir(gameDir, { recursive: true });

      const target = parseTarget(versionId);
      let mcVersion = target.mcVersion;
      let instanceDir = gameDir;
      let loaderKind = 'vanilla';
      let loaderVersion = '';
      let modpack = null;
      let instanceSettings = {};
      let targetName = versionId;

      if (this.targets) {
        const resolved = this.targets.resolve(versionId);
        mcVersion = resolved.mcVersion;
        instanceDir = resolved.instanceDir;
        loaderKind = resolved.loader || 'vanilla';
        loaderVersion = resolved.loaderVersion || '';
        instanceSettings = resolved.settings || {};
        targetName = resolved.name || versionId;
        modpack = resolved.kind === 'modpack' ? resolved.pack : null;
        if (!fs.existsSync(instanceDir)) {
          throw new Error(
            resolved.kind === 'modpack'
              ? `Папка модпака не найдена: ${instanceDir}`
              : `Папка инстанса не найдена: ${instanceDir}`
          );
        }
      } else if (target.kind === 'modpack') {
        modpack = this.modpacks?.get(target.slug);
        if (!modpack) throw new Error(`Модпак «${target.slug}» не установлен.`);
        mcVersion = modpack.mcVersion;
        instanceDir = modpack.instanceDir || path.join(gameDir, 'modpacks', target.slug);
        loaderKind = modpack.loader || 'vanilla';
        loaderVersion = modpack.loaderVersion || '';
        if (!fs.existsSync(instanceDir)) {
          throw new Error(`Папка модпака не найдена: ${instanceDir}`);
        }
      } else if (target.kind !== 'vanilla') {
        loaderKind = target.kind;
      }

      if (!mcVersion) throw new Error('Не удалось определить версию Minecraft.');
      await fsp.mkdir(instanceDir, { recursive: true });

      const effective = {
        javaPath: instanceSettings.javaPath || this.config.get('javaPath'),
        ramMb: instanceSettings.ramMb || this.config.get('ramMb'),
        jvmArgs: instanceSettings.jvmArgs || this.config.get('jvmArgs'),
        width: instanceSettings.width || this.config.get('width'),
        height: instanceSettings.height || this.config.get('height'),
        customResolution:
          instanceSettings.customResolution === undefined
            ? this.config.get('customResolution')
            : instanceSettings.customResolution,
      };
      sessionId = this.stats?.begin({
        targetId: versionId,
        name: targetName,
        mcVersion,
      });

      this.log(`Цель: ${targetName} (${mcVersion}, ${loaderKind})`);
      const versionsDir = path.join(gameDir, 'versions');
      const librariesDir = path.join(gameDir, 'libraries');
      const assetsDir = path.join(gameDir, 'assets');
      const baseDir = path.join(versionsDir, mcVersion);
      await fsp.mkdir(baseDir, { recursive: true });

      progress.setStage('manifest');
      this.log(`Подготовка ${versionId}...`);
      const baseVersion = await this.mojang.getVersionById(mcVersion);
      await fsp.writeFile(
        path.join(baseDir, `${mcVersion}.json`),
        JSON.stringify(baseVersion, null, 2),
        'utf8'
      );

      // Java is checked before any large download: no point pulling 500 MB
      // of assets if the launch can't happen.
      progress.setStage('java');
      progress.setTotal(1);
      const requiredMajor = baseVersion.javaVersion?.majorVersion || 8;
      const detected = await detectJava({
        gameDir,
        preferred: effective.javaPath,
        requiredMajor,
      });
      if (!detected.found) {
        const err = new Error(
          `Не найдена Java ${requiredMajor}+. Установите её в настройках лаунчера.`
        );
        err.code = 'JAVA_MISSING';
        err.requiredMajor = requiredMajor;
        err.component = baseVersion.javaVersion?.component || '';
        throw err;
      }
      const javaPath = detected.path;
      this.log(`Java: ${javaPath} (${detected.major})`);

      // Client jar of the vanilla parent. Forge/NeoForge installers patch
      // their own copies, so an existing loader base jar is never replaced.
      const client = baseVersion.downloads?.client;
      if (client?.url) {
        const clientJarPath = path.join(baseDir, `${mcVersion}.jar`);
        let existingSize = -1;
        try {
          existingSize = (await fsp.stat(clientJarPath)).size;
        } catch {
          // missing
        }
        const needClient =
          existingSize < 0 ||
          (loaderKind === 'vanilla' && client.size && existingSize !== client.size);
        if (needClient) {
          progress.setStage('client');
          progress.setTotal(client.size || 0);
          progress.setFile(`${mcVersion}.jar`);
          this.log('Проверка клиента...');
          await downloadFile(client.url, clientJarPath, {
            sha1: client.sha1,
            size: client.size,
            signal,
            onBytes: (n) => progress.add(n),
          });
        }
      }

      let profileId = mcVersion;
      if (loaderKind !== 'vanilla') {
        if (!this.loaders) throw new Error('Модуль загрузчиков не инициализирован.');
        progress.setStage('loader');
        progress.setTotal(0);
        progress.setFile('');
        this.log(`Проверка загрузчика ${loaderKind}${loaderVersion ? ` ${loaderVersion}` : ''}...`);
        const ensured = await this.loaders.ensure({
          kind: loaderKind,
          mcVersion,
          loaderVersion,
          gameDir,
          javaPath,
          signal,
          log: (line) => this.log(line),
          progress,
        });
        profileId = ensured.profileId;
        this.log(`Профиль запуска: ${profileId}`);
      }

      const version =
        loaderKind === 'vanilla'
          ? { ...baseVersion, clientJarVersion: mcVersion, baseId: mcVersion }
          : await resolveVersion({ mojang: this.mojang, gameDir, versionId: profileId });

      const versionDir = path.join(versionsDir, profileId);
      await fsp.mkdir(versionDir, { recursive: true });
      const nativesDir = path.join(versionDir, 'natives');

      // Libraries
      progress.setStage('libraries');
      this.log('Проверка библиотек...');
      const { classpath, downloads, natives } = collectLibraries(version, librariesDir);
      const clientJarVersion = version.clientJarVersion || mcVersion;
      const clientJar = path.join(versionsDir, clientJarVersion, `${clientJarVersion}.jar`);
      if (fs.existsSync(clientJar)) classpath.push(clientJar);
      const finalClasspath = dedupeClasspath(classpath, librariesDir);
      const libBytes = downloads.reduce((sum, d) => sum + (d.size || 0), 0);
      progress.setTotal(libBytes);
      progress.setFile('');
      await runPool(
        downloads.map((job) => async () => {
          progress.setFile(path.basename(job.dest));
          await downloadFile(job.url, job.dest, {
            sha1: job.sha1,
            size: job.size,
            signal,
            onBytes: (n) => progress.add(n),
          });
        }),
        10
      );

      // Natives
      progress.setStage('natives');
      progress.setTotal(natives.length || 1);
      progress.setFile('');
      this.log(`Распаковка нативов (${natives.length})...`);
      const nativeTargets = this.nativeTargets(version, nativesDir);
      await this.extractNatives(natives, nativeTargets, progress, signal);

      // Assets
      const { assetIndex } = await ensureAssets({
        version,
        dirs: { assets: assetsDir, gameDir: instanceDir },
        mojang: this.mojang,
        progress,
        signal,
        log: (line) => this.log(line),
      });

      // Logging config
      let logConfigArg = '';
      if (version.logging?.client?.file?.url) {
        const logFile = path.join(assetsDir, 'log_configs', version.logging.client.file.id);
        progress.setStage('client');
        progress.setTotal(version.logging.client.file.size || 0);
        await downloadFile(version.logging.client.file.url, logFile, {
          sha1: version.logging.client.file.sha1,
          size: version.logging.client.file.size,
          signal,
          onBytes: (n) => progress.add(n),
        });
        logConfigArg = substitute(version.logging.client.argument, { path: logFile });
      }

      // Arguments
      const accountData = account || { type: 'offline', name: this.config.get('username') };
      const clientId = this.config.get('msClientId') || '';
      const vars = {
        auth_player_name: accountData.name,
        version_name: version.id,
        game_directory: instanceDir,
        assets_root: assetsDir,
        game_assets: path.join(assetsDir, 'virtual', 'legacy'),
        assets_index_name: assetIndex || version.assets || 'legacy',
        auth_uuid: accountData.uuid || '',
        auth_access_token: accountData.accessToken || '',
        auth_xuid: accountData.xuid || '',
        clientid: clientId,
        auth_session: accountData.accessToken || '',
        user_type: accountData.userType || (accountData.type === 'microsoft' ? 'msa' : 'legacy'),
        version_type: version.type || 'release',
        natives_directory: nativesDir,
        launcher_name: LAUNCHER_NAME,
        launcher_version: LAUNCHER_VERSION,
        classpath: finalClasspath.join(path.delimiter),
        library_directory: librariesDir,
        classpath_separator: path.delimiter,
        user_properties: '{}',
        resolution_width: String(effective.width || 1280),
        resolution_height: String(effective.height || 720),
      };

      const customResolution = Boolean(effective.customResolution);
      const features = { has_custom_resolution: customResolution };

      let jvmArgs;
      let gameArgs;
      if (Array.isArray(version.arguments?.game)) {
        jvmArgs = flattenArgs(version.arguments.jvm, vars, features);
        gameArgs = flattenArgs(version.arguments.game, vars, features);
      } else {
        jvmArgs = [
          `-Djava.library.path=${nativesDir}`,
          `-Dminecraft.launcher.brand=${LAUNCHER_NAME}`,
          `-Dminecraft.launcher.version=${LAUNCHER_VERSION}`,
          '-cp',
          vars.classpath,
        ];
        gameArgs = splitArgs(version.minecraftArguments || '').map((a) => substitute(a, vars));
        if (customResolution) {
          gameArgs.push('--width', vars.resolution_width, '--height', vars.resolution_height);
        }
      }

      if (logConfigArg) jvmArgs.unshift(logConfigArg);

      if (!jvmArgs.some((arg) => arg === '-cp' || arg === '-classpath')) {
        jvmArgs.push('-cp', vars.classpath);
      }
      if (!jvmArgs.some((arg) => arg.startsWith('-Djava.library.path'))) {
        jvmArgs.push(`-Djava.library.path=${nativesDir}`);
      }

      const ram = Math.max(1024, Number(effective.ramMb) || 4096);
      const extraJvm = splitArgs(effective.jvmArgs || '');
      jvmArgs.unshift(`-Xmx${ram}M`, `-Xms${Math.min(ram, 1024)}M`, ...extraJvm);

      const args = [...jvmArgs, version.mainClass, ...gameArgs];

      progress.setStage('launch');
      progress.setTotal(1);
      progress.add(1);
      this.log('Запуск Minecraft...');
      this.log(`Аргументы JVM: ${jvmArgs.join(' ')}`);

      const child = spawn(javaPath, args, {
        cwd: instanceDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      this.child = child;
      spawned = true;

      const streams = { out: { buffer: '' }, err: { buffer: '' } };
      const consume = (chunk, state) => {
        state.buffer += chunk.toString('utf8');

        if (state.buffer.includes('<log4j:Event')) {
          let start = state.buffer.indexOf('<log4j:Event');
          if (start > 0) {
            const prefix = state.buffer.slice(0, start);
            state.buffer = state.buffer.slice(start);
            for (const line of prefix.split(/\r?\n/)) if (line.trim()) this.log(line.trim());
          }
          let end;
          while ((end = state.buffer.indexOf('</log4j:Event>')) !== -1) {
            const block = state.buffer.slice(0, end + '</log4j:Event>'.length);
            state.buffer = state.buffer.slice(end + '</log4j:Event>'.length);
            const parsed = parseLog4jEvent(block);
            if (parsed) this.log(parsed);
          }
          return;
        }

        const lines = state.buffer.split(/\r?\n/);
        state.buffer = lines.pop();
        for (const line of lines) if (line.trim()) this.log(line);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => consume(chunk, streams.out));
      child.stderr.on('data', (chunk) => consume(chunk, streams.err));

      child.on('error', (err) => {
        this.log(`Ошибка процесса: ${err.message}`);
      });

      const exit = await new Promise((resolve) => {
        child.on('exit', (code, signalName) => resolve({ code, signal: signalName }));
      });

      for (const state of Object.values(streams)) {
        if (state.buffer.trim()) this.log(state.buffer.trim());
        state.buffer = '';
      }

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.log(`Minecraft завершился. Код: ${exit.code}, время: ${seconds}с`);
      this.stats?.end(sessionId, {
        seconds: Number(seconds),
        exitCode: exit.code,
        crashed: exit.code !== 0,
      });
      this.send('exit', { code: exit.code, seconds });
      return { ok: exit.code === 0, code: exit.code };
    } catch (err) {
      if (err.name === 'AbortError' || signal.aborted) {
        this.log('Запуск отменён.');
        this.stats?.end(sessionId, {
          seconds: (Date.now() - startedAt) / 1000,
          exitCode: null,
          crashed: false,
        });
        this.send('exit', { code: null, cancelled: true });
        return { ok: false, cancelled: true };
      }
      this.log(`Ошибка: ${err.message}`);
      this.stats?.end(sessionId, {
        seconds: (Date.now() - startedAt) / 1000,
        exitCode: null,
        crashed: spawned,
      });
      throw err;
    } finally {
      this.child = null;
      this.running = false;
      this.abort = null;
    }
  }

  nativeTargets(version, nativesDir) {
    const root = path.resolve(nativesDir);
    const targets = [root];
    const seen = new Set([root]);
    const marker = '${natives_directory}/';

    for (const arg of version.arguments?.jvm || []) {
      if (typeof arg !== 'string') continue;
      let from = 0;
      while (true) {
        const at = arg.indexOf(marker, from);
        if (at < 0) break;
        from = at + marker.length;
        const rest = arg.slice(from).trim();
        if (!rest || rest.includes('${') || /[\s;]/.test(rest)) continue;
        const dir = path.resolve(root, rest);
        if (dir.startsWith(root + path.sep) && !seen.has(dir)) {
          seen.add(dir);
          targets.push(dir);
        }
      }
    }
    return targets;
  }

  async extractNatives(natives, targets, progress, signal) {
    const roots = targets.map((dir) => path.resolve(dir));
    for (const dir of roots) {
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true });
    }

    const seen = new Set();
    for (const native of natives) {
      if (signal?.aborted) throw Object.assign(new Error('Отменено'), { name: 'AbortError' });
      if (seen.has(native.jar)) continue;
      seen.add(native.jar);
      if (!fs.existsSync(native.jar)) {
        this.log(`Натив отсутствует: ${native.jar}`);
        progress.add(1);
        continue;
      }

      const zip = new AdmZip(native.jar);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const name = entry.entryName.replace(/\\/g, '/');
        if (native.exclude.some((prefix) => name.startsWith(prefix))) continue;

        let data = null;
        for (const root of roots) {
          const dest = path.resolve(root, name);
          if (dest !== root && !dest.startsWith(root + path.sep)) continue;
          if (!data) data = entry.getData();
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, data);
        }
      }
      progress.add(1);
    }
  }

  async installJava({ component, majorVersion }) {
    if (this.running) throw new Error('Сначала закройте игру.');
    const gameDir = this.config.get('gameDir');
    const progress = this.progressReporter();
    const result = await downloadRuntime({
      component,
      majorVersion,
      gameDir,
      progress,
      log: (line) => this.log(line),
    });
    this.config.update({ javaPath: result.path });
    return result;
  }
}

module.exports = { Launcher, substitute, flattenArgs, splitArgs };
