'use strict';
// 生成应用/托盘图标（团子脸）PNG，无第三方依赖：node scripts/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { encodePng } = require('../src/core/png');

function png(size, pixel) {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px.set(pixel(x + 0.5, y + 0.5, size), (y * size + x) * 4);
  return encodePng(size, size, px, 4);
}

// 简单的有符号距离着色 + 抗锯齿
const smooth = (d) => Math.max(0, Math.min(1, 0.5 - d));
function face(x, y, S) {
  const u = (v) => (v / S) * 64; // 以 64 为设计坐标
  const X = u(x), Y = u(y), px = 64 / S;
  const ell = (cx, cy, rx, ry) => (Math.hypot((X - cx) / rx, (Y - cy) / ry) - 1) * Math.min(rx, ry) / px;
  const tri = (ax, ay, bx, by, cx, cy) => {
    const s = (p1x, p1y, p2x, p2y) => (X - p2x) * (p1y - p2y) - (p1x - p2x) * (Y - p2y);
    const d1 = s(ax, ay, bx, by), d2 = s(bx, by, cx, cy), d3 = s(cx, cy, ax, ay);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  };
  let col = [0, 0, 0, 0];
  const over = (c, a) => {
    if (a <= 0) return;
    const na = a + (col[3] / 255) * (1 - a);
    col = [0, 1, 2].map((i) => (c[i] * a + col[i] * (col[3] / 255) * (1 - a)) / (na || 1));
    col.push(na * 255);
  };
  const outline = [91, 70, 54], body = [255, 243, 224], cheek = [255, 170, 160];
  const earL = tri(10, 26, 16, 4, 28, 16), earR = tri(54, 26, 48, 4, 36, 16);
  if (earL || earR) over(outline, 1);
  if (tri(13, 22, 17, 9, 25, 16) || tri(51, 22, 47, 9, 39, 16)) over(body, 1);
  over(outline, smooth(ell(32, 37, 27, 23)));
  over(body, smooth(ell(32, 37, 24.5, 20.5)));
  over(cheek, 0.8 * smooth(ell(17, 42, 4.5, 3)));
  over(cheek, 0.8 * smooth(ell(47, 42, 4.5, 3)));
  over(outline, smooth(ell(23, 35, 3.2, 4.2)));
  over(outline, smooth(ell(41, 35, 3.2, 4.2)));
  over([255, 255, 255], smooth(ell(24.2, 33.6, 1.1, 1.3)));
  over([255, 255, 255], smooth(ell(42.2, 33.6, 1.1, 1.3)));
  over(outline, smooth(ell(32, 43, 2.2, 1.4)));
  return col.map(Math.round);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 64, 256]) fs.writeFileSync(path.join(out, `icon-${s}.png`), png(s, face));
console.log('图标已生成：', out);
