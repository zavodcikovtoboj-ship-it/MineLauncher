'use strict';

const fs = require('fs');
const path = require('path');

const { parseTarget } = require('./loaders');

/**
 * Resolves any launcher target id into a common shape:
 * vanilla/loader versions, installed modpacks and custom instances.
 */
class Targets {
  constructor({ config, modpacks, instances }) {
    this.config = config;
    this.modpacks = modpacks;
    this.instances = instances;
  }

  baseGameDir() {
    return this.config.get('gameDir');
  }

  resolve(versionId) {
    const id = String(versionId || '');
    if (!id) throw new Error('Цель запуска не выбрана.');
    const target = parseTarget(id);

    if (target.kind === 'modpack') {
      const pack = this.modpacks?.get(target.slug);
      if (!pack) throw new Error(`Модпак «${target.slug}» не установлен.`);
      const instanceDir = path.resolve(pack.instanceDir || path.join(this.baseGameDir(), 'modpacks', target.slug));
      return {
        ...target,
        id,
        kind: 'modpack',
        name: pack.name || target.slug,
        mcVersion: pack.mcVersion,
        loader: pack.loader || 'vanilla',
        loaderVersion: pack.loaderVersion || '',
        instanceDir,
        pack,
        settings: {},
      };
    }

    if (target.kind === 'instance') {
      const instance = this.instances?.get(target.slug);
      if (!instance) throw new Error(`Инстанс «${target.slug}» не найден.`);
      if (!instance.exists) throw new Error(`Папка инстанса «${instance.name}» отсутствует.`);
      return {
        ...target,
        id,
        kind: 'instance',
        name: instance.name || target.slug,
        mcVersion: instance.mcVersion,
        loader: instance.loader || 'vanilla',
        loaderVersion: instance.loaderVersion || '',
        instanceDir: path.resolve(instance.instanceDir),
        instance,
        settings: {
          ramMb: Number(instance.ramMb) || 0,
          jvmArgs: instance.jvmArgs || '',
          javaPath: instance.javaPath || '',
          width: Number(instance.width) || 0,
          height: Number(instance.height) || 0,
          customResolution: Boolean(instance.customResolution),
        },
      };
    }

    if (target.kind !== 'vanilla') {
      return {
        ...target,
        id,
        kind: target.kind,
        name: `${target.kind} ${target.mcVersion}`,
        mcVersion: target.mcVersion,
        loader: target.kind,
        loaderVersion: '',
        instanceDir: this.baseGameDir(),
        settings: {},
      };
    }

    return {
      ...target,
      id,
      kind: 'vanilla',
      name: target.mcVersion,
      mcVersion: target.mcVersion,
      loader: 'vanilla',
      loaderVersion: '',
      instanceDir: this.baseGameDir(),
      settings: {},
    };
  }

  listContentTargets() {
    const options = [];
    for (const instance of this.instances?.list() || []) {
      options.push({
        id: `instance:${instance.slug}`,
        kind: 'instance',
        name: instance.name,
        mcVersion: instance.mcVersion,
        loader: instance.loader || 'vanilla',
        exists: instance.exists,
      });
    }
    for (const pack of this.modpacks?.list() || []) {
      options.push({
        id: `modpack:${pack.slug}`,
        kind: 'modpack',
        name: pack.name,
        mcVersion: pack.mcVersion,
        loader: pack.loader || 'vanilla',
        exists: fs.existsSync(pack.instanceDir || ''),
      });
    }
    return options;
  }

  isManaged(versionId) {
    try {
      const resolved = this.resolve(versionId);
      return resolved.kind === 'instance' || resolved.kind === 'modpack';
    } catch {
      return false;
    }
  }
}

module.exports = { Targets };
