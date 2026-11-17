'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  username: 'Player',
  accountType: 'offline',
  msClientId: '',
  msRefreshToken: '',
  msProfile: null,
  ramMb: 4096,
  javaPath: '',
  gameDir: '',
  jvmArgs: '',
  customResolution: false,
  width: 1280,
  height: 720,
  selectedVersion: '',
  showSnapshots: false,
  closeOnLaunch: false,
  theme: 'dark',
  accent: 'green',
  language: 'ru',
  speedLimitKbps: 0,
  proxyMode: 'system',
  proxyUrl: '',
  mirrorMode: 'auto',
  autoUpdateCheck: true,
  updateFeedUrl: '',
  discordClientId: '',
  cleanupDays: 7,
  backupRetention: 10,
};

class Config {
  constructor(file, defaultGameDir) {
    this.file = file;
    this.defaultGameDir = defaultGameDir;
    this.data = { ...DEFAULTS };
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (raw[key] !== undefined && raw[key] !== null) this.data[key] = raw[key];
      }
    } catch {
      // first run or corrupt file: defaults are fine
    }
    if (!this.data.gameDir) this.data.gameDir = this.defaultGameDir;
    return this.data;
  }

  all() {
    return { ...this.data };
  }

  get(key) {
    return this.data[key];
  }

  update(patch) {
    for (const key of Object.keys(DEFAULTS)) {
      if (patch[key] !== undefined) this.data[key] = patch[key];
    }
    this.save();
    return this.all();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Config, DEFAULTS };
