// 首页：天气 → 安排 → 知识库，随时间自动切换视角
//   工作时段（及上班前）→ 今天的天气与安排
//   临近下班 / 已下班（工作日：下班前 home.tomorrowLeadMin 分钟；休息日：home.restDayTomorrowAt 之后）→ 明天的天气 + 今天剩余 + 明天安排
// 阈值全部取自设置，每分钟自动刷新（输入中或有弹窗时跳过）
import { h, api, run, WEEK, dateKey, relTime } from '../lib.js';
import { icon, weatherIcon, skyGradient } from '../icons.js';
import { agendaList } from './agenda.js';

const REPORT_PROMPT = '帮我写今天的工作日报';
const goChat = (send) => window.dispatchEvent(new CustomEvent('pa:navigate', { detail: { view: 'chat', send } }));

export const refreshOn = ['tasks', 'events', 'reminders', 'kb'];
let root = null;
let timer = null;
let revision = 0;
let weatherPin = null; // 手动切换的天气日（null = 跟随视角）

export function render(el, opts = {}) {
  root = el;
  weatherPin = null;
  draw();
  clearInterval(timer);
  timer = setInterval(() => {
    if (!root?.isConnected) return;
    const a = document.activeElement;
    const busy = document.querySelector('.modal-mask') || (a && root.contains(a) && /INPUT|TEXTAREA/.test(a.tagName) && a.value);
    if (root.isConnected && !busy) draw();
  }, 60_000);
  if (opts.report) goChat(REPORT_PROMPT);
}
export function unmount() {
  clearInterval(timer);
  timer = null;
  root = null;
  revision++;
}
export function refresh() {
  if (root?.isConnected) draw();
}

const toMin = (hhmm) => {
  const [a, b] = hhmm.split(':').map(Number);
  return a * 60 + (b || 0);
};

/** 视角：before | work | closing | evening | rest */
function perspective(now, work, workday, home) {
  const m = now.getHours() * 60 + now.getMinutes();
  let phase;
  if (!workday) phase = m >= toMin(home.restDayTomorrowAt || '18:00') ? 'evening' : 'rest';
  else if (m < toMin(work.start)) phase = 'before';
  else if (m < toMin(work.end) - (home.tomorrowLeadMin ?? 60)) phase = 'work';
  else if (m < toMin(work.end)) phase = 'closing';
  else phase = 'evening';
  return { phase, tomorrow: phase === 'closing' || phase === 'evening', workday };
}

async function draw() {
  const target = root;
  if (!target?.isConnected) return;
  const ticket = ++revision;
  const current = () => root === target && target.isConnected && ticket === revision;
  const now = new Date();
  const todayKey = dateKey(now);
  const tomorrowKey = dateKey(new Date(now.getTime() + 864e5));
  const [{ settings }, agToday] = await Promise.all([api('settingsGet'), api('agenda', todayKey)]);
  if (!current()) return;
  const p = perspective(now, settings.work, agToday.workday, settings.home || {});
  const agTomorrow = p.tomorrow ? await api('agenda', tomorrowKey) : null;
  if (!current()) return;
  target.replaceChildren(weatherCard(p), agendaCard(p, agToday, agTomorrow), knowledgeCard());
}

// ───────── 天气 ─────────
function weatherCard(p) {
  const card = h('section.wx-hero', h('div.wx-loading', '…'));
  api('weather')
    .then((w) => paintWeather(card, w, weatherPin ?? (p.tomorrow ? 1 : 0)))
    .catch(() => {
      card.classList.add('wx-off');
      card.replaceChildren(h('div.wx-loading', '天气暂时获取不到'));
    });
  return card;
}

function paintWeather(card, w, idx) {
  const now = new Date();
  const isTomorrow = idx === 1;
  const d = w.days[idx];
  const kind = isTomorrow ? d.kind : w.now.kind;
  const isDay = isTomorrow ? true : w.now.isDay;
  card.style.background = skyGradient(kind, isDay);

  // 逐小时：今天 = 从当前整点起 24 小时；明天 = 明天 6 点到 23 点
  const hourStart = new Date(now);
  hourStart.setMinutes(0, 0, 0);
  const hours = isTomorrow
    ? w.hourly.filter((x) => x.time.startsWith(d.date) && +x.time.slice(11, 13) >= 6)
    : w.hourly.filter((x) => new Date(x.time) >= hourStart).slice(0, 24);

  const tips = [];
  if (d.rain >= 50) tips.push(`${isTomorrow ? '明天' : '今天'}降雨概率 ${d.rain}%，记得带伞`);
  if (isTomorrow) {
    const diff = d.max - w.days[0].max;
    if (diff <= -5) tips.push(`明天降温 ${-diff}°，注意添衣`);
    if (diff >= 5) tips.push(`明天升温 ${diff}°`);
  }
  if (d.uv >= 8) tips.push(`紫外线强（${d.uv}），注意防晒`);

  const switcher = h('button.wx-pill', { title: '切换今天 / 明天', onclick: () => ((weatherPin = isTomorrow ? 0 : 1), paintWeather(card, w, weatherPin)) }, isTomorrow ? '明天' : '今天', icon('chevronR', 11));
  const desc = isTomorrow ? `${d.text} · 降雨 ${d.rain}%` : `${w.now.text} · 体感 ${w.now.feels}° · 湿度 ${w.now.humidity}%`;

  card.replaceChildren(
    h(
      'div.wx-top',
      weatherIcon(kind, isDay, 40),
      h('div.wx-temp', isTomorrow ? `${d.min}°–${d.max}°` : `${w.now.temp}°`),
      h('div.wx-meta', h('div.wx-city', w.city, switcher), h('div.wx-desc', desc), isTomorrow ? '' : h('div.wx-desc', `${d.min}° / ${d.max}° · ${d.sunrise}–${d.sunset}`))
    ),
    h(
      'div.wx-hours',
      hours.map((x, i) =>
        h(
          'div.wx-h',
          h('span.wx-ht', !isTomorrow && i === 0 ? '现在' : `${+x.time.slice(11, 13)}时`),
          weatherIcon(x.kind, x.isDay, 18),
          h('span.wx-hv', `${x.temp}°`),
          x.rain >= 30 ? h('span.wx-hr', `${x.rain}%`) : ''
        )
      )
    ),
    tips.length ? h('div.wx-tip', tips[0]) : ''
  );
}

// ───────── 安排 ─────────
function agendaCard(p, agToday, agTomorrow) {
  const goPlan = h('button.link-btn', { onclick: () => document.querySelector('[data-id=plan]').click() }, '日历', icon('chevronR', 12));
  const report = p.tomorrow && p.workday ? h('button.link-btn', { onclick: () => goChat(REPORT_PROMPT) }, '写日报') : '';
  const d = new Date();
  const head = (title, extra) => h('div.sec-head', h('h3', title), h('span.sec-sub', extra || ''), h('span.spacer'), report, goPlan);

  if (!p.tomorrow) {
    const n = agToday.items.filter((x) => x.type !== 'event');
    return h('section.card', head('今日安排', `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}${n.length ? ` · ${n.filter((x) => x.done).length}/${n.length}` : ''}`), agendaList(agToday, { emptyText: '今天还没有安排' }));
  }
  const left = { ...agToday, items: agToday.items.filter((x) => !x.done) };
  return h(
    'section.card',
    head('安排'),
    left.items.length ? [h('div.sec-label', `今天还剩 ${left.items.length} 项`), agendaList(left)] : '',
    h('div.sec-label', `明天 · ${agTomorrow.weekday}${agTomorrow.workday ? '' : ' · 休息'}`),
    agendaList(agTomorrow, { emptyText: '明天还没有安排' })
  );
}

// ───────── 知识库 ─────────
const DOC_ICON = { file: 'file', url: 'link', text: 'text', note: 'note', image: 'image' };

function knowledgeCard() {
  const card = h('section.card');
  const list = h('div.kb-list');
  const input = h('input.input.search', { placeholder: '搜索知识库' });
  const goKb = h('button.link-btn', { onclick: () => document.querySelector('[data-id=knowledge]').click() }, '全部', icon('chevronR', 12));
  const docRow = (title, sub, ico, onclick) => h('div.kb-row', { onclick }, icon(ico, 16, 'kb-ico'), h('div.grow', h('div.kb-title', title), sub ? h('div.kb-sub', sub) : ''));

  const showRecent = async () => {
    const [docs, stats] = await Promise.all([api('kbList'), api('kbStats')]);
    card.querySelector('.sec-sub').textContent = stats.docs ? `${stats.docs} 篇` : '';
    list.replaceChildren(
      ...(docs.length
        ? docs.slice(0, 5).map((d) => docRow(d.title, relTime(d.createdAt), DOC_ICON[d.type] || 'file', () => api('kbOpen', d.id)))
        : [h('div.kb-empty', icon('upload', 16), '把文件拖进来就能收录')])
    );
  };
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const q = input.value.trim();
    if (!q) return showRecent();
    const r = (await run(() => api('kbSearch', q, 5))) || [];
    list.replaceChildren(...(r.length ? r.map((x) => docRow(x.title + (x.heading ? ' › ' + x.heading : ''), x.text.replace(/\s+/g, ' ').slice(0, 60), 'file', () => api('kbOpen', x.docId))) : [h('div.kb-empty', '没找到')]));
  });
  input.addEventListener('input', () => !input.value && showRecent());
  card.append(h('div.sec-head', h('h3', '知识库'), h('span.sec-sub'), h('span.spacer'), goKb), h('div.search-wrap', icon('search', 15), input), list);
  showRecent();
  return card;
}
