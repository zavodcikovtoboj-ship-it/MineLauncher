'use strict';

// Local regression coverage for the 1.0 modules. Uses only temporary folders
// and a loopback HTTP server: no Mojang/Modrinth downloads and no real user data.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const { Config } = require('../electron/core/config');
const { Instances } = require('../electron/core/instances');
const { Targets } = require('../electron/core/targets');
const { Content } = require('../electron/core/content');
const { Maintenance } = require('../electron/core/maintenance');
const { Servers } = require('../electron/core/servers');
const { Stats } = require('../electron/core/stats');
const { DiscordRpc } = require('../electron/core/discord');
const { Sync } = require('../electron/core/sync');
const { configureNetwork, networkSettings, downloadFile } = require('../electron/core/net');

const ROOT = path.join(os.tmpdir(), 'mclauncher-regression');
const GAME_DIR = path.join(ROOT, 'minecraft');
const DATA_DIR = path.join(ROOT, 'data');

let passed = 0;
function ok(label) {
  passed++;
  console.log(`ok ${passed} - ${label}`);
}

function makeJar(file, meta) {
  const zip = new AdmZip();
  zip.addFile('fabric.mod.json', Buffer.from(JSON.stringify(meta), 'utf8'));
  zip.addFile('assets/example.txt', Buffer.from('demo', 'utf8'));
  zip.writeZip(file);
}

function makeZip(file, entries) {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.from(data));
  zip.writeZip(file);
}

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(GAME_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const config = new Config(path.join(DATA_DIR, 'config.json'), GAME_DIR);
  config.load();
  config.update({ gameDir: GAME_DIR, backupRetention: 5, cleanupDays: 7 });
  const instances = new Instances({ config, registryFile: path.join(DATA_DIR, 'instances.json') });
  const modpacks = { list: () => [], get: () => null };
  const targets = new Targets({ config, instances, modpacks });
  const content = new Content({ targets });
  const stats = new Stats({ registryFile: path.join(DATA_DIR, 'stats.json') });

  // ---------------- instances ----------------
  const instance = await instances.create({
    name: 'Regression Fabric',
    mcVersion: '26.3',
    loader: 'fabric',
  });
  assert.strictEqual(instance.slug, 'regression-fabric');
  assert.ok(fs.existsSync(path.join(instance.instanceDir, 'instance.json')));
  assert.strictEqual(instances.list().length, 1);
  ok('instance create');

  const resolved = targets.resolve(`instance:${instance.slug}`);
  assert.strictEqual(resolved.kind, 'instance');
  assert.strictEqual(resolved.loader, 'fabric');
  assert.strictEqual(resolved.mcVersion, '26.3');
  assert.ok(targets.isManaged(`instance:${instance.slug}`));
  assert.strictEqual(targets.resolve('26.3').kind, 'vanilla');
  const contentTargets = targets.listContentTargets();
  assert.ok(contentTargets.some((item) => item.id === `instance:${instance.slug}`));
  ok('targets resolve');

  await fsp.writeFile(path.join(instance.instanceDir, 'notes.txt'), 'keep me', 'utf8');
  const exportFile = path.join(DATA_DIR, 'instance-export.zip');
  const exported = await instances.export(instance.slug, exportFile);
  assert.ok(exported.size > 0);
  await instances.remove(instance.slug);
  assert.strictEqual(instances.list().length, 0);
  assert.ok(!fs.existsSync(instance.instanceDir));
  const imported = await instances.import(exportFile);
  assert.strictEqual(imported.name, 'Regression Fabric');
  assert.strictEqual(await fsp.readFile(path.join(imported.instanceDir, 'notes.txt'), 'utf8'), 'keep me');
  ok('instance export/import');

  // ---------------- content ----------------
  const modA = path.join(DATA_DIR, 'mod-a.jar');
  const modB = path.join(DATA_DIR, 'mod-b.jar');
  makeJar(modA, {
    id: 'mod-a',
    name: 'Mod A',
    version: '1.0.0',
    depends: { fabricloader: '>=0.15', minecraft: '26.3', 'mod-b': '>=1.0' },
  });
  makeJar(modB, { id: 'mod-b', name: 'Mod B', version: '1.0.0' });
  const targetId = `instance:${instance.slug}`;
  const first = await content.importLocal({ targetId, kind: 'mods', filePath: modA });
  assert.strictEqual(first.item.title, 'Mod A');
  await content.importLocal({ targetId, kind: 'mods', filePath: modB });
  let list = content.list({ targetId });
  assert.strictEqual(list.items.length, 2);
  assert.ok(list.items.every((item) => item.exists));
  let report = content.conflicts({ targetId });
  assert.strictEqual(report.mods.length, 2);
  assert.strictEqual(report.conflicts.filter((item) => item.severity === 'error').length, 0);
  assert.ok(report.ok);
  ok('content import and dependency check');

  const packFile = path.join(DATA_DIR, 'resources.zip');
  makeZip(packFile, { 'pack.mcmeta': '{"pack":{"pack_format":34,"description":"demo"}}', 'pack.png': 'png' });
  const pack = await content.importLocal({ targetId, kind: 'resourcepacks', filePath: packFile });
  assert.ok(fs.existsSync(path.join(instance.instanceDir, 'resourcepacks', path.basename(pack.item.relPath))));
  list = content.list({ targetId });
  assert.strictEqual(list.items.length, 3);
  ok('content resourcepack import');

  await content.remove({ targetId, key: first.item.key });
  list = content.list({ targetId });
  assert.strictEqual(list.items.length, 2);
  const modBItem = list.items.find((item) => item.kind === 'mods');
  await fsp.rm(path.join(instance.instanceDir, modBItem.relPath), { force: true });
  await fsp.writeFile(path.join(instance.instanceDir, 'mods', 'untracked.jar'), 'not a zip', 'utf8');
  report = content.conflicts({ targetId });
  assert.strictEqual(report.missing.length, 1);
  assert.strictEqual(report.untracked.length, 1);
  assert.ok(report.conflicts.some((item) => item.type === 'untracked'));
  ok('content remove, missing and untracked conflicts');

  // ---------------- stats ----------------
  const sessionA = stats.begin({ targetId, name: 'Regression Fabric', mcVersion: '26.3' });
  stats.end(sessionA, { seconds: 65, exitCode: 0, crashed: false });
  const sessionB = stats.begin({ targetId, name: 'Regression Fabric', mcVersion: '26.3' });
  stats.end(sessionB, { seconds: 5, exitCode: 1, crashed: true });
  const summary = stats.summary();
  assert.strictEqual(summary.launches, 2);
  assert.strictEqual(summary.totalSeconds, 70);
  assert.strictEqual(summary.crashes, 1);
  assert.strictEqual(summary.byTarget.length, 1);
  assert.strictEqual(summary.byTarget[0].seconds, 70);
  assert.strictEqual(summary.recent.length, 2);
  stats.reset();
  assert.strictEqual(stats.summary().launches, 0);
  ok('statistics aggregation and reset');

  // ---------------- servers ----------------
  const servers = new Servers({ registryFile: path.join(DATA_DIR, 'servers.json') });
  assert.ok(servers.list().length >= 3);
  const added = servers.add({ name: 'Local Smoke', address: '127.0.0.1:25566' });
  assert.strictEqual(added.address, '127.0.0.1:25566');
  assert.throws(() => servers.add({ name: 'Dup', address: '127.0.0.1:25566' }), /уже есть/);
  assert.throws(() => servers.add({ name: 'Bad', address: '127.0.0.1:70000' }), /порт/);
  const localServer = servers.add({ name: 'Offline', address: '127.0.0.1:1' });
  const ping = await servers.ping(localServer.id, { timeout: 1200 });
  assert.strictEqual(ping.status, null);
  assert.ok(ping.error);
  servers.remove(added.id);
  servers.remove(localServer.id);
  ok('server registry, validation and offline ping');

  // ---------------- discord ----------------
  const discordConfig = {
    data: { discordClientId: '', discordRpc: false },
    get(key) {
      return this.data[key];
    },
  };
  const discord = new DiscordRpc({ config: discordConfig });
  const builtinStatus = discord.status();
  assert.strictEqual(builtinStatus.enabled, true, 'built-in ID must enable RPC');
  assert.strictEqual(builtinStatus.builtin, true);
  assert.match(builtinStatus.clientId, /^\d{17,20}$/);
  discordConfig.data.discordClientId = '123456789012345678';
  assert.strictEqual(discord.enabled(), true, 'ID alone must enable RPC');
  assert.deepStrictEqual(discord.status(), {
    enabled: true,
    connected: false,
    clientId: '123456789012345678',
    builtin: false,
  });
  discordConfig.data.discordClientId = '';
  assert.strictEqual(discord.status().builtin, true, 'empty setting falls back to the built-in ID');
  const buttons = discord.resolveButtons();
  assert.strictEqual(buttons.length, 2, 'at most two rich presence buttons');
  assert.ok(buttons.every((b) => /^https:\/\//.test(b.url) && b.label.length <= 32));
  assert.ok(buttons[0].url.endsWith('/releases/latest'), 'first button opens the download page');
  discordConfig.data.language = 'en';
  assert.strictEqual(discord.resolveButtons()[0].label, 'Download launcher');
  discordConfig.data.language = 'ru';
  assert.strictEqual(discord.resolveButtons()[0].label, 'Скачать лаунчер');
  discord.stop();
  ok('discord rich presence is always on and exposes download buttons');

  // ---------------- sync ----------------
  const syncConfig = new Config(path.join(DATA_DIR, 'config-sync.json'), GAME_DIR);
  syncConfig.load();
  syncConfig.update({
    gameDir: GAME_DIR,
    theme: 'light',
    language: 'en',
    ramMb: 6144,
    msRefreshToken: 'secret-token',
    msProfile: { name: 'Secret', uuid: '0' },
  });
  const sync = new Sync({ config: syncConfig, targets, instances });
  const settingsFile = path.join(DATA_DIR, 'settings.json');
  await sync.exportSettings(settingsFile);
  const exportedPayload = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
  assert.strictEqual(exportedPayload.format, 'minelauncher-settings');
  assert.strictEqual(exportedPayload.config.theme, 'light');
  assert.ok(!('msRefreshToken' in exportedPayload.config));
  assert.ok(!('msProfile' in exportedPayload.config));

  const importConfig = new Config(path.join(DATA_DIR, 'config-import.json'), GAME_DIR);
  importConfig.load();
  const importSync = new Sync({ config: importConfig, targets, instances: instances });
  await importSync.importSettings(settingsFile);
  assert.strictEqual(importConfig.get('theme'), 'light');
  assert.strictEqual(importConfig.get('language'), 'en');
  assert.strictEqual(importConfig.get('ramMb'), 6144);
  ok('settings export/import without secrets');

  await fsp.mkdir(path.join(instance.instanceDir, 'saves', 'World'), { recursive: true });
  await fsp.writeFile(path.join(instance.instanceDir, 'saves', 'World', 'level.dat'), 'level', 'utf8');
  const worldsFile = path.join(DATA_DIR, 'worlds.zip');
  const worldsExported = await sync.exportWorlds(targetId, worldsFile);
  assert.ok(worldsExported.size > 0);
  await fsp.rm(path.join(instance.instanceDir, 'saves'), { recursive: true, force: true });
  const worldsImported = await sync.importWorlds(targetId, worldsFile);
  assert.ok(worldsImported.restored >= 1);
  assert.strictEqual(
    await fsp.readFile(path.join(instance.instanceDir, 'saves', 'World', 'level.dat'), 'utf8'),
    'level'
  );
  ok('worlds export/import');

  // ---------------- maintenance ----------------
  const maintenance = new Maintenance({
    config,
    mojang: {},
    loaders: {},
    modpacks,
    instances,
    targets,
    content,
    cacheDir: path.join(DATA_DIR, 'cache'),
  });

  await fsp.mkdir(path.join(instance.instanceDir, 'crash-reports'), { recursive: true });
  await fsp.writeFile(
    path.join(instance.instanceDir, 'crash-reports', 'crash-2026-01-01.txt'),
    'Minecraft Crash Report\njava.lang.OutOfMemoryError: Java heap space\n',
    'utf8'
  );
  const crash = await maintenance.analyzeCrash(targetId);
  assert.strictEqual(crash.found, true);
  assert.ok(/OutOfMemory|heap|памят/i.test(JSON.stringify(crash.causes)));
  ok('crash analysis');

  await fsp.mkdir(path.join(instance.instanceDir, 'config'), { recursive: true });
  await fsp.writeFile(path.join(instance.instanceDir, 'config', 'demo.cfg'), 'enabled=true', 'utf8');
  const backup = await maintenance.createBackup(targetId, { includeWorlds: true });
  assert.ok(backup.size > 0);
  const backups = await maintenance.listBackups();
  assert.ok(backups.some((item) => item.name === backup.name));
  await fsp.rm(path.join(instance.instanceDir, 'config'), { recursive: true, force: true });
  const restored = await maintenance.restoreBackup(targetId, backup.name);
  assert.ok(restored.restored >= 1);
  assert.strictEqual(
    await fsp.readFile(path.join(instance.instanceDir, 'config', 'demo.cfg'), 'utf8'),
    'enabled=true'
  );
  ok('backup create/list/restore');

  await fsp.mkdir(path.join(instance.instanceDir, 'mods'), { recursive: true });
  await fsp.writeFile(path.join(instance.instanceDir, 'mods', 'reset-me.jar'), 'jar', 'utf8');
  const resetKeep = await maintenance.reset(targetId, { keepWorlds: true });
  assert.ok(resetKeep.keptWorlds);
  assert.ok(!fs.existsSync(path.join(instance.instanceDir, 'mods')));
  assert.ok(fs.existsSync(path.join(instance.instanceDir, 'saves', 'World', 'level.dat')));
  const resetDrop = await maintenance.reset(targetId, { keepWorlds: false });
  assert.ok(!resetDrop.keptWorlds);
  assert.ok(!fs.existsSync(path.join(instance.instanceDir, 'saves')));
  ok('instance reset keep/delete worlds');

  const oldLog = path.join(instance.instanceDir, 'logs', 'old.log');
  await fsp.mkdir(path.dirname(oldLog), { recursive: true });
  await fsp.writeFile(oldLog, 'old', 'utf8');
  const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await fsp.utimes(oldLog, oldTime, oldTime);
  const installerDir = path.join(DATA_DIR, 'cache', 'installers');
  await fsp.mkdir(installerDir, { recursive: true });
  await fsp.writeFile(path.join(installerDir, 'old.exe'), 'exe', 'utf8');
  const cleanup = await maintenance.cleanup({ days: 7 });
  assert.ok(cleanup.removed >= 1);
  assert.ok(!fs.existsSync(oldLog));
  const disk = await maintenance.diskUsage();
  assert.strictEqual(disk.categories.length, 9);
  assert.ok(disk.total > 0);
  ok('cleanup and disk usage');

  // ---------------- resume download ----------------
  const payload = crypto.randomBytes(256 * 1024);
  const sha1 = crypto.createHash('sha1').update(payload).digest('hex');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range || '' });
    const match = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    if (match) {
      const start = Number(match[1]);
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length - start,
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(payload.subarray(start));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
      'Accept-Ranges': 'bytes',
    });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/artifact.bin`;
  const downloadPath = path.join(DATA_DIR, 'downloads', 'artifact.bin');
  await fsp.mkdir(path.dirname(downloadPath), { recursive: true });
  await fsp.writeFile(`${downloadPath}.part`, payload.subarray(0, 4096));
  const resumed = await downloadFile(url, downloadPath, { size: payload.length, sha1 });
  assert.strictEqual(resumed.resumed, true);
  assert.deepStrictEqual(await fsp.readFile(downloadPath), payload);
  assert.ok(!fs.existsSync(`${downloadPath}.part`));
  assert.ok(requests.some((item) => item.range === 'bytes=4096-'));
  const skipped = await downloadFile(url, downloadPath, { size: payload.length, sha1 });
  assert.strictEqual(skipped.skipped, true);
  configureNetwork({ speedLimitKbps: 512, mirrorMode: 'official' });
  assert.deepStrictEqual(networkSettings(), { speedLimitKbps: 512, mirrorMode: 'official' });
  configureNetwork({ speedLimitKbps: 0, mirrorMode: 'auto' });
  await new Promise((resolve) => server.close(resolve));
  ok('resumable HTTP download with SHA-1 and network settings');

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`\nregression ok: ${passed} checks`);
})().catch((err) => {
  console.error('REGRESSION FAILED:', err);
  process.exit(1);
});
