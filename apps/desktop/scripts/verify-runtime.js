'use strict';
// Fault injection is restricted to isolated Electron fixtures, never the live app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const readLogs = dir => {
  const logs = fs.existsSync(path.join(dir, 'logs')) ? path.join(dir, 'logs') : dir;
  return fs.readdirSync(logs).filter(f => f.endsWith('.log')).map(f => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n');
};
async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) { if (fn()) return; await pause(40); }
  throw new Error('Timed out: ' + label);
}

if (!process.versions.electron) {
  (async () => {
    const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-runtime-check-'));
    const scenarios = process.argv[2] ? [process.argv[2]] : ['recovery', 'store-save', 'renderer', 'fatal', 'bootstrap', 'unexpected', 'clean'];
    for (const scenario of scenarios) {
      const dir = path.join(fixtures, scenario); fs.mkdirSync(dir);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [__filename, dir, scenario], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
      const timer = setTimeout(() => child.kill(), 45000);
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      clearTimeout(timer);
      assert.equal(code, ['fatal', 'bootstrap'].includes(scenario) ? 1 : scenario === 'unexpected' ? 42 : 0, output);
      const expected = ['fatal', 'bootstrap', 'unexpected'].includes(scenario) ? 'unexpected_exit' : 'normal_exit';
      await waitFor(() => readLogs(dir).includes(`"event":"${expected}"`), scenario + ' exit record');
      const records = readLogs(dir);
      if (scenario === 'recovery') {
        assert.match(records, /"event":"main_unresponsive"/);
        assert.match(records, /"event":"main_responsive"/);
        assert.match(records, /fixture:block/);
      } else if (scenario === 'store-save') {
        assert.match(records, /"event":"main_unresponsive"/);
        assert.match(records, /"event":"main_responsive"/);
        assert.match(records, /store:state:write/);
        assert.ok(!records.includes('private-fixture-state-value'));
      } else if (scenario === 'renderer') assert.match(records, /"event":"render_process_gone"/);
      else if (scenario === 'fatal') assert.match(records, /"event":"uncaught_exception"/);
      else if (scenario === 'bootstrap') assert.match(records, /"event":"startup_failed"/);
      else if (scenario === 'clean') {
        assert.ok(!records.includes('"event":"unexpected_exit"'));
        assert.match(records, /queued-normal-record-499/);
      }
      console.log('PASS independent diagnostics: ' + scenario);
    }
    console.log(JSON.stringify({ verified: true, fixtures }));
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
} else {
  const { app, BrowserWindow, crashReporter, powerMonitor } = require('electron');
  const [dir, scenario] = process.argv.slice(2);
  app.setPath('userData', path.join(dir, 'profile'));
  app.disableHardwareAcceleration();
  if (scenario === 'bootstrap') {
    const { Settings, deepMerge, DEFAULTS } = require('../src/core/settings');
    require('../src/core/settings').Settings = class extends Settings {
      load() { return deepMerge(DEFAULTS, { paths: { dataDir: dir, knowledgeDir: path.join(dir, 'kb'), docsDir: path.join(dir, 'notes') } }); }
    };
    // 业务核心在后台进程；主进程启动时创建后台客户端，这里让它失败来验证启动失败的记录
    require('../src/main/core-client').CoreClient = class { constructor() { throw new Error('Isolated fixture startup failure'); } };
    require('../src/main/main');
  } else {
  const log = require('../src/main/logger').createLogger(dir);
  const diagnostics = require('../src/main/runtime-diagnostics').installRuntimeDiagnostics({ app, crashReporter, powerMonitor, log, dir, timeoutMs: 200, pollMs: 40, heartbeatMs: 40 });
  (async () => {
    await app.whenReady();
    await waitFor(() => readLogs(dir).includes('watchdog_started'), 'watchdog startup');
    await pause(100);
    if (scenario === 'recovery') {
      diagnostics.syncOperation('fixture:block', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650));
      await waitFor(() => readLogs(dir).includes('main_responsive'), 'heartbeat recovery');
    } else if (scenario === 'store-save') {
      const { Store } = require('../src/core/store');
      const store = new Store(dir, { observeSync: (name, fn) => diagnostics.syncOperation(name, fn) });
      const write = fs.writeFileSync;
      fs.writeFileSync = function(file, ...args) {
        if (file === store.state.file + '.tmp') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 650);
        return write.call(this, file, ...args);
      };
      try {
        store.state.data.fixtureValue = 'private-fixture-state-value';
        store.state.save(); // Actual debounce callback, outside the caller's diagnostic scope.
        await waitFor(() => readLogs(dir).includes('main_responsive'), 'debounced save heartbeat recovery');
        assert.equal(JSON.parse(fs.readFileSync(store.state.file, 'utf8')).fixtureValue, 'private-fixture-state-value');
      } finally { fs.writeFileSync = write; }
    } else if (scenario === 'renderer') {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      diagnostics.watchWindow(win, '测试');
      await win.loadURL('data:text/html,<title>Isolated diagnostic fixture</title>');
      const gone = new Promise(resolve => win.webContents.once('render-process-gone', resolve));
      win.webContents.forcefullyCrashRenderer();
      await gone; await log.flush(); win.destroy();
    } else if (scenario === 'fatal') {
      setTimeout(() => { throw new Error('Isolated fixture fatal error'); }, 0);
      return;
    } else if (scenario === 'unexpected') { app.exit(42); return; }
    if (scenario === 'clean') for (let i = 0; i < 500; i++) log('info', 'queued-normal-record-' + i);
    else await log.flush();
    app.quit();
  })().catch(error => { log.critical('error', '验证失败', { error }); app.exit(2); });
  }
}
