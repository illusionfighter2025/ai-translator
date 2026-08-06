// Generate PNG icons for the extension using a minimal PNG encoder (no deps).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c1 = [79, 124, 255];
  const c2 = [106, 92, 255];
  const radius = size * 0.22;
  const white = [255, 255, 255];

  function setPixel(x, y, color, alpha = 255) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = color[0]; rgba[i + 1] = color[1]; rgba[i + 2] = color[2]; rgba[i + 3] = alpha;
  }
  function disc(px, py, r, color) {
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++)
        if (ox * ox + oy * oy <= r * r) setPixel(px + ox, py + oy, color);
  }
  function fillRect(x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) setPixel(x, y, color);
  }
  function thickLine(x0, y0, x1, y1, t, color) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    let guard = 0;
    while (guard++ < 100000) {
      disc(x, y, t, color);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  // rounded-rect gradient background
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let inside = true;
      const r = radius;
      if (x < r && y < r) inside = Math.hypot(r - x, r - y) <= r;
      else if (x > size - r && y < r) inside = Math.hypot(size - r - x, r - y) <= r;
      else if (x < r && y > size - r) inside = Math.hypot(r - x, size - r - y) <= r;
      else if (x > size - r && y > size - r) inside = Math.hypot(size - r - x, size - r - y) <= r;
      if (!inside) {
        rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = 0;
        continue;
      }
      const t = (x + y) / (size * 2);
      const col = mix(c1, c2, t);
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = 255;
    }
  }

  // globe + arrow motif
  const cx = size / 2, cy = size / 2;
  const r = size * 0.30;
  const t = Math.max(1, Math.round(size * 0.045));
  // circle outline
  for (let a = 0; a < Math.PI * 2; a += 0.01) {
    disc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, t, white);
  }
  // equator arrow
  thickLine(cx - r, cy, cx + r, cy, Math.max(1, Math.round(size * 0.03)), white);
  const ah = size * 0.10;
  thickLine(cx + r - ah, cy - ah, cx + r, cy, Math.max(1, Math.round(size * 0.025)), white);
  thickLine(cx + r - ah, cy + ah, cx + r, cy, Math.max(1, Math.round(size * 0.025)), white);
  // meridian
  thickLine(cx, cy - r, cx, cy + r, Math.max(1, Math.round(size * 0.025)), white);

  return makePNG(size, size, rgba);
}

const outDir = path.join(__dirname, "icons");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = drawIcon(size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`Wrote icons/icon${size}.png (${png.length} bytes)`);
}
console.log("done");
