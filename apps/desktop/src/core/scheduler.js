'use strict';
// 主动引擎：喝水 / 起立 / 护眼、下班、早报、会前、任务到期、自定义提醒、番茄专注
// 每 30 秒一次 tick；健康提醒默认按「实际键鼠活跃时长」累计，离开电脑超过 N 分钟视为已活动
const T = require('./time');
const { performance } = require('node:perf_hooks');

const TICK_MS = 30_000;
const ACTIVE_IDLE_SEC = 90; // 空闲少于该秒数视为"正在用电脑"

const HEALTH = {
  water: {
    title: '喝水时间到',
    texts: ['喝口水吧，我陪你一起 💧', '已经忙了好一会儿啦，补充点水分～', '咕嘟咕嘟——该喝水啦'],
    state: 'drink',
    done: '喝了',
  },
  stand: {
    title: '起来活动一下',
    texts: ['坐太久啦，站起来伸个懒腰 🙆', '起身走两步，顺便看看窗外～', '肩颈要紧，起来活动 2 分钟吧'],
    state: 'stretch',
    done: '起来了',
  },
  eyes: {
    title: '让眼睛休息一下',
    texts: ['看看 6 米外的地方 20 秒 👀', '闭眼放松一下，眼睛会感谢你的'],
    state: 'sleepy',
    done: '休息了',
  },
};

class Scheduler {
  /**
   * @param {import('./services').Core} core
   * @param {{getIdleSec:()=>number, isFullscreen:()=>boolean, deliver:(n:object)=>void}} env
   */
  constructor(core, env) {
    this.core = core;
    this.env = env;
    this.timer = null;
    this.lastTick = Date.now();
    this.locked = false;
  }

  get st() {
    const s = this.core.store.state.data;
    s.scheduler ||= {};
    const st = s.scheduler;
    st.acc ||= { water: 0, stand: 0, eyes: 0 };
    st.fired ||= {};
    return st;
  }
  get cfg() {
    return this.core.s.reminders;
  }
  save() {
    this.core.store.state.save();
  }

  start() {
    this.dayRollover(new Date());
    this.timer = setInterval(() => this.tick(), TICK_MS);
    setTimeout(() => this.tick(), 4000);
  }
  stop() {
    clearInterval(this.timer);
  }

  // ───────── 免打扰 ─────────
  dndReason(now = new Date()) {
    const st = this.st;
    if (st.dndUntil && new Date(st.dndUntil) > now) return 'manual';
    if (st.focusUntil && new Date(st.focusUntil) > now) return 'focus';
    const q = this.cfg.quietHours;
    if (q.enabled && T.inRange(q.start, q.end, now)) return 'quiet';
    if (this.cfg.dndFullscreen && this.env.isFullscreen()) return 'fullscreen';
    if (this.locked) return 'locked';
    return '';
  }
  setDnd(minutes) {
    this.st.dndUntil = minutes ? T.localISO(new Date(Date.now() + minutes * 60_000)) : '';
    this.save();
  }

  // ───────── 番茄专注 ─────────
  startFocus(minutes = this.core.s.focus.minutes) {
    this.st.focusUntil = T.localISO(new Date(Date.now() + minutes * 60_000));
    this.st.focusMinutes = minutes;
    this.save();
    this.core.emit('focus.changed', this.focusState());
  }
  stopFocus() {
    this.st.focusUntil = '';
    this.save();
    this.core.emit('focus.changed', this.focusState());
  }
  focusState() {
    const u = this.st.focusUntil;
    return u && new Date(u) > new Date() ? { active: true, until: u, minutes: this.st.focusMinutes } : { active: false };
  }

  /** 锁屏 / 解锁（由主进程 powerMonitor 通知） */
  setLocked(v) {
    this.locked = v;
    if (v) this.lockedAt = Date.now();
    else if (this.lockedAt && Date.now() - this.lockedAt > this.cfg.breakResetMin * 60_000) {
      // 离开了一段时间：起立/护眼计时清零
      this.st.acc.stand = 0;
      this.st.acc.eyes = 0;
      this.save();
    }
  }

  deliver(n) {
    const dnd = this.dndReason();
    this.env.deliver({ ...n, dnd });
  }

  tick() {
    const started = performance.now();
    const now = new Date();
    const elapsed = Math.min((now - this.lastTick) / 1000, TICK_MS / 1000 * 2); // 睡眠唤醒后不累计
    this.lastTick = now.getTime();
    try {
      this.dayRollover(now);
      this.focusTick(now);
      this.healthTick(now, elapsed);
      this.morningTick(now);
      this.offworkTick(now);
      this.eventTick(now);
      this.taskDueTick(now);
      this.customTick(now);
    } catch (e) {
      this.core.log('error', `scheduler: ${e.stack || e.message}`);
    } finally {
      const elapsedMs = performance.now() - started;
      if (elapsedMs > 1000) this.core.log('warn', `scheduler tick 耗时 ${elapsedMs}ms`, {
        event: 'scheduler_slow_tick', elapsedMs: Math.round(elapsedMs),
      });
    }
  }

  dayRollover(now) {
    const today = T.dateKey(now);
    if (this.st.day !== today) {
      this.st.day = today;
      this.st.fired = {};
      this.st.acc = { water: 0, stand: 0, eyes: 0 };
      this.save();
    }
    // Same-day backdated tasks and startup after an earlier run still need a check.
    return this.core.carryOver(now);
  }

  focusTick(now) {
    const u = this.st.focusUntil;
    if (!u || new Date(u) > now) return;
    this.st.focusUntil = '';
    this.core.store.daily(T.dateKey(now)).focus++;
    this.save();
    this.core.emit('focus.changed', this.focusState());
    this.env.deliver({
      id: 'focus-done',
      kind: 'focus',
      title: '专注完成 🍅',
      text: `太棒了！休息 ${this.core.s.focus.breakMinutes} 分钟吧`,
      state: 'happy',
      important: true,
      actions: [
        { id: 'focus-again', label: '再来一个' },
        { id: 'ok', label: '休息一下' },
      ],
    });
  }

  healthTick(now, elapsed) {
    const cfg = this.cfg;
    const st = this.st;
    if (cfg.onlyWorkHours && !T.inWorkHours(this.core.s.work, now)) return;
    const idle = this.env.getIdleSec();
    const active = cfg.mode === 'fixed' || idle < ACTIVE_IDLE_SEC;
    if (idle > cfg.breakResetMin * 60) {
      st.acc.stand = 0;
      st.acc.eyes = 0;
    }
    if (!active) return;
    const dnd = this.dndReason(now);
    for (const kind of Object.keys(HEALTH)) {
      const c = cfg[kind];
      if (!c?.enabled) continue;
      st.acc[kind] += elapsed;
      if (st.acc[kind] < c.intervalMin * 60) continue;
      if (dnd) continue; // 免打扰期间暂存，结束后再提醒
      st.acc[kind] = 0;
      const h = HEALTH[kind];
      const stats = this.core.store.daily(T.dateKey(now));
      const extra = kind === 'water' ? `（今天 ${stats.water}/${cfg.water.goal} 杯）` : '';
      this.deliver({
        id: `health-${kind}`,
        kind,
        title: h.title,
        text: h.texts[Math.floor(Math.random() * h.texts.length)] + extra,
        state: h.state,
        actions: [
          { id: `${kind}-done`, label: h.done },
          { id: `${kind}-snooze`, label: `${cfg.snoozeMin} 分钟后` },
        ],
      });
    }
    this.save();
  }

  /** 气泡按钮回调 */
  handleAction(action) {
    const [kind, op] = action.split('-');
    if (HEALTH[kind]) {
      if (op === 'done') {
        const d = this.core.store.daily(T.dateKey());
        d[kind] = (d[kind] || 0) + 1;
        this.st.acc[kind] = 0;
        this.core.emit('data.changed', { kind: 'stats' });
      } else if (op === 'snooze') {
        this.st.acc[kind] = Math.max(0, this.cfg[kind].intervalMin * 60 - this.cfg.snoozeMin * 60);
      }
      this.save();
      return true;
    }
    if (action === 'focus-again') {
      this.startFocus();
      return true;
    }
    return false;
  }

  /** 手动记一杯水 / 一次起立（来自面板或右键菜单） */
  logHealth(kind) {
    return this.handleAction(`${kind}-done`);
  }

  once(key, fn) {
    if (this.st.fired[key]) return;
    this.st.fired[key] = true;
    this.save();
    fn();
  }

  morningTick(now) {
    const w = this.core.s.work;
    if (!this.cfg.morning.enabled || !T.isWorkday(w, now)) return;
    const start = T.atTime(w.start, now);
    if (now < new Date(start - 30 * 60_000) || now > T.atTime(w.end, now)) return;
    if (this.env.getIdleSec() > ACTIVE_IDLE_SEC) return; // 等用户回到电脑前
    this.once('morning', async () => {
      const t = this.core.today();
      let wx = '';
      try {
        const x = await this.core.weather();
        wx = `${x.city}${x.now.text} ${x.now.temp}℃，今天 ${x.days[0].min}~${x.days[0].max}℃` + (x.rainNext12h >= 50 ? '，可能下雨记得带伞☔' : '');
      } catch {
        /* 天气失败不影响早报 */
      }
      const hour = now.getHours();
      const hi = hour < 11 ? '早上好' : hour < 14 ? '中午好' : '下午好';
      this.deliver({
        id: 'morning',
        kind: 'morning',
        title: `${hi}，${this.core.s.user.nickname}！`,
        text: [wx, `今天有 ${t.events.length} 个日程、${t.tasks.total} 项任务、${t.todos.open} 项待办`].filter(Boolean).join('\n'),
        state: 'happy',
        actions: [{ id: 'open-today', label: '看看今天' }],
      });
    });
  }

  offworkTick(now) {
    const w = this.core.s.work;
    const c = this.cfg.offwork;
    if (!c.enabled || !T.isWorkday(w, now)) return;
    const end = T.atTime(w.end, now);
    const pre = new Date(end - c.preMin * 60_000);
    if (now >= pre && now < end) {
      this.once('offwork-pre', () => {
        const t = this.core.today();
        this.deliver({
          id: 'offwork-pre',
          kind: 'offwork',
          title: `还有 ${c.preMin} 分钟下班`,
          text: `今天任务完成 ${t.tasks.done}/${t.tasks.total}，要我帮你写日报吗？`,
          state: 'alert',
          important: true,
          actions: [
            { id: 'report', label: '生成日报' },
            { id: 'ok', label: '好的' },
          ],
        });
      });
    }
    if (now >= end && now < new Date(end.getTime() + 60 * 60_000)) {
      this.once('offwork', () =>
        this.deliver({
          id: 'offwork',
          kind: 'offwork',
          title: '下班啦！🎉',
          text: '辛苦了，今天就到这里吧～ 记得带好东西',
          state: 'happy',
          important: true,
          actions: [{ id: 'ok', label: '下班！' }],
        })
      );
    }
  }

  eventTick(now) {
    for (const ev of this.core.listEvents({ from: now, to: new Date(now.getTime() + 120 * 60_000) })) {
      if (ev.allDay || ev.remindBefore === null) continue;
      const start = new Date(ev.start);
      const before = ev.remindBefore ?? this.cfg.meetingBeforeMin;
      if (now >= new Date(start - before * 60_000) && now < start) {
        this.once(`event-${ev.id}-${ev.start}`, () =>
          this.deliver({
            id: `event-${ev.id}`,
            kind: 'event',
            title: `${Math.max(1, Math.round((start - now) / 60_000))} 分钟后：${ev.title}`,
            text: `${T.hm(start)}–${T.hm(new Date(ev.end))}${ev.location ? ` · ${ev.location}` : ''}`,
            state: 'alert',
            important: true,
            actions: [{ id: 'ok', label: '知道了' }],
          })
        );
      }
    }
  }

  taskDueTick(now) {
    const ahead = new Date(now.getTime() + this.cfg.taskDueBeforeMin * 60_000);
    for (const t of this.core.store.tasks.items) {
      if (t.status === 'done' || !t.due || t.due.length < 16) continue;
      const due = new Date(t.due);
      if (due > now && due <= ahead) {
        this.once(`due-${t.id}-${t.due}`, () =>
          this.deliver({
            id: `due-${t.id}`,
            kind: 'task',
            title: `快到截止时间：${t.title}`,
            text: `截止 ${T.hm(due)}`,
            state: 'alert',
            important: true,
            actions: [
              { id: `task-done:${t.id}`, label: '已完成' },
              { id: 'ok', label: '知道了' },
            ],
          })
        );
      }
    }
  }

  customTick(now) {
    for (const r of this.core.store.reminders.items) {
      if (!r.enabled || !r.nextAt || new Date(r.nextAt) > now) continue;
      const late = now - new Date(r.nextAt) > 30 * 60_000; // 关机/睡眠错过太久的，标注一下
      this.deliver({
        id: `reminder-${r.id}`,
        kind: 'reminder',
        title: late ? '⏰ 错过的提醒' : '⏰ 提醒',
        text: r.text,
        state: 'alert',
        important: true,
        actions: [
          { id: `remind-snooze:${r.id}`, label: `${this.cfg.snoozeMin} 分钟后` },
          { id: 'ok', label: '好的' },
        ],
      });
      if (r.repeat === 'none') r.enabled = false;
      r.nextAt = this.core.nextFire(r, now);
      this.core.store.reminders.save();
      this.core.emit('data.changed', { kind: 'reminders' });
    }
  }

  snoozeReminder(id) {
    const r = this.core.store.reminders.get(id);
    if (!r) return;
    r.enabled = true;
    r.nextAt = T.localISO(new Date(Date.now() + this.cfg.snoozeMin * 60_000));
    this.core.store.reminders.save();
  }
}

module.exports = { Scheduler, HEALTH };
