'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

function combineArguments(parent, child) {
  const parentArgs = parent?.arguments || {};
  const childArgs = child?.arguments || {};
  if (!parent.arguments && !child.arguments) return undefined;
  return {
    ...parentArgs,
    ...childArgs,
    game: [...(parentArgs.game || []), ...(childArgs.game || [])],
    jvm: [...(parentArgs.jvm || []), ...(childArgs.jvm || [])],
  };
}

/**
 * Merges a loader profile (Forge/NeoForge/Fabric) with its vanilla parent.
 * Child values win, libraries and arguments are concatenated.
 */
function mergeVersions(child, parent) {
  const merged = { ...parent, ...child };
  merged.id = child.id || parent.id;
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.libraries = [...(parent.libraries || []), ...(child.libraries || [])];
  merged.arguments = combineArguments(parent, child);
  merged.minecraftArguments = child.minecraftArguments || parent.minecraftArguments;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.logging = child.logging || parent.logging;
  merged.type = child.type || parent.type;
  merged.clientJarVersion = parent.clientJarVersion || parent.id;
  merged.baseId = parent.baseId || parent.id;
  return merged;
}

async function readLocalVersion(gameDir, versionId) {
  const file = path.join(gameDir, 'versions', versionId, `${versionId}.json`);
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolves a version, walking inheritsFrom and merging with the parent.
 * Installed loader profiles live in <gameDir>/versions/<id>/<id>.json.
 */
async function resolveVersion({ mojang, gameDir, versionId }) {
  const local = await readLocalVersion(gameDir, versionId);
  const version = local || (await mojang.getVersionById(versionId));

  if (!version.inheritsFrom) {
    return {
      ...version,
      clientJarVersion: version.clientJarVersion || version.id,
      baseId: version.baseId || version.id,
    };
  }

  const parent = await resolveVersion({
    mojang,
    gameDir,
    versionId: version.inheritsFrom,
  });
  return mergeVersions(version, parent);
}

module.exports = { resolveVersion, mergeVersions };
