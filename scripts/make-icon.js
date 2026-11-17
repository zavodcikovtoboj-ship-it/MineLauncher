'use strict';

// Procedurally renders build/icon.png and build/icon.ico without any image
// dependencies. The icon mirrors the launcher logo: four pixel blocks on a
// dark rounded tile.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function roundRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 256;
  const blockSize = 70 * scale;
  const gap = 12 * scale;
  const total = blockSize * 2 + gap;
  const origin = (size - total) / 2;
  const colors = [
    [69, 225, 142],
    [52, 201, 122],
    [47, 185, 111],
    [58, 208, 127],
  ];

  const samples = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = px + (sx + 0.5) / samples;
          const y = py + (sy + 0.5) / samples;

          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;

          const tile = roundRect(x, y, 4 * scale, 4 * scale, size - 4 * scale, size - 4 * scale, 58 * scale);
          if (tile) {
            // Vertical background gradient plus a faint green glow behind blocks.
            const t = y / size;
            [cr, cg, cb] = mix([19, 24, 31], [8, 11, 15], t);
            const glowX = x - size / 2;
            const glowY = y - size / 2;
            const glow = Math.max(0, 1 - Math.sqrt(glowX * glowX + glowY * glowY) / (size * 0.48));
            [cr, cg, cb] = mix([cr, cg, cb], [23, 72, 50], glow * 0.38);
            ca = 255;

            // Subtle tile border.
            if (
              !roundRect(
                x,
                y,
                6.5 * scale,
                6.5 * scale,
                size - 6.5 * scale,
                size - 6.5 * scale,
                55 * scale
              )
            ) {
              [cr, cg, cb] = mix([cr, cg, cb], [48, 60, 73], 0.55);
            }
          }

          for (let i = 0; i < 4; i++) {
            const bx = origin + (i % 2) * (blockSize + gap);
            const by = origin + Math.floor(i / 2) * (blockSize + gap);
            if (!roundRect(x, y, bx, by, bx + blockSize, by + blockSize, 9 * scale)) continue;

            const color = colors[i];
            // Diagonal lighting: bright at the top-left, darker bottom-right.
            const u = (x - bx) / blockSize;
            const v = (y - by) / blockSize;
            const light = 1.16 - (u + v) * 0.24;
            [cr, cg, cb] = color.map((c) => Math.round(c * light));
            ca = 255;

            // Pixel-art inner border.
            const edge = 3.5 * scale;
            const inner = roundRect(
              x,
              y,
              bx + edge,
              by + edge,
              bx + blockSize - edge,
              by + blockSize - edge,
              6 * scale
            );
            if (!inner) [cr, cg, cb] = mix([cr, cg, cb], [15, 41, 29], 0.42);
          }

          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }

      const count = samples * samples;
      const index = (py * size + px) * 4;
      rgba[index] = Math.round(r / count);
      rgba[index + 1] = Math.round(g / count);
      rgba[index + 2] = Math.round(b / count);
      rgba[index + 3] = Math.round(a / count);
    }
  }

  return rgba;
}

function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, png]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const icon256 = encodePng(256, 256, render(256));
const icon512 = encodePng(512, 512, render(512));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), icon512);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(icon256, 256));

console.log('icon.png:', path.join(OUT_DIR, 'icon.png'));
console.log('icon.ico:', path.join(OUT_DIR, 'icon.ico'));
