// Generate a simple teal rounded-square PNG app/tray icon (no external deps).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 64;

function px(x, y) {
  const r = 14;
  const inside =
    x >= 0 && y >= 0 && x < SIZE && y < SIZE &&
    !(x < r && y < r && (r - x) ** 2 + (r - y) ** 2 > r * r) &&
    !(x >= SIZE - r && y < r && (x - (SIZE - r - 1)) ** 2 + (r - y) ** 2 > r * r) &&
    !(x < r && y >= SIZE - r && (r - x) ** 2 + (y - (SIZE - r - 1)) ** 2 > r * r) &&
    !(x >= SIZE - r && y >= SIZE - r && (x - (SIZE - r - 1)) ** 2 + (y - (SIZE - r - 1)) ** 2 > r * r);
  if (!inside) return [0, 0, 0, 0];
  const t = (x + y) / (2 * SIZE);
  let R = Math.round(45 + t * (59 - 45));
  let G = Math.round(212 + t * (130 - 212));
  let B = Math.round(191 + t * (246 - 191));
  for (const base of [24, 40]) {
    const wave = base + Math.sin((x / SIZE) * Math.PI * 2) * 4;
    if (Math.abs(y - wave) < 2.2 && x > 12 && x < 52) {
      R = 4; G = 32; B = 29;
    }
  }
  return [R, G, B, 255];
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = px(x, y);
    raw[o++] = r;
    raw[o++] = g;
    raw[o++] = b;
    raw[o++] = a;
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
