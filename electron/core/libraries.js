'use strict';

const os = require('os');
const path = require('path');

const OS_NAME = 'windows';
const LIBRARY_BASE = 'https://libraries.minecraft.net/';

const ARCH_ALIASES = {
  ia32: ['x86', 'i386', 'i686'],
  x64: ['x86_64', 'amd64', 'x64'],
  arm64: ['arm64', 'aarch64'],
};

function archAllowed(ruleArch) {
  if (!ruleArch) return true;
  const aliases = ARCH_ALIASES[process.arch] || [process.arch];
  return aliases.includes(ruleArch);
}

function rulesAllow(rules, features = {}) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (rule.os) {
      if (rule.os.name && rule.os.name !== OS_NAME) continue;
      if (rule.os.arch && !archAllowed(rule.os.arch)) continue;
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(os.release())) continue;
        } catch {
          continue;
        }
      }
    }
    if (rule.features) {
      const match = Object.entries(rule.features).every(([key, value]) => Boolean(features[key]) === Boolean(value));
      if (!match) continue;
    }
    allowed = rule.action === 'allow';
  }
  return allowed;
}

function mavenPath(name) {
  const parts = name.split(':');
  if (parts.length < 3) return null;
  const [group, artifact, version, classifier] = parts;
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

function isNativeName(name) {
  const parts = name.split(':');
  return parts.length >= 4 && parts[3].startsWith('natives-');
}

// Mojang's JSON allows every Windows native variant (x64, arm64, x86)
// on os.name=windows; the classifier itself is what selects the arch.
function nativeArchCompatible(name) {
  if (name.endsWith('-arm64')) return process.arch === 'arm64';
  if (name.endsWith('-x86')) return process.arch === 'ia32';
  return true;
}

function nativeClassifier(lib) {
  const raw = lib.natives && lib.natives[OS_NAME];
  if (!raw) return null;
  const arch = process.arch === 'ia32' ? '32' : '64';
  return raw.replace('${arch}', arch);
}

/**
 * Resolves libraries for the current platform.
 * Returns absolute classpath entries, download jobs and native jars to extract.
 */
function collectLibraries(version, librariesDir) {
  const classpath = [];
  const downloads = [];
  const natives = [];
  const seenDownloads = new Set();
  const seenClasspath = new Set();

  const addDownload = (artifact, dest) => {
    if (!artifact || !artifact.url || seenDownloads.has(dest)) return;
    seenDownloads.add(dest);
    downloads.push({
      url: artifact.url,
      dest,
      sha1: artifact.sha1,
      size: artifact.size,
    });
  };

  for (const lib of version.libraries || []) {
    if (!rulesAllow(lib.rules, {})) continue;

    const classifier = nativeClassifier(lib);
    const nativeName = isNativeName(lib.name);
    if (nativeName && !nativeArchCompatible(lib.name)) continue;

    if (lib.downloads) {
      const artifact = lib.downloads.artifact;
      if (artifact && artifact.path) {
        const dest = path.join(librariesDir, artifact.path);
        addDownload(artifact, dest);
        if (nativeName) {
          natives.push({ jar: dest, exclude: lib.extract?.exclude || ['META-INF/'] });
        } else if (!seenClasspath.has(dest)) {
          seenClasspath.add(dest);
          classpath.push(dest);
        }
      }

      if (classifier && lib.downloads.classifiers) {
        const nativeArtifact = lib.downloads.classifiers[classifier];
        if (nativeArtifact && nativeArtifact.path) {
          const dest = path.join(librariesDir, nativeArtifact.path);
          addDownload(nativeArtifact, dest);
          natives.push({ jar: dest, exclude: lib.extract?.exclude || ['META-INF/'] });
        }
      }
    } else if (lib.name) {
      // Very old version JSONs (1.2.5 and below) and Fabric profiles only
      // carry maven coordinates plus an optional repository base URL.
      const rel = mavenPath(lib.name);
      if (rel) {
        const dest = path.join(librariesDir, rel);
        const base = lib.url || LIBRARY_BASE;
        addDownload({ url: base + rel, sha1: lib.sha1, size: lib.size }, dest);
        if (!nativeName && !seenClasspath.has(dest)) {
          seenClasspath.add(dest);
          classpath.push(dest);
        }
      }
    }
  }

  return { classpath, downloads, natives };
}

module.exports = { collectLibraries, rulesAllow, mavenPath, OS_NAME };
