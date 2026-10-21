'use strict';
// 统一的路径解析：项目根目录 = apps/desktop 的上两级
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');

/** 把配置里的相对路径（以项目根为基准）解析为绝对路径 */
function resolveFromRoot(p) {
  if (!p) return ROOT;
  const expanded = p.replace(/%([^%]+)%/g, (_, k) => process.env[k] || '');
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(ROOT, expanded);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { ROOT, CONFIG_DIR, resolveFromRoot, ensureDir };
