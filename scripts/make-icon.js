/* Generates renderer/assets/icon.ico — black rounded square + mint glow ring + core dot.
   Run: node scripts/make-icon.js  */
const fs = require('fs');
const path = require('path');

const SIZES = [256, 128, 64, 48, 32, 16];

function render(size) {
  const c = (size - 1) / 2;
  const img = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    img[i] = b; img[i + 1] = g; img[i + 2] = r; img[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c, dy = y - c;
      const d = Math.sqrt(dx * dx + dy * dy) / (size / 2); // 0..1 from center

      // background: near-black rounded square
      const margin = 0.06;
      const r2 = 0.22; // corner radius (fraction)
      let inside = true;
      const nx = Math.abs(dx / (size / 2)), ny = Math.abs(dy / (size / 2));
      const cx = Math.max(nx - (1 - margin - r2), 0), cy = Math.max(ny - (1 - margin - r2), 0);
      if (nx > 1 - margin || ny > 1 - margin || (cx * cx + cy * cy) > r2 * r2) inside = false;

      if (!inside) { put(x, y, 0, 0, 0, 0); continue; }

      let r = 4, g = 6, b = 5; // near-black base

      // outer glow ring (mint, soft)
      const ringD = Math.abs(d - 0.72);
      if (ringD < 0.10) {
        const t = 1 - ringD / 0.10;
        const glow = Math.pow(t, 1.8);
        r = Math.min(255, r + 46 * glow);
        g = Math.min(255, g + 230 * glow);
        b = Math.min(255, b + 168 * glow);
      }

      // thin sharp ring edge
      if (ringD < 0.022) {
        const t = 1 - ringD / 0.022;
        r = Math.min(255, r + 40 * t);
        g = Math.min(255, g + 235 * t);
        b = Math.min(255, b + 175 * t);
      }

      // core dot
      if (d < 0.20) {
        const t = 1 - d / 0.20;
        const core = Math.pow(t, 0.7);
        r = Math.min(255, r + 70 * core);
        g = Math.min(255, g + 240 * core);
        b = Math.min(255, b + 180 * core);
      }

      put(x, y, Math.round(r), Math.round(g), Math.round(b), 255);
    }
  }
  return img;
}

function buildIco(size) {
  const img = render(size);
  const rowLen = size * 4;
  const maskRow = Math.ceil(size / 8 / 4) * 4;
  const dataSize = 40 + rowLen * size + maskRow * size;
  const buf = Buffer.alloc(6 + 16 + dataSize);
  buf.writeUInt16LE(0, 0);           // reserved
  buf.writeUInt16LE(1, 2);           // type icon
  buf.writeUInt16LE(1, 4);           // count
  const e = 6;
  buf[e] = size >= 256 ? 0 : size;   // width
  buf[e + 1] = size >= 256 ? 0 : size;
  buf[e + 2] = 0; buf[e + 3] = 0;    // colors, reserved
  buf.writeUInt16LE(1, e + 4);       // planes
  buf.writeUInt16LE(32, e + 6);      // bpp
  buf.writeUInt32LE(dataSize, e + 8);
  buf.writeUInt32LE(22, e + 12);     // offset
  // BITMAPINFOHEADER
  const h = 22;
  buf.writeUInt32LE(40, h);
  buf.writeInt32LE(size, h + 4);     // width
  buf.writeInt32LE(size * 2, h + 8); // height (XOR+AND)
  buf.writeUInt16LE(1, h + 12);
  buf.writeUInt16LE(32, h + 14);
  buf.writeUInt32LE(0, h + 16);
  buf.writeUInt32LE(rowLen * size + maskRow * size, h + 20);
  // pixel rows bottom-up
  let o = h + 40;
  for (let y = size - 1; y >= 0; y--) {
    img.copy(buf, o, y * rowLen, (y + 1) * rowLen);
    o += rowLen;
  }
  return buf;
}

const outDir = path.join(__dirname, '..', 'renderer', 'assets');
fs.mkdirSync(outDir, { recursive: true });
const ico = path.join(outDir, 'icon.ico');
fs.writeFileSync(ico, Buffer.concat(SIZES.map(buildIco)));
console.log('icon written:', ico, fs.statSync(ico).size, 'bytes');
