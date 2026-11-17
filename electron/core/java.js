'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawnSync } = require('child_process');
const { fetchJson, downloadFile, runPool } = require('./net');

const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

const COMPONENT_BY_MAJOR = {
  8: 'jre-legacy',
  16: 'java-runtime-alpha',
  17: 'java-runtime-beta',
  21: 'java-runtime-delta',
  25: 'java-runtime-epsilon',
};

function platformKey() {
  if (process.arch === 'ia32') return 'windows-x86';
  if (process.arch === 'arm64') return 'windows-arm64';
  return 'windows-x64';
}

function readJavaMajor(javaPath) {
  if (!javaPath || !fs.existsSync(javaPath)) return null;
  const res = spawnSync(javaPath, ['-version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  const match = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  const major = Number(match[1]) === 1 ? Number(match[2]) : Number(match[1]);
  return Number.isFinite(major) ? major : null;
}

function scanRuntimeDir(gameDir) {
  const out = [];
  const runtimeDir = path.join(gameDir, 'runtime');
  let components = [];
  try {
    components = fs.readdirSync(runtimeDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const component of components) {
    if (!component.isDirectory()) continue;
    const platformDir = path.join(runtimeDir, component.name, platformKey());
    const platformExe = path.join(platformDir, 'bin', 'java.exe');
    if (fs.existsSync(platformExe)) {
      out.push(platformExe);
      continue;
    }
    // Older layouts put bin/ directly under the component directory.
    const legacyExe = path.join(runtimeDir, component.name, 'bin', 'java.exe');
    if (fs.existsSync(legacyExe)) out.push(legacyExe);
  }
  return out;
}

function scanProgramFiles() {
  const out = [];
  const bases = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Amazon Corretto',
    'C:\\Program Files\\Semeru',
    'C:\\Program Files\\RedHat',
    'C:\\Program Files\\SapMachine',
    'C:\\Program Files\\JetBrains\\Runtime',
  ];
  for (const base of bases) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const exe = path.join(base, dir.name, 'bin', 'java.exe');
      if (fs.existsSync(exe)) out.push(exe);
    }
  }
  return out;
}

function scanPath() {
  const out = [];
  const res = spawnSync('where.exe', ['java'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
  if (res.status === 0 && res.stdout) {
    for (const line of res.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().endsWith('java.exe')) out.push(trimmed);
    }
  }
  return out;
}

function scanRegistry() {
  const out = [];
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\JDK',
    'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
    'HKLM\\SOFTWARE\\JavaSoft\\JRE',
  ];
  for (const key of keys) {
    const res = spawnSync('reg.exe', ['query', key, '/s', '/v', 'JavaHome'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    if (res.status !== 0 || !res.stdout) continue;
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = line.match(/JavaHome\s+REG_\w+\s+(.+)$/i);
      if (match) {
        const exe = path.join(match[1].trim(), 'bin', 'java.exe');
        if (fs.existsSync(exe)) out.push(exe);
      }
    }
  }
  return out;
}

/**
 * Finds installed Java runtimes and picks the lowest version that satisfies
 * the game's requirement (old versions break on brand-new JVMs).
 */
async function detectJava({ gameDir, preferred = '', requiredMajor = 8, refresh = false }) {
  if (detectJava.cache && !refresh) {
    return pickJava(detectJava.cache, preferred, requiredMajor);
  }

  const candidates = [];
  if (preferred) candidates.push(preferred);
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  candidates.push(...scanPath(), ...scanRuntimeDir(gameDir), ...scanProgramFiles(), ...scanRegistry());

  const seen = new Set();
  const found = [];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const major = readJavaMajor(candidate);
    if (major) found.push({ path: candidate, major });
    if (found.length >= 24) break;
  }

  detectJava.cache = found;
  return pickJava(found, preferred, requiredMajor);
}

function pickJava(found, preferred, requiredMajor) {
  const viable = found.filter((j) => j.major >= requiredMajor);
  if (viable.length === 0) {
    return { found: false, requiredMajor, all: found, path: '', major: 0 };
  }
  const preferredEntry = preferred
    ? viable.find((j) => j.path.toLowerCase() === preferred.toLowerCase())
    : null;
  if (preferredEntry) return { found: true, ...preferredEntry, all: found };

  viable.sort((a, b) => a.major - b.major);
  return { found: true, ...viable[0], all: found };
}

/**
 * Installs a Mojang-bundled JRE (no system Java required).
 * Returns the java.exe path.
 */
async function downloadRuntime({ component, majorVersion, gameDir, progress, signal, log }) {
  const index = await fetchJson(RUNTIME_INDEX);
  const platform = platformKey();
  const componentName = component || COMPONENT_BY_MAJOR[majorVersion] || 'java-runtime-delta';

  let entries = index?.[platform]?.[componentName];
  if (!Array.isArray(entries) || entries.length === 0) {
    const byMajor = COMPONENT_BY_MAJOR[majorVersion];
    entries = index?.[platform]?.[byMajor];
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Mojang не отдаёт JRE ${componentName} для ${platform}`);
  }

  entries.sort((a, b) => new Date(b.version?.released || 0) - new Date(a.version?.released || 0));
  const entry = entries[0];
  const manifest = await fetchJson(entry.manifest.url);
  const files = manifest.files || {};

  const baseDir = path.join(gameDir, 'runtime', componentName, platform);
  const fileEntries = Object.entries(files).filter(([, info]) => info.type === 'file');
  const totalBytes = fileEntries.reduce((sum, [, info]) => sum + (info.downloads?.raw?.size || 0), 0);
  progress.setStage('java');
  progress.setTotal(totalBytes);

  const tasks = fileEntries.map(([rel, info]) => async () => {
    const raw = info.downloads?.raw;
    if (!raw?.url) return;
    const dest = path.join(baseDir, ...rel.split('/'));
    progress.setFile(rel);
    await downloadFile(raw.url, dest, {
      sha1: raw.sha1,
      size: raw.size,
      signal,
      onBytes: (n) => progress.add(n),
    });
  });

  await runPool(tasks, 12);

  for (const [rel, info] of Object.entries(files)) {
    if (info.type === 'directory') {
      await fsp.mkdir(path.join(baseDir, ...rel.split('/')), { recursive: true });
    }
  }

  const javaExe = path.join(baseDir, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) {
    throw new Error('JRE скачалась, но java.exe не найден');
  }
  log?.(`Java установлена: ${javaExe}`);
  detectJava.cache = null;
  return { path: javaExe, component: componentName, version: entry.version?.name || '' };
}

module.exports = { detectJava, downloadRuntime, readJavaMajor, platformKey, COMPONENT_BY_MAJOR };
