'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const { fetchJson, downloadFile } = require('./net');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const KIND_INFO = {
  mods: { projectType: 'mod', dir: 'mods', extensions: ['.jar'] },
  resourcepacks: { projectType: 'resourcepack', dir: 'resourcepacks', extensions: ['.zip'] },
  shaders: { projectType: 'shader', dir: 'shaderpacks', extensions: ['.zip'] },
};
const LOADER_KEYS = { fabric: 'fabric', forge: 'forge', neoforge: 'neoforge' };
const BUILTIN_DEPENDENCIES = new Set(['minecraft', 'java', 'fabricloader', 'fabric_loader', 'forge', 'neoforge']);

function safeName(value, fallback = 'file') {
  const base = path.basename(String(value || '')).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : fallback;
}

function inside(root, rel) {
  const target = path.resolve(root, ...String(rel).split(/[\\/]+/));
  const base = path.resolve(root);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

async function sha1File(file) {
  const hash = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function parseFabricMeta(zip) {
  const entry = zip.getEntry('fabric.mod.json');
  if (!entry) return null;
  try {
    const data = JSON.parse(entry.getData().toString('utf8'));
    return {
      loader: 'fabric',
      id: String(data.id || ''),
      name: String(data.name || data.id || ''),
      version: String(data.version || ''),
      depends: Object.keys(data.depends || {}),
      breaks: Object.keys(data.breaks || {}),
    };
  } catch {
    return null;
  }
}

function parseTomlValue(text, key) {
  const match = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'm'));
  return match ? match[1] ?? match[2] ?? '' : '';
}

function parseForgeMeta(zip) {
  const entry = zip.getEntry('META-INF/neoforge.mods.toml') || zip.getEntry('META-INF/mods.toml');
  if (!entry) return null;
  try {
    const text = entry.getData().toString('utf8');
    const modId = parseTomlValue(text, 'modId');
    if (!modId) return null;
    const depends = [];
    const mandatory = new Set();
    const depRe = /\[\[dependencies(?:\.[^\]]+)?\]\]([\s\S]*?)(?=\n\[\[|\s*$)/g;
    let match;
    while ((match = depRe.exec(text))) {
      const block = match[1];
      const depId = parseTomlValue(block, 'modId');
      const isMandatory = /mandatory\s*=\s*true/.test(block);
      if (depId && isMandatory) mandatory.add(depId);
      if (depId) depends.push(depId);
    }
    return {
      loader: 'forge',
      id: modId,
      name: parseTomlValue(text, 'displayName') || modId,
      version: parseTomlValue(text, 'version'),
      depends: [...new Set([...depends, ...mandatory])],
      mandatory: [...mandatory],
      breaks: [],
    };
  } catch {
    return null;
  }
}

function readModMeta(file) {
  try {
    const zip = new AdmZip(file);
    const fabric = parseFabricMeta(zip);
    const forge = parseForgeMeta(zip);
    if (fabric && forge) return { ...fabric, loader: 'fabric+forge', forge };
    if (fabric) return fabric;
    if (forge) return forge;
    return {
      loader: 'unknown',
      id: path.basename(file, path.extname(file)).toLowerCase(),
      name: path.basename(file),
      version: '',
      depends: [],
      breaks: [],
    };
  } catch {
    return null;
  }
}

function inferKindFromZip(file) {
  try {
    const zip = new AdmZip(file);
    const names = zip.getEntries().map((entry) => entry.entryName.replace(/\\/g, '/'));
    if (names.some((name) => name.startsWith('shaders/'))) return 'shaders';
    if (names.includes('pack.mcmeta')) return 'resourcepacks';
    return 'resourcepacks';
  } catch {
    return 'resourcepacks';
  }
}

function compareVersions(a, b) {
  const left = String(a || '').split(/[.-]/);
  const right = String(b || '').split(/[.-]/);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = Number(l);
    const rn = Number(r);
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln - rn;
    } else if (l !== r) {
      return l.localeCompare(r, 'en');
    }
  }
  return 0;
}

class Content {
  constructor({ targets, log }) {
    this.targets = targets;
    this.log = log || (() => {});
    this.projectCache = new Map();
    this.versionCache = new Map();
  }

  target(versionId) {
    const info = this.targets.resolve(versionId);
    return {
      ...info,
      targetId: versionId,
      contentFile: path.join(info.instanceDir, 'content.json'),
      contentRoot: info.instanceDir,
    };
  }

  read(target) {
    try {
      const raw = JSON.parse(fs.readFileSync(target.contentFile, 'utf8'));
      const items = Array.isArray(raw?.items) ? raw.items : [];
      return { version: 1, items: items.filter((item) => item && item.kind && item.relPath) };
    } catch {
      return { version: 1, items: [] };
    }
  }

  write(target, data) {
    fs.mkdirSync(path.dirname(target.contentFile), { recursive: true });
    const tmp = `${target.contentFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, target.contentFile);
  }

  async project(projectId, { force = false } = {}) {
    const key = String(projectId);
    const cached = this.projectCache.get(key);
    if (!force && cached && Date.now() - cached.time < 10 * 60 * 1000) return cached.value;
    const value = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(key)}`);
    this.projectCache.set(key, { time: Date.now(), value });
    return value;
  }

  async projectVersions(projectId, { force = false } = {}) {
    const key = String(projectId);
    const cached = this.versionCache.get(key);
    if (!force && cached && Date.now() - cached.time < 5 * 60 * 1000) return cached.value;
    const value = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(key)}/version`);
    if (!Array.isArray(value)) throw new Error('Modrinth вернул некорректный список версий.');
    this.versionCache.set(key, { time: Date.now(), value });
    return value;
  }

  compatibleVersions(versions, target, kind) {
    const mc = target.mcVersion;
    const loader = LOADER_KEYS[target.loader];
    return versions
      .filter((version) => {
        const games = version.game_versions || [];
        if (mc && games.length && !games.includes(mc)) return false;
        if (kind === 'mods' && loader) {
          const loaders = (version.loaders || []).map((item) => String(item).toLowerCase());
          if (loaders.length && !loaders.includes(loader)) return false;
        }
        return true;
      })
      .sort((a, b) => new Date(b.date_published || 0) - new Date(a.date_published || 0));
  }

  primaryFile(version) {
    const files = version?.files || [];
    return files.find((file) => file.primary) || files[0] || null;
  }

  async latestCompatible(projectId, target, kind, { force = false } = {}) {
    const versions = await this.projectVersions(projectId, { force });
    return this.compatibleVersions(versions, target, kind)[0] || null;
  }

  async search({ targetId, kind = 'mods', query = '', limit = 16 }) {
    const info = KIND_INFO[kind];
    if (!info) throw new Error('Неизвестный тип контента.');
    const target = this.target(targetId);
    const params = new URLSearchParams();
    params.set('query', String(query || ''));
    params.set('limit', String(Math.min(30, Math.max(1, Number(limit) || 16))));
    params.set('index', query ? 'relevance' : 'downloads');
    const facets = [[`project_type:${info.projectType}`], [`versions:${target.mcVersion}`]];
    if (kind === 'mods' && LOADER_KEYS[target.loader]) {
      facets.push([`categories:${LOADER_KEYS[target.loader]}`]);
    }
    params.set('facets', JSON.stringify(facets));
    const data = await fetchJson(`${MODRINTH_API}/search?${params.toString()}`);
    return (data.hits || []).map((hit) => ({
      projectId: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      description: hit.description,
      iconUrl: hit.icon_url || '',
      downloads: hit.downloads || 0,
      follows: hit.follows || 0,
      categories: hit.categories || [],
      versions: hit.versions || [],
    }));
  }

  uniqueRelPath(target, kind, filename, existingItem) {
    const dir = KIND_INFO[kind].dir;
    const clean = safeName(filename);
    const data = this.read(target);
    const taken = new Set(
      data.items
        .filter((item) => item.kind === kind && item.relPath !== existingItem?.relPath)
        .map((item) => item.relPath.toLowerCase())
    );
    const ext = path.extname(clean);
    const base = clean.slice(0, clean.length - ext.length);
    let candidate = `${dir}/${clean}`;
    let index = 2;
    while (
      taken.has(candidate.toLowerCase()) ||
      (fs.existsSync(inside(target.contentRoot, candidate)) &&
        candidate.toLowerCase() !== String(existingItem?.relPath || '').toLowerCase())
    ) {
      candidate = `${dir}/${base}-${index++}${ext}`;
    }
    return candidate;
  }

  register(target, item) {
    const data = this.read(target);
    data.items = data.items.filter(
      (entry) => !(entry.kind === item.kind && entry.key === item.key)
    );
    data.items.push(item);
    this.write(target, data);
    return item;
  }

  async install({
    targetId,
    kind = 'mods',
    projectId,
    versionId = null,
    withDependencies = true,
    signal,
    progress,
    log,
    visited = new Set(),
    depth = 0,
  }) {
    const info = KIND_INFO[kind];
    if (!info) throw new Error('Неизвестный тип контента.');
    if (!projectId) throw new Error('Не выбран проект Modrinth.');
    if (depth > 8) throw new Error('Слишком глубокая цепочка зависимостей.');
    const visitKey = `${kind}:${projectId}`;
    if (visited.has(visitKey)) return { skippedDependency: true };
    visited.add(visitKey);

    const target = this.target(targetId);
    const project = await this.project(projectId);
    let version = null;
    if (versionId) {
      const versions = await this.projectVersions(projectId);
      version = versions.find((item) => item.id === versionId) || null;
    }
    if (!version) {
      version = await this.latestCompatible(projectId, target, kind);
    }
    if (!version) {
      throw new Error(`Для «${project.title || project.slug}» нет версии под Minecraft ${target.mcVersion}.`);
    }
    const file = this.primaryFile(version);
    if (!file?.url) throw new Error(`У версии «${project.title || project.slug}» нет файла для скачивания.`);

    const data = this.read(target);
    const existing = data.items.find((item) => item.kind === kind && item.projectId === projectId) || null;
    const relPath = this.uniqueRelPath(target, kind, file.filename || `${project.slug}.jar`, existing);
    const dest = inside(target.contentRoot, relPath);
    if (!dest) throw new Error('Небезопасный путь файла контента.');
    await fsp.mkdir(path.dirname(dest), { recursive: true });

    if (existing && existing.relPath !== relPath) {
      const old = inside(target.contentRoot, existing.relPath);
      if (old && old !== dest) await fsp.rm(old, { force: true }).catch(() => {});
    }

    progress?.setStage?.('content');
    progress?.setFile?.(relPath);
    progress?.setTotal?.((progress.total || 0) + (file.size || 0));
    log?.(`Загрузка ${kind}: ${project.title || project.slug} ${version.version_number || ''}`);
    await downloadFile(file.url, dest, {
      sha1: file.hashes?.sha1,
      size: file.size,
      signal,
      force: true,
      onBytes: (n) => progress?.add?.(n),
    });

    const dependencies = [];
    for (const dependency of version.dependencies || []) {
      if (dependency.dependency_type !== 'required' || !dependency.project_id) continue;
      dependencies.push({
        projectId: dependency.project_id,
        versionId: dependency.version_id || null,
      });
      if (!withDependencies) continue;
      try {
        await this.install({
          targetId,
          kind,
          projectId: dependency.project_id,
          versionId: dependency.version_id || null,
          withDependencies: true,
          signal,
          progress,
          log,
          visited,
          depth: depth + 1,
        });
      } catch (err) {
        log?.(`Зависимость ${dependency.project_id}: ${err.message}`);
        throw new Error(
          `Не удалось установить зависимость для «${project.title || project.slug}»: ${err.message}`
        );
      }
    }

    const item = {
      key: `${kind}:${projectId}`,
      kind,
      projectId,
      slug: project.slug || projectId,
      title: project.title || project.slug || projectId,
      iconUrl: project.icon_url || '',
      versionId: version.id,
      versionName: version.version_number || version.name || '',
      filename: path.basename(relPath),
      relPath,
      url: file.url,
      sha1: file.hashes?.sha1 || '',
      size: file.size || 0,
      source: 'modrinth',
      installedAt: new Date().toISOString(),
      dependencies,
    };
    this.register(target, item);
    return { item, target, project, version };
  }

  list({ targetId }) {
    const target = this.target(targetId);
    const data = this.read(target);
    const items = data.items.map((item) => {
      const file = inside(target.contentRoot, item.relPath);
      return { ...item, exists: Boolean(file && fs.existsSync(file)) };
    });
    return { target, items };
  }

  async remove({ targetId, key }) {
    const target = this.target(targetId);
    const data = this.read(target);
    const item = data.items.find((entry) => entry.key === key);
    if (!item) throw new Error('Элемент контента не найден.');
    const file = inside(target.contentRoot, item.relPath);
    if (file) await fsp.rm(file, { force: true }).catch(() => {});
    data.items = data.items.filter((entry) => entry.key !== key);
    this.write(target, data);
    return { ok: true, item };
  }

  async checkUpdates({ targetId, signal, log }) {
    const target = this.target(targetId);
    const data = this.read(target);
    const remote = data.items.filter((item) => item.source === 'modrinth' && item.projectId);
    const updates = [];
    let index = 0;
    const worker = async () => {
      while (index < remote.length) {
        if (signal?.aborted) throw Object.assign(new Error('Отменено'), { name: 'AbortError' });
        const item = remote[index++];
        try {
          const latest = await this.latestCompatible(item.projectId, target, item.kind, { force: true });
          if (latest && latest.id !== item.versionId) {
            updates.push({
              key: item.key,
              item,
              latest: {
                versionId: latest.id,
                versionName: latest.version_number || latest.name || '',
                file: this.primaryFile(latest),
              },
            });
          }
        } catch (err) {
          log?.(`Проверка обновлений ${item.title}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, remote.length) }, worker));
    return updates;
  }

  async update({ targetId, key, signal, progress, log }) {
    const target = this.target(targetId);
    const data = this.read(target);
    const item = data.items.find((entry) => entry.key === key);
    if (!item) throw new Error('Элемент контента не найден.');
    const latest = await this.latestCompatible(item.projectId, target, item.kind, { force: true });
    if (!latest) throw new Error(`Нет совместимого обновления для «${item.title}».`);
    const result = await this.install({
      targetId,
      kind: item.kind,
      projectId: item.projectId,
      versionId: latest.id,
      withDependencies: false,
      signal,
      progress,
      log,
    });
    return result;
  }

  listFiles(target, kind) {
    const dir = path.join(target.contentRoot, KIND_INFO[kind].dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        relPath: `${KIND_INFO[kind].dir}/${entry.name}`,
        file: path.join(dir, entry.name),
        size: fs.statSync(path.join(dir, entry.name)).size,
      }));
  }

  conflicts({ targetId }) {
    const target = this.target(targetId);
    const data = this.read(target);
    const trackedByRel = new Map(data.items.map((item) => [item.relPath.toLowerCase(), item]));
    const report = {
      target: { id: target.targetId, name: target.name, mcVersion: target.mcVersion, loader: target.loader },
      conflicts: [],
      duplicates: [],
      missing: [],
      untracked: [],
      mods: [],
      files: 0,
    };

    for (const kind of Object.keys(KIND_INFO)) {
      const files = this.listFiles(target, kind);
      report.files += files.length;
      const byName = new Map();
      for (const file of files) {
        const lower = file.name.toLowerCase();
        if (!byName.has(lower)) byName.set(lower, []);
        byName.get(lower).push(file);
        if (!trackedByRel.has(file.relPath.toLowerCase()) && kind === 'mods') {
          report.untracked.push({ kind, relPath: file.relPath, name: file.name });
        }
      }
      for (const group of byName.values()) {
        if (group.length > 1) {
          report.duplicates.push({
            kind,
            name: group[0].name,
            count: group.length,
            message: `Несколько файлов с одинаковым именем в ${KIND_INFO[kind].dir}.`,
          });
        }
      }
    }

    for (const item of data.items) {
      const file = inside(target.contentRoot, item.relPath);
      if (!file || !fs.existsSync(file)) {
        report.missing.push({
          key: item.key,
          kind: item.kind,
          title: item.title,
          relPath: item.relPath,
          message: `Файл не найден: ${item.relPath}`,
        });
      }
    }

    const mods = new Map();
    for (const file of this.listFiles(target, 'mods')) {
      const meta = readModMeta(file.file);
      const tracked = trackedByRel.get(file.relPath.toLowerCase()) || null;
      const info = {
        file: file.name,
        relPath: file.relPath,
        id: meta?.id || file.name.toLowerCase(),
        name: meta?.name || file.name,
        version: meta?.version || '',
        loader: meta?.loader || 'unknown',
        tracked: Boolean(tracked),
      };
      mods.set(info.id, { ...info, meta });
      report.mods.push(info);
    }

    for (const mod of report.mods) {
      if (!mod.meta) continue;
      if (target.loader === 'fabric' && mod.loader === 'forge') {
        report.conflicts.push({
          severity: 'error',
          type: 'loader',
          file: mod.file,
          message: `「${mod.name}」 — мод Forge/NeoForge, а инстанс использует Fabric.`,
        });
      }
      if ((target.loader === 'forge' || target.loader === 'neoforge') && mod.loader === 'fabric') {
        report.conflicts.push({
          severity: 'error',
          type: 'loader',
          file: mod.file,
          message: `«${mod.name}» — мод Fabric, а инстанс использует ${target.loader}.`,
        });
      }
      for (const dependency of mod.meta.depends || []) {
        if (BUILTIN_DEPENDENCIES.has(String(dependency).toLowerCase())) continue;
        if (!mods.has(dependency)) {
          report.conflicts.push({
            severity: 'error',
            type: 'dependency',
            file: mod.file,
            message: `«${mod.name}» требует отсутствующий мод «${dependency}».`,
          });
        }
      }
      for (const broken of mod.meta.breaks || []) {
        if (mods.has(broken)) {
          report.conflicts.push({
            severity: 'error',
            type: 'break',
            file: mod.file,
            message: `«${mod.name}» несовместим с «${mods.get(broken).name}».`,
          });
        }
      }
    }

    if (report.untracked.length) {
      report.conflicts.push({
        severity: 'warn',
        type: 'untracked',
        message: `Файлов вне учёта лаунчера: ${report.untracked.length}. Они не обновляются автоматически.`,
      });
    }

    report.ok = !report.conflicts.some((item) => item.severity === 'error') && !report.duplicates.length;
    return report;
  }

  async importLocal({ targetId, kind, filePath, log }) {
    const source = path.resolve(String(filePath || ''));
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat) throw new Error('Файл не найден.');
    const resolvedTarget = this.target(targetId);
    let actualKind = kind;
    if (!actualKind) {
      const ext = path.extname(source).toLowerCase();
      if (ext === '.jar') actualKind = 'mods';
      else if (stat.isDirectory()) actualKind = 'resourcepacks';
      else actualKind = inferKindFromZip(source);
    }
    const info = KIND_INFO[actualKind];
    if (!info) throw new Error('Неизвестный тип контента.');
    if (stat.isFile() && info.extensions.length && !info.extensions.includes(path.extname(source).toLowerCase())) {
      throw new Error(`Для «${actualKind}» нужен файл ${info.extensions.join(' / ')}.`);
    }

    const dir = path.join(resolvedTarget.contentRoot, info.dir);
    await fsp.mkdir(dir, { recursive: true });
    let name = safeName(source);
    let dest = path.join(dir, name);
    let index = 2;
    while (fs.existsSync(dest)) {
      const ext = path.extname(name);
      dest = path.join(dir, `${name.slice(0, name.length - ext.length)}-${index++}${ext}`);
    }
    if (stat.isDirectory()) {
      await fsp.cp(source, dest, { recursive: true, force: false });
    } else {
      await fsp.copyFile(source, dest);
    }
    const relPath = `${info.dir}/${path.basename(dest)}`;
    let meta = stat.isFile() ? readModMeta(dest) : null;
    const item = {
      key: `${actualKind}:local:${relPath}`,
      kind: actualKind,
      projectId: null,
      slug: '',
      title: meta?.name || path.basename(dest),
      iconUrl: '',
      versionId: '',
      versionName: meta?.version || '',
      filename: path.basename(dest),
      relPath,
      url: '',
      sha1: stat.isFile() ? await sha1File(dest) : '',
      size: stat.isFile() ? (await fsp.stat(dest)).size : 0,
      source: 'local',
      installedAt: new Date().toISOString(),
      dependencies: [],
    };
    this.register(resolvedTarget, item);
    log?.(`Импортирован локальный файл: ${relPath}`);
    return { item, target: resolvedTarget };
  }

  async details(projectId) {
    const project = await this.project(projectId);
    return {
      projectId: project.id,
      slug: project.slug,
      title: project.title,
      description: project.description,
      body: project.body || '',
      iconUrl: project.icon_url || '',
      downloads: project.downloads || 0,
      categories: project.categories || [],
      sourceUrl: project.source_url || '',
      issuesUrl: project.issues_url || '',
    };
  }
}

module.exports = {
  Content,
  KIND_INFO,
  readModMeta,
  compareVersions,
  safeName,
};
