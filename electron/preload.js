'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set([
  'launch:progress',
  'launch:log',
  'launch:exit',
  'launch:crash',
  'ms:device',
  'modpack:progress',
  'modpack:log',
  'content:progress',
  'content:log',
  'maintenance:progress',
  'maintenance:log',
  'update:available',
  'update:progress',
  'update:checked',
]);

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  getVersions: (force) => ipcRenderer.invoke('versions:list', force),
  getVersionMeta: (versionId) => ipcRenderer.invoke('versions:meta', versionId),
  getLoaderCatalog: (force) => ipcRenderer.invoke('loaders:catalog', force),
  detectJava: () => ipcRenderer.invoke('java:detect'),
  installJava: (component, majorVersion) =>
    ipcRenderer.invoke('java:install', { component, majorVersion }),

  getModpacks: () => ipcRenderer.invoke('modpacks:list'),
  searchModpacks: (query) => ipcRenderer.invoke('modpacks:search', query),
  installModpack: (projectId) => ipcRenderer.invoke('modpacks:install', projectId),
  removeModpack: (slug) => ipcRenderer.invoke('modpacks:remove', slug),
  checkModpackUpdates: () => ipcRenderer.invoke('modpacks:check-updates'),
  updateModpack: (slug) => ipcRenderer.invoke('modpacks:update', slug),

  listInstances: () => ipcRenderer.invoke('instances:list'),
  createInstance: (patch) => ipcRenderer.invoke('instances:create', patch),
  updateInstance: (slug, patch) => ipcRenderer.invoke('instances:update', slug, patch),
  removeInstance: (slug) => ipcRenderer.invoke('instances:remove', slug),
  exportInstance: (slug) => ipcRenderer.invoke('instances:export', slug),
  importInstance: () => ipcRenderer.invoke('instances:import'),

  getContentTargets: () => ipcRenderer.invoke('content:targets'),
  searchContent: (options) => ipcRenderer.invoke('content:search', options),
  listContent: (targetId) => ipcRenderer.invoke('content:list', targetId),
  installContent: (options) => ipcRenderer.invoke('content:install', options),
  removeContent: (options) => ipcRenderer.invoke('content:remove', options),
  checkContentUpdates: (targetId) => ipcRenderer.invoke('content:updates', targetId),
  updateContent: (options) => ipcRenderer.invoke('content:update', options),
  getContentConflicts: (targetId) => ipcRenderer.invoke('content:conflicts', targetId),
  getContentDetails: (projectId) => ipcRenderer.invoke('content:details', projectId),
  importContent: (options) => ipcRenderer.invoke('content:import', options),

  verifyFiles: (versionId) => ipcRenderer.invoke('maintenance:verify', versionId),
  repairFiles: (versionId) => ipcRenderer.invoke('maintenance:repair', versionId),
  reinstallLoader: (versionId) => ipcRenderer.invoke('maintenance:reinstall-loader', versionId),
  resetInstance: (versionId, options) => ipcRenderer.invoke('maintenance:reset', versionId, options),
  analyzeCrash: (versionId) => ipcRenderer.invoke('maintenance:crash', versionId),
  cleanupFiles: (options) => ipcRenderer.invoke('maintenance:cleanup', options),
  getDiskUsage: () => ipcRenderer.invoke('maintenance:disk'),
  getBackups: () => ipcRenderer.invoke('maintenance:backups'),
  createBackup: (versionId, options) => ipcRenderer.invoke('maintenance:backup-create', versionId, options),
  restoreBackup: (versionId, name) => ipcRenderer.invoke('maintenance:backup-restore', versionId, name),
  deleteBackup: (name) => ipcRenderer.invoke('maintenance:backup-delete', name),

  getServers: () => ipcRenderer.invoke('servers:list'),
  addServer: (options) => ipcRenderer.invoke('servers:add', options),
  removeServer: (id) => ipcRenderer.invoke('servers:remove', id),
  pingServer: (id) => ipcRenderer.invoke('servers:ping', id),
  pingAllServers: () => ipcRenderer.invoke('servers:ping-all'),

  getStats: () => ipcRenderer.invoke('stats:get'),
  resetStats: () => ipcRenderer.invoke('stats:reset'),

  getDiscordStatus: () => ipcRenderer.invoke('discord:status'),
  setDiscordActivity: (patch) => ipcRenderer.invoke('discord:activity', patch),

  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),

  getNetworkSettings: () => ipcRenderer.invoke('net:settings'),
  runDiagnostics: () => ipcRenderer.invoke('net:diagnostics'),

  exportSettings: () => ipcRenderer.invoke('sync:export-settings'),
  importSettings: () => ipcRenderer.invoke('sync:import-settings'),
  exportWorlds: (versionId) => ipcRenderer.invoke('sync:export-worlds', versionId),
  importWorlds: (versionId) => ipcRenderer.invoke('sync:import-worlds', versionId),

  offlineLogin: (name) => ipcRenderer.invoke('account:offline', name),
  msLogin: (clientId) => ipcRenderer.invoke('account:ms-login', clientId),
  msCancel: () => ipcRenderer.invoke('account:ms-cancel'),
  logout: () => ipcRenderer.invoke('account:logout'),

  launch: (versionId) => ipcRenderer.invoke('launch', versionId),
  cancel: () => ipcRenderer.invoke('launch:cancel'),

  openFolder: (which) => ipcRenderer.invoke('folder:open', which),
  openTargetFolder: (versionId, sub) => ipcRenderer.invoke('folder:open-target', versionId, sub),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  appInfo: () => ipcRenderer.invoke('app:info'),
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  on: (channel, callback) => {
    if (!EVENTS.has(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
