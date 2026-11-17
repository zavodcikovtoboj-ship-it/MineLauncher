'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { fetchJson } = require('./net');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_TTL = 60 * 60 * 1000;

class Mojang {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.manifest = null;
    this.manifestTime = 0;
    this.versionCache = new Map();
    this.indexCache = new Map();
  }

  get manifestFile() {
    return path.join(this.cacheDir, 'version_manifest_v2.json');
  }

  async getManifest({ force = false } = {}) {
    const fresh = this.manifest && Date.now() - this.manifestTime < MANIFEST_TTL;
    if (fresh && !force) return this.manifest;

    if (!force) {
      try {
        const st = await fsp.stat(this.manifestFile);
        if (Date.now() - st.mtimeMs < MANIFEST_TTL) {
          const cached = JSON.parse(await fsp.readFile(this.manifestFile, 'utf8'));
          if (cached && Array.isArray(cached.versions)) {
            this.manifest = cached;
            this.manifestTime = st.mtimeMs;
            return cached;
          }
        }
      } catch {
        // no cache yet
      }
    }

    const manifest = await fetchJson(MANIFEST_URL);
    if (!manifest || !Array.isArray(manifest.versions)) {
      throw new Error('Некорректный манифест версий Mojang');
    }
    this.manifest = manifest;
    this.manifestTime = Date.now();
    await fsp.mkdir(this.cacheDir, { recursive: true });
    await fsp.writeFile(this.manifestFile, JSON.stringify(manifest), 'utf8').catch(() => {});
    return manifest;
  }

  async getVersionJson(url) {
    if (this.versionCache.has(url)) return this.versionCache.get(url);
    const version = await fetchJson(url);
    if (!version || !version.id || !version.mainClass) {
      throw new Error('Некорректный JSON версии');
    }
    this.versionCache.set(url, version);
    return version;
  }

  async getVersionById(id) {
    const manifest = await this.getManifest();
    const entry = manifest.versions.find((v) => v.id === id);
    if (!entry) throw new Error(`Версия ${id} не найдена в манифесте Mojang.`);
    return this.getVersionJson(entry.url);
  }

  async getAssetIndex(url) {
    if (this.indexCache.has(url)) return this.indexCache.get(url);
    const index = await fetchJson(url);
    if (!index || typeof index.objects !== 'object') {
      throw new Error('Некорректный индекс ассетов');
    }
    this.indexCache.set(url, index);
    return index;
  }
}

module.exports = { Mojang, MANIFEST_URL };
