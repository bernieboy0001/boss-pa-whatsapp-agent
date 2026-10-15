/*
 * Generates the PWA app icons in public/icons/.
 *
 * The mark is a bold gold "orbit" — a thick gold ring with a cream satellite
 * dot — on the brand maroon, drawn with analytic anti-aliasing so it stays
 * crisp and legible at small (mobile home-screen) sizes. "maskable" variants
 * are full-bleed with the mark inset into the safe zone so Android can crop
 * them to any shape without clipping the ring.
 *
 * No image dependencies: pixels are rasterised here and encoded as PNG with
 * Node's built-in zlib. Run:
 *   node scripts/gen-icons.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const MAROON = [101, 33, 42]; // #65212A
const GOLD = [201, 162, 75]; // #C9A24B
const CREAM = [247, 245, 243]; // #F7F5F3

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hyp = Math.hypot;
// Signed-distance -> coverage with a ~1px feather for smooth edges.
const cov = (d) => clamp01(0.5 - d);
const over = (dst, src, a) => dst + (src - dst) * a;

function roundedBoxSDF(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return hyp(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Render one RGBA icon as a flat Uint8ClampedArray. */
function render(size, { maskable }) {
  const px = new Uint8ClampedArray(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;

  // "any" icons are a rounded tile; maskable icons are full-bleed and get a bit
  // more breathing room so the platform's crop can't clip the mark.
  const radius = maskable ? 0 : size * 0.22;
  const ringR = size * (maskable ? 0.24 : 0.3);
  const ringT = size * (maskable ? 0.055 : 0.072);
  const dotR = size * (maskable ? 0.052 : 0.065);
  const ang = -Math.PI / 4; // satellite sits on the upper-right of the ring
  const dotX = cx + Math.cos(ang) * ringR;
  const dotY = cy + Math.sin(ang) * ringR;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;

      const bgD = maskable
        ? Math.max(Math.abs(fx - cx) - cx, Math.abs(fy - cy) - cy) // full square
        : roundedBoxSDF(fx, fy, cx, cy, cx, cy, radius);
      const bgA = maskable ? 1 : cov(bgD);
      if (bgA <= 0) continue;

      let r = MAROON[0];
      let g = MAROON[1];
      let b = MAROON[2];

      const ringA = cov(Math.abs(hyp(fx - cx, fy - cy) - ringR) - ringT) * bgA;
      if (ringA > 0) {
        r = over(r, GOLD[0], ringA);
        g = over(g, GOLD[1], ringA);
        b = over(b, GOLD[2], ringA);
      }

      const dotA = cov(hyp(fx - dotX, fy - dotY) - dotR) * bgA;
      if (dotA > 0) {
        r = over(r, CREAM[0], dotA);
        g = over(g, CREAM[1], dotA);
        b = over(b, CREAM[2], dotA);
      }

      const o = (y * size + x) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = Math.round(bgA * 255);
    }
  }
  return px;
}

// ---- minimal PNG writer (8-bit RGBA) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(outDir, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-180.png", size: 180, maskable: false }, // apple-touch-icon
  { file: "maskable-192.png", size: 192, maskable: true },
  { file: "maskable-512.png", size: 512, maskable: true },
  { file: "favicon-48.png", size: 48, maskable: false },
];
for (const t of targets) {
  const png = encodePng(t.size, render(t.size, { maskable: t.maskable }));
  writeFileSync(resolve(outDir, t.file), png);
  console.log(`wrote icons/${t.file} (${t.size}px${t.maskable ? ", maskable" : ""}) ${png.length}B`);
}
