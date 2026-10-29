// Generates the app icons as plain PNGs: node pwa/tools/make-icons.mjs
// No dependencies and no downloads. A navy square with a blue disc, a white ring and a white
// dot: simple on purpose, and inside the maskable safe zone (central 80%).
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
const NAVY = [31, 45, 61];
const BLUE = [58, 120, 216];
const WHITE = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
const coverage = (distance, edge) => Math.min(1, Math.max(0, edge - distance + 0.5)); // 1px soft edge

function pixel(x, y, size) {
  const dx = x + 0.5 - size / 2;
  const dy = y + 0.5 - size / 2;
  const r = Math.hypot(dx, dy);
  let color = NAVY;
  color = mix(color, BLUE, coverage(r, size * 0.3));
  color = mix(color, WHITE, coverage(Math.abs(r - size * 0.3), size * 0.018));
  return mix(color, WHITE, coverage(r, size * 0.07));
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB
    for (let x = 0; x < size; x += 1) Buffer.from(pixel(x, y, size)).copy(row, 1 + x * 3);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(join(OUT, name), png(size));
  console.log(`wrote icons/${name} (${size}x${size})`);
}
