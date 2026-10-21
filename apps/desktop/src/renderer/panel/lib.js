// 面板公共工具：DOM 构造、API、提示、格式化、Markdown
import { marked } from '../../../node_modules/marked/lib/marked.esm.js';
import DOMPurify from '../../../node_modules/dompurify/dist/purify.es.mjs';

export const api = (m, ...a) => window.pa.api(m, ...a);

/** h('div.card#x', {onclick}, child...) */
export function h(sel, props, ...children) {
  if (props == null || typeof props !== 'object' || props instanceof Node || Array.isArray(props)) {
    children.unshift(props);
    props = {};
  }
  const [, tag = 'div', rest = ''] = sel.match(/^([a-z0-9]*)(.*)$/i);
  const el = document.createElement(tag || 'div');
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === '.' ? el.classList.add(m[2]) : (el.id = m[2]);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function toast(msg, type = 'info', ms = 2600) {
  const box = document.getElementById('toasts');
  const t = h('div.toast.' + type, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 300);
}

/** 包装异步操作：失败自动提示 */
export async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(String(e.message || e).replace(/^Error invoking remote method 'api': Error: /, ''), 'err', 4000);
    return undefined;
  }
}

marked.setOptions({ gfm: true, breaks: true });
export function md(text) {
  // CommonMark 对紧贴中文标点的 **粗体** 不生效，这里预先转换
  const pre = (text || '').replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  return DOMPurify.sanitize(marked.parse(pre), { ADD_ATTR: ['target'] });
}

const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = dateKey();
  const k = dateKey(d);
  const t = iso.length > 10 ? hm(d) : '';
  if (k === today) return t ? `今天 ${t}` : '今天';
  if (k === dateKey(new Date(Date.now() + 864e5))) return `明天 ${t}`.trim();
  if (k === dateKey(new Date(Date.now() - 864e5))) return `昨天 ${t}`.trim();
  return `${d.getMonth() + 1}/${d.getDate()} ${t}`.trim();
}

/** Date → 带时区偏移的本地 ISO，如 2026-10-10T15:00:00+08:00 */
export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${dateKey(d)}T${hm(d)}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
/** datetime-local 输入框 ↔ ISO */
export const toLocalInput = (iso) => (iso ? `${dateKey(new Date(iso))}T${hm(new Date(iso))}` : '');
export const fromLocalInput = (v) => (v ? isoLocal(new Date(v)) : '');

export function empty(text) {
  return h('div.empty', text);
}

export function confirmDialog(text, okText = '确定') {
  return new Promise((resolve) => {
    const close = (v) => {
      mask.remove();
      resolve(v);
    };
    const mask = h(
      'div.modal-mask',
      { onclick: (e) => e.target === mask && close(false) },
      h('div.modal', h('div.modal-text', text), h('div.row.end', h('button.btn.ghost', { onclick: () => close(false) }, '取消'), h('button.btn.primary', { onclick: () => close(true) }, okText)))
    );
    document.body.append(mask);
  });
}

/** 简单模态框：内容节点 + 按钮，返回 close 函数 */
export function modal(title, body, buttons = []) {
  const mask = h('div.modal-mask');
  const close = () => mask.remove();
  mask.addEventListener('click', (e) => e.target === mask && close());
  mask.append(h('div.modal.wide', h('div.modal-title', title), body, h('div.row.end', buttons.map((b) => h('button.btn.' + (b.kind || 'ghost'), { onclick: () => b.onClick(close) }, b.label)))));
  document.body.append(mask);
  return close;
}

export const PRIORITY = [
  { v: 0, label: '紧急', cls: 'p0' },
  { v: 1, label: '高', cls: 'p1' },
  { v: 2, label: '中', cls: 'p2' },
  { v: 3, label: '低', cls: 'p3' },
];
