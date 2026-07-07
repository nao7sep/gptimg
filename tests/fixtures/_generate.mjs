// Regenerate the chroma test fixtures.
//
//   node tests/fixtures/_generate.mjs
//
// All fixtures are 128x128 RGBA PNGs. Both this script and the resulting
// PNGs are committed; the script exists so the assertions in
// tests/local/chroma.test.ts can be retraced to a deterministic source.

import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 128;
const H = 128;

function makeBuffer() {
  return Buffer.alloc(W * H * 4);
}

function put(buf, x, y, r, g, b, a = 255) {
  const i = (y * W + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

async function save(buf, name) {
  const out = path.join(HERE, name);
  await sharp(buf, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(out);
  console.log("wrote", path.basename(out));
}

// 1. green-disk.png — green chroma backdrop with a red subject disc.
{
  const buf = makeBuffer();
  const cx = W / 2;
  const cy = H / 2;
  const R = 30;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < R * R) {
        put(buf, x, y, 200, 30, 40);
      } else {
        const noise = ((x * 13 + y * 7) % 11) - 5;
        put(buf, x, y, 10 + noise, 200 + noise, 10 + noise);
      }
    }
  }
  await save(buf, "green-disk.png");
}

// 2. noisy-bg.png — high-variance border (a coherent backdrop cannot be
//    modeled), red subject in the middle.
{
  const buf = makeBuffer();
  const palette = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
  ];
  const cx = W / 2;
  const cy = H / 2;
  const R = 30;
  const BORDER = 8;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const isBorder =
        x < BORDER || x >= W - BORDER || y < BORDER || y >= H - BORDER;
      if (isBorder) {
        const c = palette[(x * 7 + y * 11) % palette.length];
        put(buf, x, y, c[0], c[1], c[2]);
      } else {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy < R * R) {
          put(buf, x, y, 200, 30, 40);
        } else {
          put(buf, x, y, 128, 128, 128);
        }
      }
    }
  }
  await save(buf, "noisy-bg.png");
}

// 3. donut.png — green outer + red annulus + green hole. Used to test the
//    distinction between mode=outer (keep the hole) and mode=all (remove it).
{
  const buf = makeBuffer();
  const cx = W / 2;
  const cy = H / 2;
  const OUTER = 50;
  const INNER = 25;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r2 = dx * dx + dy * dy;
      const noise = ((x * 13 + y * 7) % 11) - 5;
      const greenR = 10 + noise;
      const greenG = 200 + noise;
      const greenB = 10 + noise;
      if (r2 < INNER * INNER) {
        // Inner hole: same green as outer.
        put(buf, x, y, greenR, greenG, greenB);
      } else if (r2 < OUTER * OUTER) {
        // Red ring.
        put(buf, x, y, 200, 30, 40);
      } else {
        put(buf, x, y, greenR, greenG, greenB);
      }
    }
  }
  await save(buf, "donut.png");
}

// 4. subject-collision.png — green backdrop, red subject disc, and a sizable
//    green disc embedded inside the subject. The embedded green is far from
//    the border so outer-mode rejects it; its low distance to the key should
//    trip subjectKeyCollisionRisk.
{
  const buf = makeBuffer();
  const cx = W / 2;
  const cy = H / 2;
  const R_SUBJECT = 30;
  const R_INNER_GREEN = 15;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r2 = dx * dx + dy * dy;
      const noise = ((x * 13 + y * 7) % 11) - 5;
      const greenR = 10 + noise;
      const greenG = 200 + noise;
      const greenB = 10 + noise;
      if (r2 < R_INNER_GREEN * R_INNER_GREEN) {
        put(buf, x, y, greenR, greenG, greenB);
      } else if (r2 < R_SUBJECT * R_SUBJECT) {
        put(buf, x, y, 200, 30, 40);
      } else {
        put(buf, x, y, greenR, greenG, greenB);
      }
    }
  }
  await save(buf, "subject-collision.png");
}
