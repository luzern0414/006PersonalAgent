'use strict';
// Run the real Electron main process with isolated settings/data and fixed
// weather. No model requests, real task edits, or visible test windows.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

if (!process.versions.electron) {
  const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-panel-check-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, taskDir], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const watchdog = setTimeout(() => child.kill(), 45_000);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', (e) => { clearTimeout(watchdog); console.error(e); process.exitCode = 1; });
  child.on('exit', (code) => { clearTimeout(watchdog); process.exitCode = code === 0 ? 0 : 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const taskDir = process.argv[2];
  app.setPath('userData', path.join(taskDir, 'userData'));
  const { Settings, deepMerge, DEFAULTS } = require('../src/core/settings');
  class TestSettings extends Settings {
    load() {
      return deepMerge(DEFAULTS, {
        paths: { dataDir: taskDir, knowledgeDir: path.join(taskDir, 'kb'), docsDir: path.join(taskDir, 'notes') },
        pet: { visible: false }, performance: { panelReleaseMin: -1 }, langsmith: { enabled: false },
        llm: { model: 'gpt-6-luna', fastModel: 'gpt-6-luna' },
      });
    }
    write(data) { fs.writeFileSync(path.join(taskDir, 'settings.json'), JSON.stringify(data)); }
  }
  require('../src/core/settings').Settings = TestSettings;
  // 业务核心运行在后台进程（utilityProcess）：测试替身写成 fixture 模块，由后台进程在初始化前加载
  const src = JSON.stringify(path.resolve(__dirname, '../src/core'));
  const fixture = path.join(taskDir, 'core-fixture.js');
  fs.writeFileSync(fixture, `
    const path = require('node:path');
    const core = (m) => require(path.join(${src}, m));
    core('scheduler').Scheduler.prototype.start = function () {};
    core('llm').LLM.prototype.listModels = async () => ['gpt-6-luna'];
    core('agent').Agent.prototype.run = async function ({ conversationId = 'main' }, hooks) {
      this.active.set(conversationId, new AbortController());
      try {
        const approved = await hooks.confirm({ tool: 'fixture_confirmation', args: {}, preview: '仅用于测试的确认' });
        return approved ? { text: 'approved' } : { error: 'AbortError' };
      } finally { this.active.delete(conversationId); }
    };
    const { dateKey, addDays } = core('time');
    core('services').Core.prototype.weather = async () => {
      const now = new Date();
      return {
        city: '深圳', now: { temp: 28, feels: 30, humidity: 70, wind: 8, text: '晴', kind: 'clear', isDay: true, rainy: false },
        days: [0, 1, 2, 3].map((n) => ({ date: dateKey(addDays(now, n)), min: 23, max: 29, kind: 'clear', text: '晴', rain: 0, uv: 3, sunrise: '06:15', sunset: '18:00' })),
        hourly: Array.from({ length: 48 }, (_, n) => ({ time: new Date(now.getTime() + n * 36e5).toISOString().slice(0, 13) + ':00', temp: 28, kind: 'clear', isDay: true, rain: 0 })),
      };
    };
  `);
  process.env.PA_CORE_FIXTURE = fixture;
  const { dateKey, addDays } = require('../src/core/time');
  const db = path.join(taskDir, 'db'); fs.mkdirSync(db, { recursive: true });
  const today = dateKey();
  const record = (id, title, planDate, status = 'open') => ({ id, title, planDate, status, due: '', notes: '', priority: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(db, 'tasks.json'), JSON.stringify({ items: [
    record('today', '本周待办测试', today), record('future', '跨日期待办测试', dateKey(addDays(new Date(), 50))), record('done', '已完成待办测试', dateKey(addDays(new Date(), -20)), 'done'),
  ] }));
  fs.writeFileSync(path.join(db, 'events.json'), JSON.stringify({ items: [{ id: 'event', title: '本周日程测试', start: today + 'T11:00:00+08:00', end: today + 'T12:00:00+08:00', createdAt: new Date().toISOString() }] }));
  fs.writeFileSync(path.join(db, 'reminders.json'), JSON.stringify({ items: [{ id: 'reminder', text: '本周提醒测试', repeat: 'none', enabled: true, at: today + 'T16:00:00+08:00', nextAt: today + 'T16:00:00+08:00' }] }));
  const nativeShowInactive = BrowserWindow.prototype.showInactive;
  BrowserWindow.prototype.show = function () {};
  BrowserWindow.prototype.showInactive = function () {};
  BrowserWindow.prototype.focus = function () {};
  // The test process must not compete with the running app's hotkeys.
  require('electron').globalShortcut.register = () => true;
  require('electron').globalShortcut.unregisterAll = () => {};
  process.argv.push('--dev');
  require('../src/main/main');

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(fn, label) {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await pause(25); }
    throw new Error('Timed out: ' + label);
  }
  const shots = path.resolve(__dirname, '../../../data/verification/2026-10-12');
  const errors = [];
  const timed = async (label, action) => {
    const started = performance.now();
    const result = await action();
    const ms = Math.round(performance.now() - started);
    if (ms > 1000) console.log(JSON.stringify({ slowStep: label, ms }));
    return result;
  };
  async function screenshot(win, name) {
    // A shown, fully transparent window lets the compositor submit fresh frames
    // without exposing fixture data or stealing focus from the live app.
    await timed(name + ' show', () => { win.setOpacity(0); nativeShowInactive.call(win); });
    await timed(name + ' repaint', () => win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'));
    await pause(100);
    const file = path.join(shots, `${name}-${Date.now()}.png`);
    const capture = await timed(name + ' capture', () => win.webContents.capturePage());
    const png = await timed(name + ' encode', () => capture.toPNG());
    await timed(name + ' write', () => fs.promises.writeFile(file, png));
    console.log(JSON.stringify({ screenshot: file }));
  }
  async function verify() {
    await app.whenReady();
    let win;
    await waitFor(() => { win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/panel.html')); return !!win; }, 'panel creation');
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    const evaluate = async (code) => {
      try { return await timed('renderer: ' + code.slice(0, 120), () => win.webContents.executeJavaScript(code)); }
      catch (e) { throw new Error('Renderer command failed: ' + code + '\n' + errors.join('\n'), { cause: e }); }
    };
    const tab = async (id) => { await evaluate(`document.querySelector('[data-id=${id}]').click()`); };
    const button = async (label) => { await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`); };
    await waitFor(() => evaluate('!!document.querySelector(".wx-temp")'), 'weather rendering');
    fs.mkdirSync(shots, { recursive: true });
    await screenshot(win, 'today');
    console.log(JSON.stringify({ weatherHeight: await evaluate('Math.round(document.querySelector(".wx-hero").getBoundingClientRect().height)') }));

    await tab('chat');
    await waitFor(() => evaluate('!!document.querySelector(".composer textarea")'), 'chat composer');
    assert.equal(await evaluate('document.querySelector(".composer textarea").placeholder'), '');
    await evaluate(`(() => { const input=document.querySelector('.composer textarea'); input.value=${JSON.stringify('切页后保留的草稿\n第二行')}; input.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await tab('settings');
    await waitFor(() => evaluate('!!document.querySelector(".set-row")'), 'settings');
    await tab('chat');
    await waitFor(() => evaluate('!!document.querySelector(".composer textarea")'), 'restored composer');
    assert.equal(await evaluate('document.querySelector(".composer textarea").value'), '切页后保留的草稿\n第二行');
    console.log('PASS chat draft survives tab navigation');

    await tab('plan');
    await waitFor(() => evaluate('document.querySelectorAll(".cal-cell").length===7'), 'week calendar');
    assert.equal(await evaluate('document.querySelectorAll(".cal-cell").length'), 7);
    assert.ok(await evaluate('document.querySelector("#view").textContent.includes("本周待办测试") && document.querySelector("#view").textContent.includes("本周日程测试") && document.querySelector("#view").textContent.includes("本周提醒测试")'));
    await screenshot(win, 'week');
    await button('展开月历');
    await waitFor(() => evaluate('document.querySelectorAll(".cal-cell").length===42'), 'expanded month');
    await button('收起月历');
    await waitFor(() => evaluate('document.querySelectorAll(".cal-cell").length===7'), 'collapsed week');
    await button('全部待办');
    await waitFor(() => evaluate('document.querySelector("#view").textContent.includes("跨日期待办测试") && document.querySelector("#view").textContent.includes("已完成待办测试")'), 'all tasks across dates');
    assert.equal(await evaluate('document.querySelector(".tab.active").dataset.id'), 'plan');
    assert.ok(await evaluate('!!document.querySelector(".plan-all-tasks")'));
    await screenshot(win, 'all-tasks');

    const row = (title) => `Array.from(document.querySelectorAll('.ag-item')).find(el => el.querySelector('.ag-title').textContent === ${JSON.stringify(title)})`;
    await evaluate(`${row('跨日期待办测试')}.querySelector('.check').click()`);
    await waitFor(() => evaluate(`${row('跨日期待办测试')}?.classList.contains('done')`), 'task completed');
    await evaluate(`Array.from(document.querySelectorAll('.plan-task-filters button')).find(b => b.textContent.startsWith('未完成')).click()`);
    await waitFor(() => evaluate('!!document.querySelector(".plan-all-tasks") && !document.querySelector("#view").textContent.includes("跨日期待办测试")'), 'open tasks filter');
    assert.ok(await evaluate('document.querySelector("#view").textContent.includes("本周待办测试")'));
    await evaluate(`Array.from(document.querySelectorAll('.plan-task-filters button')).find(b => b.textContent.startsWith('已完成')).click()`);
    await waitFor(() => evaluate('document.querySelector("#view").textContent.includes("跨日期待办测试") && !document.querySelector("#view").textContent.includes("本周待办测试")'), 'done tasks filter');

    // 新增 / 修改只通过对话：点击条目不再弹出编辑框，页面上也没有手动输入框
    await evaluate(`${row('跨日期待办测试')}.querySelector('.grow').click()`);
    await pause(150);
    assert.equal(await evaluate('!!document.querySelector(".modal")'), false);
    assert.equal(await evaluate('document.querySelectorAll("#view input:not([type=checkbox]), #view textarea").length'), 0);
    await evaluate(`${row('跨日期待办测试')}.querySelector('.ag-del').click()`);
    await waitFor(() => evaluate('!document.querySelector("#view").textContent.includes("跨日期待办测试")'), 'task deletion');
    console.log('PASS all-task completion, open/done filters, no manual editor, deletion');
    console.log('PASS week/month calendar, merged agenda and all tasks');

    await evaluate(`window.pa.reportError({kind:'fixture',message:'isolated renderer report'}); true`);
    await waitFor(() => fs.readdirSync(path.join(taskDir, 'logs')).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).some(f => fs.readFileSync(path.join(taskDir, 'logs', f), 'utf8').includes('renderer_error')), 'renderer diagnostic IPC');
    await evaluate(`window.pa.chat({conversationId:'main',text:'isolated confirmation fixture'}).catch(() => {}); true`);
    await waitFor(() => evaluate('window.pa.api("chatActive")').then((n) => n === 1), 'pending confirmation');

    // Use a fresh renderer to verify persistence beyond module memory.
    const old = win;
    win = new BrowserWindow({ show: false, width: 420, height: 680, webPreferences: { preload: path.resolve(__dirname, '../src/preload/preload.js'), sandbox: true, contextIsolation: true } });
    await win.loadFile(path.resolve(__dirname, '../src/renderer/panel/panel.html'));
    old.destroy();
    await waitFor(() => evaluate('window.pa.api("chatActive")').then((n) => n === 0), 'renderer loss cancels pending confirmation');
    console.log('PASS renderer report and renderer-loss confirmation cleanup');
    await tab('chat');
    await waitFor(() => evaluate('!!document.querySelector(".composer textarea")'), 'new renderer composer');
    assert.equal(await evaluate('document.querySelector(".composer textarea").value'), '切页后保留的草稿\n第二行');
    console.log('PASS chat draft survives renderer recreation');

    const win32 = require('../src/main/win32');
    const { performance } = require('node:perf_hooks');
    let maxLag = 0, last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 10); last = now; }, 10);
    for (let i = 0; i < 100; i++) { win32.isFullscreen(); assert.equal(await win32.sendToBottom(win), true); }
    await pause(50); clearInterval(ticker);
    assert.ok(maxLag < 500, 'native window stress blocked main thread: ' + maxLag);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ verified: true, nativeCalls: 100, maxEventLoopLagMs: Math.round(maxLag), screenshots: shots }));
    await evaluate('window.pa.api("quit")');
  }
  verify().catch((e) => { console.error(e.stack); app.exit(1); });
}
