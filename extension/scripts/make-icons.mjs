#!/usr/bin/env node
/**
 * Generates the extension's PNG icons from code.
 *
 * Written as a generator rather than checked-in binaries so the icon always
 * matches the accent token — change `color.accent` in tokens.ts and rerun
 * `npm run build:icons`, and the icon follows. It also keeps the repository free
 * of binary assets that nobody can diff.
 *
 * The mark is a magnifying-glass ring: "scope", drawn in the accent teal.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'public/icons');

const SIZES = [16, 32, 48, 128];

/** Read straight from the token file so the icon can never drift from the UI. */
function accentColor() {
  const source = readFileSync(resolve(root, 'src/design/tokens.ts'), 'utf8');
  const match = /accent:\s*'(#[0-9A-Fa-f]{6})'/.exec(source);
  if (!match) throw new Error('Could not read the accent colour from tokens.ts');
  const hex = match[1];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Renders one icon into an RGBA buffer.
 *
 * Coverage is sampled 3x3 per pixel rather than tested once at the centre;
 * at 16px a hard-edged circle is visibly jagged, and supersampling is the
 * cheapest fix that does not require a rasterising dependency.
 */
function render(size, [r, g, b]) {
  const pixels = Buffer.alloc(size * size * 4);
  const s = size;

  // Geometry in unit coordinates, scaled to whatever size is being drawn.
  const corner = 0.22 * s;
  const ringCx = 0.44 * s;
  const ringCy = 0.44 * s;
  const ringOuter = 0.26 * s;
  const ringInner = 0.155 * s;
  const handleHalf = Math.max(0.045 * s, 1);

  const samples = 3;
  const step = 1 / (samples + 1);

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let bgHits = 0;
      let fgHits = 0;

      for (let sy = 1; sy <= samples; sy++) {
        for (let sx = 1; sx <= samples; sx++) {
          const px = x + sx * step;
          const py = y + sy * step;

          if (!inRoundedSquare(px, py, s, corner)) continue;
          bgHits++;

          const dx = px - ringCx;
          const dy = py - ringCy;
          const distance = Math.hypot(dx, dy);
          const onRing = distance <= ringOuter && distance >= ringInner;
          if (onRing || onHandle(px, py, s, ringCx, ringCy, ringOuter, handleHalf)) {
            fgHits++;
          }
        }
      }

      const total = samples * samples;
      const alpha = Math.round((bgHits / total) * 255);
      const white = fgHits / total;

      const offset = (y * s + x) * 4;
      // Composite the white mark over the teal field, then apply the shape's
      // own coverage as the alpha channel.
      pixels[offset] = Math.round(r + (255 - r) * white);
      pixels[offset + 1] = Math.round(g + (255 - g) * white);
      pixels[offset + 2] = Math.round(b + (255 - b) * white);
      pixels[offset + 3] = alpha;
    }
  }

  return pixels;
}

function inRoundedSquare(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false;
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return Math.hypot(x - cx, y - cy) <= radius;
}

/** The diagonal handle running down-right from the ring. */
function onHandle(x, y, size, cx, cy, outer, half) {
  const startX = cx + outer * 0.72;
  const startY = cy + outer * 0.72;
  const endX = 0.82 * size;
  const endY = 0.82 * size;

  const vx = endX - startX;
  const vy = endY - startY;
  const lengthSq = vx * vx + vy * vy;
  const t = Math.max(0, Math.min(1, ((x - startX) * vx + (y - startY) * vy) / lengthSq));
  const nearestX = startX + t * vx;
  const nearestY = startY + t * vy;
  return Math.hypot(x - nearestX, y - nearestY) <= half;
}

// --- Minimal PNG encoder ----------------------------------------------------

function encodePng(width, height, rgba) {
  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const color = accentColor();

  for (const size of SIZES) {
    const png = encodePng(size, size, render(size, color));
    await writeFile(resolve(outDir, `icon-${size}.png`), png);
    console.log(`wrote icons/icon-${size}.png (${png.length} bytes)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
