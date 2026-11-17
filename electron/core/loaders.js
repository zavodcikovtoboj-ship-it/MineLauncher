'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const { fetchJson, fetchText, downloadFile } = require('./net');

const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
// The official NeoForged maven is not reachable from every network.
// CreeperHost mirrors it and is used first; the official host is the fallback.
const NEOFORGE_MAVENS = [
  'https://maven.creeperhost.net',
  'https://maven.neoforged.net/releases',
];

const META_TTL = 6 * 60 * 60 * 1000;
const INSTALLER_TIMEOUT = 30 * 60 * 1000;

function parseTarget(versionId) {
  const id = String(versionId || '');
  if (id.startsWith('fabric:')) return { kind: 'fabric', mcVersion: id.slice(7) };
  if (id.startsWith('forge:')) return { kind: 'forge', mcVersion: id.slice(6) };
  if (id.startsWith('neoforge:')) return { kind: 'neoforge', mcVersion: id.slice(9) };
  if (id.startsWith('modpack:')) return { kind: 'modpack', slug: id.slice(8) };
  if (id.startsWith('instance:')) return { kind: 'instance', slug: id.slice(9) };
  return { kind: 'vanilla', mcVersion: id };
}

function targetLabel(target) {
  if (!target) return '';
  if (target.kind === 'fabric') return `Fabric ${target.mcVersion}`;
  if (target.kind === 'forge') return `Forge ${target.mcVersion}`;
  if (target.kind === 'neoforge') return `NeoForge ${target.mcVersion}`;
  if (target.kind === 'modpack') return `Модпак ${target.slug}`;
  if (target.kind === 'instance') return `Инстанс ${target.slug}`;
  return target.mcVersion;
}

function compareVersions(a, b) {
  const split = (value) => {
    const [base, pre] = String(value).split('-');
    const nums = base.split('.').map((part) => parseInt(part, 10) || 0);
    return { nums, pre: pre ? 1 : 0 };
  };
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.nums[i] || 0) - (right.nums[i] || 0);
    if (diff !== 0) return diff;
  }
  // A release is newer than a beta with the same numeric version.
  return left.pre - right.pre;
}

function parseXmlVersions(xml) {
  const out = [];
  const re = /<version>([^<]+)<\/version>/g;
  let match;
  while ((match = re.exec(xml || ''))) out.push(match[1].trim());
  return out;
}

function parseForgeVersions(xml) {
  const map = new Map();
  for (const full of parseXmlVersions(xml)) {
    const dash = full.indexOf('-');
    if (dash <= 0) continue;
    const mcVersion = full.slice(0, dash);
    const loaderVersion = full.slice(dash + 1);
    if (!loaderVersion) continue;
    const current = map.get(mcVersion);
    if (!current || compareVersions(loaderVersion, current) > 0) map.set(mcVersion, loaderVersion);
  }
  return map;
}

function neoPrefixFor(mcVersion) {
  const base = mcVersion.startsWith('1.') ? mcVersion.slice(2) : mcVersion;
  return `${base}.`;
}

function parseNeoForgeVersions(xml, mcVersions) {
  const prefixes = mcVersions
    .map((mc) => ({ mc, prefix: neoPrefixFor(mc) }))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  const map = new Map();
  for (const loaderVersion of parseXmlVersions(xml)) {
    if (!/\d/.test(loaderVersion)) continue;
    const hit = prefixes.find((entry) => loaderVersion.startsWith(entry.prefix));
    if (!hit) continue;
    const current = map.get(hit.mc);
    if (!current || compareVersions(loaderVersion, current) > 0) map.set(hit.mc, loaderVersion);
  }
  return map;
}

function lineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop();
      for (const line of parts) if (line.trim()) onLine(line.trim());
    },
    flush() {
      if (buffer.trim()) onLine(buffer.trim());
      buffer = '';
    },
  };
}

function killProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } catch {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

class Loaders {
  constructor({ mojang, cacheDir, registryFile }) {
    this.mojang = mojang;
    this.cacheDir = cacheDir;
    this.metaDir = path.join(cacheDir, 'meta');
    this.installerDir = path.join(cacheDir, 'installers');
    this.registryFile = registryFile;
    this._catalog = null;
    this._catalogTime = 0;
    this._registry = null;
    this._forgeMap = null;
    this._neoMap = null;
  }

  readRegistry() {
    if (this._registry) return this._registry;
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      this._registry = { targets: raw?.targets || {} };
    } catch {
      this._registry = { targets: {} };
    }
    return this._registry;
  }

  saveRegistry() {
    const registry = this.readRegistry();
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
    const tmp = `${this.registryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), 'utf8');
    fs.renameSync(tmp, this.registryFile);
  }

  profileFile(gameDir, profileId) {
    return path.join(gameDir, 'versions', profileId, `${profileId}.json`);
  }

  profileExists(gameDir, profileId) {
    try {
      return fs.statSync(this.profileFile(gameDir, profileId)).isFile();
    } catch {
      return false;
    }
  }

  installed(gameDir, kind, mcVersion) {
    const entry = this.readRegistry().targets[`${kind}:${mcVersion}`];
    if (!entry || !entry.profileId) return null;
    if (!this.profileExists(gameDir, entry.profileId)) return null;
    return entry;
  }

  remember(entry) {
    const registry = this.readRegistry();
    registry.targets[`${entry.kind}:${entry.mcVersion}`] = entry;
    this.saveRegistry();
    return entry;
  }

  forget(kind, mcVersion) {
    const registry = this.readRegistry();
    delete registry.targets[`${kind}:${mcVersion}`];
    this.saveRegistry();
  }

  async deleteProfile(gameDir, profileId) {
    if (!profileId) return false;
    const versionsDir = path.resolve(gameDir, 'versions');
    const dir = path.resolve(versionsDir, profileId);
    if (path.dirname(dir) !== versionsDir) throw new Error('Небезопасный путь профиля загрузчика.');
    await fsp.rm(dir, { recursive: true, force: true });
    return true;
  }

  async fetchMeta(name, urls, force) {
    const file = path.join(this.metaDir, name);
    let stat = null;
    try {
      stat = await fsp.stat(file);
    } catch {
      // no cache yet
    }
    if (!force && stat && Date.now() - stat.mtimeMs < META_TTL) {
      return fsp.readFile(file, 'utf8');
    }

    let lastError = null;
    for (const url of urls) {
      try {
        const text = await fetchText(url, { retries: 1, timeout: 30000 });
        await fsp.mkdir(this.metaDir, { recursive: true });
        await fsp.writeFile(file, text, 'utf8');
        return text;
      } catch (err) {
        lastError = err;
      }
    }
    if (stat) return fsp.readFile(file, 'utf8');
    throw lastError || new Error(`Не удалось загрузить метаданные ${name}`);
  }

  async catalog({ force = false } = {}) {
    if (!force && this._catalog && Date.now() - this._catalogTime < META_TTL) {
      return this._catalog;
    }

    const manifest = await this.mojang.getManifest();
    const allVersions = manifest.versions.map((v) => v.id);
    const releases = manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);

    const safe = async (name, urls) => {
      try {
        return await this.fetchMeta(name, urls, force);
      } catch {
        return '';
      }
    };

    const [fabricGamesText, fabricLoadersText, forgeText, neoText] = await Promise.all([
      safe('fabric-games.json', [`${FABRIC_META}/versions/game`]),
      safe('fabric-loaders.json', [`${FABRIC_META}/versions/loader`]),
      safe('forge-maven.xml', [`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`]),
      safe('neoforge-maven.xml', NEOFORGE_MAVENS.map((base) => `${base}/net/neoforged/neoforge/maven-metadata.xml`)),
    ]);

    let fabricGames = [];
    try {
      const parsed = JSON.parse(fabricGamesText);
      if (Array.isArray(parsed)) fabricGames = parsed.map((item) => item.version).filter(Boolean);
    } catch {
      // keep empty
    }

    let latestFabricLoader = '';
    try {
      const parsed = JSON.parse(fabricLoadersText);
      if (Array.isArray(parsed) && parsed[0]?.version) latestFabricLoader = parsed[0].version;
    } catch {
      // keep empty
    }

    this._forgeMap = parseForgeVersions(forgeText);
    this._neoMap = parseNeoForgeVersions(neoText, releases);

    const versionOrder = new Map(allVersions.map((id, index) => [id, index]));
    const sortEntries = (entries) =>
      entries.sort((a, b) => (versionOrder.get(a.mcVersion) ?? 1e9) - (versionOrder.get(b.mcVersion) ?? 1e9));

    this._catalog = {
      fabric: {
        latestLoader: latestFabricLoader,
        games: fabricGames.filter((id) => versionOrder.has(id)),
      },
      forge: sortEntries(
        [...this._forgeMap.entries()]
          .filter(([mc]) => versionOrder.has(mc))
          .map(([mcVersion, loaderVersion]) => ({ mcVersion, loaderVersion }))
      ),
      neoforge: sortEntries(
        [...this._neoMap.entries()]
          .filter(([mc]) => versionOrder.has(mc))
          .map(([mcVersion, loaderVersion]) => ({ mcVersion, loaderVersion }))
      ),
    };
    this._catalogTime = Date.now();
    return this._catalog;
  }

  async latestLoader(kind, mcVersion) {
    await this.catalog();
    if (kind === 'fabric') {
      const loader = this._catalog.fabric.latestLoader;
      if (!loader) throw new Error('Не удалось получить версии Fabric Loader.');
      if (!this._catalog.fabric.games.includes(mcVersion)) {
        throw new Error(`Fabric не поддерживает версию ${mcVersion}.`);
      }
      return loader;
    }
    const map = kind === 'forge' ? this._forgeMap : this._neoMap;
    const loader = map?.get(mcVersion);
    if (!loader) {
      const name = kind === 'forge' ? 'Forge' : 'NeoForge';
      throw new Error(`${name} не поддерживает версию ${mcVersion}.`);
    }
    return loader;
  }

  async ensureBase({ gameDir, mcVersion, progress, signal, log }) {
    const version = await this.mojang.getVersionById(mcVersion);
    const dir = path.join(gameDir, 'versions', mcVersion);
    await fsp.mkdir(dir, { recursive: true });

    const jsonFile = path.join(dir, `${mcVersion}.json`);
    const json = JSON.stringify(version, null, 2);
    let current = null;
    try {
      current = await fsp.readFile(jsonFile, 'utf8');
    } catch {
      // missing
    }
    if (current !== json) await fsp.writeFile(jsonFile, json, 'utf8');

    const client = version.downloads?.client;
    if (client?.url) {
      const jar = path.join(dir, `${mcVersion}.jar`);
      let stat = null;
      try {
        stat = await fsp.stat(jar);
      } catch {
        // missing
      }
      if (!stat) {
        progress?.setStage('client');
        progress?.setTotal(client.size || 0);
        progress?.setFile(`${mcVersion}.jar`);
        log?.(`Загрузка клиента ${mcVersion} для установщика...`);
        await downloadFile(client.url, jar, {
          sha1: client.sha1,
          size: client.size,
          signal,
          onBytes: (n) => progress?.add(n),
        });
      }
    }
    return version;
  }

  async ensureFabric({ gameDir, mcVersion, loaderVersion, log }) {
    const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(
      loaderVersion
    )}/profile/json`;
    log?.(`Получение профиля Fabric ${loaderVersion} для ${mcVersion}...`);
    const profile = await fetchJson(url);
    const profileId = profile.id || `fabric-loader-${loaderVersion}-${mcVersion}`;
    profile.id = profileId;
    profile.inheritsFrom = profile.inheritsFrom || mcVersion;

    const dir = path.join(gameDir, 'versions', profileId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${profileId}.json`), JSON.stringify(profile, null, 2), 'utf8');
    return profileId;
  }

  async downloadInstaller(urls, dest, { signal, log } = {}) {
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    const valid = () => {
      try {
        new AdmZip(dest);
        return true;
      } catch {
        return false;
      }
    };

    if (fs.existsSync(dest) && valid()) return dest;

    let lastError = null;
    for (const url of urls) {
      try {
        log?.(`Загрузка установщика: ${url}`);
        await downloadFile(url, dest, { signal, force: true });
        if (valid()) return dest;
        await fsp.rm(dest, { force: true });
        lastError = new Error('Скачанный установщик повреждён.');
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Не удалось скачать установщик загрузчика.');
  }

  ensureLauncherProfiles(gameDir) {
    const file = path.join(gameDir, 'launcher_profiles.json');
    if (fs.existsSync(file)) return;
    fs.writeFileSync(
      file,
      JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2),
      'utf8'
    );
  }

  async runInstaller({ javaPath, jar, gameDir, label, signal, log }) {
    this.ensureLauncherProfiles(gameDir);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const tail = [];
      const reader = lineReader((line) => {
        tail.push(line);
        if (tail.length > 30) tail.shift();
        log?.(`[${label}] ${line}`);
      });

      log?.(`Запуск установщика ${label}...`);
      const child = spawn(javaPath, ['-jar', jar, '--installClient', gameDir], {
        cwd: gameDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killProcess(child);
      }, INSTALLER_TIMEOUT);

      const onAbort = () => killProcess(child);
      signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reader.flush();
        fn(value);
      };

      child.stdout.on('data', (chunk) => reader.push(chunk));
      child.stderr.on('data', (chunk) => reader.push(chunk));
      child.on('error', (err) => finish(reject, err));
      child.on('exit', (code) => {
        if (signal?.aborted) {
          finish(reject, Object.assign(new Error('Установка отменена.'), { name: 'AbortError' }));
          return;
        }
        if (timedOut) {
          finish(reject, new Error(`Установщик ${label} не завершился за 30 минут.`));
          return;
        }
        if (code === 0) {
          finish(resolve, true);
          return;
        }
        const details = tail.slice(-8).join('\n');
        finish(
          reject,
          new Error(`Установщик ${label} завершился с кодом ${code}.${details ? `\n${details}` : ''}`)
        );
      });
    });
  }

  findProfile(gameDir, predicate) {
    const versionsDir = path.join(gameDir, 'versions');
    let dirs = [];
    try {
      dirs = fs.readdirSync(versionsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      if (!predicate(dir.name)) continue;
      if (this.profileExists(gameDir, dir.name)) return dir.name;
    }
    return null;
  }

  async ensureForge({ gameDir, mcVersion, loaderVersion, javaPath, signal, log }) {
    const profileId = `${mcVersion}-forge-${loaderVersion}`;
    if (this.profileExists(gameDir, profileId)) return profileId;

    const existing = this.findProfile(
      gameDir,
      (name) => name.startsWith(`${mcVersion}-forge-`) && name.includes(loaderVersion)
    );
    if (existing) return existing;

    const fileName = `forge-${mcVersion}-${loaderVersion}-installer.jar`;
    const installer = path.join(this.installerDir, fileName);
    const url = `${FORGE_MAVEN}/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/${fileName}`;
    await this.downloadInstaller([url], installer, { signal, log });
    await this.runInstaller({ javaPath, jar: installer, gameDir, label: `Forge ${loaderVersion}`, signal, log });

    if (this.profileExists(gameDir, profileId)) return profileId;
    const found = this.findProfile(
      gameDir,
      (name) => name.startsWith(`${mcVersion}-forge-`) && name.includes(loaderVersion)
    );
    if (found) return found;
    throw new Error(`Forge ${loaderVersion} установился, но профиль запуска не найден.`);
  }

  async ensureNeoForge({ gameDir, mcVersion, loaderVersion, javaPath, signal, log }) {
    const profileId = `neoforge-${loaderVersion}`;
    if (this.profileExists(gameDir, profileId)) return profileId;

    const fileName = `neoforge-${loaderVersion}-installer.jar`;
    const installer = path.join(this.installerDir, fileName);
    const urls = NEOFORGE_MAVENS.map(
      (base) => `${base}/net/neoforged/neoforge/${loaderVersion}/${fileName}`
    );
    await this.downloadInstaller(urls, installer, { signal, log });
    await this.runInstaller({
      javaPath,
      jar: installer,
      gameDir,
      label: `NeoForge ${loaderVersion}`,
      signal,
      log,
    });

    if (this.profileExists(gameDir, profileId)) return profileId;
    const found = this.findProfile(gameDir, (name) => name === `neoforge-${loaderVersion}`);
    if (found) return found;
    throw new Error(`NeoForge ${loaderVersion} установился, но профиль запуска не найден.`);
  }

  async ensure({
    kind,
    mcVersion,
    loaderVersion,
    gameDir,
    javaPath,
    signal,
    log,
    progress,
  }) {
    if (!kind || kind === 'vanilla') {
      await this.ensureBase({ gameDir, mcVersion, progress, signal, log });
      return { kind: 'vanilla', mcVersion, profileId: mcVersion, loaderVersion: '' };
    }

    await this.ensureBase({ gameDir, mcVersion, progress, signal, log });

    const cached = this.installed(gameDir, kind, mcVersion);
    if (!loaderVersion && cached) return cached;
    if (loaderVersion && cached && cached.loaderVersion === loaderVersion) return cached;

    let version = loaderVersion;
    if (!version) {
      try {
        version = await this.latestLoader(kind, mcVersion);
      } catch (err) {
        if (cached) return cached;
        throw err;
      }
    }

    if (cached && cached.loaderVersion === version) return cached;

    const expected =
      kind === 'fabric'
        ? `fabric-loader-${version}-${mcVersion}`
        : kind === 'forge'
          ? `${mcVersion}-forge-${version}`
          : `neoforge-${version}`;

    let profileId = expected;
    if (!this.profileExists(gameDir, profileId)) {
      progress?.setStage('loader');
      progress?.setTotal(0);
      progress?.setFile('');
      if (kind === 'fabric') {
        profileId = await this.ensureFabric({ gameDir, mcVersion, loaderVersion: version, log });
      } else if (kind === 'forge') {
        if (!javaPath) throw new Error('Для установки Forge нужна Java.');
        profileId = await this.ensureForge({
          gameDir,
          mcVersion,
          loaderVersion: version,
          javaPath,
          signal,
          log,
        });
      } else if (kind === 'neoforge') {
        if (!javaPath) throw new Error('Для установки NeoForge нужна Java.');
        profileId = await this.ensureNeoForge({
          gameDir,
          mcVersion,
          loaderVersion: version,
          javaPath,
          signal,
          log,
        });
      } else {
        throw new Error(`Неизвестный загрузчик: ${kind}`);
      }
    }

    return this.remember({
      kind,
      mcVersion,
      loaderVersion: version,
      profileId,
      installedAt: new Date().toISOString(),
    });
  }
}

module.exports = {
  Loaders,
  parseTarget,
  targetLabel,
  compareVersions,
  parseForgeVersions,
  parseNeoForgeVersions,
  FABRIC_META,
  FORGE_MAVEN,
  NEOFORGE_MAVENS,
};
