'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const AdmZip = require('adm-zip');

const { DEFAULTS } = require('./config');
const { normalizeRel } = require('./modpacks');

const SECRET_KEYS = new Set(['msRefreshToken', 'msProfile']);

function inside(root, rel) {
  const target = path.resolve(root, ...String(rel).split(/[\\/]+/));
  const base = path.resolve(root);
  return target === base || target.startsWith(base + path.sep) ? target : null;
}

function safeConfig(config) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (SECRET_KEYS.has(key)) continue;
    const value = config.get(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

class Sync {
  constructor({ config, targets, instances }) {
    this.config = config;
    this.targets = targets;
    this.instances = instances;
  }

  async exportSettings(file) {
    const dest = path.resolve(String(file || ''));
    if (!dest) throw new Error('Не выбран файл для экспорта настроек.');
    const payload = {
      format: 'minelauncher-settings',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      launcherVersion: require('../../package.json').version,
      config: safeConfig(this.config),
      instances: this.instances.list().map((instance) => ({
        slug: instance.slug,
        name: instance.name,
        mcVersion: instance.mcVersion,
        loader: instance.loader,
        loaderVersion: instance.loaderVersion,
      })),
      modpacks: this.targets.modpacks.list().map((pack) => ({
        slug: pack.slug,
        name: pack.name,
        mcVersion: pack.mcVersion,
        loader: pack.loader,
        loaderVersion: pack.loaderVersion,
      })),
    };
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: dest };
  }

  async importSettings(file) {
    const source = path.resolve(String(file || ''));
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(source, 'utf8'));
    } catch (err) {
      throw new Error(`Не удалось прочитать файл настроек: ${err.message}`);
    }
    const config = raw?.config && typeof raw.config === 'object' ? raw.config : raw;
    if (!config || typeof config !== 'object') throw new Error('Файл не содержит настроек лаунчера.');
    const patch = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (SECRET_KEYS.has(key)) continue;
      if (config[key] !== undefined && config[key] !== null) patch[key] = config[key];
    }
    if (!Object.keys(patch).length) throw new Error('В файле нет известных настроек.');
    this.config.update(patch);
    return {
      ok: true,
      applied: Object.keys(patch),
      config: safeConfig(this.config),
    };
  }

  target(versionId) {
    const target = this.targets.resolve(versionId);
    if (target.kind !== 'instance' && target.kind !== 'modpack') {
      throw new Error('Синхронизация миров доступна только для инстанса или модпака.');
    }
    return target;
  }

  async exportWorlds(versionId, file) {
    const target = this.target(versionId);
    const saves = path.join(target.instanceDir, 'saves');
    if (!fs.existsSync(saves)) throw new Error('В этом инстансе нет папки saves.');
    const dest = path.resolve(String(file || ''));
    if (!dest) throw new Error('Не выбран файл для экспорта миров.');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const zip = new AdmZip();
    zip.addLocalFolder(saves, 'saves');
    zip.writeZip(dest);
    const stat = await fsp.stat(dest);
    return { ok: true, path: dest, size: stat.size, target: target.name };
  }

  async importWorlds(versionId, file) {
    const target = this.target(versionId);
    const source = path.resolve(String(file || ''));
    if (!fs.existsSync(source)) throw new Error('Архив миров не найден.');
    const zip = new AdmZip(source);
    const saves = path.join(target.instanceDir, 'saves');
    await fsp.mkdir(saves, { recursive: true });
    let restored = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      let rel = normalizeRel(entry.entryName);
      if (!rel) continue;
      if (rel.startsWith('saves/')) rel = rel.slice(6);
      if (!rel) continue;
      const dest = inside(saves, rel);
      if (!dest) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.getData());
      restored++;
    }
    if (!restored) throw new Error('В архиве не найдено файлов миров.');
    return { ok: true, restored, target: target.name };
  }
}

module.exports = { Sync, safeConfig };
