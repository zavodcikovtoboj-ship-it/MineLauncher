'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');

const { Config, DEFAULTS } = require('./core/config');
const { Mojang } = require('./core/mojang');
const { Launcher } = require('./core/launcher');
const { detectJava } = require('./core/java');
const { offlineAccount, loginMicrosoft, refreshMicrosoft } = require('./core/auth');
const { Loaders, parseTarget } = require('./core/loaders');
const { Modpacks } = require('./core/modpacks');
const { Instances } = require('./core/instances');
const { Targets } = require('./core/targets');
const { Content } = require('./core/content');
const { Maintenance } = require('./core/maintenance');
const { Servers } = require('./core/servers');
const { Stats } = require('./core/stats');
const { DiscordRpc } = require('./core/discord');
const { Updates } = require('./core/updates');
const { Sync } = require('./core/sync');
const { Progress, configureNetwork, diagnose, networkSettings } = require('./core/net');

app.setName(process.env.ML_SMOKE === '1' ? 'MineLauncherSmoke' : 'MineLauncher');

// Smoke runs must not touch the real %APPDATA% folder. Setting APPDATA on
// Windows does not move Electron's userData, so the test harness passes an
// explicit directory instead.
if (process.env.ML_SMOKE === '1' && process.env.ML_SMOKE_DATA) {
  const smokeData = path.resolve(process.env.ML_SMOKE_DATA);
  fs.mkdirSync(smokeData, { recursive: true });
  app.setPath('userData', smokeData);
  app.setPath('sessionData', smokeData);
}

const userData = app.getPath('userData');
const config = new Config(path.join(userData, 'config.json'), path.join(userData, 'minecraft'));
config.load();

const cacheDir = path.join(userData, 'cache');
const mojang = new Mojang(cacheDir);
const loaders = new Loaders({
  mojang,
  cacheDir,
  registryFile: path.join(userData, 'loaders.json'),
});
const modpacks = new Modpacks({
  config,
  mojang,
  loaders,
  cacheDir,
  registryFile: path.join(userData, 'modpacks.json'),
});
const instances = new Instances({
  config,
  registryFile: path.join(userData, 'instances.json'),
});
const targets = new Targets({ config, modpacks, instances });
const content = new Content({ targets });
const maintenance = new Maintenance({
  config,
  mojang,
  loaders,
  modpacks,
  instances,
  targets,
  content,
  cacheDir,
});
const servers = new Servers({ registryFile: path.join(userData, 'servers.json') });
const stats = new Stats({ registryFile: path.join(userData, 'stats.json') });
const updates = new Updates({ config, currentVersion: app.getVersion(), cacheDir });
const sync = new Sync({ config, targets, instances });

let win = null;
let launcher = null;
let msAbort = null;
let javaInstalling = false;
let modpackInstalling = false;
let contentBusy = false;
let maintenanceBusy = false;
let updateBusy = false;
let lastUpdateInfo = null;
let lastUpdateFile = null;
let updateCheckTimer = null;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const discord = new DiscordRpc({
  config,
  log: (line) => send('launch:log', String(line)),
});

configureNetwork({
  speedLimitKbps: config.get('speedLimitKbps'),
  mirrorMode: config.get('mirrorMode'),
});

function serializeError(err) {
  return {
    ok: false,
    error: err?.message || String(err),
    code: err?.code || '',
    requiredMajor: err?.requiredMajor || 0,
    component: err?.component || '',
  };
}

function publicConfig() {
  const { msRefreshToken, ...safe } = config.all();
  return safe;
}

function progressFor(channel) {
  return new Progress((payload) => send(channel, payload));
}

function logTo(...channels) {
  return (line) => {
    const text = String(line);
    for (const channel of channels) send(channel, text);
  };
}

function normalizeProxyRules(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Укажите адрес прокси.');
  if (/^socks(4|5)?:\/\//i.test(raw) || /^socks=/i.test(raw)) {
    return raw.startsWith('socks=') ? raw : raw.replace(/^socks(4|5)?:\/\//i, 'socks5://');
  }
  if (/^https?:\/\//i.test(raw)) {
    const host = raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    return `http=${host};https=${host}`;
  }
  return `http=${raw};https=${raw}`;
}

async function applyProxy() {
  const mode = String(config.get('proxyMode') || 'system');
  if (!session.defaultSession) return;
  if (mode === 'direct') {
    await session.defaultSession.setProxy({ mode: 'direct' });
    return;
  }
  if (mode === 'manual') {
    await session.defaultSession.setProxy({
      proxyRules: normalizeProxyRules(config.get('proxyUrl')),
      proxyBypassRules: '<local>',
    });
    return;
  }
  await session.defaultSession.setProxy({ mode: 'system' });
}

async function applyRuntimeSettings() {
  configureNetwork({
    speedLimitKbps: config.get('speedLimitKbps'),
    mirrorMode: config.get('mirrorMode'),
  });
  await applyProxy().catch((err) => {
    send('launch:log', `Прокси: ${err.message}`);
  });
  discord.configure();
}

async function silentUpdateCheck() {
  if (!config.get('updateFeedUrl')) return;
  try {
    const info = await updates.check();
    lastUpdateInfo = info;
    if (info.hasUpdate) send('update:available', info);
    else send('update:checked', { ...info, hasUpdate: false });
  } catch (err) {
    send('update:checked', { ok: false, error: err.message });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 1000,
    minHeight: 660,
    frame: false,
    show: false,
    backgroundColor: '#0e1013',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  launcher = new Launcher({ config, mojang, send, loaders, modpacks, targets, stats });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('closed', () => {
    win = null;
  });
}

async function resolveAccount() {
  const type = config.get('accountType');
  if (type === 'microsoft') {
    const refreshToken = config.get('msRefreshToken');
    if (!refreshToken) {
      const err = new Error('Вход Microsoft не выполнен. Войдите в аккаунт.');
      err.code = 'MS_REAUTH';
      throw err;
    }
    try {
      const account = await refreshMicrosoft({
        clientId: config.get('msClientId'),
        refreshToken,
      });
      config.update({
        msRefreshToken: account.refreshToken,
        msProfile: { name: account.name, uuid: account.uuid },
        username: account.name,
      });
      return account;
    } catch (err) {
      err.code = 'MS_REAUTH';
      throw err;
    }
  }
  return offlineAccount(config.get('username'));
}

function registerIpc() {
  ipcMain.handle('config:get', () => publicConfig());

  ipcMain.handle('config:set', async (_event, patch) => {
    const clean = {};
    const denied = new Set(['msRefreshToken', 'msProfile']);
    for (const key of Object.keys(DEFAULTS)) {
      if (denied.has(key)) continue;
      if (patch && patch[key] !== undefined) clean[key] = patch[key];
    }
    const next = config.update(clean);
    if (next.gameDir) fs.mkdirSync(next.gameDir, { recursive: true });
    await applyRuntimeSettings();
    return publicConfig();
  });

  ipcMain.handle('versions:list', async (_event, force) => {
    try {
      const manifest = await mojang.getManifest({ force: Boolean(force) });
      return {
        ok: true,
        latest: manifest.latest,
        versions: manifest.versions.map((v) => ({
          id: v.id,
          type: v.type,
          releaseTime: v.releaseTime,
          url: v.url,
        })),
        modpacks: modpacks.list(),
        instances: instances.list(),
      };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('loaders:catalog', async (_event, force) => {
    try {
      const catalog = await loaders.catalog({ force: Boolean(force) });
      return {
        ok: true,
        fabric: catalog.fabric,
        forge: catalog.forge,
        neoforge: catalog.neoforge,
      };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('versions:meta', async (_event, versionId) => {
    try {
      if (!versionId) throw new Error('Версия не указана.');
      let resolved;
      try {
        resolved = targets.resolve(versionId);
      } catch {
        resolved = parseTarget(versionId);
      }
      if (!resolved.mcVersion) throw new Error('Версия не указана.');
      const version = await mojang.getVersionById(resolved.mcVersion);
      return {
        ok: true,
        id: versionId,
        baseId: resolved.mcVersion,
        name: resolved.name || versionId,
        type: version.type,
        javaVersion: version.javaVersion || null,
        loader: resolved.loader || 'vanilla',
        target: parseTarget(versionId),
      };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('modpacks:list', () => ({ ok: true, packs: modpacks.list() }));

  ipcMain.handle('modpacks:search', async (_event, query) => {
    try {
      const hits = await modpacks.search(String(query || ''));
      return { ok: true, hits };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('modpacks:install', async (_event, projectId) => {
    if (modpackInstalling) return { ok: false, error: 'Установка модпака уже идёт.' };
    modpackInstalling = true;
    const progress = progressFor('modpack:progress');
    const log = logTo('modpack:log', 'launch:log');
    try {
      const entry = await modpacks.install({ projectId, log, progress });
      return { ok: true, pack: entry, packs: modpacks.list(), instances: instances.list() };
    } catch (err) {
      return serializeError(err);
    } finally {
      modpackInstalling = false;
    }
  });

  ipcMain.handle('modpacks:remove', async (_event, slug) => {
    try {
      await modpacks.remove(String(slug || ''));
      return { ok: true, packs: modpacks.list() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('modpacks:check-updates', async () => {
    try {
      const updatesList = await modpacks.checkUpdates({ log: logTo('launch:log') });
      return { ok: true, updates: updatesList };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('modpacks:update', async (_event, slug) => {
    if (modpackInstalling) return { ok: false, error: 'Операция с модпаком уже идёт.' };
    modpackInstalling = true;
    try {
      const result = await modpacks.update(String(slug || ''), {
        log: logTo('modpack:log', 'launch:log'),
        progress: progressFor('modpack:progress'),
      });
      return { ok: true, ...result, packs: modpacks.list() };
    } catch (err) {
      return serializeError(err);
    } finally {
      modpackInstalling = false;
    }
  });

  ipcMain.handle('instances:list', () => ({ ok: true, instances: instances.list() }));

  ipcMain.handle('instances:create', async (_event, patch) => {
    try {
      const entry = await instances.create(patch || {});
      return { ok: true, instance: entry, instances: instances.list() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('instances:update', async (_event, slug, patch) => {
    try {
      const entry = await instances.update(String(slug || ''), patch || {});
      return { ok: true, instance: entry, instances: instances.list() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('instances:remove', async (_event, slug) => {
    try {
      await instances.remove(String(slug || ''));
      return { ok: true, instances: instances.list() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('instances:export', async (_event, slug) => {
    try {
      const instance = instances.get(String(slug || ''));
      if (!instance) throw new Error('Инстанс не найден.');
      const result = await dialog.showSaveDialog(win, {
        title: 'Экспорт инстанса',
        defaultPath: path.join(maintenance.backupsDir(), `${instance.slug}-instance.zip`),
        filters: [{ name: 'Архив инстанса', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      const exported = await instances.export(instance.slug, result.filePath);
      return { ok: true, ...exported };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('instances:import', async () => {
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Импорт инстанса',
        properties: ['openFile'],
        filters: [{ name: 'Архив инстанса', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      const entry = await instances.import(result.filePaths[0]);
      return { ok: true, instance: entry, instances: instances.list() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('content:targets', () => ({ ok: true, targets: targets.listContentTargets() }));

  ipcMain.handle('content:search', async (_event, options) => {
    try {
      const hits = await content.search({
        targetId: options?.targetId,
        kind: options?.kind,
        query: options?.query,
        limit: options?.limit,
      });
      return { ok: true, hits };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('content:list', (_event, targetId) => {
    try {
      return { ok: true, ...content.list({ targetId }) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('content:install', async (_event, options) => {
    if (contentBusy) return { ok: false, error: 'Операция с контентом уже идёт.' };
    contentBusy = true;
    const progress = progressFor('content:progress');
    const log = logTo('content:log', 'launch:log');
    try {
      const result = await content.install({
        targetId: options?.targetId,
        kind: options?.kind,
        projectId: options?.projectId,
        versionId: options?.versionId || null,
        withDependencies: options?.withDependencies !== false,
        progress,
        log,
      });
      return { ok: true, ...result, ...content.list({ targetId: options?.targetId }) };
    } catch (err) {
      return serializeError(err);
    } finally {
      contentBusy = false;
    }
  });

  ipcMain.handle('content:remove', async (_event, options) => {
    try {
      await content.remove({ targetId: options?.targetId, key: options?.key });
      return { ok: true, ...content.list({ targetId: options?.targetId }) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('content:updates', async (_event, targetId) => {
    try {
      const updatesList = await content.checkUpdates({
        targetId,
        log: logTo('launch:log'),
      });
      return { ok: true, updates: updatesList };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('content:update', async (_event, options) => {
    if (contentBusy) return { ok: false, error: 'Операция с контентом уже идёт.' };
    contentBusy = true;
    try {
      const result = await content.update({
        targetId: options?.targetId,
        key: options?.key,
        progress: progressFor('content:progress'),
        log: logTo('content:log', 'launch:log'),
      });
      return { ok: true, ...result, ...content.list({ targetId: options?.targetId }) };
    } catch (err) {
      return serializeError(err);
    } finally {
      contentBusy = false;
    }
  });

  ipcMain.handle('content:conflicts', (_event, targetId) => {
    try {
      return { ok: true, ...content.conflicts({ targetId }) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('content:details', async (_event, projectId) => {
    try {
      return { ok: true, project: await content.details(projectId) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('content:import', async (_event, options) => {
    try {
      let filePath = options?.filePath || '';
      if (!filePath) {
        const result = await dialog.showOpenDialog(win, {
          title: 'Импорт контента',
          properties: ['openFile'],
          filters: [
            { name: 'Моды и паки', extensions: ['jar', 'zip'] },
            { name: 'Все файлы', extensions: ['*'] },
          ],
        });
        if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
        filePath = result.filePaths[0];
      }
      const imported = await content.importLocal({
        targetId: options?.targetId,
        kind: options?.kind,
        filePath,
        log: logTo('launch:log'),
      });
      return {
        ok: true,
        item: imported.item,
        ...content.list({ targetId: options?.targetId }),
      };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('maintenance:verify', async (_event, versionId) => {
    if (maintenanceBusy) return { ok: false, error: 'Обслуживание уже выполняется.' };
    maintenanceBusy = true;
    try {
      const result = await maintenance.verify(versionId, { deep: true });
      return { ok: true, summary: result.summary };
    } catch (err) {
      return serializeError(err);
    } finally {
      maintenanceBusy = false;
    }
  });

  ipcMain.handle('maintenance:repair', async (_event, versionId) => {
    if (maintenanceBusy) return { ok: false, error: 'Обслуживание уже выполняется.' };
    maintenanceBusy = true;
    try {
      const result = await maintenance.repair(versionId, {
        progress: progressFor('maintenance:progress'),
        log: logTo('maintenance:log', 'launch:log'),
      });
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    } finally {
      maintenanceBusy = false;
    }
  });

  ipcMain.handle('maintenance:reinstall-loader', async (_event, versionId) => {
    if (maintenanceBusy) return { ok: false, error: 'Обслуживание уже выполняется.' };
    maintenanceBusy = true;
    try {
      const result = await maintenance.reinstallLoader(versionId, {
        progress: progressFor('maintenance:progress'),
        log: logTo('maintenance:log', 'launch:log'),
      });
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    } finally {
      maintenanceBusy = false;
    }
  });

  ipcMain.handle('maintenance:reset', async (_event, versionId, options) => {
    if (maintenanceBusy) return { ok: false, error: 'Обслуживание уже выполняется.' };
    maintenanceBusy = true;
    try {
      const result = await maintenance.reset(versionId, {
        keepWorlds: options?.keepWorlds !== false,
        progress: progressFor('maintenance:progress'),
        log: logTo('maintenance:log', 'launch:log'),
      });
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    } finally {
      maintenanceBusy = false;
    }
  });

  ipcMain.handle('maintenance:crash', async (_event, versionId) => {
    try {
      return { ok: true, analysis: await maintenance.analyzeCrash(versionId) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('maintenance:cleanup', async (_event, options) => {
    if (maintenanceBusy) return { ok: false, error: 'Обслуживание уже выполняется.' };
    maintenanceBusy = true;
    try {
      const result = await maintenance.cleanup({ days: options?.days || config.get('cleanupDays') });
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    } finally {
      maintenanceBusy = false;
    }
  });

  ipcMain.handle('maintenance:disk', async () => {
    try {
      return { ok: true, ...(await maintenance.diskUsage()) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('maintenance:backups', async () => {
    try {
      return { ok: true, backups: await maintenance.listBackups() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('maintenance:backup-create', async (_event, versionId, options) => {
    if (maintenanceBusy) return { ok: false, error: 'Обслуживание уже выполняется.' };
    maintenanceBusy = true;
    try {
      const result = await maintenance.createBackup(versionId, {
        includeWorlds: options?.includeWorlds !== false,
        log: logTo('launch:log'),
      });
      return { ok: true, ...result, backups: await maintenance.listBackups() };
    } catch (err) {
      return serializeError(err);
    } finally {
      maintenanceBusy = false;
    }
  });

  ipcMain.handle('maintenance:backup-restore', async (_event, versionId, name) => {
    if (maintenanceBusy) return { ok: false, error: 'Обслуживание уже выполняется.' };
    maintenanceBusy = true;
    try {
      const result = await maintenance.restoreBackup(versionId, name);
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    } finally {
      maintenanceBusy = false;
    }
  });

  ipcMain.handle('maintenance:backup-delete', async (_event, name) => {
    try {
      await maintenance.deleteBackup(name);
      return { ok: true, backups: await maintenance.listBackups() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('servers:list', () => ({ ok: true, servers: servers.list() }));

  ipcMain.handle('servers:add', (_event, options) => {
    try {
      const server = servers.add(options || {});
      return { ok: true, server, servers: servers.list() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('servers:remove', (_event, id) => {
    try {
      servers.remove(String(id || ''));
      return { ok: true, servers: servers.list() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('servers:ping', async (_event, id) => {
    try {
      return { ok: true, server: await servers.ping(String(id || '')) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('servers:ping-all', async () => {
    try {
      return { ok: true, servers: await servers.pingAll() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('stats:get', () => ({ ok: true, summary: stats.summary() }));

  ipcMain.handle('stats:reset', () => ({ ok: true, ...stats.reset() }));

  ipcMain.handle('discord:status', () => ({ ok: true, ...discord.status() }));

  ipcMain.handle('discord:activity', (_event, patch) => {
    try {
      return { ok: true, ...discord.setActivity(patch || {}) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('updates:check', async () => {
    try {
      const info = await updates.check();
      lastUpdateInfo = info;
      return { ok: true, update: info };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('updates:download', async () => {
    if (updateBusy) return { ok: false, error: 'Загрузка обновления уже идёт.' };
    updateBusy = true;
    try {
      if (!lastUpdateInfo?.hasUpdate) {
        lastUpdateInfo = await updates.check();
      }
      if (!lastUpdateInfo.hasUpdate) throw new Error('Обновлений нет.');
      const progress = progressFor('update:progress');
      progress.setStage('update');
      const file = await updates.download(lastUpdateInfo, {
        onProgress: (n) => progress.add(n),
      });
      lastUpdateFile = file.path;
      return { ok: true, ...file, update: lastUpdateInfo };
    } catch (err) {
      return serializeError(err);
    } finally {
      updateBusy = false;
    }
  });

  ipcMain.handle('updates:install', async () => {
    try {
      if (!lastUpdateFile) throw new Error('Сначала скачайте обновление.');
      const result = await updates.install(lastUpdateFile);
      setTimeout(() => app.quit(), 800);
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('sync:export-settings', async () => {
    try {
      const result = await dialog.showSaveDialog(win, {
        title: 'Экспорт настроек',
        defaultPath: path.join(app.getPath('documents'), 'minelauncher-settings.json'),
        filters: [{ name: 'Настройки MineLauncher', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      return { ok: true, ...(await sync.exportSettings(result.filePath)) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('sync:import-settings', async () => {
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Импорт настроек',
        properties: ['openFile'],
        filters: [{ name: 'Настройки MineLauncher', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      const imported = await sync.importSettings(result.filePaths[0]);
      await applyRuntimeSettings();
      return { ok: true, ...imported, config: publicConfig() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('sync:export-worlds', async (_event, versionId) => {
    try {
      const result = await dialog.showSaveDialog(win, {
        title: 'Экспорт миров',
        defaultPath: path.join(app.getPath('documents'), 'minelauncher-worlds.zip'),
        filters: [{ name: 'Архив миров', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      return { ok: true, ...(await sync.exportWorlds(versionId, result.filePath)) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('sync:import-worlds', async (_event, versionId) => {
    try {
      const result = await dialog.showOpenDialog(win, {
        title: 'Импорт миров',
        properties: ['openFile'],
        filters: [{ name: 'Архив миров', extensions: ['zip'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
      return { ok: true, ...(await sync.importWorlds(versionId, result.filePaths[0])) };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('net:diagnostics', async () => {
    try {
      return { ok: true, results: await diagnose() };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('net:settings', () => ({
    ok: true,
    network: networkSettings(),
    proxyMode: config.get('proxyMode'),
    proxyUrl: config.get('proxyUrl'),
    mirrorMode: config.get('mirrorMode'),
  }));

  ipcMain.handle('java:detect', async () => {
    try {
      const result = await detectJava({
        gameDir: config.get('gameDir'),
        preferred: config.get('javaPath'),
        requiredMajor: 8,
        refresh: true,
      });
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('java:install', async (_event, options) => {
    if (javaInstalling) return { ok: false, error: 'Установка Java уже идёт.' };
    javaInstalling = true;
    try {
      const result = await launcher.installJava({
        component: options?.component || '',
        majorVersion: Number(options?.majorVersion) || 21,
      });
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    } finally {
      javaInstalling = false;
    }
  });

  ipcMain.handle('account:offline', (_event, name) => {
    const account = offlineAccount(name);
    config.update({
      username: account.name,
      accountType: 'offline',
    });
    return { ok: true, account };
  });

  ipcMain.handle('account:ms-login', async (_event, clientId) => {
    try {
      if (!clientId) throw new Error('Укажите Azure Client ID.');
      config.update({ msClientId: clientId });
      msAbort?.abort();
      msAbort = new AbortController();

      const account = await loginMicrosoft({
        clientId,
        signal: msAbort.signal,
        onDeviceCode: (code) => send('ms:device', code),
      });

      config.update({
        accountType: 'microsoft',
        msRefreshToken: account.refreshToken,
        msProfile: { name: account.name, uuid: account.uuid },
        username: account.name,
      });
      return { ok: true, profile: { name: account.name, uuid: account.uuid } };
    } catch (err) {
      return serializeError(err);
    } finally {
      msAbort = null;
    }
  });

  ipcMain.handle('account:ms-cancel', () => {
    msAbort?.abort();
    msAbort = null;
    return { ok: true };
  });

  ipcMain.handle('account:logout', () => {
    config.update({
      accountType: 'offline',
      msRefreshToken: '',
      msProfile: null,
    });
    return { ok: true };
  });

  ipcMain.handle('launch', async (_event, versionId) => {
    try {
      if (!versionId) throw new Error('Версия не выбрана.');
      const account = await resolveAccount();
      const result = await launcher.launch({ versionId, account });
      if (!result.ok && !result.cancelled) {
        try {
          result.crash = await maintenance.analyzeCrash(versionId);
          if (result.crash?.found) send('launch:crash', { versionId, analysis: result.crash });
        } catch {
          // crash analysis must never hide the original result
        }
      }
      return { ok: true, ...result };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('launch:cancel', () => ({ ok: launcher.cancel() }));

  ipcMain.handle('folder:open', async (_event, which) => {
    const gameDir = config.get('gameDir');
    const target = which === 'logs' ? path.join(gameDir, 'logs') : gameDir;
    fs.mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    return { ok: !error, error };
  });

  ipcMain.handle('folder:open-target', async (_event, versionId, sub) => {
    try {
      const allowed = new Set([
        'instance',
        'mods',
        'resourcepacks',
        'shaderpacks',
        'saves',
        'logs',
        'crash-reports',
        'backups',
        'cache',
      ]);
      const folder = String(sub || 'instance');
      if (!allowed.has(folder)) throw new Error('Папка недоступна.');
      let targetDir;
      if (folder === 'backups') targetDir = maintenance.backupsDir();
      else if (folder === 'cache') targetDir = cacheDir;
      else {
        const resolved = targets.resolve(versionId);
        targetDir = folder === 'instance' ? resolved.instanceDir : path.join(resolved.instanceDir, folder);
      }
      fs.mkdirSync(targetDir, { recursive: true });
      const error = await shell.openPath(targetDir);
      return { ok: !error, error, path: targetDir };
    } catch (err) {
      return serializeError(err);
    }
  });

  ipcMain.handle('link:open', async (_event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { ok: false, error: 'Разрешены только http(s)-ссылки.' };
      }
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch {
      return { ok: false, error: 'Некорректная ссылка.' };
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData,
    gameDir: config.get('gameDir'),
    cacheDir,
    platform: process.platform,
    arch: process.arch,
  }));

  ipcMain.on('window:minimize', () => win?.minimize());
  ipcMain.on('window:maximize', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on('window:close', () => win?.close());
}

const gotLock = process.env.ML_SMOKE === '1' ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    registerIpc();
    createWindow();
    await applyRuntimeSettings();
    if (config.get('autoUpdateCheck') && config.get('updateFeedUrl')) {
      updateCheckTimer = setTimeout(() => {
        silentUpdateCheck();
      }, 5000);
      updateCheckTimer.unref?.();
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    discord.stop();
    clearTimeout(updateCheckTimer);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  if (win && !win.isDestroyed()) {
    dialog.showErrorBox('Ошибка лаунчера', err.stack || err.message);
  }
});
