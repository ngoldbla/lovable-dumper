#!/usr/bin/env node
// Generates build/icon.png (512×512) — the app icon source. electron-builder
// derives the per-platform .icns / .ico from this PNG at build time.
//
// Zero dependencies: we rasterize into an RGBA buffer (3×3 supersampled for
// anti-aliasing) and hand-encode a PNG using only node:zlib. Re-run with
// `node scripts/make-icon.mjs` after tweaking the geometry below.
//
// Design: a coral→amber rounded square with a dark "dump" glyph — a downward
// arrow dropping into a tray — echoing the app's terminal accent palette.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const SIZE = 512;
const SS = 3; // supersample factor

// palette
const CORAL = [255, 92, 56];
const AMBER = [255, 178, 77];
const GLYPH = [20, 16, 12];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Distance from point to the rounded-square mask: returns coverage 0..1 at full
// resolution; we sample it at sub-pixel positions for AA.
function insideRounded(x, y, size, r) {
  const cx = Math.min(x, size - x);
  const cy = Math.min(y, size - y);
  if (cx >= r || cy >= r) return x >= 0 && x < size && y >= 0 && y < size;
  const dx = r - cx;
  const dy = r - cy;
  return dx * dx + dy * dy <= r * r;
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Is a sub-sample point part of the dark glyph?
function inGlyph(x, y) {
  // arrow stem
  if (x >= 236 && x < 276 && y >= 148 && y < 300) return true;
  // arrow head (downward triangle)
  if (pointInTriangle(x, y, 180, 288, 332, 288, 256, 368)) return true;
  // tray
  if (x >= 166 && x < 346 && y >= 396 && y < 424) return true;
  return false;
}

const data = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let cov = 0;
    let glyphCov = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (insideRounded(px, py, SIZE, 112)) cov++;
        if (inGlyph(px, py)) glyphCov++;
      }
    }
    const samples = SS * SS;
    const alpha = cov / samples;
    const g = glyphCov / samples;

    const t = y / SIZE;
    const bg = [
      lerp(CORAL[0], AMBER[0], t),
      lerp(CORAL[1], AMBER[1], t),
      lerp(CORAL[2], AMBER[2], t),
    ];
    // glyph composited over the gradient, then masked by the rounded alpha
    const r = lerp(bg[0], GLYPH[0], clamp01(g));
    const gg = lerp(bg[1], GLYPH[1], clamp01(g));
    const b = lerp(bg[2], GLYPH[2], clamp01(g));

    const i = (y * SIZE + x) * 4;
    data[i] = Math.round(r);
    data[i + 1] = Math.round(gg);
    data[i + 2] = Math.round(b);
    data[i + 3] = Math.round(alpha * 255);
  }
}

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", encodePng(SIZE, SIZE, data));
console.log("Wrote build/icon.png (512×512)");

// ── minimal PNG encoder ─────────────────────────────────────────────────────

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // raw scanlines, each prefixed with filter byte 0 (none)
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const src = y * width * 4;
    const dst = y * (1 + width * 4);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + width * 4);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])), 0);
  return Buffer.concat([length, typeBuf, payload, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
