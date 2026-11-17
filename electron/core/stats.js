'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Stats {
  constructor({ registryFile }) {
    this.registryFile = registryFile;
    this._data = null;
  }

  read() {
    if (this._data) return this._data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      this._data = {
        sessions: Array.isArray(raw?.sessions) ? raw.sessions : [],
        createdAt: raw?.createdAt || new Date().toISOString(),
      };
    } catch {
      this._data = { sessions: [], createdAt: new Date().toISOString() };
    }
    return this._data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
    const tmp = `${this.registryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.read(), null, 2), 'utf8');
    fs.renameSync(tmp, this.registryFile);
  }

  begin({ targetId, name, mcVersion }) {
    const data = this.read();
    const session = {
      id: crypto.randomUUID(),
      targetId: String(targetId || ''),
      name: String(name || targetId || 'Minecraft'),
      mcVersion: String(mcVersion || ''),
      startedAt: new Date().toISOString(),
      seconds: 0,
      exitCode: null,
      endedAt: null,
    };
    data.sessions.push(session);
    if (data.sessions.length > 300) data.sessions = data.sessions.slice(-300);
    this.save();
    return session.id;
  }

  end(id, { seconds, exitCode = null, crashed = false } = {}) {
    const data = this.read();
    const session = data.sessions.find((entry) => entry.id === id);
    if (!session) return null;
    session.seconds = Math.max(0, Math.round(Number(seconds) || 0));
    session.exitCode = exitCode;
    session.endedAt = new Date().toISOString();
    session.crashed = Boolean(crashed);
    this.save();
    return session;
  }

  summary() {
    const data = this.read();
    const sessions = [...data.sessions].sort(
      (a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0)
    );
    const completed = sessions.filter((session) => session.seconds > 0);
    const totalSeconds = sessions.reduce((sum, session) => sum + (Number(session.seconds) || 0), 0);
    const launches = sessions.length;
    const byTarget = new Map();
    for (const session of sessions) {
      const key = session.targetId || 'unknown';
      const current = byTarget.get(key) || {
        targetId: key,
        name: session.name || key,
        launches: 0,
        seconds: 0,
        lastPlayed: '',
        crashes: 0,
      };
      current.name = session.name || current.name;
      current.launches++;
      current.seconds += Number(session.seconds) || 0;
      current.crashes += session.crashed ? 1 : 0;
      if (!current.lastPlayed || new Date(session.startedAt) > new Date(current.lastPlayed)) {
        current.lastPlayed = session.startedAt;
      }
      byTarget.set(key, current);
    }
    return {
      launches,
      totalSeconds,
      totalSessionsPlayed: completed.length,
      lastPlayed: sessions[0]?.startedAt || '',
      averageSeconds: completed.length ? Math.round(totalSeconds / completed.length) : 0,
      crashes: sessions.filter((session) => session.crashed).length,
      byTarget: [...byTarget.values()].sort((a, b) => b.seconds - a.seconds),
      recent: sessions.slice(0, 25),
    };
  }

  reset() {
    this._data = { sessions: [], createdAt: new Date().toISOString() };
    this.save();
    return { ok: true };
  }
}

module.exports = { Stats };
