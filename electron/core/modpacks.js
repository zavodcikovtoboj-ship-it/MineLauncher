'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const { fetchJson, downloadFile, runPool } = require('./net');
const { detectJava } = require('./java');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const LOADER_KEYS = {
  'fabric-loader': 'fabric',
  forge: 'forge',
  neoforge: 'neoforge',
  'quilt-loader': 'quilt',
};

function safeSlug(value) {
  return String(value || 'modpack')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'modpack';
}

function normalizeRel(value) {
  const rel = String(value || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  return parts.join('/');
}

function inside(root, rel) {
  const target = path.resolve(root, ...rel.split('/'));
  const base = path.resolve(root);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

function loaderLabel(entry) {
  if (!entry) return '';
  if (entry.loader === 'fabric') return `Fabric ${entry.loaderVersion || ''}`.trim();
  if (entry.loader === 'forge') return `Forge ${entry.loaderVersion || ''}`.trim();
  if (entry.loader === 'neoforge') return `NeoForge ${entry.loaderVersion || ''}`.trim();
  return 'Vanilla';
}

class Modpacks {
  constructor({ config, mojang, loaders, cacheDir, registryFile }) {
    this.config = config;
    this.mojang = mojang;
    this.loaders = loaders;
    this.cacheDir = cacheDir;
    this.registryFile = registryFile;
    this._registry = null;
  }

  readRegistry() {
    if (this._registry) return this._registry;
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      this._registry = { packs: raw?.packs || {} };
    } catch {
      this._registry = { packs: {} };
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

  list() {
    const registry = this.readRegistry();
    return Object.values(registry.packs).sort(
      (a, b) => new Date(b.installedAt || 0) - new Date(a.installedAt || 0)
    );
  }

  get(slug) {
    return this.readRegistry().packs[slug] || null;
  }

  async search(query = '') {
    const params = new URLSearchParams();
    params.set('query', query);
    params.set('limit', '16');
    params.set('index', query ? 'relevance' : 'downloads');
    params.set('facets', JSON.stringify([['project_type:modpack']]));
    const data = await fetchJson(`${MODRINTH_API}/search?${params.toString()}`);
    return (data.hits || []).map((hit) => ({
      projectId: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      iconUrl: hit.icon_url || '',
      downloads: hit.downloads || 0,
      follows: hit.follows || 0,
      versions: hit.versions || [],
    }));
  }

  async pickVersion(projectId, versionId = '') {
    const versions = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`);
    if (!Array.isArray(versions) || versions.length === 0) {
      throw new Error('У проекта нет опубликованных версий.');
    }
    const usable = versions
      .map((version) => {
        const file = (version.files || []).find(
          (item) => item.primary && String(item.filename || '').endsWith('.mrpack')
        ) || (version.files || []).find((item) => String(item.filename || '').endsWith('.mrpack'));
        return file ? { version, file } : null;
      })
      .filter(Boolean);
    if (usable.length === 0) throw new Error('У проекта нет .mrpack-файлов.');
    if (versionId) {
      const exact = usable.find((item) => item.version.id === versionId);
      if (!exact) throw new Error('Нужная версия модпака не найдена на Modrinth.');
      return exact;
    }
    return usable[0];
  }

  async install({ projectId, versionId = '', update = false, signal, log, progress }) {
    if (!projectId) throw new Error('Не выбран модпак.');
    const gameDir = this.config.get('gameDir');
    await fsp.mkdir(gameDir, { recursive: true });

    progress?.setStage('modpack');
    log?.('Получение информации о модпаке Modrinth...');
    const [project, picked] = await Promise.all([
      fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}`),
      this.pickVersion(projectId, versionId),
    ]);

    const slug = safeSlug(project.slug || project.title || projectId);
    const existing = this.get(slug);
    if (existing && !update) {
      throw new Error(`Модпак «${project.title || slug}» уже установлен. Сначала удалите его.`);
    }

    const instanceDir = existing?.instanceDir || path.join(gameDir, 'modpacks', slug);
    if (!existing && fs.existsSync(instanceDir)) {
      throw new Error(`Папка модпака уже существует: ${instanceDir}. Удалите её вручную.`);
    }

    const { version, file } = picked;
    const packFile = path.join(this.cacheDir, 'modpacks', `${slug}-${version.id}.mrpack`);
    progress?.setStage('modpack');
    progress?.setTotal(file.size || 0);
    progress?.setFile(file.filename || `${slug}.mrpack`);
    log?.(`Загрузка ${file.filename || 'модпака'}...`);
    await downloadFile(file.url, packFile, {
      sha1: file.hashes?.sha1,
      size: file.size,
      signal,
      force: update,
      onBytes: (n) => progress?.add(n),
    });

    let index;
    let zip;
    try {
      zip = new AdmZip(packFile);
      const entry = zip.getEntry('modrinth.index.json');
      if (!entry) throw new Error('В .mrpack нет modrinth.index.json.');
      index = JSON.parse(entry.getData().toString('utf8'));
    } catch (err) {
      throw new Error(`Не удалось прочитать модпак: ${err.message}`);
    }

    let previousMeta = null;
    try {
      previousMeta = JSON.parse(await fsp.readFile(path.join(instanceDir, 'modpack.json'), 'utf8'));
    } catch {
      // first install
    }

    const dependencies = index.dependencies || {};
    const mcVersion = dependencies.minecraft;
    if (!mcVersion) throw new Error('В модпаке не указана версия Minecraft.');

    let loader = 'vanilla';
    let loaderVersion = '';
    for (const [key, kind] of Object.entries(LOADER_KEYS)) {
      if (dependencies[key]) {
        if (kind === 'quilt') {
          throw new Error('Модпаки Quilt пока не поддерживаются. Нужен Fabric, Forge или NeoForge.');
        }
        loader = kind;
        loaderVersion = String(dependencies[key]);
        break;
      }
    }

    // Java is needed before a Forge/NeoForge installer can run.
    const baseVersion = await this.mojang.getVersionById(mcVersion);
    const requiredMajor = baseVersion.javaVersion?.majorVersion || 8;
    const detected = await detectJava({
      gameDir,
      preferred: this.config.get('javaPath'),
      requiredMajor,
      refresh: true,
    });
    if (!detected.found) {
      const err = new Error(`Не найдена Java ${requiredMajor}+ для этого модпака.`);
      err.code = 'JAVA_MISSING';
      err.requiredMajor = requiredMajor;
      err.component = baseVersion.javaVersion?.component || '';
      throw err;
    }

    progress?.setStage('loader');
    progress?.setTotal(0);
    log?.(`Проверка загрузчика: ${loader} ${loaderVersion}`.trim());
    const ensured = await this.loaders.ensure({
      kind: loader,
      mcVersion,
      loaderVersion: loader === 'vanilla' ? '' : loaderVersion,
      gameDir,
      javaPath: detected.path,
      signal,
      log,
      progress,
    });

    await fsp.mkdir(instanceDir, { recursive: true });
    log?.('Распаковка overrides...');
    this.extractOverrides(zip, instanceDir, 'overrides');
    this.extractOverrides(zip, instanceDir, 'client-overrides');

    const files = Array.isArray(index.files) ? index.files : [];
    const clientFiles = files.filter((item) => {
      const side = item.env?.client;
      return side !== 'unsupported' && item.downloads?.length;
    });
    const managedFiles = clientFiles
      .map((item) => normalizeRel(item.path))
      .filter(Boolean);

    // On an update, remove files that belonged to the old pack version but are
    // no longer listed in the new index. User-added files are not touched.
    if (previousMeta?.files?.length) {
      const nextSet = new Set(managedFiles.map((rel) => rel.toLowerCase()));
      for (const rel of previousMeta.files) {
        const normalized = normalizeRel(rel);
        if (!normalized || nextSet.has(normalized.toLowerCase())) continue;
        const old = inside(instanceDir, normalized);
        if (old) await fsp.rm(old, { force: true }).catch(() => {});
      }
    }

    const totalBytes = clientFiles.reduce((sum, item) => sum + (item.fileSize || 0), 0);
    progress?.setStage('modpack-files');
    progress?.setTotal(totalBytes);
    progress?.setFile('');
    log?.(`Загрузка файлов модпака: ${clientFiles.length}...`);

    await runPool(
      clientFiles.map((item) => async () => {
        const rel = normalizeRel(item.path);
        if (!rel) {
          log?.(`Пропущен небезопасный путь: ${item.path}`);
          return;
        }
        const dest = inside(instanceDir, rel);
        if (!dest) {
          log?.(`Пропущен путь вне папки модпака: ${item.path}`);
          return;
        }
        progress?.setFile(rel);
        await downloadFile(item.downloads[0], dest, {
          sha1: item.hashes?.sha1,
          size: item.fileSize,
          signal,
          onBytes: (n) => progress?.add(n),
        });
      }),
      8
    );

    const meta = {
      formatVersion: index.formatVersion || 1,
      name: index.name || project.title || slug,
      summary: index.summary || project.description || '',
      versionId: version.id,
      versionName: version.name || version.version_number || '',
      projectId: project.id || projectId,
      slug,
      mcVersion,
      loader,
      loaderVersion,
      profileId: ensured.profileId,
      installedAt: existing?.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: managedFiles,
    };

    await fsp.writeFile(path.join(instanceDir, 'modpack.json'), JSON.stringify(meta, null, 2), 'utf8');

    const entry = {
      slug,
      name: index.name || project.title || slug,
      summary: index.summary || project.description || '',
      iconUrl: project.icon_url || '',
      projectId: project.id || projectId,
      versionId: version.id,
      versionName: version.name || version.version_number || '',
      mcVersion,
      loader,
      loaderVersion,
      loaderLabel: loaderLabel({ loader, loaderVersion }),
      profileId: ensured.profileId,
      instanceDir: path.resolve(instanceDir),
      installedAt: meta.installedAt,
      updatedAt: meta.updatedAt,
    };

    const registry = this.readRegistry();
    registry.packs[slug] = entry;
    this.saveRegistry();
    log?.(`Модпак «${entry.name}» ${update ? 'обновлён' : 'установлен'} в ${instanceDir}`);
    return entry;
  }

  async checkUpdates({ signal, log } = {}) {
    const updates = [];
    for (const pack of this.list()) {
      if (!pack.projectId) continue;
      if (signal?.aborted) throw Object.assign(new Error('Отменено'), { name: 'AbortError' });
      try {
        const { version } = await this.pickVersion(pack.projectId);
        if (version.id !== pack.versionId) {
          updates.push({
            slug: pack.slug,
            name: pack.name,
            current: {
              versionId: pack.versionId,
              versionName: pack.versionName || '',
            },
            latest: {
              versionId: version.id,
              versionName: version.name || version.version_number || '',
            },
          });
        }
      } catch (err) {
        log?.(`Обновление модпака ${pack.name}: ${err.message}`);
      }
    }
    return updates;
  }

  async update(slug, { signal, log, progress } = {}) {
    const pack = this.get(slug);
    if (!pack) throw new Error('Модпак не найден.');
    if (!pack.projectId) throw new Error('У модпака нет projectId Modrinth.');
    const { version } = await this.pickVersion(pack.projectId);
    if (version.id === pack.versionId) {
      return { updated: false, pack };
    }
    const entry = await this.install({
      projectId: pack.projectId,
      versionId: version.id,
      update: true,
      signal,
      log,
      progress,
    });
    return { updated: true, pack: entry, previousVersion: pack.versionName || '' };
  }

  async reinstall(slug, { signal, log, progress } = {}) {
    const pack = this.get(slug);
    if (!pack) throw new Error('Модпак не найден.');
    if (!pack.projectId) throw new Error('У модпака нет projectId Modrinth.');
    const entry = await this.install({
      projectId: pack.projectId,
      versionId: pack.versionId || '',
      update: true,
      signal,
      log,
      progress,
    });
    return entry;
  }

  extractOverrides(zip, instanceDir, prefix) {
    const needle = `${prefix}/`;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      const name = entry.entryName.replace(/\\/g, '/');
      if (!name.startsWith(needle)) continue;
      const rel = normalizeRel(name.slice(needle.length));
      if (!rel) continue;
      const dest = inside(instanceDir, rel);
      if (!dest) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  }

  async remove(slug) {
    const registry = this.readRegistry();
    const entry = registry.packs[slug];
    if (!entry) throw new Error('Модпак не найден.');

    const instanceDir = path.resolve(entry.instanceDir || '');
    const parent = path.dirname(instanceDir);
    const safe =
      path.basename(instanceDir) === slug &&
      path.basename(parent) === 'modpacks' &&
      instanceDir.length > parent.length + 1;
    if (!safe) throw new Error('Небезопасный путь модпака, удаление отменено.');

    await fsp.rm(instanceDir, { recursive: true, force: true });
    delete registry.packs[slug];
    this.saveRegistry();
    return { ok: true };
  }
}

module.exports = { Modpacks, safeSlug, normalizeRel, loaderLabel };
