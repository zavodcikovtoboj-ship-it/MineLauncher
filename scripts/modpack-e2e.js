'use strict';

// Installs a Modrinth modpack into the E2E game directory. Used to verify the
// full .mrpack pipeline without opening the UI.

const path = require('path');
const os = require('os');

const { Mojang } = require('../electron/core/mojang');
const { Loaders } = require('../electron/core/loaders');
const { Modpacks } = require('../electron/core/modpacks');
const { Progress } = require('../electron/core/net');

const GAME_DIR = process.env.ML_E2E_DIR || path.join(os.tmpdir(), 'mclauncher-e2e');
const CACHE_DIR = path.join(os.tmpdir(), 'mclauncher-e2e-cache');
const DATA_DIR = process.env.ML_E2E_DATA || path.join(os.tmpdir(), 'mclauncher-e2e-data');
const PROJECT_ID = process.argv[2] || '1KVo5zza';

const config = {
  get(key) {
    const values = {
      gameDir: GAME_DIR,
      javaPath: '',
      ramMb: 2048,
      username: 'Player',
    };
    return values[key];
  },
  update() {},
};

(async () => {
  const mojang = new Mojang(CACHE_DIR);
  const loaders = new Loaders({
    mojang,
    cacheDir: CACHE_DIR,
    registryFile: path.join(DATA_DIR, 'loaders.json'),
  });
  const modpacks = new Modpacks({
    config,
    mojang,
    loaders,
    cacheDir: CACHE_DIR,
    registryFile: path.join(DATA_DIR, 'modpacks.json'),
  });

  const progress = new Progress((payload) => {
    const pct = payload.total > 0 ? Math.round(payload.percent) : 0;
    const line = `[${payload.stage}] ${pct}% ${payload.file || ''}`.padEnd(100).slice(0, 100);
    process.stdout.write(`\r${line}`);
  });

  console.log('game dir:', GAME_DIR);
  console.log('project:', PROJECT_ID);
  const entry = await modpacks.install({
    projectId: PROJECT_ID,
    log: (line) => console.log(`\n[log] ${line}`),
    progress,
  });
  process.stdout.write('\n');
  console.log('installed:', JSON.stringify(entry, null, 2));
})().catch((err) => {
  console.error('\nMODPACK INSTALL FAILED:', err);
  process.exit(1);
});
