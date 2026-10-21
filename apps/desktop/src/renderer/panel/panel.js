// 面板入口：标签路由（标签栏兼作拖动区）、全局拖拽入库、数据变更刷新
import { h, api, toast } from './lib.js';
import { icon } from './icons.js';
import * as today from './views/today.js';
import * as chat from './views/chat.js';
import * as plan from './views/plan.js';
import * as knowledge from './views/knowledge.js';
import * as settings from './views/settings.js';

const VIEWS = [
  { id: 'today', label: '今日', ico: 'home', mod: today },
  { id: 'chat', label: '对话', ico: 'chat', mod: chat },
  { id: 'plan', label: '日程', ico: 'calendar', mod: plan },
  { id: 'knowledge', label: '知识库', ico: 'book', mod: knowledge },
  { id: 'settings', label: '设置', ico: 'settings', mod: settings },
];

const viewEl = document.getElementById('view');
const tabsEl = document.getElementById('tabs');
let current = null;

function navigate(id, opts = {}) {
  const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
  if (current?.mod.unmount) current.mod.unmount();
  current = v;
  for (const b of tabsEl.children) b.classList.toggle('active', b.dataset.id === v.id);
  viewEl.className = v.id === 'chat' ? 'chat-mode' : '';
  viewEl.replaceChildren();
  viewEl.scrollTop = 0;
  v.mod.render(viewEl, opts);
}

tabsEl.append(...VIEWS.map((v) => h('button.tab', { 'data-id': v.id, title: v.label, onclick: () => navigate(v.id) }, icon(v.ico, 17), h('span.tab-label', v.label))));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelector('.modal-mask')?.remove();
});

window.pa.on('panel:navigate', ({ view, ...opts }) => navigate(view, opts));
// 页面内跳转（如首页「写日报」→ 对话）
window.addEventListener('pa:navigate', (e) => {
  const { view, ...opts } = e.detail || {};
  navigate(view, opts);
});

// 数据变化 → 当前视图按需刷新（节流）
let refreshTimer = null;
const refresh = (kind) => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (current?.mod.refreshOn?.includes(kind)) current.mod.refresh ? current.mod.refresh() : navigate(current.id);
    updateStatus();
  }, 150);
};
window.pa.on('data.changed', ({ kind }) => refresh(kind));
window.pa.on('focus.changed', () => refresh('focus'));
window.pa.on('settings.changed', () => refresh('settings'));

// 整个面板都可以拖文件进来入库
const overlay = document.getElementById('drop-overlay');
let depth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (depth++ === 0) overlay.classList.remove('hidden');
});
document.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
document.addEventListener('dragleave', () => {
  if (--depth <= 0) {
    depth = 0;
    overlay.classList.add('hidden');
  }
});
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0;
  overlay.classList.add('hidden');
  const paths = [...e.dataTransfer.files].map((f) => window.pa.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  toast(`正在入库 ${paths.length} 项…`);
  const r = await api('kbIngestPaths', paths);
  toast(`入库完成：成功 ${r.ok}，失败 ${r.failed}`, r.failed ? 'err' : 'ok');
});

async function updateStatus() {
  try {
    const [f, d] = await Promise.all([api('focusState'), api('dndState')]);
    const s = [];
    if (f.active) s.push(`专注至 ${f.until.slice(11, 16)}`);
    else if (d.reason === 'manual') s.push(`勿扰至 ${d.until.slice(11, 16)}`);
    else if (d.reason === 'quiet') s.push('安静时段');
    document.getElementById('status').textContent = s.join(' ');
  } catch {
    /* 忽略 */
  }
}

navigate('today');
updateStatus();
setInterval(updateStatus, 60_000);
