'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const { Transform, Readable } = require('stream');
const { pipeline } = require('stream/promises');

const USER_AGENT = 'MineLauncher/1.0.0 (+https://localhost)';

const network = {
  speedLimitKbps: 0,
  mirrorMode: 'auto', // auto | official | bmclapi
};

let limiterNext = 0;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function configureNetwork(patch = {}) {
  if (patch.speedLimitKbps !== undefined) {
    network.speedLimitKbps = Math.max(0, Number(patch.speedLimitKbps) || 0);
    limiterNext = 0;
  }
  if (patch.mirrorMode && ['auto', 'official', 'bmclapi'].includes(patch.mirrorMode)) {
    network.mirrorMode = patch.mirrorMode;
  }
  return { ...network };
}

function networkSettings() {
  return { ...network };
}

/**
 * Early Electron versions do not expose Chromium networking from Node.
 * net.fetch is used when available so the system/manual proxy configured on
 * the Electron session applies to every download. Node's fetch is the
 * fallback for scripts and tests.
 */
let cachedNetFetch = null;
let netFetchChecked = false;

function httpFetch(url, options) {
  if (!netFetchChecked) {
    netFetchChecked = true;
    try {
      const electron = require('electron');
      if (electron && electron.net && typeof electron.net.fetch === 'function') {
        cachedNetFetch = (...args) => electron.net.fetch(...args);
      }
    } catch {
      // not running inside Electron
    }
  }
  return cachedNetFetch ? cachedNetFetch(url, options) : fetch(url, options);
}

function mirrorUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;

  if (host === 'piston-meta.mojang.com' || host === 'launchermeta.mojang.com' || host === 'piston-data.mojang.com') {
    return `https://bmclapi2.bangbang93.com${parsed.pathname}${parsed.search}`;
  }
  if (host === 'resources.download.minecraft.net') {
    return `https://bmclapi2.bangbang93.com/assets${parsed.pathname}${parsed.search}`;
  }
  if (host === 'libraries.minecraft.net') {
    return `https://bmclapi2.bangbang93.com/maven${parsed.pathname}${parsed.search}`;
  }
  return null;
}

function candidateUrls(url, overrideMode) {
  const mode = overrideMode || network.mirrorMode;
  const mirror = mirrorUrl(url);
  if (!mirror || mode === 'official') return [url];
  if (mode === 'bmclapi') return [mirror, url];
  return [url, mirror];
}

class SpeedLimiter {
  async take(bytes) {
    const kbps = network.speedLimitKbps;
    if (!kbps || !bytes) return;
    const bytesPerMs = (kbps * 1024) / 1000;
    const now = Date.now();
    const start = Math.max(now, limiterNext);
    const wait = start - now;
    limiterNext = start + bytes / bytesPerMs;
    if (wait > 0) await delay(wait);
  }
}

const limiter = new SpeedLimiter();

function abortError() {
  return Object.assign(new Error('Операция отменена.'), { name: 'AbortError' });
}

async function fetchJson(url, { retries = 3, timeout = 30000, headers, mirrorMode } = {}) {
  const text = await fetchText(url, { retries, timeout, headers, mirrorMode });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Некорректный JSON от ${url}`);
  }
}

async function fetchText(url, { retries = 3, timeout = 30000, headers, mirrorMode } = {}) {
  let lastError;
  for (const candidate of candidateUrls(url, mirrorMode)) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await httpFetch(candidate, {
          headers: { 'User-Agent': USER_AGENT, ...(headers || {}) },
          signal: controller.signal,
        });
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status} для ${candidate}`);
          error.status = res.status;
          throw error;
        }
        return await res.text();
      } catch (err) {
        lastError = err;
        if (attempt < retries && err.status !== 404) await delay(400 * (attempt + 1));
        else if (err.status === 404) break;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastError || new Error(`Не удалось загрузить ${url}`);
}

async function fileSize(file) {
  try {
    const st = await fsp.stat(file);
    return st.size;
  } catch {
    return -1;
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function removeQuietly(file) {
  await fsp.rm(file, { force: true }).catch(() => {});
}

/**
 * Downloads url -> dest with resumable .part transfer, aggregate speed limit,
 * SHA-1 verification and mirror fallback.
 */
async function downloadFile(
  url,
  dest,
  { sha1, size, onBytes, signal, retries = 3, force = false, mirrorMode } = {}
) {
  const existing = await fileSize(dest);
  const sizeMatches = size === undefined || size === null || existing === size;
  if (!force && existing >= 0 && sizeMatches && (existing > 0 || size === 0)) {
    onBytes?.(size || 0);
    return { skipped: true, path: dest, resumed: false };
  }

  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError;

  let partSize = await fileSize(part);
  if (partSize < 0) partSize = 0;
  if (size !== undefined && size !== null && partSize > size) {
    await removeQuietly(part);
    partSize = 0;
  }

  // Finish a previous transfer that only missed the final rename.
  if (partSize > 0 && size !== undefined && size !== null && partSize === size) {
    if (!sha1 || (await hashFile(part)) === sha1) {
      await fsp.rename(part, dest);
      onBytes?.(partSize);
      return { skipped: false, path: dest, size: partSize, resumed: true };
    }
    await removeQuietly(part);
    partSize = 0;
  }

  let accounted = 0;
  const countBytes = (n) => {
    accounted += n;
    onBytes?.(n);
  };

  const attemptCandidate = async (candidate, attempt, resumeSize) => {
    const headers = { 'User-Agent': USER_AGENT };
    if (resumeSize > 0) headers.Range = `bytes=${resumeSize}-`;

    const res = await httpFetch(candidate, { headers, signal });
    if (res.status === 416 && size !== null && size !== undefined && resumeSize >= size) {
      return { restart: true };
    }
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} для ${candidate}`);
      error.status = res.status;
      throw error;
    }

    let append = res.status === 206 && resumeSize > 0;
    if (!append && resumeSize > 0) {
      // The server ignored Range. Start the file over.
      await removeQuietly(part);
      resumeSize = 0;
    }

    const hash = crypto.createHash('sha1');
    if (append) {
      for await (const chunk of fs.createReadStream(part)) hash.update(chunk);
    }

    let received = 0;
    const meter = new Transform({
      async transform(chunk, _enc, cb) {
        try {
          await limiter.take(chunk.length);
          if (signal?.aborted) throw abortError();
          hash.update(chunk);
          received += chunk.length;
          countBytes(chunk.length);
          cb(null, chunk);
        } catch (err) {
          cb(err);
        }
      },
    });

    const stream = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
    await pipeline(Readable.fromWeb(res.body), meter, stream);

    const total = resumeSize + received;
    if (size !== undefined && size !== null && total !== size) {
      throw new Error(`Размер не совпал: ${total} != ${size} (${candidate})`);
    }
    if (sha1 && hash.digest('hex') !== sha1) {
      await removeQuietly(part);
      throw new Error(`SHA1 не совпал: ${candidate}`);
    }

    await fsp.rename(part, dest);
    return { skipped: false, path: dest, size: total, resumed: resumeSize > 0 };
  };

  for (const candidate of candidateUrls(url, mirrorMode)) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (signal?.aborted) throw abortError();
        // Every retry re-reads the .part size: a partially failed stream can
        // be resumed instead of downloading the beginning again.
        let resumeSize = await fileSize(part);
        if (resumeSize < 0) resumeSize = 0;
        if (size !== undefined && size !== null && resumeSize >= size) {
          await removeQuietly(part);
          resumeSize = 0;
        }
        const result = await attemptCandidate(candidate, attempt, resumeSize);
        if (result.restart) {
          await removeQuietly(part);
          continue;
        }
        return { ...result, accounted };
      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        if (err.message?.startsWith('SHA1') || err.message?.startsWith('Размер')) {
          await removeQuietly(part);
        }
        if (attempt < retries && err.status !== 404) await delay(500 * (attempt + 1));
        else if (err.status === 404) break;
      }
    }
  }
  throw lastError || new Error(`Не удалось скачать ${url}`);
}

class Progress {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.total = 0;
    this.done = 0;
    this.file = '';
    this.lastEmit = 0;
    this.stage = '';
  }

  setStage(stage) {
    this.stage = stage;
    this.done = 0;
    this.total = 0;
    this.file = '';
    this.emit(true);
  }

  addTotal(bytes) {
    this.total += bytes || 0;
  }

  setTotal(bytes) {
    this.total = bytes || 0;
  }

  add(bytes) {
    this.done += bytes || 0;
    this.emit(false);
  }

  setFile(name) {
    this.file = name;
    this.emit(false);
  }

  emit(force) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    const percent = this.total > 0 ? Math.min(100, (this.done / this.total) * 100) : 0;
    this.onUpdate?.({
      stage: this.stage,
      done: this.done,
      total: this.total,
      percent,
      file: this.file,
    });
  }
}

/**
 * Runs async tasks with bounded concurrency.
 * Stops scheduling new work after the first failure, waits for in-flight tasks.
 */
async function runPool(tasks, concurrency = 8) {
  let index = 0;
  let firstError = null;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (true) {
      if (firstError) return;
      const current = index++;
      if (current >= tasks.length) return;
      try {
        await tasks[current]();
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  });

  await Promise.all(workers);
  if (firstError) throw firstError;
}

async function probe(url, { timeout = 8000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let host = '';
  let ip = '';
  try {
    host = new URL(url).hostname;
    const addresses = await dns.lookup(host, { all: true }).catch(() => []);
    ip = addresses[0]?.address || '';
  } catch {
    // malformed URL is reported below
  }
  try {
    const res = await httpFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-64' },
      signal: controller.signal,
    });
    return {
      url,
      host,
      ip,
      ok: res.ok || res.status === 206,
      status: res.status,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      url,
      host,
      ip,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err.name === 'AbortError' ? 'Таймаут' : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function diagnose(targets = []) {
  const list = targets.length
    ? targets
    : [
        { name: 'Mojang', url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json' },
        { name: 'Modrinth', url: 'https://api.modrinth.com/v2/search?limit=1' },
        { name: 'Fabric Meta', url: 'https://meta.fabricmc.net/v2/versions/loader' },
        { name: 'Forge Maven', url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' },
        {
          name: 'NeoForge (CreeperHost)',
          url: 'https://maven.creeperhost.net/net/neoforged/neoforge/maven-metadata.xml',
        },
        { name: 'BMCLAPI (зеркало)', url: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json' },
      ];
  const results = await Promise.all(list.map(async (item) => ({ name: item.name, ...(await probe(item.url)) })));
  return results;
}

module.exports = {
  fetchJson,
  fetchText,
  downloadFile,
  Progress,
  runPool,
  delay,
  diagnose,
  probe,
  configureNetwork,
  networkSettings,
  mirrorUrl,
  candidateUrls,
  USER_AGENT,
};
