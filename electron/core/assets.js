'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { downloadFile, runPool } = require('./net');

const RESOURCES_BASE = 'https://resources.download.minecraft.net';

function objectPath(assetsDir, hash) {
  return path.join(assetsDir, 'objects', hash.slice(0, 2), hash);
}

async function linkOrCopy(source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.access(target);
    return;
  } catch {
    // missing: create it
  }
  try {
    await fsp.link(source, target);
  } catch {
    await fsp.copyFile(source, target);
  }
}

/**
 * Ensures the asset index and every object referenced by it.
 * Old versions (pre-1.7) additionally need a virtual or resources tree.
 */
async function ensureAssets({ version, dirs, mojang, progress, signal, log }) {
  const indexId = version.assetIndex?.id || version.assets || null;
  if (!version.assetIndex?.url) {
    log?.(`Ассеты для ${version.id}: пропущено (индекс отсутствует)`);
    return { assetIndex: indexId || 'legacy' };
  }

  const index = await mojang.getAssetIndex(version.assetIndex.url);
  const indexFile = path.join(dirs.assets, 'indexes', `${indexId}.json`);
  await fsp.mkdir(path.dirname(indexFile), { recursive: true });
  if (!fs.existsSync(indexFile)) {
    await fsp.writeFile(indexFile, JSON.stringify(index), 'utf8');
  }

  const entries = Object.entries(index.objects || {});
  let knownBytes = 0;
  for (const [, obj] of entries) knownBytes += obj.size || 0;
  progress.setStage('assets');
  progress.setTotal(knownBytes);

  const tasks = entries.map(([name, obj]) => async () => {
    const dest = objectPath(dirs.assets, obj.hash);
    progress.setFile(name);
    await downloadFile(`${RESOURCES_BASE}/${obj.hash.slice(0, 2)}/${obj.hash}`, dest, {
      sha1: obj.hash,
      size: obj.size,
      signal,
      onBytes: (n) => progress.add(n),
    });
  });

  await runPool(tasks, 12);

  if (index.virtual || index.map_to_resources) {
    const targetRoot = index.virtual
      ? path.join(dirs.assets, 'virtual', indexId)
      : path.join(dirs.gameDir, 'resources');

    log?.(`Раскладка старых ассетов в ${targetRoot}`);
    progress.setStage('assets-map');
    progress.setTotal(entries.length);
    for (const [name, obj] of entries) {
      const source = objectPath(dirs.assets, obj.hash);
      await linkOrCopy(source, path.join(targetRoot, name));
      progress.add(1);
    }
  }

  return { assetIndex: indexId };
}

module.exports = { ensureAssets, objectPath };
