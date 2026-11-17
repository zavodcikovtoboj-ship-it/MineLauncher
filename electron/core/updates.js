'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const { fetchJson, downloadFile } = require('./net');
const { compareVersions } = require('./loaders');

function cleanVersion(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .replace(/[^0-9A-Za-z.+_-].*$/, '');
}

function githubApi(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    return `https://api.github.com/repos/${parts[0]}/${parts[1]}/releases/latest`;
  } catch {
    return '';
  }
}

function extractRelease(data, feed) {
  const release = Array.isArray(data) ? data[0] : data;
  if (!release || typeof release !== 'object') throw new Error('Пустой ответ сервера обновлений.');
  const version = cleanVersion(release.version || release.tag_name || release.name);
  if (!version) throw new Error('В ответе нет версии обновления.');
  let url = release.downloadUrl || release.download_url || '';
  if (!url && Array.isArray(release.assets)) {
    const exe = release.assets.find((item) => /\.exe$/i.test(item.name || item.browser_download_url || ''));
    // Prefer the installer over the portable build: auto-update must replace
    // the installed app, not start a second portable copy.
    const installer = release.assets.find(
      (item) => /\.exe$/i.test(item.name || '') && /(setup|installer|install)/i.test(item.name || '')
    );
    const asset = installer || exe;
    url = asset?.browser_download_url || asset?.url || '';
  }
  if (!url && /^https?:\/\//i.test(release.html_url || '')) {
    url = release.html_url;
  }
  return {
    version,
    url: url ? String(url) : '',
    notes: String(release.notes || release.body || release.changelog || '').slice(0, 20000),
    publishedAt: release.publishedAt || release.published_at || '',
    sha256: String(release.sha256 || ''),
    feed,
  };
}

class Updates {
  constructor({ config, currentVersion, cacheDir }) {
    this.config = config;
    this.currentVersion = cleanVersion(currentVersion);
    this.cacheDir = cacheDir;
    this.downloadDir = path.join(cacheDir, 'updates');
  }

  feedUrl() {
    return String(this.config.get('updateFeedUrl') || '').trim();
  }

  async check() {
    let feed = this.feedUrl();
    if (!feed) throw new Error('Не задан адрес канала обновлений в настройках.');
    if (!/^https:\/\//i.test(feed)) throw new Error('Канал обновлений должен использовать HTTPS.');
    const github = githubApi(feed);
    if (github) feed = github;

    const data = await fetchJson(feed, {
      headers: { Accept: 'application/vnd.github+json' },
      timeout: 20000,
    });
    const release = extractRelease(data, feed);
    const hasUpdate = compareVersions(release.version, this.currentVersion) > 0;
    return {
      ok: true,
      current: this.currentVersion,
      latest: release.version,
      hasUpdate,
      url: release.url,
      notes: release.notes,
      publishedAt: release.publishedAt,
      sha256: release.sha256,
      feed,
    };
  }

  async download(info, { signal, onProgress } = {}) {
    if (!info?.url) throw new Error('В канале обновлений нет ссылки на файл.');
    if (!/^https:\/\//i.test(info.url)) throw new Error('Ссылка на обновление должна использовать HTTPS.');
    const name = path.basename(new URL(info.url).pathname) || `MineLauncher-${info.latest || 'update'}.exe`;
    if (!/\.exe$/i.test(name)) throw new Error('Канал обновлений должен вести на .exe-файл.');
    const dest = path.join(this.downloadDir, name);
    await fsp.mkdir(this.downloadDir, { recursive: true });
    await downloadFile(info.url, dest, {
      signal,
      force: true,
      onBytes: (n) => onProgress?.(n),
    });
    const stat = await fsp.stat(dest);
    return { path: dest, name, size: stat.size };
  }

  async install(filePath) {
    const file = path.resolve(String(filePath || ''));
    const root = path.resolve(this.downloadDir);
    if (!file.startsWith(root + path.sep)) {
      throw new Error('Установщик обновления находится вне папки загрузок лаунчера.');
    }
    if (!/\.exe$/i.test(file)) throw new Error('Ожидался .exe-установщик.');
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error('Файл обновления не найден.');
    const child = spawn(file, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true, path: file };
  }
}

module.exports = { Updates, cleanVersion, githubApi };
