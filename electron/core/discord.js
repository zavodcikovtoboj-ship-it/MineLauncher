'use strict';

const net = require('net');
const crypto = require('crypto');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_PING = 3;
const OP_PONG = 4;

// Application ID of the launcher's own Discord app, registered at
// https://discord.com/developers/applications. The value is public and is not
// a secret. A non-empty ID in Settings overrides this built-in one.
const BUILTIN_CLIENT_ID = '1571927876310274119';

function encodeFrame(op, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + data.length);
  frame.writeInt32LE(op, 0);
  frame.writeInt32LE(data.length, 4);
  data.copy(frame, 8);
  return frame;
}

/**
 * Minimal Discord Rich Presence client over the local IPC socket.
 * No third-party dependency; silently disables itself when Discord is absent.
 */
class DiscordRpc {
  constructor({ config, log }) {
    this.config = config;
    this.log = log || (() => {});
    this.socket = null;
    this.connected = false;
    this.stopped = true;
    this.buffer = Buffer.alloc(0);
    this.retryTimer = null;
    this.clientId = '';
    this.pipeIndex = 0;
    this.activity = {
      details: 'В лаунчере',
      state: 'MineLauncher',
      startTimestamp: Date.now(),
    };
  }

  resolveClientId() {
    const configured = String(this.config.get('discordClientId') || '').trim();
    return configured || BUILTIN_CLIENT_ID;
  }

  enabled() {
    return Boolean(this.resolveClientId());
  }

  status() {
    const configured = String(this.config.get('discordClientId') || '').trim();
    const clientId = this.resolveClientId();
    return {
      enabled: Boolean(clientId),
      connected: this.connected,
      clientId,
      builtin: Boolean(clientId && !configured),
    };
  }

  configure() {
    const id = this.resolveClientId();
    if (!id) {
      this.stop();
      return;
    }
    if (this.clientId !== id) {
      this.stop();
      this.clientId = id;
      this.start();
      return;
    }
    if (!this.connected) this.start();
  }

  setActivity(patch = {}) {
    if (patch.details !== undefined) this.activity.details = String(patch.details).slice(0, 128);
    if (patch.state !== undefined) this.activity.state = String(patch.state).slice(0, 128);
    if (patch.startTimestamp) this.activity.startTimestamp = Number(patch.startTimestamp) || Date.now();
    if (this.enabled()) {
      if (!this.connected) this.start();
      else this.sendActivity();
    }
    return this.status();
  }

  sendActivity() {
    if (!this.socket || !this.connected) return;
    const activity = {
      details: this.activity.details,
      state: this.activity.state,
      timestamps: { start: this.activity.startTimestamp },
      instance: false,
    };
    this.send(OP_FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: crypto.randomUUID(),
    });
  }

  send(op, payload) {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(op, payload));
    } catch {
      this.handleClose();
    }
  }

  start() {
    const id = this.resolveClientId();
    if (!id) {
      this.stop();
      return;
    }
    // A connection attempt or a pending retry is already running.
    if (!this.stopped && (this.socket || this.retryTimer)) return;
    this.clientId = id;
    this.stopped = false;
    this.pipeIndex = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.tryPipe();
  }

  tryPipe() {
    if (this.stopped || !this.clientId) return;
    if (this.pipeIndex > 9) {
      this.scheduleRetry();
      return;
    }
    const pipe = process.platform === 'win32'
      ? `\\\\?\\pipe\\discord-ipc-${this.pipeIndex}`
      : `/tmp/discord-ipc-${this.pipeIndex}`;
    this.pipeIndex++;
    const socket = net.createConnection(pipe);
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    let opened = false;
    let moved = false;

    const fail = () => {
      if (moved) return;
      moved = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      if (this.socket === socket) this.socket = null;
      if (!opened) this.tryPipe();
    };

    socket.once('connect', () => {
      opened = true;
      this.connected = false;
      this.send(OP_HANDSHAKE, { v: 1, client_id: this.clientId });
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', fail);
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.connected = false;
      }
      if (opened) this.scheduleRetry();
      else fail();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > 8 * 1024 * 1024) {
        this.handleClose();
        return;
      }
      if (this.buffer.length < 8 + length) return;
      const payload = this.buffer.slice(8, 8 + length).toString('utf8');
      this.buffer = this.buffer.slice(8 + length);
      let data = null;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (op === OP_PING) {
        this.send(OP_PONG, data);
        continue;
      }
      if (data?.evt === 'READY' || data?.cmd === 'DISPATCH') {
        this.connected = true;
        this.log('Discord Rich Presence подключён.');
        this.sendActivity();
      }
    }
  }

  scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.connected && !this.stopped) {
        this.pipeIndex = 0;
        this.tryPipe();
      }
    }, 15000);
    this.retryTimer.unref?.();
  }

  handleClose() {
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.socket = null;
    this.connected = false;
    this.scheduleRetry();
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.send(OP_FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null },
        nonce: crypto.randomUUID(),
      });
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.socket = null;
  }
}

module.exports = { DiscordRpc };
