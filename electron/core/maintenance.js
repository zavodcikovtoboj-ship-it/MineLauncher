'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const { downloadFile, runPool } = require('./net');
const { collectLibraries } = require('./libraries');
const { objectPath } = require('./assets');
const { resolveVersion } = require('./version');
const { detectJava } = require('./java');
const { readModMeta } = require('./content');
const { normalizeRel } = require('./modpacks');

const RESOURCES_BASE = 'https://resources.download.minecraft.net';

function inside(root, rel) {
  const target = path.resolve(root, ...String(rel).split(/[\\/]+/));
  const base = path.resolve(root);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

async function dirSize(dir, depth = 0) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 12) total += await dirSize(full, depth + 1);
    } else {
      try {
        total += (await fsp.stat(full)).size;
      } catch {
        // vanished
      }
    }
  }
  return total;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function walkFiles(dir, visit, depth = 0) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 10) await walkFiles(full, visit, depth + 1);
    } else {
      await visit(full, entry);
    }
  }
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(
    now.getMinutes()
  )}${pad(now.getSeconds())}`;
}

class Maintenance {
  constructor({ config, mojang, loaders, modpacks, instances, targets, content, cacheDir }) {
    this.config = config;
    this.mojang = mojang;
    this.loaders = loaders;
    this.modpacks = modpacks;
    this.instances = instances;
    this.targets = targets;
    this.content = content;
    this.cacheDir = cacheDir;
  }

  gameDir() {
    return this.config.get('gameDir');
  }

  backupsDir() {
    return path.join(this.gameDir(), 'backups');
  }

  async expectedFor(versionId) {
    const target = this.targets.resolve(versionId);
    const gameDir = this.gameDir();
    const versionsDir = path.join(gameDir, 'versions');
    const librariesDir = path.join(gameDir, 'libraries');
    const assetsDir = path.join(gameDir, 'assets');
    const baseVersion = await this.mojang.getVersionById(target.mcVersion);
    const manifest = await this.mojang.getManifest();
    const manifestEntry = manifest.versions.find((entry) => entry.id === target.mcVersion);

    let loaderProfileId = '';
    if (target.loader && target.loader !== 'vanilla') {
      loaderProfileId =
        target.pack?.profileId ||
        this.loaders.installed(gameDir, target.loader, target.mcVersion)?.profileId ||
        '';
    }
    if (target.kind === 'modpack' && target.pack?.profileId) loaderProfileId = target.pack.profileId;

    let resolved = baseVersion;
    if (loaderProfileId) {
      try {
        resolved = await resolveVersion({ mojang: this.mojang, gameDir, versionId: loaderProfileId });
      } catch {
        // keep vanilla expectations; the missing profile is reported below
      }
    }

    const files = [];
    const add = (dest, options = {}) => {
      if (!dest) return;
      files.push({
        dest: path.resolve(dest),
        sha1: options.sha1 || '',
        size: Number.isFinite(options.size) ? options.size : null,
        url: options.url || '',
        deep: Boolean(options.deep),
        kind: options.kind || 'file',
        label: options.label || path.basename(dest),
      });
    };

    add(path.join(versionsDir, target.mcVersion, `${target.mcVersion}.json`), {
      url: manifestEntry?.url || '',
      kind: 'json',
      hash: false,
      label: `${target.mcVersion}.json`,
    });

    const client = baseVersion.downloads?.client;
    if (client?.url) {
      add(path.join(versionsDir, target.mcVersion, `${target.mcVersion}.jar`), {
        url: client.url,
        sha1: client.sha1,
        size: client.size,
        deep: true,
        kind: 'client',
        label: `${target.mcVersion}.jar`,
      });
    }

    try {
      const { downloads } = collectLibraries(resolved, librariesDir);
      for (const job of downloads) {
        add(job.dest, {
          url: job.url,
          sha1: job.sha1,
          size: job.size,
          deep: true,
          kind: 'library',
        });
      }
    } catch {
      // libraries are reported as unverified
    }

    if (baseVersion.assetIndex?.url) {
      const indexId = baseVersion.assetIndex.id || baseVersion.assets || 'legacy';
      const indexFile = path.join(assetsDir, 'indexes', `${indexId}.json`);
      add(indexFile, {
        url: baseVersion.assetIndex.url,
        sha1: baseVersion.assetIndex.sha1 || '',
        size: baseVersion.assetIndex.size,
        kind: 'asset-index',
        deep: true,
        label: `${indexId}.json`,
      });
      try {
        const index = await this.mojang.getAssetIndex(baseVersion.assetIndex.url);
        for (const [name, obj] of Object.entries(index.objects || {})) {
          add(objectPath(assetsDir, obj.hash), {
            url: `${RESOURCES_BASE}/${obj.hash.slice(0, 2)}/${obj.hash}`,
            sha1: obj.hash,
            size: obj.size,
            deep: false,
            kind: 'asset',
            label: name,
          });
        }
      } catch {
        // index unavailable while offline
      }
    }

    if (resolved.logging?.client?.file?.url) {
      const logFile = resolved.logging.client.file;
      add(path.join(assetsDir, 'log_configs', logFile.id), {
        url: logFile.url,
        sha1: logFile.sha1,
        size: logFile.size,
        deep: true,
        kind: 'log-config',
        label: logFile.id,
      });
    }

    if (loaderProfileId) {
      add(this.loaders.profileFile(gameDir, loaderProfileId), {
        kind: 'loader-profile',
        label: loaderProfileId,
      });
    }

    if (target.kind === 'instance' || target.kind === 'modpack') {
      const contentFile = path.join(target.instanceDir, 'content.json');
      try {
        const data = JSON.parse(await fsp.readFile(contentFile, 'utf8'));
        for (const item of data.items || []) {
          const dest = inside(target.instanceDir, item.relPath);
          if (!dest) continue;
          add(dest, {
            url: item.url || '',
            sha1: item.sha1 || '',
            size: item.size || null,
            deep: true,
            kind: 'content',
            label: item.relPath,
          });
        }
      } catch {
        // no content registry
      }
    }

    if (target.kind === 'modpack' && target.pack?.versionId) {
      const packFile = path.join(
        this.modpacks.cacheDir,
        'modpacks',
        `${target.pack.slug}-${target.pack.versionId}.mrpack`
      );
      try {
        const zip = new AdmZip(packFile);
        const entry = zip.getEntry('modrinth.index.json');
        if (entry) {
          const index = JSON.parse(entry.getData().toString('utf8'));
          for (const item of index.files || []) {
            if (item.env?.client === 'unsupported' || !item.downloads?.length) continue;
            const rel = normalizeRel(item.path);
            if (!rel) continue;
            const dest = inside(target.instanceDir, rel);
            if (!dest) continue;
            add(dest, {
              url: item.downloads[0],
              sha1: item.hashes?.sha1,
              size: item.fileSize,
              deep: true,
              kind: 'modpack-file',
              label: rel,
            });
          }
        }
      } catch {
        // cached mrpack not available; content registry still covers added files
      }
    }

    return { target, baseVersion, resolved, files, loaderProfileId };
  }

  async verify(versionId, { deep = true } = {}) {
    const started = Date.now();
    const expected = await this.expectedFor(versionId);
    const issues = [];
    let checkedBytes = 0;
    let checked = 0;
    let missing = 0;
    let corrupt = 0;

    await runPool(
      expected.files.map((file) => async () => {
        checked++;
        let stat;
        try {
          stat = await fsp.stat(file.dest);
        } catch {
          missing++;
          issues.push({
            type: 'missing',
            kind: file.kind,
            label: file.label,
            path: file.dest,
            url: file.url,
            repairable: Boolean(file.url) || file.kind === 'loader-profile',
          });
          return;
        }
        if (!stat.isFile()) {
          missing++;
          issues.push({
            type: 'missing',
            kind: file.kind,
            label: file.label,
            path: file.dest,
            url: file.url,
            repairable: Boolean(file.url),
          });
          return;
        }
        checkedBytes += stat.size;
        if (file.size !== null && stat.size !== file.size) {
          corrupt++;
          issues.push({
            type: 'size',
            kind: file.kind,
            label: file.label,
            path: file.dest,
            expected: file.size,
            actual: stat.size,
            url: file.url,
            repairable: Boolean(file.url),
          });
          return;
        }
        if (deep && file.deep && file.sha1) {
          const actual = await hashFile(file.dest);
          if (actual !== file.sha1) {
            corrupt++;
            issues.push({
              type: 'hash',
              kind: file.kind,
              label: file.label,
              path: file.dest,
              expected: file.sha1,
              actual,
              url: file.url,
              repairable: Boolean(file.url),
            });
          }
        }
      }),
      6
    );

    if (expected.loaderProfileId && !fs.existsSync(this.loaders.profileFile(this.gameDir(), expected.loaderProfileId))) {
      if (!issues.some((issue) => issue.kind === 'loader-profile')) {
        issues.push({
          type: 'missing',
          kind: 'loader-profile',
          label: expected.loaderProfileId,
          path: this.loaders.profileFile(this.gameDir(), expected.loaderProfileId),
          repairable: true,
        });
      }
    }

    const summary = {
      ok: issues.length === 0,
      target: {
        id: versionId,
        name: expected.target.name,
        kind: expected.target.kind,
        mcVersion: expected.target.mcVersion,
        loader: expected.target.loader,
      },
      checked,
      checkedBytes,
      missing,
      corrupt,
      issues: issues.slice(0, 300),
      issueCount: issues.length,
      durationMs: Date.now() - started,
    };
    return { summary, expected, issues };
  }

  async repair(versionId, { signal, log, progress } = {}) {
    const { summary, expected, issues } = await this.verify(versionId, { deep: true });
    if (summary.ok) return { ok: true, repaired: 0, summary };

    const gameDir = this.gameDir();
    let repaired = 0;
    const failed = [];
    const issuePaths = new Set(issues.map((issue) => path.resolve(issue.path)));
    const files = expected.files.filter((file) => issuePaths.has(path.resolve(file.dest)) && file.url);
    const loaderBroken =
      Boolean(expected.loaderProfileId) &&
      !fs.existsSync(this.loaders.profileFile(gameDir, expected.loaderProfileId));
    const unique = new Map(files.map((file) => [file.dest, file]));

    progress?.setStage?.('repair');
    progress?.setTotal?.(unique.size + (loaderBroken ? 1 : 0));
    progress?.setFile?.('');

    await runPool(
      [...unique.values()].map((file) => async () => {
        try {
          progress?.setFile?.(file.label);
          await downloadFile(file.url, file.dest, {
            sha1: file.sha1 || undefined,
            size: file.size === null ? undefined : file.size,
            force: true,
            signal,
            onBytes: (n) => progress?.add?.(n),
          });
          repaired++;
          log?.(`Восстановлен ${file.label}`);
        } catch (err) {
          failed.push({ label: file.label, error: err.message });
          log?.(`Не удалось восстановить ${file.label}: ${err.message}`);
        }
      }),
      5
    );

    if (loaderBroken) {
      try {
        await this.reinstallLoader(versionId, { signal, log, progress });
        repaired++;
      } catch (err) {
        failed.push({ label: 'Профиль загрузчика', error: err.message });
        log?.(`Загрузчик не переустановлен: ${err.message}`);
      }
    }

    const after = await this.verify(versionId, { deep: true });
    return {
      ok: after.summary.ok,
      repaired,
      failed,
      before: summary,
      summary: after.summary,
    };
  }

  async reinstallLoader(versionId, { signal, log, progress } = {}) {
    const target = this.targets.resolve(versionId);
    if (!target.loader || target.loader === 'vanilla') {
      throw new Error('У этой цели нет модифицированного загрузчика.');
    }
    const gameDir = this.gameDir();
    const base = await this.mojang.getVersionById(target.mcVersion);
    const requiredMajor = base.javaVersion?.majorVersion || 8;
    const java = await detectJava({
      gameDir,
      preferred: target.settings?.javaPath || this.config.get('javaPath'),
      requiredMajor,
      refresh: true,
    });
    if (!java.found) {
      const err = new Error(`Для переустановки ${target.loader} нужна Java ${requiredMajor}+.`);
      err.code = 'JAVA_MISSING';
      err.requiredMajor = requiredMajor;
      err.component = base.javaVersion?.component || '';
      throw err;
    }

    let loaderVersion = target.loaderVersion;
    if (!loaderVersion) {
      loaderVersion = await this.loaders.latestLoader(target.loader, target.mcVersion);
    }
    const cached = this.loaders.installed(gameDir, target.loader, target.mcVersion);
    const profileId = target.pack?.profileId || cached?.profileId || '';
    if (profileId) {
      await this.loaders.deleteProfile(gameDir, profileId);
      log?.(`Удалён старый профиль ${profileId}`);
    }
    this.loaders.forget(target.loader, target.mcVersion);

    progress?.setStage?.('loader');
    progress?.setTotal?.(0);
    const ensured = await this.loaders.ensure({
      kind: target.loader,
      mcVersion: target.mcVersion,
      loaderVersion,
      gameDir,
      javaPath: java.path,
      signal,
      log,
      progress,
    });
    log?.(`Загрузчик ${target.loader} ${loaderVersion} переустановлен: ${ensured.profileId}`);
    return { profileId: ensured.profileId, loader: target.loader, loaderVersion };
  }

  async reset(versionId, { keepWorlds = true, signal, log, progress } = {}) {
    const target = this.targets.resolve(versionId);
    if (target.kind !== 'instance' && target.kind !== 'modpack') {
      throw new Error('Сброс доступен только для собственного инстанса или модпака.');
    }
    const dirs = ['mods', 'resourcepacks', 'shaderpacks', 'config', 'defaultconfigs', 'scripts', 'kubejs', 'logs', 'crash-reports'];
    if (!keepWorlds) dirs.push('saves');

    let freed = 0;
    for (const name of dirs) {
      const dir = path.join(target.instanceDir, name);
      freed += await dirSize(dir);
      await fsp.rm(dir, { recursive: true, force: true });
    }
    await fsp.rm(path.join(target.instanceDir, 'content.json'), { force: true }).catch(() => {});

    if (target.kind === 'modpack') {
      log?.('Повторная распаковка модпака...');
      await this.modpacks.reinstall(target.pack.slug, { signal, log, progress });
    }
    return { ok: true, freed, keptWorlds: keepWorlds, target: target.name };
  }

  async analyzeCrash(versionId) {
    let target = null;
    try {
      target = this.targets.resolve(versionId);
    } catch {
      target = null;
    }
    const gameDir = this.gameDir();
    const roots = [target?.instanceDir, gameDir].filter(Boolean);
    let crashFile = '';
    let latest = 0;
    for (const root of new Set(roots)) {
      const dir = path.join(root, 'crash-reports');
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
        const full = path.join(dir, entry.name);
        try {
          const stat = await fsp.stat(full);
          if (stat.mtimeMs > latest) {
            latest = stat.mtimeMs;
            crashFile = full;
          }
        } catch {
          // skip
        }
      }
    }
    if (!crashFile) {
      for (const root of new Set(roots)) {
        const candidate = path.join(root, 'logs', 'latest.log');
        try {
          const stat = await fsp.stat(candidate);
          if (stat.mtimeMs > latest) {
            latest = stat.mtimeMs;
            crashFile = candidate;
          }
        } catch {
          // skip
        }
      }
    }
    if (!crashFile) {
      return {
        found: false,
        summary: 'Свежих отчётов о краше и latest.log не найдено.',
        causes: [],
        excerpt: '',
      };
    }

    let text = '';
    try {
      const stat = await fsp.stat(crashFile);
      const start = Math.max(0, stat.size - 250000);
      const handle = await fsp.open(crashFile, 'r');
      try {
        const buffer = Buffer.alloc(stat.size - start);
        await handle.read(buffer, 0, buffer.length, start);
        text = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (err) {
      return { found: true, summary: `Не удалось прочитать ${crashFile}: ${err.message}`, causes: [], excerpt: '' };
    }

    const patterns = [
      {
        test: /OutOfMemoryError|Java heap space/i,
        title: 'Не хватает оперативной памяти',
        advice: 'Увеличьте выделяемую память в настройках инстанса или закройте другие приложения.',
      },
      {
        test: /UnsupportedClassVersionError|class file version/i,
        title: 'Неподходящая версия Java',
        advice: 'Установите Java нужной версии: для старых версий игры Java 8, для новых — 21/25.',
      },
      {
        test: /Missing or unsupported mandatory dependencies|ModResolutionException|InvalidModIdException/i,
        title: 'Не хватает или конфликтуют моды',
        advice: 'Откройте «Контент» → «Проверить конфликты» и установите отсутствующие зависимости.',
      },
      {
        test: /NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException|IncompatibleClassChangeError/i,
        title: 'Конфликт версий модов или загрузчика',
        advice: 'Проверьте, что все моды собраны под одну версию Minecraft и один загрузчик. Удалите дубликаты.',
      },
      {
        test: /GLFW error|Failed to create window|Pixel format not accelerated|OpenGL/i,
        title: 'Проблема с видеодрайвером или OpenGL',
        advice: 'Обновите драйвер видеокарты. Для старых версий попробуйте отключить аппаратное ускорение в настройках игры.',
      },
      {
        test: /Address already in use|Failed to bind|Could not reserve enough space/i,
        title: 'Ошибка запуска JVM',
        advice: 'Закройте другой экземпляр Minecraft/лаунчера или уменьшите память.',
      },
      {
        test: /java\.io\.FileNotFoundException|AccessDeniedException|Read-only file system/i,
        title: 'Проблема доступа к файлам',
        advice: 'Проверьте права на папку игры и антивирус. Не запускайте лаунчер из защищённой папки.',
      },
      {
        test: /Caused by: .*Mixin|Mixin apply failed|mixin/i,
        title: 'Ошибка миксинов',
        advice: 'Обычно вызвана несовместимым модом. Проверьте конфликты и обновите моды.',
      },
    ];
    const causes = [];
    for (const pattern of patterns) {
      if (pattern.test.test(text)) causes.push({ title: pattern.title, advice: pattern.advice });
    }

    const description =
      text.match(/Description:\s*([^\r\n]+)/i)?.[1]?.trim() ||
      text.match(/Exception in thread "[^"]+"\s*([^\r\n]+)/)?.[1]?.trim() ||
      '';
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const excerpt = lines.slice(-70).join('\n');
    if (!causes.length) {
      causes.push({
        title: 'Универсальная диагностика',
        advice: 'Проверьте консоль и файл crash-report. Чаще всего помогают проверка файлов, обновление модов и увеличение памяти.',
      });
    }
    return {
      found: true,
      file: crashFile,
      description,
      summary: description || causes[0].title,
      causes,
      excerpt,
    };
  }

  async cleanup({ days = 7 } = {}) {
    const cutoff = Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000;
    const gameDir = this.gameDir();
    let removed = 0;
    let freed = 0;
    const items = [];

    const removeOld = async (dir) => {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        try {
          const stat = await fsp.stat(full);
          if (stat.mtimeMs < cutoff) {
            await fsp.rm(full, { force: true });
            removed++;
            freed += stat.size;
            items.push(full);
          }
        } catch {
          // skip
        }
      }
    };

    const roots = new Set([gameDir]);
    for (const instance of this.instances.list()) roots.add(instance.instanceDir);
    for (const pack of this.modpacks.list()) roots.add(pack.instanceDir);
    for (const root of roots) {
      if (!root) continue;
      await removeOld(path.join(root, 'logs'));
      await removeOld(path.join(root, 'crash-reports'));
    }

    const partRoots = [
      path.join(gameDir, 'versions'),
      path.join(gameDir, 'libraries'),
      path.join(gameDir, 'assets'),
      path.join(gameDir, 'instances'),
      path.join(gameDir, 'modpacks'),
      path.join(this.cacheDir, 'modpacks'),
      path.join(this.cacheDir, 'installers'),
      path.join(this.cacheDir, 'updates'),
    ];
    for (const root of partRoots) {
      await walkFiles(root, async (file) => {
        if (!file.endsWith('.part')) return;
        try {
          const stat = await fsp.stat(file);
          if (stat.mtimeMs >= cutoff) return;
          await fsp.rm(file, { force: true });
          removed++;
          freed += stat.size;
          items.push(file);
        } catch {
          // skip
        }
      });
    }

    await removeOld(path.join(this.cacheDir, 'installers'));
    return { removed, freed, items: items.slice(0, 120) };
  }

  async diskUsage() {
    const gameDir = this.gameDir();
    const categories = [];
    const add = async (name, dir, userData = false) => {
      const size = await dirSize(dir);
      categories.push({ name, path: dir, size, exists: fs.existsSync(dir), userData });
    };
    await Promise.all([
      add('Версии', path.join(gameDir, 'versions')),
      add('Библиотеки', path.join(gameDir, 'libraries')),
      add('Ассеты', path.join(gameDir, 'assets')),
      add('Модпаки', path.join(gameDir, 'modpacks')),
      add('Инстансы', path.join(gameDir, 'instances')),
      add('Java', path.join(gameDir, 'runtime')),
      add('Бэкапы', this.backupsDir()),
      add('Логи', path.join(gameDir, 'logs')),
      add('Кэш лаунчера', this.cacheDir, true),
    ]);
    const total = categories.reduce((sum, category) => sum + category.size, 0);
    return { categories, total, gameDir };
  }

  async createBackup(versionId, { includeWorlds = true, log } = {}) {
    const target = this.targets.resolve(versionId);
    if (target.kind !== 'instance' && target.kind !== 'modpack') {
      throw new Error('Бэкап доступен только для инстанса или модпака.');
    }
    const backupDir = this.backupsDir();
    await fsp.mkdir(backupDir, { recursive: true });
    const slug = target.slug || target.pack?.slug || target.kind;
    const file = path.join(backupDir, `${slug}-${timestamp()}.zip`);
    const zip = new AdmZip();

    const directories = ['mods', 'config', 'resourcepacks', 'shaderpacks', 'defaultconfigs', 'scripts', 'kubejs'];
    if (includeWorlds) directories.push('saves');
    for (const name of directories) {
      const dir = path.join(target.instanceDir, name);
      if (fs.existsSync(dir)) zip.addLocalFolder(dir, name);
    }
    for (const name of ['instance.json', 'modpack.json', 'content.json', 'options.txt', 'servers.dat']) {
      const filePath = path.join(target.instanceDir, name);
      if (fs.existsSync(filePath)) zip.addLocalFile(filePath);
    }
    zip.writeZip(file);
    const stat = await fsp.stat(file);
    log?.(`Создан бэкап ${file} (${stat.size} байт)`);

    const keep = Math.max(1, Number(this.config.get('backupRetention')) || 10);
    const backups = await this.listBackups();
    for (const old of backups.slice(keep)) {
      await fsp.rm(path.join(backupDir, old.name), { force: true }).catch(() => {});
    }
    return { ok: true, name: path.basename(file), path: file, size: stat.size, includeWorlds };
  }

  async listBackups() {
    const dir = this.backupsDir();
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = await fsp.stat(full);
        out.push({ name: entry.name, path: full, size: stat.size, mtime: stat.mtimeMs });
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async deleteBackup(name) {
    const file = path.join(this.backupsDir(), path.basename(String(name || '')));
    if (!file.endsWith('.zip')) throw new Error('Некорректное имя бэкапа.');
    await fsp.rm(file, { force: true });
    return { ok: true };
  }

  async restoreBackup(versionId, name) {
    const target = this.targets.resolve(versionId);
    if (target.kind !== 'instance' && target.kind !== 'modpack') {
      throw new Error('Восстановление доступно только для инстанса или модпака.');
    }
    const file = path.join(this.backupsDir(), path.basename(String(name || '')));
    if (!fs.existsSync(file)) throw new Error('Бэкап не найден.');
    const zip = new AdmZip(file);
    let restored = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const rel = normalizeRel(entry.entryName);
      if (!rel) continue;
      const dest = inside(target.instanceDir, rel);
      if (!dest) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.getData());
      restored++;
    }
    return { ok: true, restored, name: path.basename(file) };
  }

  async contentConflicts(versionId) {
    const report = this.content.conflicts({ targetId: versionId });
    const missing = (await this.verify(versionId, { deep: false })).summary;
    return { ...report, verification: missing };
  }

  async modAnalysis(versionId) {
    const target = this.targets.resolve(versionId);
    const dir = path.join(target.instanceDir, 'mods');
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const mods = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue;
      const meta = readModMeta(path.join(dir, entry.name));
      mods.push({
        file: entry.name,
        id: meta?.id || '',
        name: meta?.name || entry.name,
        version: meta?.version || '',
        loader: meta?.loader || 'unknown',
        depends: meta?.depends || [],
      });
    }
    return mods;
  }
}

module.exports = { Maintenance, dirSize, timestamp, hashFile };
