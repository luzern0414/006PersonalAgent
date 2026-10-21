'use strict';
// 业务服务层：任务 / 日程 / 提醒 / 笔记 / 记忆 / 今日概览 / 日报 / 消息发送
// 不依赖 Electron，主进程 IPC 与 Agent 工具共用
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./store');
const { KnowledgeBase } = require('./kb/kb');
const { OCR } = require('./kb/ocr');
const { LLM } = require('./llm');
const { resolveCredentials, decryptSecret } = require('./credentials');
const weather = require('./weather');
const messenger = require('./messenger');
const T = require('./time');
const { CONFIG_DIR } = require('./paths');

const PRIORITY = ['紧急', '高', '中', '低'];

class Core {
  /** @param {import('./settings').Settings} settings */
  constructor(settings, { log = console.log, observeSync } = {}) {
    this.settings = settings;
    this.log = log;
    this.emitter = () => {}; // 由主进程注入：(event, payload) => void
    const p = settings.paths();
    this.store = new Store(p.dataDir, { observeSync });
    this.llm = new LLM(() => resolveCredentials(this.settings.get()));
    this.ocr = new OCR({
      llm: this.llm,
      getMode: () => this.settings.get().kb.ocr,
      cacheDir: () => path.join(this.settings.paths().dataDir, 'cache'),
      log: (lvl, msg) => this.log(lvl, msg),
    });
    this.kb = new KnowledgeBase({
      getDir: () => this.settings.paths().knowledgeDir,
      getOpts: () => this.settings.get().kb,
      llm: this.llm,
      ocr: this.ocr,
      log: (lvl, msg) => this.log(lvl, msg),
    });
  }

  get s() {
    return this.settings.get();
  }
  emit(type, data) {
    this.emitter(type, data);
  }

  // ───────────────────────── 待办 ─────────────────────────
  /** 待办归属的日期：计划日期 > 截止日期 > 创建日期 */
  taskDate(t) {
    return t.planDate || (t.due ? T.dateKey(new Date(t.due)) : T.dateKey(new Date(t.createdAt)));
  }
  /** view: today（今天的 + 逾期未完成）| day（指定 date）| open | done | all */
  listTasks({ view = 'all', date } = {}) {
    const today = T.dateKey();
    let items = this.store.tasks.list();
    if (view === 'today') {
      items = items.filter((t) => {
        const d = this.taskDate(t);
        return d === today || (t.status !== 'done' && d < today);
      });
    } else if (view === 'day') items = items.filter((t) => this.taskDate(t) === (date || today));
    else if (view === 'open') items = items.filter((t) => t.status !== 'done');
    else if (view === 'done') items = items.filter((t) => t.status === 'done');
    // 完成与否不影响顺序：勾选后原地划线，不跳动
    return items.sort(
      (a, b) =>
        this.taskDate(a).localeCompare(this.taskDate(b)) ||
        (a.due || '9').localeCompare(b.due || '9') ||
        (a.priority ?? 2) - (b.priority ?? 2) ||
        a.createdAt.localeCompare(b.createdAt)
    );
  }
  addTask({ title, priority = 2, due = '', planDate = '', notes = '', kind = 'todo', project = '' }) {
    if (!title) throw new Error('标题不能为空');
    planDate ||= due ? T.dateKey(new Date(due)) : T.dateKey();
    const t = this.store.tasks.add({ title, kind, priority: +priority, due, planDate, project, notes, status: 'open' });
    this.emit('data.changed', { kind: 'tasks' });
    return t;
  }
  updateTask(id, patch) {
    if (patch.status === 'done') patch.completedAt = new Date().toISOString();
    if (patch.status === 'open') patch.completedAt = '';
    const t = this.store.tasks.update(id, patch);
    if (!t) throw new Error('待办不存在');
    this.emit('data.changed', { kind: 'tasks' });
    if (patch.status === 'done') this.emit('task.completed', t);
    return t;
  }
  removeTask(id) {
    const ok = this.store.tasks.remove(id);
    this.emit('data.changed', { kind: 'tasks' });
    return ok;
  }
  /** 过去日期的未完成待办顺延到今天；启动、切日和恢复时可重复检查。 */
  carryOver(now = new Date()) {
    const today = T.dateKey(now);
    // UTC midnights count local calendar dates without daylight-saving offsets.
    const todayDay = Date.parse(`${today}T00:00:00Z`);
    const changes = [];
    for (const t of this.store.tasks.items) {
      const from = this.taskDate(t);
      if (t.status === 'done' || from >= today) continue;
      const days = (todayDay - Date.parse(`${from}T00:00:00Z`)) / 864e5;
      if (!Number.isFinite(days) || days < 1) continue;
      t.planDate = today;
      t.carried = (Number(t.carried) || 0) + days;
      t.updatedAt = now.toISOString();
      changes.push({ id: t.id, from, to: today, days });
    }
    if (changes.length) {
      this.store.tasks.save();
      this.emit('data.changed', { kind: 'tasks' });
      this.log('info', `顺延 ${changes.length} 项未完成待办到 ${today}`, {
        event: 'tasks_rollover', date: today, count: changes.length, tasks: changes,
      });
    }
    return changes.length;
  }

  // ───────────────────────── 日程 ─────────────────────────
  listEvents({ from, to } = {}) {
    const f = from ? new Date(from) : T.startOfDay();
    const e = to ? new Date(to) : T.addDays(f, 1);
    return this.store.events
      .list((ev) => new Date(ev.start) < e && (new Date(ev.end || ev.start) > f || new Date(ev.start) >= f))
      .sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.start.localeCompare(b.start));
  }
  addEvent({ title, start, end, location = '', notes = '', remindBefore }) {
    if (!title || !start) throw new Error('需要标题和开始时间');
    const s = new Date(start);
    if (isNaN(s)) throw new Error('开始时间格式不正确');
    const en = end ? new Date(end) : new Date(s.getTime() + 60 * 60_000);
    const ev = this.store.events.add({
      title,
      start: T.localISO(s),
      end: T.localISO(en),
      location,
      notes,
      remindBefore: remindBefore ?? this.s.reminders.meetingBeforeMin,
    });
    this.emit('data.changed', { kind: 'events' });
    return ev;
  }
  updateEvent(id, patch) {
    for (const k of ['start', 'end']) if (patch[k]) patch[k] = T.localISO(new Date(patch[k]));
    const ev = this.store.events.update(id, patch);
    this.emit('data.changed', { kind: 'events' });
    return ev;
  }
  removeEvent(id) {
    const ok = this.store.events.remove(id);
    this.emit('data.changed', { kind: 'events' });
    return ok;
  }
  formatSchedule(range = 'today') {
    const from = T.startOfDay();
    const to = T.addDays(from, range === 'week' ? 7 : 1);
    const evs = this.listEvents({ from, to });
    const lines = evs.map((e) => {
      const d = new Date(e.start);
      const day = range === 'week' ? `${d.getMonth() + 1}/${d.getDate()} 周${T.WEEK[d.getDay()]} ` : '';
      const time = e.allDay ? '全天' : `${T.hm(d)}–${T.hm(new Date(e.end))}`;
      return `- ${day}${time} ${e.title}${e.location ? `（${e.location}）` : ''}`;
    });
    const title = range === 'week' ? '本周日程' : `${T.dateKey()} 日程`;
    return { title, text: lines.length ? lines.join('\n') : '暂无安排' };
  }

  // ───────────────────────── 自定义提醒 ─────────────────────────
  /** repeat: none | daily | workdays | weekly | interval */
  nextFire(r, after = new Date()) {
    if (!r.enabled) return '';
    if (r.repeat === 'none') return r.at && new Date(r.at) > after ? r.at : '';
    if (r.repeat === 'interval') return T.localISO(new Date(after.getTime() + (r.intervalMin || 60) * 60_000));
    for (let i = 0; i < 400; i++) {
      const d = T.atTime(r.time || '09:00', T.addDays(after, i));
      if (d <= after || (r.doneDates || []).includes(T.dateKey(d))) continue;
      if (r.repeat === 'workdays' && !T.isWorkday(this.s.work, d)) continue;
      if (r.repeat === 'weekly' && !(r.weekdays || [1]).includes(d.getDay())) continue;
      return T.localISO(d);
    }
    return '';
  }
  listReminders() {
    return this.store.reminders.list().sort((a, b) => (a.nextAt || '9').localeCompare(b.nextAt || '9'));
  }
  addReminder({ text, at = '', repeat = 'none', time = '', weekdays, intervalMin }) {
    if (!text) throw new Error('提醒内容不能为空');
    if (repeat === 'none' && !at) throw new Error('一次性提醒需要时间 at');
    const r = { text, repeat, at: at ? T.localISO(new Date(at)) : '', time: time || (at ? T.hm(new Date(at)) : '09:00'), weekdays, intervalMin, enabled: true };
    r.nextAt = this.nextFire(r);
    const saved = this.store.reminders.add(r);
    this.emit('data.changed', { kind: 'reminders' });
    return saved;
  }
  updateReminder(id, patch) {
    const r = this.store.reminders.get(id);
    if (!r) throw new Error('提醒不存在');
    Object.assign(r, patch);
    r.nextAt = this.nextFire(r);
    this.store.reminders.update(id, r);
    this.emit('data.changed', { kind: 'reminders' });
    return r;
  }
  removeReminder(id) {
    const ok = this.store.reminders.remove(id);
    this.emit('data.changed', { kind: 'reminders' });
    return ok;
  }
  /** 提醒在某天的触发时刻（按间隔重复的提醒不逐条展示） */
  reminderTimes(r, date) {
    if (r.repeat === 'none') return r.at && T.dateKey(new Date(r.at)) === date ? [T.hm(new Date(r.at))] : [];
    if (r.repeat === 'interval' || date < T.dateKey(new Date(r.createdAt))) return [];
    const d = new Date(`${date}T00:00:00`);
    if (r.repeat === 'workdays' && !T.isWorkday(this.s.work, d)) return [];
    if (r.repeat === 'weekly' && !(r.weekdays || [1]).includes(d.getDay())) return [];
    return [r.time || '09:00'];
  }
  /** 勾选/取消某一天的提醒：一次性提醒直接关闭；重复提醒只跳过这一天 */
  setReminderDone(id, date, done) {
    const r = this.store.reminders.get(id);
    if (!r) throw new Error('提醒不存在');
    if (r.repeat === 'none') r.enabled = !done;
    else {
      const set = new Set(r.doneDates || []);
      done ? set.add(date) : set.delete(date);
      r.doneDates = [...set].sort().slice(-60);
    }
    r.nextAt = this.nextFire(r);
    this.store.reminders.update(id, r);
    this.emit('data.changed', { kind: 'reminders' });
    return r;
  }

  // ───────────────────────── 按天汇总（日程 + 提醒 + 待办） ─────────────────────────
  /** 某一天的全部安排，按时间排列；完成 / 已过的条目保留并标记 done */
  agenda(date = T.dateKey()) {
    const now = new Date();
    const today = T.dateKey(now);
    const d0 = new Date(`${date}T00:00:00`);
    const items = [];
    for (const e of this.listEvents({ from: d0, to: T.addDays(d0, 1) })) {
      const s = new Date(e.start);
      items.push({ type: 'event', id: e.id, title: e.title, time: e.allDay ? '' : T.hm(s), end: e.allDay ? '' : T.hm(new Date(e.end)), allDay: !!e.allDay, location: e.location || '', done: new Date(e.end) < now, raw: e });
    }
    for (const r of this.store.reminders.items) {
      for (const time of this.reminderTimes(r, date)) {
        const at = T.atTime(time, d0);
        const done = r.repeat === 'none' ? !r.enabled || at < now : (r.doneDates || []).includes(date) || at < now;
        items.push({ type: 'reminder', id: r.id, title: r.text, time, repeat: r.repeat, done });
      }
    }
    for (const t of this.listTasks({ view: date === today ? 'today' : 'day', date })) {
      const dueToday = t.due && T.dateKey(new Date(t.due)) === date;
      items.push({ type: 'todo', id: t.id, title: t.title, time: dueToday ? T.hm(new Date(t.due)) : '', done: t.status === 'done', priority: t.priority ?? 2, carried: t.carried || 0, raw: t });
    }
    // 有时间的按时间排；全天日程在最前；不带时间的待办在最后（稳定排序，勾选后不跳动）
    const key = (x) => (x.allDay ? '00:00' : x.time || '99:99');
    items.sort((a, b) => key(a).localeCompare(key(b)));
    return { date, isToday: date === today, weekday: `周${T.WEEK[d0.getDay()]}`, workday: T.isWorkday(this.s.work, d0), items };
  }
  /** 月历角标：{ 'YYYY-MM-DD': { todo, done, event, reminder } } */
  monthSummary(year, month) {
    const prefix = `${year}-${T.pad(month)}-`;
    const out = {};
    const add = (k, f) => k.startsWith(prefix) && ((out[k] ||= { todo: 0, done: 0, event: 0, reminder: 0 })[f] += 1);
    for (const t of this.store.tasks.items) add(this.taskDate(t), t.status === 'done' ? 'done' : 'todo');
    for (const e of this.store.events.items) add(T.dateKey(new Date(e.start)), 'event');
    for (const r of this.store.reminders.items) if (r.repeat === 'none' && r.at) add(T.dateKey(new Date(r.at)), 'reminder');
    return out;
  }
  /** 未来 N 天的安排（不含每天重复的提醒，避免刷屏） */
  upcoming(days = 30) {
    const out = [];
    for (let i = 1; i <= days; i++) {
      const a = this.agenda(T.dateKey(T.addDays(new Date(), i)));
      a.items = a.items.filter((x) => !(x.type === 'reminder' && x.repeat !== 'none'));
      if (a.items.length) out.push(a);
    }
    return out;
  }

  // ───────────────────────── 文档 / 随手记 ─────────────────────────
  get docsDir() {
    return this.settings.paths().docsDir;
  }
  listNotes() {
    const dir = this.docsDir;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, path: path.join(dir, f), size: st.size, updatedAt: st.mtime.toISOString() };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  readNote(file) {
    return fs.readFileSync(this._notePath(file), 'utf8');
  }
  _notePath(file) {
    return path.resolve(this.docsDir, path.basename(file));
  }
  async saveNote({ title, content, tags = [], file }) {
    fs.mkdirSync(this.docsDir, { recursive: true });
    const safe = (title || '随手记').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 40);
    const p = file ? this._notePath(file) : path.join(this.docsDir, `${T.dateKey()}_${safe}.md`);
    const body = content.startsWith('#') ? content : `# ${title || safe}\n\n${content}`;
    fs.writeFileSync(p, body + (tags.length ? `\n\n标签：${tags.map((t) => '#' + t).join(' ')}\n` : ''));
    // 同步进知识库，便于检索（只记文件名，文档目录迁移后仍可对应）
    this.kb.removeByNote(path.basename(p));
    await this.kb.ingest({ text: body, title: title || safe, type: 'note', notePath: path.basename(p), tags });
    this.emit('data.changed', { kind: 'notes' });
    return { path: p, name: path.basename(p) };
  }
  removeNote(file) {
    const p = this._notePath(file);
    fs.rmSync(p, { force: true });
    this.kb.removeByNote(path.basename(p));
    this.emit('data.changed', { kind: 'notes' });
    return true;
  }

  // ───────────────────────── 长期记忆 ─────────────────────────
  remember(fact) {
    const m = this.store.memories.add({ fact });
    return m;
  }

  // ───────────────────────── 天气 ─────────────────────────
  weather(city, opts) {
    return weather.getWeather(city || this.s.user.city, opts);
  }

  // ───────────────────────── 今日概览 ─────────────────────────
  today() {
    const now = new Date();
    const w = this.s.work;
    const workday = T.isWorkday(w, now);
    const end = T.atTime(w.end, now);
    const tasks = this.listTasks({ view: 'today' });
    const events = this.listEvents();
    const stats = this.store.daily(T.dateKey());
    return {
      date: T.dateKey(now),
      weekday: `周${T.WEEK[now.getDay()]}`,
      time: T.hm(now),
      workday,
      minutesToOffwork: workday ? Math.round((end - now) / 60_000) : null,
      work: { start: w.start, end: w.end },
      tasks: { total: tasks.length, done: tasks.filter((t) => t.status === 'done').length, items: tasks },
      events,
      nextEvent: events.find((e) => !e.allDay && new Date(e.start) > now) || null,
      stats,
      waterGoal: this.s.reminders.water.goal,
      nickname: this.s.user.nickname,
    };
  }

  /** 给模型看的今日快照（纯文本，控制 token） */
  todayText() {
    const t = this.today();
    const lines = [
      `当前时间：${T.localISO()}（${t.weekday}，${t.workday ? '工作日' : '休息日'}）`,
      `工作时间：${t.work.start}–${t.work.end}` + (t.minutesToOffwork > 0 ? `，距下班 ${T.fmtDuration(t.minutesToOffwork)}` : ''),
      `今日日程：${t.events.length ? t.events.map((e) => `${e.allDay ? '全天' : e.start.slice(11, 16)} ${e.title}`).join('；') : '无'}`,
      `今日待办：${t.tasks.done}/${t.tasks.total} 完成` +
        (t.tasks.items.length ? '：' + t.tasks.items.map((x) => `${x.status === 'done' ? '✓' : '○'}${x.title}`).join('；') : ''),
      `未来 7 天：${this.upcoming(7).map((a) => `${a.date.slice(5)} ${a.items.map((x) => x.title).join('、')}`).join('；') || '无安排'}`,
      `今日喝水 ${t.stats.water}/${t.waterGoal} 杯，起立 ${t.stats.stand} 次，专注 ${t.stats.focus} 个番茄`,
    ];
    return lines.join('\n');
  }

  memoriesText() {
    const m = this.store.memories.list();
    return m.length ? m.map((x) => `- ${x.fact}`).join('\n') : '（暂无）';
  }

  // ───────────────────────── 日报 ─────────────────────────
  async generateReport(date = T.dateKey()) {
    const done = this.store.tasks.list((t) => t.status === 'done' && (t.completedAt || '').slice(0, 10) === date);
    const open = this.store.tasks.list((t) => t.status !== 'done' && this.taskDate(t) <= date);
    const evs = this.store.events.list((e) => e.start.slice(0, 10) === date);
    const notes = this.listNotes().filter((n) => n.updatedAt.slice(0, 10) === date);
    const tpl = this._prompt('daily_report.md');
    const fill = {
      'user.nickname': this.s.user.nickname,
      date,
      tasks_done: done.map((t) => t.title).join('；') || '无',
      tasks_open: open.map((t) => t.title).join('；') || '无',
      events: evs.map((e) => `${e.start.slice(11, 16)} ${e.title}`).join('；') || '无',
      notes: notes.map((n) => n.name.replace(/\.md$/, '')).join('；') || '无',
      chat_items: '无',
    };
    const prompt = tpl.replace(/\{\{([\w.]+)\}\}/g, (_, k) => fill[k] ?? '');
    const run = this.llm.traceable(
      async (input) => this.llm.complete({ messages: [{ role: 'user', content: input.prompt }], temperature: 0.3 }),
      { name: 'daily_report', run_type: 'chain', metadata: { date } }
    );
    const text = await run({ prompt, date });
    await this.llm.flush();
    return { title: `${date} 工作日报`, text };
  }

  _prompt(name) {
    return fs.readFileSync(path.join(CONFIG_DIR, 'prompts', name), 'utf8');
  }

  // ───────────────────────── 消息发送 ─────────────────────────
  channels() {
    return (this.s.channels || []).map(({ secret, webhook, ...c }) => ({ ...c, configured: !!webhook }));
  }
  async sendMessage({ channelId, title, text }) {
    const ch = (this.s.channels || []).find((c) => c.id === channelId || c.name === channelId);
    if (!ch) throw new Error(`找不到渠道：${channelId}`);
    const rec = this.store.outbox.add({ channelId: ch.id, title, text, status: 'sending' });
    try {
      await messenger.send({ ...ch, webhook: decryptSecret(ch.webhook), secret: decryptSecret(ch.secret) }, { title, text });
      this.store.outbox.update(rec.id, { status: 'sent', sentAt: new Date().toISOString() });
      return { ok: true, channel: ch.name };
    } catch (e) {
      this.store.outbox.update(rec.id, { status: 'failed', error: e.message });
      throw e;
    }
  }
}

module.exports = { Core, PRIORITY };
