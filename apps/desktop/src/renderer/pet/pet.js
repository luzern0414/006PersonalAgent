'use strict';
// 宠物窗口逻辑：状态机、气泡队列、拖动、文件投喂、眼睛跟随
const $ = (s) => document.querySelector(s);
const root = $('#root');
const bubble = $('#bubble');
const chip = $('#chip');
const hit = $('#hit');
const eyes = $('#eyes');

// ───── 状态机 ─────
const STATES = ['idle', 'sleep', 'sleepy', 'think', 'talk', 'alert', 'happy', 'drag', 'eat', 'hungry', 'drink', 'stretch'];
let base = 'idle'; // 持续状态（idle / sleep / think / talk / drag）
let tempTimer = null;

function applyState(s) {
  for (const x of STATES) root.classList.remove('s-' + x);
  root.classList.add('s-' + s);
}
/** duration 有值时为临时动作，结束后回到持续状态 */
function setState(state, duration) {
  clearTimeout(tempTimer);
  if (duration) {
    applyState(state);
    tempTimer = setTimeout(() => applyState(base), duration);
  } else {
    base = state;
    applyState(state);
  }
}
window.pa.on('pet:state', ({ state, duration }) => {
  if (state === 'wake') {
    if (base === 'sleep') setState('idle');
    return setState('happy', 1600);
  }
  setState(state, duration);
});
window.pa.on('pet:focus', (f) => root.classList.toggle('focus', !!f.active));
window.pa.on('pet:scale', (k) => applyScale(k));

// ───── 可交互区域上报（主进程据此做点击穿透） ─────
function reportRects() {
  const rects = [];
  const add = (el, id) => {
    if (!el || el.classList.contains('hidden')) return;
    const r = el.getBoundingClientRect();
    rects.push({ id, x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width), h: Math.ceil(r.height) });
  };
  add(hit, 'pet');
  add(bubble, 'bubble');
  window.pa.pet.hitRects(rects);
}
function applyScale(k) {
  root.style.transform = k && k !== 1 ? `scale(${k})` : '';
  requestAnimationFrame(reportRects);
}

// ───── 气泡队列 ─────
const queue = [];
let current = null;
let hideTimer = null;
let hovering = false;

function showBubble(n) {
  if (current && current.id === n.id) Object.assign(current, n); // 同 id 替换
  else if (current) return void queue.push(n);
  current = n;
  $('.bubble-title').textContent = n.title || '';
  $('.bubble-text').textContent = n.text || '';
  const acts = $('.bubble-actions');
  acts.replaceChildren(
    ...(n.actions || []).map((a) => {
      const b = document.createElement('button');
      b.textContent = a.label;
      b.onclick = (e) => {
        e.stopPropagation();
        if (a.id !== 'ok') window.pa.pet.bubbleAction(a.id);
        hideBubble();
      };
      return b;
    })
  );
  bubble.classList.remove('hidden');
  chip.classList.add('hidden');
  if (n.state) setState(n.state, 2600);
  reportRects();
  scheduleHide();
}
function scheduleHide() {
  clearTimeout(hideTimer);
  const sec = current?.actions?.length ? Math.max(current.seconds || 12, 20) : current?.seconds || 8;
  hideTimer = setTimeout(() => (hovering ? scheduleHide() : hideBubble()), sec * 1000);
}
function hideBubble() {
  clearTimeout(hideTimer);
  bubble.classList.add('hidden');
  current = null;
  reportRects();
  if (queue.length) setTimeout(() => showBubble(queue.shift()), 300);
}
window.pa.on('pet:bubble', showBubble);
$('.bubble-close').onclick = (e) => {
  e.stopPropagation();
  hideBubble();
};
$('.bubble-text').onclick = () => window.pa.pet.bubbleAction('open:today');
bubble.addEventListener('mouseenter', () => (hovering = true));
bubble.addEventListener('mouseleave', () => (hovering = false));

// ───── 拖动 / 点击 / 右键 ─────
hit.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  chip.classList.add('hidden');
  window.pa.pet.dragStart();
});
window.addEventListener('mouseup', (e) => e.button === 0 && window.pa.pet.dragEnd());
hit.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.pa.pet.menu();
});

// ───── 悬停信息条 ─────
let chipTimer = null;
let todayCache = { at: 0, v: null };
hit.addEventListener('mouseenter', () => {
  clearTimeout(chipTimer);
  chipTimer = setTimeout(async () => {
    if (current || base === 'drag') return;
    if (Date.now() - todayCache.at > 30_000) todayCache = { at: Date.now(), v: await window.pa.api('today') };
    const t = todayCache.v;
    const parts = [];
    if (t.workday && t.minutesToOffwork > 0) {
      const m = t.minutesToOffwork;
      parts.push(`距下班 ${m >= 60 ? Math.floor(m / 60) + 'h' : ''}${m % 60}m`);
    } else parts.push(t.workday ? '已下班 🌙' : '休息日 ☕');
    if (t.nextEvent) parts.push(`${t.nextEvent.start.slice(11, 16)} ${t.nextEvent.title.slice(0, 8)}`);
    parts.push(`任务 ${t.tasks.done}/${t.tasks.total}`, `💧${t.stats.water}`);
    chip.textContent = parts.join(' · ');
    chip.classList.remove('hidden');
  }, 700);
});
hit.addEventListener('mouseleave', () => {
  clearTimeout(chipTimer);
  chip.classList.add('hidden');
});

// ───── 投喂：拖文件/文字到宠物身上 ─────
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (dragDepth++ === 0) setState('hungry', 60_000);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    setState(base);
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  const files = [...(e.dataTransfer?.files || [])].map((f) => window.pa.pathForFile(f)).filter(Boolean);
  if (files.length) return window.pa.pet.drop(files);
  const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
  if (text) window.pa.pet.dropText(text);
  else setState(base);
});

// ───── 眼睛跟随鼠标 ─────
window.pa.on('pet:cursor', ({ x, y }) => {
  if (base === 'sleep') return;
  const r = hit.getBoundingClientRect();
  const dx = x - (r.left + r.width / 2);
  const dy = y - (r.top + r.height * 0.55);
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, d / 300);
  eyes.style.transform = `translate(${((dx / d) * 4 * k).toFixed(1)}px, ${((dy / d) * 3 * k).toFixed(1)}px)`;
});

// ───── 天气：下雨撑伞 ─────
async function refreshWeather() {
  try {
    const w = await window.pa.api('weather');
    root.classList.toggle('rain', !!w.now.rainy);
  } catch {
    /* 离线 */
  }
}

// ───── 初始化 ─────
(async () => {
  const { settings } = await window.pa.api('settingsGet');
  applyScale(settings.pet.scale);
  const f = await window.pa.api('focusState');
  root.classList.toggle('focus', !!f.active);
  setState('happy', 1800);
  refreshWeather();
  setInterval(refreshWeather, 30 * 60_000);
  window.addEventListener('resize', reportRects);
})();
