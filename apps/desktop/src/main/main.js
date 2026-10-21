'use strict';
// 主进程：只负责窗口（宠物 / 面板）、托盘、快捷键、通知、剪贴板、对话框、设置加密。
// 业务逻辑（待办、日程、提醒调度、知识库、模型、天气联网）运行在后台 utilityProcess（src/worker/core-host.js），
// 这样后台的慢网络、大文件解析、磁盘读写都不会让界面卡住。
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, globalShortcut, Notification, nativeImage, shell, dialog, powerMonitor, safeStorage, clipboard, crashReporter } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Settings } = require('../core/settings');
const { setCipher, encryptSecret, resolveCredentials, mask } = require('../core/credentials');
const { SUPPORTED } = require('../core/kb/parsers');
const { TYPES: CHANNEL_TYPES } = require('../core/messenger');
const { newId } = require('../core/store');
const T = require('../core/time');
const win32 = require('./win32');
const { createLogger } = require('./logger');
const { installRuntimeDiagnostics } = require('./runtime-diagnostics');
const { createChatConfirmations } = require('./chat-confirmations');
const { CoreClient } = require('./core-client');

// ───────────────────────── 启动前：单实例 + 性能开关 ─────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
const settings = new Settings();
if (settings.get().performance.disableGpu) app.disableHardwareAcceleration();
// 减少常驻进程与内存：关闭备用渲染进程、媒体会话等用不到的特性；限制 V8 堆
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaSessionService,HardwareMediaKeyHandling,Translate');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
app.setAppUserModelId('PersonalAgent.Desktop');
// 主进程可手动 GC：面板释放后立即回收内存
require('v8').setFlagsFromString('--expose-gc');
const gc = require('vm').runInNewContext('gc');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const PET_BASE = { w: 240, h: 280 }; // 宠物窗口（含上方气泡区域）
const REPORT_PROMPT = '帮我写今天的工作日报';

const log = createLogger(settings.paths().logsDir);
const diagnostics = installRuntimeDiagnostics({ app, crashReporter, powerMonitor, log, dir: settings.paths().logsDir });
let core = null; // CoreClient：后台业务进程
let petWin = null;
let panelWin = null;
let tray = null;
let panelReleaseTimer = null;
let quitting = false;
let activeChats = 0;
const pendingConfirms = createChatConfirmations();
const chatCalls = new Map(); // callId → { send, senderId, convId, onEvent }

const callCore = (method, ...args) => core.call(method, args);
const callCoreLong = (method, ...args) => core.call(method, args, { timeoutMs: 0 });

// ───────────────────────── 工具函数 ─────────────────────────
function petSize() {
  const k = settings.get().pet.scale || 1;
  return { w: Math.round(PET_BASE.w * k), h: Math.round(PET_BASE.h * k) };
}
function sendPet(ch, data) {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send(ch, data);
}
function sendPanel(ch, data) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(ch, data);
}
function broadcast(ch, data) {
  sendPet(ch, data);
  sendPanel(ch, data);
}
function petVisible() {
  return !!(petWin && !petWin.isDestroyed() && petWin.isVisible());
}

// ───────────────────────── 宠物窗口 ─────────────────────────
let hitRects = []; // 渲染进程上报的可交互区域（窗口内 CSS 像素）
let ignoring = null;
let hitTimer = null;
let lastEye = '';
let drag = null;

function createPetWindow() {
  const { w, h } = petSize();
  const wa = screen.getPrimaryDisplay().workArea;
  let pos = settings.get().pet.position;
  const visibleSomewhere = pos && screen.getAllDisplays().some((d) => {
    const b = d.workArea;
    return pos.x + w / 2 > b.x && pos.x + w / 2 < b.x + b.width && pos.y + h / 2 > b.y && pos.y + h / 2 < b.y + b.height;
  });
  if (!visibleSomewhere) pos = { x: wa.x + wa.width - w - 24, y: wa.y + wa.height - h };

  petWin = new BrowserWindow({
    x: pos.x,
    y: pos.y,
    width: w,
    height: h,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // 不抢焦点
    alwaysOnTop: settings.get().pet.alwaysOnTop,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, spellcheck: false, backgroundThrottling: true },
  });
  diagnostics.watchWindow(petWin, '桌宠');
  petWin.setAlwaysOnTop(settings.get().pet.alwaysOnTop, 'floating');
  petWin.loadFile(path.join(RENDERER, 'pet', 'pet.html'));
  petWin.once('ready-to-show', () => {
    if (settings.get().pet.visible) petWin.showInactive();
    setIgnore(true);
    startHitTest();
  });
  petWin.on('closed', () => {
    petWin = null;
    stopHitTest();
  });
}

/**
 * 透明区域点击穿透。不使用 { forward: true }：Windows 上它会安装系统级低层鼠标钩子（WH_MOUSE_LL），
 * 全系统每次鼠标移动都要经过本进程主线程，主线程稍忙就会让整个桌面的鼠标卡顿。
 * 命中判断改由下方的光标轮询完成，不需要转发鼠标事件。
 */
function setIgnore(v) {
  if (!petWin || ignoring === v) return;
  ignoring = v;
  petWin.setIgnoreMouseEvents(v);
}

/** 光标轮询：命中宠物身体/气泡时接收鼠标，否则点击穿透；顺便驱动眼睛跟随 */
function startHitTest() {
  stopHitTest();
  hitTimer = setInterval(() => diagnostics.syncOperation('timer:petHitTest', () => {
    if (!petWin || !petWin.isVisible() || drag) return;
    const p = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    const lx = p.x - b.x;
    const ly = p.y - b.y;
    const inside = hitRects.some((r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);
    setIgnore(!inside);
    if (settings.get().pet.eyeFollow) {
      const key = `${Math.round(lx / 8)},${Math.round(ly / 8)}`;
      if (key !== lastEye) {
        lastEye = key;
        sendPet('pet:cursor', { x: lx, y: ly });
      }
    }
  }), 90);
}
function stopHitTest() {
  clearInterval(hitTimer);
  hitTimer = null;
}

function startDrag() {
  if (!petWin) return;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = petWin.getPosition();
  drag = { cx: c.x, cy: c.y, wx, wy, moved: false, timer: null };
  setIgnore(false);
  drag.timer = setInterval(() => diagnostics.syncOperation('timer:petDrag', () => {
    if (!drag || !petWin) return;
    const p = screen.getCursorScreenPoint();
    const dx = p.x - drag.cx;
    const dy = p.y - drag.cy;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      sendPet('pet:state', { state: 'drag' });
    }
    if (drag.moved) petWin.setPosition(drag.wx + dx, drag.wy + dy);
    if (win32.isLeftButtonDown() === false) endDrag(); // 鼠标在窗口外松开也能结束
  }), 16);
}
function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  if (!moved) return togglePanel();
  sendPet('pet:state', { state: 'idle' });
  snapToEdge();
}

function snapToEdge() {
  if (!petWin) return;
  const b = petWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const body = hitRects.find((r) => r.id === 'pet') || { x: 0, y: 0, w: b.width, h: b.height };
  const left = b.x + body.x;
  const right = b.x + body.x + body.w;
  const bottom = b.y + body.y + body.h;
  const TH = 36;
  let { x, y } = b;
  if (left - wa.x < TH) x = wa.x - body.x;
  else if (wa.x + wa.width - right < TH) x = wa.x + wa.width - body.x - body.w;
  if (wa.y + wa.height - bottom < TH) y = wa.y + wa.height - body.y - body.h;
  if (b.y + body.y < wa.y) y = wa.y - body.y;
  petWin.setPosition(Math.round(x), Math.round(y));
  settings.update({ pet: { position: { x: Math.round(x), y: Math.round(y) } } });
}

function togglePet(show) {
  if (!petWin) return;
  const v = show ?? !petWin.isVisible();
  if (v) {
    petWin.showInactive();
    startHitTest();
  } else {
    petWin.hide();
    stopHitTest();
  }
  settings.update({ pet: { visible: v } });
  buildTrayMenu();
}

async function showPetMenu() {
  const st = await callCore('menuState').catch(() => ({ focus: { active: false }, dnd: false }));
  Menu.buildFromTemplate([
    { label: '打开面板', click: () => showPanel() },
    { label: '和我聊天', click: () => showPanel('chat') },
    { type: 'separator' },
    { label: '💧 喝了一杯水', click: () => healthLog('water') },
    { label: '🙆 起来活动了', click: () => healthLog('stand') },
    st.focus.active
      ? { label: '结束专注', click: () => callCore('focusStop') }
      : { label: `🍅 专注 ${settings.get().focus.minutes} 分钟`, click: () => startFocus() },
    st.dnd ? { label: '取消勿扰', click: () => callCore('dnd', 0) } : { label: '勿扰 1 小时', click: () => callCore('dnd', 60) },
    { type: 'separator' },
    { label: '收藏剪贴板到知识库', click: () => ingestClipboard() },
    { label: '隐藏宠物', click: () => togglePet(false) },
    { label: '设置', click: () => showPanel('settings') },
    { label: '退出', click: () => quit() },
  ]).popup({ window: petWin });
}

// ───────────────────────── 面板窗口 = 桌面组件 ─────────────────────────
// 点宠物打开/收起；失焦后沉到其他程序窗口之后（像固定在桌面上）；拖到哪里就记住哪里
// 收起一段时间后销毁窗口释放内存，再次打开约 0.3 秒
function createPanelWindow() {
  panelWin = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 360,
    minHeight: 480,
    frame: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#f3f2ef',
    title: '小管家',
    icon: path.join(ASSETS, 'icon-256.png'),
    webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, spellcheck: false, backgroundThrottling: true },
  });
  diagnostics.watchWindow(panelWin, '面板');
  panelWin.loadFile(path.join(RENDERER, 'panel', 'panel.html'));
  panelWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hidePanel();
    }
  });
  panelWin.on('closed', () => (panelWin = null));
  const win = panelWin;
  panelWin.on('blur', () => setTimeout(async () => {
    if (win.isDestroyed() || !win.isVisible() || win.isFocused()) return;
    if (!(await win32.sendToBottom(win))) log('warn', '面板沉底失败');
  }, 150));
  let moveTimer = null;
  panelWin.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!panelWin) return;
      const [x, y] = panelWin.getPosition();
      const [w, h] = panelWin.getSize();
      settings.update({ pet: { panelPosition: { x, y, w, h } } });
    }, 400);
  });
  panelWin.on('resized', () => panelWin.emit('moved'));
  panelWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  panelWin.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  return new Promise((r) => panelWin.once('ready-to-show', r));
}

function placePanel() {
  // 优先用户拖过的位置（仍在某块屏幕内时）
  const saved = settings.get().pet.panelPosition;
  if (saved) {
    const fits = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return saved.x + 40 > b.x && saved.x + 40 < b.x + b.width && saved.y + 20 > b.y && saved.y + 20 < b.y + b.height;
    });
    if (fits) {
      if (saved.w && saved.h) panelWin.setSize(saved.w, saved.h);
      return panelWin.setPosition(saved.x, saved.y);
    }
  }
  const [pw, ph] = panelWin.getSize();
  const ref = petWin && petWin.isVisible() ? petWin.getBounds() : null;
  const wa = (ref ? screen.getDisplayMatching(ref) : screen.getPrimaryDisplay()).workArea;
  let x, y;
  if (ref) {
    const body = hitRects.find((r) => r.id === 'pet') || { x: 0, y: 0, w: ref.width, h: ref.height };
    const cx = ref.x + body.x + body.w / 2;
    x = cx > wa.x + wa.width / 2 ? ref.x + body.x - pw - 8 : ref.x + body.x + body.w + 8;
    y = ref.y + body.y + body.h - ph;
  } else {
    x = wa.x + wa.width - pw - 16;
    y = wa.y + wa.height - ph - 16;
  }
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - pw));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - ph));
  panelWin.setPosition(Math.round(x), Math.round(y));
}

async function showPanel(view, opts) {
  callCore('dayRollover').catch(() => {});
  clearTimeout(panelReleaseTimer);
  const fresh = !panelWin;
  if (fresh) await createPanelWindow();
  if (fresh || !panelWin.isVisible()) placePanel();
  panelWin.show();
  panelWin.focus();
  if (view) sendPanel('panel:navigate', { view, ...opts });
}
function hidePanel() {
  if (!panelWin) return;
  panelWin.hide();
  const min = settings.get().performance.panelReleaseMin;
  clearTimeout(panelReleaseTimer);
  if (min >= 0) {
    const release = () => {
      if (panelWin && !panelWin.isVisible()) {
        // 正在对话/等待工具确认时保留渲染进程及 IPC 接收方。
        if (activeChats > 0) {
          panelReleaseTimer = setTimeout(release, 30_000);
          return;
        }
        panelWin.destroy(); // destroy 不触发 close 事件
        panelWin = null;
        callCore('kbUnload').catch(() => {}); // 同时释放知识库索引内存
        setTimeout(gc, 1000);
      }
    };
    panelReleaseTimer = setTimeout(release, min * 60_000);
  }
}
/** 点宠物：没打开 → 打开；打开但被其他窗口挡住 → 提到最前；已在最前 → 收起 */
function togglePanel() {
  if (!panelWin || !panelWin.isVisible()) return showPanel();
  if (!panelWin.isFocused()) return showPanel();
  hidePanel();
}

// ───────────────────────── 托盘 ─────────────────────────
function buildTrayMenu() {
  if (!tray) return;
  const visible = petVisible();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开面板', click: () => showPanel() },
      { label: visible ? '隐藏宠物' : '显示宠物', click: () => togglePet(!visible) },
      { label: '勿扰 1 小时', click: () => callCore('dnd', 60) },
      { label: '设置', click: () => showPanel('settings') },
      { label: '开机自动启动', type: 'checkbox', checked: !!settings.get().autostart, click: (m) => saveSettings({ autostart: m.checked }) },
      { type: 'separator' },
      { label: '退出', click: () => quit() },
    ])
  );
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'icon-32.png')));
  tray.setToolTip('小管家');
  tray.on('click', () => togglePanel());
  tray.on('double-click', () => togglePet(true));
  buildTrayMenu();
}

// ───────────────────────── 提醒投递 ─────────────────────────
/** 宠物气泡优先；宠物隐藏/免打扰时按设置降级为系统通知 */
function deliver(n) {
  const cfg = settings.get().reminders;
  const hidden = !petVisible();
  const degrade = !!n.dnd;
  if (degrade && !n.important) return; // 免打扰期间不重要的直接跳过
  if (!hidden && !degrade) sendPet('pet:bubble', { ...n, seconds: cfg.bubbleSeconds });
  const toast = cfg.toast === 'always' || ((hidden || degrade) && cfg.toast !== 'never');
  if (toast && Notification.isSupported()) {
    const nt = new Notification({ title: n.title || '小管家', body: n.text || '', icon: path.join(ASSETS, 'icon-64.png'), silent: degrade });
    nt.on('click', () => showPanel());
    nt.show();
  }
  log('info', '提醒投递', { event: 'reminder_delivery', kind: n.kind, id: n.id, dnd: n.dnd, important: !!n.important });
}

async function healthLog(kind) {
  const d = await callCore('healthLog', kind);
  sendPet('pet:state', { state: kind === 'water' ? 'drink' : 'stretch', duration: 2500 });
  sendPet('pet:bubble', { id: 'h', text: kind === 'water' ? `今天第 ${d.water} 杯水 💧` : `今天起身 ${d.stand} 次啦 👍`, seconds: 3 });
  return d;
}
function startFocus() {
  callCore('focusStart');
  sendPet('pet:bubble', { id: 'f', text: `开始专注 ${settings.get().focus.minutes} 分钟，我帮你挡住打扰 🎧`, seconds: 4 });
}

async function onBubbleAction(action) {
  const r = await callCore('bubbleAction', action).catch(() => ({ handled: false }));
  if (r.handled) {
    const kind = action.split('-')[0];
    if (action.endsWith('-done')) sendPet('pet:state', { state: kind === 'water' ? 'drink' : 'happy', duration: 2500 });
    return;
  }
  const [name, arg] = action.split(':');
  if (name === 'open-today') return showPanel('today');
  if (name === 'report') return showPanel('chat', { send: REPORT_PROMPT });
  if (name === 'open') return showPanel(arg);
}

// ───────────────────────── 知识库入库（拖拽 / 剪贴板）：解析在后台进程完成 ─────────────────────────
async function ingestPaths(paths) {
  sendPet('pet:state', { state: 'eat', duration: 1800 });
  const { files, results } = await callCoreLong('ingestPaths', paths);
  if (!files) {
    sendPet('pet:bubble', { id: 'kb', text: '这个我吃不下…暂不支持该格式 😣', seconds: 4 });
    return { ok: 0, failed: paths.length, results: [] };
  }
  const ok = results.filter((r) => r.ok).length;
  const first = results[0];
  const text =
    files === 1
      ? first.ok
        ? first.duplicate
          ? `《${first.file}》之前已经收过啦`
          : `已收进知识库：《${first.file}》，共 ${first.chunks} 段 📚`
        : `《${first.file}》没消化掉：${first.error}`
      : `收进知识库 ${ok}/${files} 个文件 📚`;
  sendPet('pet:bubble', { id: 'kb', text, seconds: 5, actions: [{ id: 'open:knowledge', label: '去看看' }] });
  return { ok, failed: files - ok, results };
}

async function ingestText(text) {
  try {
    sendPet('pet:state', { state: 'eat', duration: 1800 });
    const r = await callCoreLong('ingestText', text);
    sendPet('pet:bubble', { id: 'kb', text: `已收藏：${r.title}`, seconds: 4 });
  } catch (e) {
    sendPet('pet:bubble', { id: 'kb', text: `收藏失败：${e.message}`, seconds: 4 });
  }
}

async function ingestClipboard() {
  // 剪贴板是截图：存成临时 PNG 后走 OCR 入库
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const tmp = path.join(os.tmpdir(), `截图_${T.dateKey()}_${T.hm().replace(':', '')}.png`);
    fs.writeFileSync(tmp, img.toPNG());
    sendPet('pet:bubble', { id: 'kb', text: '正在识别截图里的文字…', seconds: 30 });
    try {
      return await ingestPaths([tmp]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const text = clipboard.readText().trim();
  if (!text) return sendPet('pet:bubble', { id: 'kb', text: '剪贴板里没有文字或图片哦', seconds: 3 });
  return ingestText(text);
}

// ───────────────────────── 设置（主进程独占写入；同步给后台进程） ─────────────────────────
/** 把 settings 里加密保存的值解密后交给后台（只在内存中，不落盘） */
function secretEntries() {
  const s = settings.get();
  const vals = [s.llm.apiKey, s.langsmith.apiKey, ...(s.channels || []).flatMap((c) => [c.webhook, c.secret])];
  const out = [];
  for (const v of vals) {
    if (!v || !v.startsWith('enc:') || !safeStorage.isEncryptionAvailable()) continue;
    try {
      out.push([v.slice(4), safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))]);
    } catch {
      /* 无法解密的值忽略 */
    }
  }
  return out;
}
function syncCoreSettings() {
  if (!core) return;
  core.post({ type: 'settings', data: settings.get() });
  core.post({ type: 'secrets', entries: secretEntries() });
}

function publicSettings() {
  const s = structuredClone(settings.get());
  const c = resolveCredentials(s);
  s.llm.apiKey = s.llm.apiKey ? '••••••' : '';
  s.langsmith.apiKey = s.langsmith.apiKey ? '••••••' : '';
  s.channels = (s.channels || []).map((ch) => ({ ...ch, webhook: ch.webhook ? '••••••' : '', secret: ch.secret ? '••••••' : '' }));
  return {
    settings: s,
    resolved: {
      baseUrl: c.baseUrl,
      apiKey: mask(c.apiKey),
      model: c.model,
      keyFile: c.keyFile,
      langsmithKey: mask(c.langsmith.apiKey),
      paths: settings.paths(),
    },
    channelTypes: CHANNEL_TYPES,
  };
}

async function saveSettings(patch, { migrate = true } = {}) {
  const prev = settings.get();
  const prevPaths = settings.paths();
  // 密钥：空字符串/掩码表示不修改；明文则加密保存
  const keepOrEnc = (v, old) => (v === undefined || v === '' || v === '••••••' ? old : v === '-' ? '' : encryptSecret(v));
  if (patch.llm && 'apiKey' in patch.llm) patch.llm.apiKey = keepOrEnc(patch.llm.apiKey, prev.llm.apiKey);
  if (patch.langsmith && 'apiKey' in patch.langsmith) patch.langsmith.apiKey = keepOrEnc(patch.langsmith.apiKey, prev.langsmith.apiKey);
  if (patch.channels) {
    patch.channels = patch.channels.map((ch) => {
      const old = (prev.channels || []).find((o) => o.id === ch.id) || {};
      return { ...ch, id: ch.id || newId(), webhook: keepOrEnc(ch.webhook, old.webhook), secret: keepOrEnc(ch.secret, old.secret) };
    });
  }
  settings.update(patch); // onChange 会把新设置同步给后台进程
  const now = settings.paths();
  let notes = [];
  if (migrate && (now.knowledgeDir !== prevPaths.knowledgeDir || now.docsDir !== prevPaths.docsDir || now.dataDir !== prevPaths.dataDir)) {
    notes = await callCoreLong('migratePaths', prevPaths, now);
  }
  // 运行时生效项
  if (petWin) {
    const s = settings.get();
    petWin.setAlwaysOnTop(s.pet.alwaysOnTop, 'floating');
    const { w, h } = petSize();
    const [cw, ch] = petWin.getSize();
    if (cw !== w || ch !== h) {
      petWin.setResizable(true);
      petWin.setSize(w, h);
      petWin.setResizable(false);
      sendPet('pet:scale', s.pet.scale);
    }
  }
  if (patch.hotkeys) registerShortcuts();
  if ('autostart' in patch) applyAutostart();
  if (patch.performance && patch.performance.disableGpu !== prev.performance.disableGpu) notes.push('GPU 设置将在重启后生效');
  broadcast('settings.changed', {});
  return { ...publicSettings(), notes };
}

function applyAutostart() {
  const on = !!settings.get().autostart;
  const args = app.isPackaged ? [] : [path.resolve(__dirname, '..', '..')];
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args });
}

// ───────────────────────── 快捷键 ─────────────────────────
function registerShortcuts() {
  globalShortcut.unregisterAll();
  const hk = settings.get().hotkeys;
  const map = {
    togglePanel: () => togglePanel(),
    quickChat: () => showPanel('chat', { focusInput: true }),
    newTodo: () => showPanel('chat', { focusInput: true }), // 新增待办统一通过对话完成
    togglePet: () => togglePet(),
  };
  for (const [k, fn] of Object.entries(map)) {
    if (!hk[k]) continue;
    try {
      if (!globalShortcut.register(hk[k], fn)) log('warn', `快捷键被占用：${hk[k]}`);
    } catch (e) {
      log('warn', `快捷键无效 ${hk[k]}：${e.message}`);
    }
  }
}

// ───────────────────────── IPC ─────────────────────────
async function memoryUsage() {
  const metrics = app.getAppMetrics();
  const total = metrics.reduce((s, m) => s + (m.memory?.privateBytes || m.memory?.workingSetSize || 0), 0);
  return {
    totalMB: Math.round(total / 1024),
    processes: metrics.map((m) => ({ type: m.type, mb: Math.round((m.memory?.privateBytes || m.memory?.workingSetSize || 0) / 1024) })),
  };
}

// 直接转发给后台进程的方法（只读查询 + 勾选/删除；新增与修改统一通过对话完成）
const FORWARD = [
  'today', 'weather', 'focusStart', 'focusStop', 'focusState', 'dnd', 'dndState',
  'tasksList', 'tasksUpdate', 'tasksRemove', 'eventsList', 'eventsRemove', 'scheduleText',
  'remindersList', 'remindersRemove', 'reminderDone', 'agenda', 'monthSummary', 'upcoming',
  'kbStats', 'kbList', 'kbSearch', 'kbRemove', 'notesList', 'notesRead', 'notesRemove',
  'chatHistory', 'channels', 'send', 'channelTest', 'llmModels', 'llmTest', 'memoriesList', 'memoriesRemove',
];
const API = {
  ...Object.fromEntries(FORWARD.map((m) => [m, (...args) => callCore(m, ...args)])),
  reportGenerate: (date) => callCoreLong('reportGenerate', date),
  healthLog: (kind) => healthLog(kind),
  remindTest: () => deliver({ id: 'test', kind: 'test', title: '提醒测试', text: '这是一条测试提醒 🔔', state: 'alert', important: true, actions: [{ id: 'ok', label: '好的' }] }),
  kbIngestPaths: (paths) => ingestPaths(paths),
  kbClipboard: () => ingestClipboard(),
  kbOpen: async (id) => {
    const t = await callCore('kbTarget', id);
    if (!t) return false;
    return t.url ? shell.openExternal(t.url) : shell.openPath(t.path);
  },
  kbPickFiles: async () => {
    const r = await dialog.showOpenDialog(panelWin, { properties: ['openFile', 'multiSelections'], filters: [{ name: '文档', extensions: [...SUPPORTED] }] });
    return r.canceled ? null : ingestPaths(r.filePaths);
  },
  chatStop: (id = 'main') => {
    pendingConfirms.cancel({ conversationId: id });
    return callCore('chatStop', id);
  },
  settingsGet: () => publicSettings(),
  settingsSave: (patch, opts) => saveSettings(patch, opts),
  pickDir: async (def) => {
    const r = await dialog.showOpenDialog(panelWin, { defaultPath: def, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  openPath: (p) => shell.openPath(p),
  memory: () => memoryUsage(),
  chatActive: () => activeChats,
  appInfo: () => ({ version: app.getVersion(), electron: process.versions.electron, dataDir: settings.paths().dataDir }),
  quit: () => quit(),
};

function setupIpc() {
  ipcMain.on('diagnostics:renderer', (event, payload) => {
    if (event.sender !== panelWin?.webContents && event.sender !== petWin?.webContents) return;
    diagnostics.rendererError(event.sender, payload);
  });
  ipcMain.handle('api', async (_e, method, ...args) => {
    const fn = API[method];
    if (!fn) throw new Error(`未知方法 ${method}`);
    return diagnostics.operation(`api:${method}`, () => fn(...args));
  });

  // 对话：在后台进程运行，流式事件经主进程转给发起的窗口
  ipcMain.handle('chat:send', async (e, { conversationId, text }) => {
    const wc = e.sender;
    const senderId = wc.id;
    const convId = conversationId || 'main';
    const callId = newId();
    const send = (ev) => { if (wc.isDestroyed()) return false; wc.send('chat:event', ev); return true; };
    const onRendererLost = () => {
      const cancelled = pendingConfirms.cancel({ senderId, conversationId: convId });
      callCore('chatStop', convId).catch(() => {});
      log('warn', '对话页面退出，取消进行中的请求和确认', { event: 'chat_renderer_lost', senderId, conversationId: convId, cancelled });
    };
    wc.once('render-process-gone', onRendererLost);
    wc.once('destroyed', onRendererLost);
    sendPet('pet:state', { state: 'think' });
    let talking = false;
    chatCalls.set(callId, {
      senderId,
      convId,
      send,
      onEvent: (ev) => {
        if (ev.type === 'delta' && !talking) {
          talking = true;
          sendPet('pet:state', { state: 'talk' });
        }
        send(ev);
      },
    });
    activeChats++;
    try {
      return await diagnostics.operation('chat:send', () => callCoreLong('chatRun', callId, { conversationId, text }));
    } catch (err) {
      return { error: err.message };
    } finally {
      activeChats--;
      chatCalls.delete(callId);
      pendingConfirms.cancel({ senderId, conversationId: convId });
      wc.removeListener('render-process-gone', onRendererLost);
      wc.removeListener('destroyed', onRendererLost);
      sendPet('pet:state', { state: 'idle' });
    }
  });
  ipcMain.handle('chat:confirm', (event, id, ok) => pendingConfirms.answer(event.sender.id, id, ok));

  // 宠物窗口
  ipcMain.on('pet:hit-rects', (_e, rects) => (hitRects = rects));
  ipcMain.on('pet:drag-start', () => startDrag());
  ipcMain.on('pet:drag-end', () => endDrag());
  ipcMain.on('pet:menu', () => showPetMenu());
  ipcMain.on('pet:bubble-action', (_e, action) => onBubbleAction(action));
  ipcMain.on('pet:drop', (_e, paths) => ingestPaths(paths).catch((err) => log('warn', `入库失败：${err.message}`)));
  ipcMain.on('pet:drop-text', (_e, text) => ingestText(text));
}

// ───────────────────────── 后台进程的主动消息 ─────────────────────────
async function onCoreMessage(msg) {
  switch (msg.type) {
    case 'emit':
      if (msg.event === 'kb:progress') return sendPanel('kb:progress', msg.data);
      broadcast(msg.event, msg.data);
      if (msg.event === 'task.completed') sendPet('pet:state', { state: 'happy', duration: 2500 });
      if (msg.event === 'focus.changed') sendPet('pet:focus', msg.data);
      return;
    case 'deliver':
      return deliver(msg.n);
    case 'chat-event':
      return chatCalls.get(msg.callId)?.onEvent(msg.ev);
    case 'confirm': {
      const c = chatCalls.get(msg.callId);
      const ok = c ? await pendingConfirms.request({ senderId: c.senderId, conversationId: c.convId, payload: msg.payload, send: c.send }) : false;
      return core.post({ type: 'confirm-answer', cid: msg.cid, ok });
    }
    case 'mainCall':
      try {
        if (msg.method !== 'prepareImage') throw new Error(`未知方法 ${msg.method}`);
        return core.post({ type: 'mainResult', id: msg.id, ok: true, value: prepareImage(Buffer.from(msg.args[0]), msg.args[1]) });
      } catch (e) {
        return core.post({ type: 'mainResult', id: msg.id, ok: false, error: e.message });
      }
  }
}

/** OCR 前压缩大图（视觉模型对尺寸有限制）；nativeImage 只能在主进程使用 */
function prepareImage(buf, mime) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return { buf, mime };
  const { width, height } = img.getSize();
  const max = 2000;
  if (width <= max && height <= max && buf.length < 4 * 1024 * 1024 && /png|jpeg|webp/.test(mime)) return { buf, mime };
  const k = Math.min(1, max / Math.max(width, height));
  return { buf: img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }).toJPEG(88), mime: 'image/jpeg' };
}

// ───────────────────────── 生命周期 ─────────────────────────
async function quit() {
  quitting = true;
  pendingConfirms.cancel();
  await core?.stop();
  app.quit();
}

app.whenReady().then(() => {
  const paths = settings.paths();
  let lastHeartbeat = performance.now();
  const heartbeat = setInterval(() => diagnostics.syncOperation('timer:fullscreenPoll', () => {
    const now = performance.now();
    const lag = now - lastHeartbeat - 1000;
    if (lag > 1000) log('warn', `主进程事件循环阻塞 ${Math.round(lag)}ms`, { event: 'main_event_loop_lag', elapsedMs: Math.round(lag), runId: diagnostics.runId });
    lastHeartbeat = now;
    // 主动更新缓存，避免每次提醒 tick 都刚好读到上一次检测结果。
    if (settings.get().reminders.dndFullscreen) win32.isFullscreen();
  }), 1000);
  heartbeat.unref();
  if (safeStorage.isEncryptionAvailable()) {
    setCipher({
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
    });
  }

  core = new CoreClient({ log, onMessage: (m) => onCoreMessage(m).catch((e) => log('warn', `处理后台消息失败：${e.message}`)), onReady: syncCoreSettings });
  core.start();
  settings.onChange(() => syncCoreSettings());

  setupIpc();
  createPetWindow();
  createTray();
  registerShortcuts();

  // 每 2 秒把系统空闲时长、全屏状态推给后台调度器；离开电脑 5 分钟宠物睡觉，回来时醒来打招呼
  let asleep = false;
  setInterval(() => diagnostics.syncOperation('timer:envPush', () => {
    const idle = powerMonitor.getSystemIdleTime();
    core.post({ type: 'env', idleSec: idle, fullscreen: win32.isFullscreen() });
    if (!petVisible()) return;
    if (!asleep && idle > 300) {
      asleep = true;
      sendPet('pet:state', { state: 'sleep' });
    } else if (asleep && idle < 5) {
      asleep = false;
      sendPet('pet:state', { state: 'wake' });
    }
  }), 2000);

  powerMonitor.on('lock-screen', () => core.post({ type: 'lock', locked: true }));
  powerMonitor.on('unlock-screen', () => {
    core.post({ type: 'lock', locked: false });
    sendPet('pet:state', { state: 'happy', duration: 2000 });
  });
  powerMonitor.on('suspend', () => { lastHeartbeat = performance.now(); });
  powerMonitor.on('resume', () => {
    lastHeartbeat = performance.now();
    core.post({ type: 'resume' });
  });
  log('info', `启动完成 数据目录=${paths.dataDir} 知识库=${paths.knowledgeDir}`);
  if (process.argv.includes('--dev')) showPanel();
}).catch(error => {
  log.critical('error', '应用启动失败', { event: 'startup_failed', runId: diagnostics.runId, error });
  app.exit(1);
});

app.on('second-instance', () => showPanel());
app.on('window-all-closed', () => {}); // 常驻托盘，不因窗口关闭而退出
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => {
  quitting = true;
});
