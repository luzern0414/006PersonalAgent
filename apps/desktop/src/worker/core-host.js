'use strict';
// 后台业务进程（Electron utilityProcess）
// 任务 / 日程 / 提醒调度 / 知识库（解析、OCR、检索）/ 模型调用 / 天气联网全部在这里运行，
// 主进程只负责窗口与系统交互：这里即使遇到慢网络、大文件解析或同步磁盘读写，也不会让宠物和面板卡住。
//
// 与主进程的消息（process.parentPort）：
//   主 → 后台：call{id,method,args} | settings{data} | secrets{entries} | env{idleSec,fullscreen} | lock{locked} | resume | confirm-answer{cid,ok}
// 启动握手：后台加载完发 hello → 主进程下发 settings / secrets → 后台据此初始化业务核心 → 发 ready
// 测试可设置环境变量 PA_CORE_FIXTURE 指向一个模块，在初始化前替换核心模块的实现（只用于隔离测试）
//   后台 → 主：hello | ready | result{id,ok,value,error} | emit{event,data} | deliver{n} | chat-event{callId,ev} | confirm{callId,cid,payload} | log{level,msg,details} | mainCall{id,method,args}
const fs = require('node:fs');
const path = require('node:path');
const { Settings } = require('../core/settings');
const { Core } = require('../core/services');
const { Agent } = require('../core/agent');
const { Scheduler } = require('../core/scheduler');
const { KnowledgeBase } = require('../core/kb/kb');
const { SUPPORTED } = require('../core/kb/parsers');
const { setCipher } = require('../core/credentials');
const T = require('../core/time');

const port = process.parentPort;
const post = (msg) => port.postMessage(msg);
const log = (level, msg, details) => post({ type: 'log', level, msg: String(msg), details });

// ───────── 设置与密钥：均由主进程下发（本进程不写 settings.json，也拿不到 DPAPI） ─────────
if (process.env.PA_CORE_FIXTURE) require(process.env.PA_CORE_FIXTURE);
class HostSettings extends Settings {
  load() {
    return {}; // 内容等主进程下发；本进程从不读写 settings.json
  }
  write() {}
}
const settings = new HostSettings();
const secrets = new Map();
setCipher({ encrypt: null, decrypt: (b64) => secrets.get(b64) ?? '' });

// ───────── 主进程环境（空闲时长、全屏）：定期推送，调度器读取缓存 ─────────
const env = { idleSec: 0, at: Date.now(), fullscreen: false };

// ───────── 调用主进程（目前只有图片压缩需要 nativeImage） ─────────
let mainSeq = 0;
const mainWaiters = new Map();
function callMain(method, ...args) {
  return new Promise((resolve, reject) => {
    const id = ++mainSeq;
    mainWaiters.set(id, { resolve, reject });
    post({ type: 'mainCall', id, method, args });
  });
}

let core, agent, scheduler;
/** 收到第一份设置后创建业务核心 */
function init() {
  core = new Core(settings, { log });
  core.emitter = (event, data) => post({ type: 'emit', event, data });
  core.ocr.prepare = async (buf, mime) => {
    const r = await callMain('prepareImage', buf, mime);
    return { buf: Buffer.from(r.buf), mime: r.mime };
  };
  agent = new Agent(core);
  scheduler = new Scheduler(core, {
    getIdleSec: () => env.idleSec,
    isFullscreen: () => env.fullscreen,
    deliver: (n) => post({ type: 'deliver', n }),
  });
  scheduler.start();
  post({ type: 'ready' });
  log('info', `后台业务进程启动 pid=${process.pid}`);
}

// ───────── 对话确认：转给主进程弹到界面，等待回答 ─────────
let confirmSeq = 0;
const confirmWaiters = new Map();

// ───────── 知识库入库（遍历文件夹 + 解析都在这里做） ─────────
async function ingestPaths(paths) {
  const files = [];
  const walk = (p, depth = 0) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (depth > 4 || /node_modules|\.git$/.test(p)) return;
      for (const f of fs.readdirSync(p)) walk(path.join(p, f), depth + 1);
    } else if (SUPPORTED.has(path.extname(p).slice(1).toLowerCase())) files.push(p);
  };
  for (const p of paths) {
    try {
      walk(p);
    } catch {
      /* 无权限等 */
    }
  }
  const results = [];
  for (const f of files) {
    try {
      const r = await core.kb.ingest({ path: f }, { onProgress: (p) => post({ type: 'emit', event: 'kb:progress', data: { file: path.basename(f), ...p } }) });
      results.push({ file: path.basename(f), ok: true, duplicate: r.duplicate, chunks: r.doc.chunks, id: r.doc.id });
    } catch (e) {
      results.push({ file: path.basename(f), ok: false, error: e.message });
      log('warn', `入库失败 ${f}: ${e.message}`);
    }
  }
  if (files.length) core.emit('data.changed', { kind: 'kb' });
  return { files: files.length, results };
}

// ───────── 对主进程开放的方法 ─────────
const API = {
  // 概览 / 天气 / 健康
  today: () => core.today(),
  weather: (city, force) => core.weather(city, { force }),
  healthLog: (kind) => (scheduler.logHealth(kind), core.store.daily(T.dateKey())),
  focusStart: (min) => (scheduler.startFocus(min), scheduler.focusState()),
  focusStop: () => (scheduler.stopFocus(), scheduler.focusState()),
  focusState: () => scheduler.focusState(),
  dnd: (min) => scheduler.setDnd(min),
  dndState: () => ({ until: scheduler.st.dndUntil || '', reason: scheduler.dndReason() }),
  menuState: () => ({ focus: scheduler.focusState(), dnd: !!(scheduler.st.dndUntil && new Date(scheduler.st.dndUntil) > new Date()) }),
  dayRollover: () => scheduler.dayRollover(new Date()),
  bubbleAction: (action) => {
    if (scheduler.handleAction(action)) return { handled: true };
    const [name, arg] = action.split(':');
    if (name === 'task-done') return core.updateTask(arg, { status: 'done' }), { handled: true };
    if (name === 'remind-snooze') return scheduler.snoozeReminder(arg), { handled: true };
    return { handled: false };
  },
  // 待办 / 日程 / 提醒（界面只读 + 勾选；新增修改走对话）
  tasksList: (q) => core.listTasks(q),
  tasksUpdate: (id, p) => core.updateTask(id, p),
  tasksRemove: (id) => core.removeTask(id),
  eventsList: (q) => core.listEvents(q),
  eventsRemove: (id) => core.removeEvent(id),
  scheduleText: (range) => core.formatSchedule(range),
  remindersList: () => core.listReminders(),
  remindersRemove: (id) => core.removeReminder(id),
  reminderDone: (id, date, done) => core.setReminderDone(id, date, done),
  agenda: (date) => {
    const a = core.agenda(date);
    return { ...a, items: a.items.map(({ raw, ...x }) => x) };
  },
  monthSummary: (y, m) => core.monthSummary(y, m),
  upcoming: (days) => core.upcoming(days).map((a) => ({ ...a, items: a.items.map(({ raw, ...x }) => x) })),
  // 知识库 / 文档
  kbStats: () => core.kb.stats(),
  kbList: () => core.kb.listDocs(),
  kbSearch: (q, k) => core.kb.search(q, k),
  kbRemove: (id) => core.kb.remove(id),
  kbUnload: () => core.kb.unload(),
  kbTarget: (id) => {
    const doc = core.kb.listDocs().find((d) => d.id === id);
    if (!doc) return null;
    if (doc.url) return { url: doc.url };
    if (doc.notePath) return { path: path.join(settings.paths().docsDir, doc.notePath) };
    return { path: core.kb.docPath(doc) };
  },
  ingestPaths,
  ingestText: async (text) => {
    const isUrl = /^https?:\/\/\S+$/.test(text.trim());
    const r = await core.kb.ingest(isUrl ? { url: text.trim() } : { text, title: text.split('\n')[0].slice(0, 30) });
    core.emit('data.changed', { kind: 'kb' });
    return { title: r.doc.title };
  },
  notesList: () => core.listNotes(),
  notesRead: (f) => core.readNote(f),
  notesRemove: (f) => core.removeNote(f),
  // 对话
  chatHistory: () => core.store.messagesFile('main').data.messages,
  chatRun: (callId, { conversationId, text }) =>
    agent.run(
      { conversationId, text },
      {
        onEvent: (ev) => post({ type: 'chat-event', callId, ev }),
        confirm: ({ tool, args, preview }) =>
          new Promise((resolve) => {
            const cid = ++confirmSeq;
            confirmWaiters.set(cid, resolve);
            post({ type: 'confirm', callId, cid, payload: { type: 'confirm', tool, args, preview } });
          }),
      }
    ),
  chatStop: (id = 'main') => agent.stop(id),
  // 日报 / 发送
  reportGenerate: (date) => core.generateReport(date),
  channels: () => core.channels(),
  send: (msg) => core.sendMessage(msg),
  channelTest: (id) => core.sendMessage({ channelId: id, title: '小管家测试消息', text: '如果你看到这条消息，说明渠道配置成功 ✅' }),
  // 模型
  llmModels: () => core.llm.listModels(),
  llmTest: async () => {
    const t0 = Date.now();
    const run = core.llm.traceable(async () => core.llm.complete({ messages: [{ role: 'user', content: '用一句话打个招呼' }] }), { name: 'connection_test', run_type: 'chain' });
    const text = await run({});
    await core.llm.flush();
    return { text, ms: Date.now() - t0, traced: core.llm._ensure().tracing };
  },
  memoriesList: () => core.store.memories.list(),
  memoriesRemove: (id) => core.store.memories.remove(id),
  /** 设置里的保存位置变了：把旧目录内容复制过去（可能很慢，放在后台做） */
  migratePaths: (prev, now) => {
    const notes = [];
    if (now.knowledgeDir !== prev.knowledgeDir) {
      if (KnowledgeBase.migrate(prev.knowledgeDir, now.knowledgeDir)) notes.push('知识库已复制到新位置（旧目录保留，可手动删除）');
      core.kb.unload();
    }
    if (now.docsDir !== prev.docsDir && fs.existsSync(prev.docsDir)) {
      if (!fs.existsSync(now.docsDir) || !fs.readdirSync(now.docsDir).length) {
        fs.cpSync(prev.docsDir, now.docsDir, { recursive: true });
        notes.push('文档已复制到新位置');
      }
    }
    if (now.dataDir !== prev.dataDir) notes.push('数据目录变更将在重启后生效');
    return notes;
  },
  activeChats: () => agent.active.size,
  shutdown: async () => {
    scheduler.stop();
    for (const id of agent.active.keys()) agent.stop(id);
    for (const r of confirmWaiters.values()) r(false);
    confirmWaiters.clear();
    await core.ocr.dispose();
    core.store.flushAll();
    await core.llm.flush();
    return true;
  },
};

// ───────── 消息分发 ─────────
port.on('message', async ({ data: msg }) => {
  switch (msg?.type) {
    case 'call': {
      const fn = API[msg.method];
      try {
        if (!fn) throw new Error(`未知方法 ${msg.method}`);
        const value = await fn(...(msg.args || []));
        post({ type: 'result', id: msg.id, ok: true, value });
      } catch (e) {
        post({ type: 'result', id: msg.id, ok: false, error: e?.message || String(e) });
      }
      break;
    }
    case 'settings':
      settings.data = msg.data;
      if (!core) init();
      break;
    case 'secrets':
      secrets.clear();
      for (const [k, v] of msg.entries) secrets.set(k, v);
      break;
    case 'env':
      Object.assign(env, { idleSec: msg.idleSec, fullscreen: !!msg.fullscreen, at: Date.now() });
      break;
    case 'lock':
      scheduler?.setLocked(!!msg.locked);
      break;
    case 'resume':
      setTimeout(() => scheduler?.tick(), 3000);
      break;
    case 'confirm-answer': {
      const r = confirmWaiters.get(msg.cid);
      confirmWaiters.delete(msg.cid);
      r?.(!!msg.ok);
      break;
    }
    case 'mainResult': {
      const w = mainWaiters.get(msg.id);
      mainWaiters.delete(msg.id);
      if (w) msg.ok ? w.resolve(msg.value) : w.reject(new Error(msg.error));
      break;
    }
  }
});

process.on('uncaughtException', (e) => log('error', `后台进程异常：${e?.stack || e}`));
process.on('unhandledRejection', (e) => log('error', `后台进程未处理的 Promise 拒绝：${e?.stack || e}`));

post({ type: 'hello' });
