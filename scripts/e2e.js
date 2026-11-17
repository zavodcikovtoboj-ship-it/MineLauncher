'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const { Mojang } = require('../electron/core/mojang');
const { Launcher } = require('../electron/core/launcher');
const { downloadRuntime, detectJava } = require('../electron/core/java');
const { Loaders } = require('../electron/core/loaders');
const { Modpacks } = require('../electron/core/modpacks');
const { Instances } = require('../electron/core/instances');
const { Targets } = require('../electron/core/targets');

const GAME_DIR = process.env.ML_E2E_DIR || path.join(os.tmpdir(), 'mclauncher-e2e');
const CACHE_DIR = path.join(os.tmpdir(), 'mclauncher-e2e-cache');
const DATA_DIR = process.env.ML_E2E_DATA || path.join(os.tmpdir(), 'mclauncher-e2e-data');
const COMPONENT = process.argv[2] || 'java-runtime-epsilon';
const VERSION = process.argv[3] || '26.3';
const LAUNCH_SECONDS = Number(process.argv[4] || 0);

const config = {
  get(key) {
    const values = {
      gameDir: GAME_DIR,
      javaPath: '',
      ramMb: 2048,
      msClientId: '',
      username: 'Player',
      jvmArgs: '',
      customResolution: false,
      width: 1280,
      height: 720,
    };
    return values[key];
  },
  update() {},
};

const send = (channel, payload) => {
  if (channel === 'log') {
    console.log(`[log] ${payload}`);
  } else if (channel === 'progress') {
    const pct = payload.total > 0 ? Math.round(payload.percent) : 0;
    process.stdout.write(`\r[${payload.stage}] ${pct}% ${payload.file || ''}`.padEnd(100).slice(0, 100));
  } else if (channel === 'exit') {
    console.log('\n[exit]', JSON.stringify(payload));
  }
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
  const instances = new Instances({
    config,
    registryFile: path.join(DATA_DIR, 'instances.json'),
  });
  const targets = new Targets({ config, modpacks, instances });
  const launcher = new Launcher({ config, mojang, send, loaders, modpacks, targets });

  console.log('game dir:', GAME_DIR);
  console.log('target:', VERSION);
  const javaExe = path.join(GAME_DIR, 'runtime', COMPONENT, 'windows-x64', 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) {
    console.log('installing runtime...');
    const started = Date.now();
    const progress = {
      setStage() {},
      setTotal() {},
      setFile() {},
      add() {
        if (Date.now() % 1000 < 20) process.stdout.write('.');
      },
    };
    const runtime = await downloadRuntime({
      component: COMPONENT,
      majorVersion: 25,
      gameDir: GAME_DIR,
      progress,
      log: (line) => console.log(`\n[log] ${line}`),
    });
    console.log(`\nruntime ready in ${((Date.now() - started) / 1000).toFixed(1)}s:`, runtime.path);
  } else {
    console.log('runtime already present:', javaExe);
  }

  const detected = await detectJava({ gameDir: GAME_DIR, requiredMajor: 8, refresh: true });
  console.log('detected:', detected);

  if (!LAUNCH_SECONDS) return;

  console.log(`launching ${VERSION}...`);
  if (LAUNCH_SECONDS > 0) {
    const watcher = setInterval(() => {
      if (!launcher.child) return;
      clearInterval(watcher);
      console.log(`\n[game started] will stop in ${LAUNCH_SECONDS}s`);
      setTimeout(() => {
        console.log('\n[cancel] stopping game after timeout');
        launcher.cancel();
      }, LAUNCH_SECONDS * 1000);
    }, 1000);
  }

  const result = await launcher.launch({
    versionId: VERSION,
    account: {
      type: 'offline',
      name: 'Player',
      uuid: '00000000000000000000000000000000',
      accessToken: '0',
      userType: 'legacy',
      xuid: '',
    },
  });
  console.log('result:', result);
})().catch((err) => {
  console.error('\nE2E FAILED:', err);
  process.exit(1);
});
