'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugify(value) {
  const text = String(value || '')
    .toLowerCase()
    .split('')
    .map((char) => TRANSLIT[char] ?? char)
    .join('')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return text || 'instance';
}

function safeRelative(value) {
  const rel = String(value || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split('/').filter((part) => part !== '');
  if (parts.some((part) => part === '..' || part === '.')) return null;
  return parts.join('/');
}

function inside(root, rel) {
  const target = path.resolve(root, ...String(rel).split('/'));
  const base = path.resolve(root);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

function cleanSettings(patch = {}) {
  const out = {};
  if (patch.name !== undefined) out.name = String(patch.name).trim().slice(0, 48) || 'Инстанс';
  for (const key of ['mcVersion', 'loader', 'loaderVersion', 'jvmArgs', 'javaPath', 'notes']) {
    if (patch[key] !== undefined) out[key] = String(patch[key] ?? '').slice(0, 4096);
  }
  if (patch.loader && !['vanilla', 'fabric', 'forge', 'neoforge'].includes(patch.loader)) {
    out.loader = 'vanilla';
  }
  for (const key of ['ramMb', 'width', 'height']) {
    if (patch[key] !== undefined) out[key] = Math.max(0, Number(patch[key]) || 0);
  }
  if (patch.customResolution !== undefined) out.customResolution = Boolean(patch.customResolution);
  return out;
}

class Instances {
  constructor({ config, registryFile }) {
    this.config = config;
    this.registryFile = registryFile;
    this._registry = null;
  }

  root() {
    return path.join(this.config.get('gameDir'), 'instances');
  }

  readRegistry() {
    if (this._registry) return this._registry;
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      this._registry = { instances: raw?.instances || {} };
    } catch {
      this._registry = { instances: {} };
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

  uniqueSlug(base) {
    const registry = this.readRegistry();
    const root = this.root();
    let slug = slugify(base);
    let index = 2;
    while (registry.instances[slug] || fs.existsSync(path.join(root, slug))) {
      slug = `${slugify(base)}-${index++}`;
    }
    return slug;
  }

  list() {
    const registry = this.readRegistry();
    const root = this.root();
    return Object.values(registry.instances)
      .map((entry) => ({
        ...entry,
        instanceDir: path.join(root, entry.slug),
        exists: fs.existsSync(path.join(root, entry.slug)),
      }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  get(slug) {
    const entry = this.readRegistry().instances[slug];
    if (!entry) return null;
    const instanceDir = path.join(this.root(), slug);
    return { ...entry, instanceDir, exists: fs.existsSync(instanceDir) };
  }

  async create(patch = {}) {
    const clean = cleanSettings(patch);
    if (!clean.mcVersion) throw new Error('Выберите версию Minecraft.');
    const slug = this.uniqueSlug(clean.name || clean.mcVersion);
    const instanceDir = path.join(this.root(), slug);
    await fsp.mkdir(instanceDir, { recursive: true });

    const meta = {
      slug,
      name: clean.name || `Инстанс ${clean.mcVersion}`,
      mcVersion: clean.mcVersion,
      loader: clean.loader || 'vanilla',
      loaderVersion: clean.loaderVersion || '',
      ramMb: clean.ramMb ?? 0,
      jvmArgs: clean.jvmArgs || '',
      javaPath: clean.javaPath || '',
      width: clean.width || 0,
      height: clean.height || 0,
      customResolution: Boolean(clean.customResolution),
      notes: clean.notes || '',
      createdAt: new Date().toISOString(),
      format: 1,
    };
    await fsp.writeFile(path.join(instanceDir, 'instance.json'), JSON.stringify(meta, null, 2), 'utf8');

    const registry = this.readRegistry();
    registry.instances[slug] = meta;
    this.saveRegistry();
    return { ...meta, instanceDir, exists: true };
  }

  async update(slug, patch = {}) {
    const entry = this.get(slug);
    if (!entry) throw new Error('Инстанс не найден.');
    const clean = cleanSettings(patch);
    delete clean.mcVersion;
    delete clean.loader;
    delete clean.loaderVersion;
    const next = { ...entry, ...clean };
    if (clean.name) next.name = clean.name;
    const meta = {
      slug: next.slug,
      name: next.name,
      mcVersion: next.mcVersion,
      loader: next.loader,
      loaderVersion: next.loaderVersion,
      ramMb: next.ramMb || 0,
      jvmArgs: next.jvmArgs || '',
      javaPath: next.javaPath || '',
      width: next.width || 0,
      height: next.height || 0,
      customResolution: Boolean(next.customResolution),
      notes: next.notes || '',
      createdAt: next.createdAt || new Date().toISOString(),
      format: 1,
    };
    await fsp.mkdir(entry.instanceDir, { recursive: true });
    await fsp.writeFile(path.join(entry.instanceDir, 'instance.json'), JSON.stringify(meta, null, 2), 'utf8');
    const registry = this.readRegistry();
    registry.instances[slug] = meta;
    this.saveRegistry();
    return { ...meta, instanceDir: entry.instanceDir, exists: true };
  }

  async remove(slug) {
    const entry = this.get(slug);
    if (!entry) throw new Error('Инстанс не найден.');
    const root = path.resolve(this.root());
    const dir = path.resolve(entry.instanceDir);
    if (path.dirname(dir) !== root || path.basename(dir) !== slug) {
      throw new Error('Небезопасный путь инстанса, удаление отменено.');
    }
    await fsp.rm(dir, { recursive: true, force: true });
    const registry = this.readRegistry();
    delete registry.instances[slug];
    this.saveRegistry();
    return { ok: true };
  }

  async export(slug, destFile) {
    const entry = this.get(slug);
    if (!entry) throw new Error('Инстанс не найден.');
    if (!fs.existsSync(entry.instanceDir)) throw new Error('Папка инстанса отсутствует.');
    const dest = path.resolve(destFile);
    if (dest.startsWith(path.resolve(entry.instanceDir) + path.sep)) {
      throw new Error('Нельзя сохранить архив внутрь экспортируемого инстанса.');
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const zip = new AdmZip();
    zip.addLocalFolder(entry.instanceDir, '');
    zip.writeZip(dest);
    const st = await fsp.stat(dest);
    return { ok: true, path: dest, size: st.size };
  }

  async import(zipPath, { name } = {}) {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const metaEntry = entries.find((entry) => {
      const rel = safeRelative(entry.entryName);
      return rel && rel.split('/').length <= 2 && rel.endsWith('instance.json');
    });
    if (!metaEntry) throw new Error('В архиве нет instance.json — это не экспорт инстанса.');

    const metaRel = safeRelative(metaEntry.entryName);
    const prefix = metaRel.includes('/') ? `${metaRel.slice(0, metaRel.lastIndexOf('/'))}/` : '';
    let meta;
    try {
      meta = JSON.parse(metaEntry.getData().toString('utf8'));
    } catch {
      throw new Error('instance.json в архиве повреждён.');
    }
    if (!meta.mcVersion) throw new Error('В архиве не указана версия Minecraft.');

    const displayName = String(name || meta.name || 'Импорт').trim().slice(0, 48);
    const slug = this.uniqueSlug(displayName || meta.mcVersion);
    const instanceDir = path.join(this.root(), slug);
    await fsp.mkdir(instanceDir, { recursive: true });

    for (const entry of entries) {
      let rel = safeRelative(entry.entryName);
      if (!rel || prefix && !rel.startsWith(prefix)) continue;
      if (prefix) rel = rel.slice(prefix.length);
      if (!rel || rel === 'instance.json') continue;
      const dest = inside(instanceDir, rel);
      if (!dest) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.getData());
    }

    const nextMeta = {
      slug,
      name: displayName || meta.name || slug,
      mcVersion: String(meta.mcVersion),
      loader: ['vanilla', 'fabric', 'forge', 'neoforge'].includes(meta.loader) ? meta.loader : 'vanilla',
      loaderVersion: String(meta.loaderVersion || ''),
      ramMb: Math.max(0, Number(meta.ramMb) || 0),
      jvmArgs: String(meta.jvmArgs || ''),
      javaPath: String(meta.javaPath || ''),
      width: Math.max(0, Number(meta.width) || 0),
      height: Math.max(0, Number(meta.height) || 0),
      customResolution: Boolean(meta.customResolution),
      notes: String(meta.notes || ''),
      createdAt: new Date().toISOString(),
      importedAt: new Date().toISOString(),
      format: 1,
    };
    await fsp.writeFile(path.join(instanceDir, 'instance.json'), JSON.stringify(nextMeta, null, 2), 'utf8');
    const registry = this.readRegistry();
    registry.instances[slug] = nextMeta;
    this.saveRegistry();
    return { ...nextMeta, instanceDir, exists: true };
  }

  resolve(slug) {
    const entry = this.get(slug);
    if (!entry) throw new Error(`Инстанс «${slug}» не найден.`);
    if (!entry.exists) throw new Error(`Папка инстанса «${entry.name}» отсутствует.`);
    return entry;
  }
}

module.exports = { Instances, slugify, safeRelative, inside };
