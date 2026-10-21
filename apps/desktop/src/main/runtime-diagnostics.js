'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

function installRuntimeDiagnostics({ app, crashReporter, powerMonitor, log, dir, timeoutMs = 15000, pollMs = 1000, heartbeatMs = 1000, metricsMs = 60000 }) {
  const runId = randomUUID();
  const operations = new Map();
  const rendererRates = new Map();
  let stopped = false, paused = false, monitor;
  const record = (level, message, details = {}) => log(level, message, { runId, ...details });
  const critical = (level, message, details) => log.critical(level, message, { runId, ...details });
  const send = (message) => {
    if (monitor?.connected) monitor.send(message, (error) => {
      if (error && !stopped) record('warn', '运行监测通信失败', { event: 'watchdog_send_error', error });
    });
  };
  const context = () => ({
    uptimeSeconds: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), operations: [...operations.values()].slice(-12),
  });
  const beginOperation = (name) => {
    const key = Symbol(name), started = performance.now();
    operations.set(key, { name, at: new Date().toISOString() });
    send({ type: 'heartbeat', context: context() });
    return { key, name, started };
  };
  const finishOperation = ({ key, name, started }) => {
    operations.delete(key);
    // Pair enter/exit updates so an unrelated later hang cannot inherit a completed operation.
    send({ type: 'heartbeat', context: context() });
    const elapsedMs = Math.round(performance.now() - started);
    if (elapsedMs > 1500) record('warn', '操作耗时较长', { event: 'slow_operation', name, elapsedMs });
  };
  function snapshot() {
    if (!app.isReady() || stopped) return;
    const operation = beginOperation('runtime:sample');
    try {
      record('info', '运行状态', { event: 'runtime_sample', ...context(), processes: app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, cpu: p.cpu?.percentCPUUsage, workingSetKB: p.memory?.workingSetSize })) });
    } catch (error) { record('warn', '运行状态采样失败', { error }); }
    finally { finishOperation(operation); }
  }
  record('info', '运行诊断启动', { event: 'runtime_started', pid: process.pid, electron: process.versions.electron, node: process.versions.node });
  try {
    const dumpDir = path.join(dir, 'crashes');
    fs.mkdirSync(dumpDir, { recursive: true });
    app.setPath('crashDumps', dumpDir);
    crashReporter.start({ uploadToServer: false, submitURL: '', compress: false });
    record('info', '本地崩溃转储启用', { event: 'crash_dumps_enabled', directory: dumpDir });
  } catch (error) { record('warn', '本地崩溃转储不可用', { event: 'crash_dumps_unavailable', error }); }
  try {
    monitor = spawn(process.execPath, [path.join(__dirname, 'runtime-watchdog.js'), dir, String(process.pid), runId, String(timeoutMs), String(pollMs)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, detached: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    monitor.on('message', message => { if (message?.type === 'watchdog_ready') send({ type: 'heartbeat', context: context() }); });
    monitor.on('error', error => record('error', '独立运行监测启动失败', { event: 'watchdog_error', error }));
    monitor.on('exit', (code, signal) => { if (!stopped) record('error', '独立运行监测提前退出', { event: 'watchdog_exit', code, signal }); });
    monitor.stderr.on('data', data => record('warn', '独立运行监测错误输出', { event: 'watchdog_stderr', message: data.toString().slice(0, 4000) }));
  } catch (error) { record('error', '独立运行监测不可用', { event: 'watchdog_error', error }); }
  const heartbeat = setInterval(() => { if (!paused) send({ type: 'heartbeat', context: context() }); }, heartbeatMs);
  const metrics = setInterval(snapshot, metricsMs);
  heartbeat.unref(); metrics.unref();
  const onException = (error, origin) => critical('error', '主进程未捕获异常', { event: 'uncaught_exception', origin, error });
  const onFatal = () => app.exit(1);
  const onRejection = (error) => record('error', '主进程未处理 Promise 拒绝', { event: 'unhandled_rejection', error });
  process.on('uncaughtExceptionMonitor', onException);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onRejection);
  app.on('child-process-gone', (_event, details) => record(details.reason === 'clean-exit' ? 'info' : 'error', '辅助进程退出', { event: 'child_process_gone', ...details }));
  app.whenReady().then(() => {
    powerMonitor.on('suspend', () => { paused = true; send({ type: 'suspend' }); record('info', '系统休眠', { event: 'system_suspend' }); });
    powerMonitor.on('resume', () => { paused = false; send({ type: 'resume' }); record('info', '系统恢复', { event: 'system_resume' }); });
    snapshot();
  });
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat); clearInterval(metrics);
    send({ type: 'shutdown' });
    critical('info', '应用正常退出标记', { event: 'normal_shutdown', ...context() });
  }
  app.on('will-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    (async () => {
      let timer;
      await Promise.race([log.flush(), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
      clearTimeout(timer);
      stop();
      // before-quit and window closing already ran; finish without re-entering
      // Electron's cancelled will-quit cycle or retaining diagnostic IPC handles.
      app.exit(0);
    })().catch(error => { critical('error', '退出日志刷新失败', { event: 'shutdown_log_error', error }); stop(); app.exit(1); });
  });
  return {
    runId, stop, snapshot,
    syncOperation(name, fn) {
      const operation = beginOperation(name);
      try { return fn(); }
      catch (error) { record('error', '操作失败', { event: 'operation_error', name, error }); throw error; }
      finally { finishOperation(operation); }
    },
    async operation(name, fn) {
      const operation = beginOperation(name);
      try { return await fn(); }
      catch (error) { record('error', '操作失败', { event: 'operation_error', name, error }); throw error; }
      finally { finishOperation(operation); }
    },
    rendererError(sender, payload) {
      const minute = Math.floor(Date.now() / 60000);
      const rate = rendererRates.get(sender.id);
      const next = rate?.minute === minute ? rate : { minute, count: 0 };
      rendererRates.set(sender.id, next);
      if (++next.count > 20) {
        if (next.count === 21) record('warn', '渲染错误过于频繁，暂时合并重复记录', { event: 'renderer_errors_throttled', webContentsId: sender.id });
        return;
      }
      const text = (value, length) => typeof value === 'string' ? value.slice(0, length) : '';
      record('error', '渲染页面异常', { event: 'renderer_error', webContentsId: sender.id,
        kind: text(payload?.kind, 80), message: text(payload?.message, 2000),
        stack: text(payload?.stack, 6000), source: text(payload?.source, 500), line: typeof payload?.line === 'number' && Number.isFinite(payload.line) ? payload.line : 0 });
    },
    watchWindow(win, name) {
      const webContentsId = win.webContents.id;
      const details = () => ({ window: name, webContentsId, ...context() });
      win.on('unresponsive', () => record('error', `${name}窗口未响应`, { event: 'window_unresponsive', ...details() }));
      win.on('responsive', () => record('info', `${name}窗口恢复响应`, { event: 'window_responsive', ...details() }));
      win.webContents.on('render-process-gone', (_event, reason) => record(reason.reason === 'clean-exit' ? 'info' : 'error', `${name}渲染进程退出`, { event: 'render_process_gone', ...details(), ...reason }));
      win.webContents.on('did-fail-load', (_event, code, description) => record('error', `${name}页面加载失败`, { event: 'page_load_failed', code, description, ...details() }));
      win.webContents.on('preload-error', (_event, file, error) => record('error', `${name}预加载失败`, { event: 'preload_error', file, error, ...details() }));
      win.on('closed', () => rendererRates.delete(webContentsId));
    },
  };
}

module.exports = { installRuntimeDiagnostics };
