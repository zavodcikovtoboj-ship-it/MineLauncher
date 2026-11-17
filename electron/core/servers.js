'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');

const DEFAULT_SERVERS = [
  { id: 'hypixel', name: 'Hypixel', address: 'mc.hypixel.net' },
  { id: 'cubecraft', name: 'CubeCraft', address: 'play.cubecraft.net' },
  { id: 'mineblaze', name: 'MineBlaze', address: 'mc.mineblaze.net' },
];

function parseAddress(input) {
  const value = String(input || '').trim();
  if (!value) throw new Error('Укажите адрес сервера.');
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) throw new Error('Некорректный IPv6-адрес.');
    const host = value.slice(1, end);
    const rest = value.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : 25565;
    return { host, port: Number.isFinite(port) && port > 0 ? port : 25565, explicitPort: rest.startsWith(':') };
  }
  const parts = value.split(':');
  if (parts.length === 2) {
    const port = Number(parts[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Некорректный порт.');
    return { host: parts[0], port, explicitPort: true };
  }
  if (parts.length > 2) throw new Error('Некорректный адрес сервера.');
  return { host: value, port: 25565, explicitPort: false };
}

function writeVarInt(value) {
  const bytes = [];
  let current = Number(value) >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (current !== 0);
  return Buffer.from(bytes);
}

function writeString(value) {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function readVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  let position = offset;
  while (position < buffer.length) {
    const byte = buffer[position++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, size: position - offset };
    }
    shift += 7;
    if (shift > 35) throw new Error('Слишком длинный VarInt.');
  }
  return null;
}

function frame(payload) {
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

function chatToText(component) {
  if (component === null || component === undefined) return '';
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map(chatToText).join('');
  if (typeof component !== 'object') return String(component);
  return `${component.text || ''}${component.extra ? component.extra.map(chatToText).join('') : ''}`;
}

function cleanMotd(value) {
  return String(value || '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readPacket(socket, state) {
  const varint = readVarInt(state.buffer, 0);
  if (!varint) return null;
  if (varint.size > 5 || varint.value > 2 * 1024 * 1024) throw new Error('Некорректный пакет сервера.');
  if (state.buffer.length < varint.size + varint.value) return null;
  const data = state.buffer.slice(varint.size, varint.size + varint.value);
  state.buffer = state.buffer.slice(varint.size + varint.value);
  return data;
}

async function resolveTarget(host, port, explicitPort) {
  if (explicitPort) return { host, port };
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (records.length) {
      const record = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      return { host: record.name, port: record.port };
    }
  } catch {
    // no SRV record
  }
  return { host, port };
}

function pingServer(address, { timeout = 6000 } = {}) {
  const parsed = parseAddress(address);
  const started = Date.now();
  return new Promise(async (resolve, reject) => {
    let socket;
    let timer;
    let settled = false;
    const state = { buffer: Buffer.alloc(0), stage: 'handshake' };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // ignore
      }
      if (error) reject(error);
      else resolve(value);
    };

    try {
      const target = await resolveTarget(parsed.host, parsed.port, parsed.explicitPort);
      socket = net.connect({ host: target.host, port: target.port });
      socket.setNoDelay(true);

      timer = setTimeout(() => finish(new Error('Сервер не ответил вовремя.')), timeout);
      socket.setTimeout(timeout, () => finish(new Error('Таймаут соединения.')));

      socket.on('error', (err) => finish(new Error(err.code === 'ECONNREFUSED' ? 'Соединение отклонено.' : err.message)));

      socket.on('connect', () => {
        const handshake = Buffer.concat([
          writeVarInt(0x00),
          writeVarInt(769),
          writeString(parsed.host),
          Buffer.from([(parsed.port >> 8) & 0xff, parsed.port & 0xff]),
          writeVarInt(1),
        ]);
        socket.write(frame(handshake));
        socket.write(frame(Buffer.from([0x00])));
      });

      socket.on('data', (chunk) => {
        if (settled) return;
        state.buffer = Buffer.concat([state.buffer, chunk]);
        try {
          const packet = readPacket(socket, state);
          if (!packet) return;
          const id = readVarInt(packet, 0);
          if (!id || id.value !== 0) throw new Error('Сервер прислал неизвестный пакет.');
          const length = readVarInt(packet, id.size);
          if (!length) throw new Error('Некорректный ответ сервера.');
          const json = packet.slice(id.size + length.size, id.size + length.size + length.value).toString('utf8');
          const data = JSON.parse(json);
          const description = cleanMotd(chatToText(data.description));
          const players = data.players || {};
          finish(null, {
            online: true,
            latency: Date.now() - started,
            version: data.version?.name || '',
            protocol: data.version?.protocol || 0,
            players: {
              online: Number(players.online) || 0,
              max: Number(players.max) || 0,
              sample: Array.isArray(players.sample)
                ? players.sample.slice(0, 12).map((player) => String(player.name || '')).filter(Boolean)
                : [],
            },
            motd: description,
            favicon: typeof data.favicon === 'string' ? data.favicon : '',
            host: target.host,
            port: target.port,
          });
        } catch (err) {
          finish(err);
        }
      });

      socket.on('close', () => {
        if (!settled) finish(new Error('Сервер закрыл соединение.'));
      });
    } catch (err) {
      finish(err);
    }
  });
}

class Servers {
  constructor({ registryFile }) {
    this.registryFile = registryFile;
    this._registry = null;
  }

  readRegistry() {
    if (this._registry) return this._registry;
    try {
      const raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      this._registry = { servers: Array.isArray(raw?.servers) ? raw.servers : [] };
    } catch {
      this._registry = {
        servers: DEFAULT_SERVERS.map((entry) => ({ ...entry, createdAt: new Date().toISOString() })),
      };
      this.saveRegistry();
    }
    return this._registry;
  }

  saveRegistry() {
    fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
    const tmp = `${this.registryFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.readRegistry(), null, 2), 'utf8');
    fs.renameSync(tmp, this.registryFile);
  }

  list() {
    return [...this.readRegistry().servers];
  }

  add({ name, address }) {
    const parsed = parseAddress(address);
    const normalized = `${parsed.host}:${parsed.port}`;
    const servers = this.readRegistry().servers;
    if (servers.some((server) => parseAddress(server.address).host === parsed.host && parseAddress(server.address).port === parsed.port)) {
      throw new Error('Такой сервер уже есть в списке.');
    }
    const entry = {
      id: crypto.randomUUID(),
      name: String(name || parsed.host).trim().slice(0, 48) || parsed.host,
      address: parsed.explicitPort || parsed.port !== 25565 ? normalized : parsed.host,
      createdAt: new Date().toISOString(),
    };
    servers.push(entry);
    this.saveRegistry();
    return entry;
  }

  remove(id) {
    const registry = this.readRegistry();
    const before = registry.servers.length;
    registry.servers = registry.servers.filter((server) => server.id !== id);
    this.saveRegistry();
    if (registry.servers.length === before) throw new Error('Сервер не найден.');
    return { ok: true };
  }

  async ping(id, options) {
    const server = this.list().find((entry) => entry.id === id);
    if (!server) throw new Error('Сервер не найден.');
    try {
      const status = await pingServer(server.address, options);
      return { ...server, status, error: '' };
    } catch (err) {
      return {
        ...server,
        status: null,
        error: err.message || 'Сервер недоступен.',
      };
    }
  }

  async pingAll(options) {
    const servers = this.list();
    const results = [];
    let index = 0;
    const worker = async () => {
      while (index < servers.length) {
        const server = servers[index++];
        results.push(await this.ping(server.id, options));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, servers.length) }, worker));
    const order = new Map(servers.map((server, position) => [server.id, position]));
    return results.sort((a, b) => order.get(a.id) - order.get(b.id));
  }
}

module.exports = { Servers, pingServer, parseAddress, cleanMotd, chatToText };
