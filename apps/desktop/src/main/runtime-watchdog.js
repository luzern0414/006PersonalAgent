'use strict';
// Independent process: it can record a silent main thread while that thread is stuck.
function createTracker({ timeoutMs = 15000, startupTimeoutMs = 45000, now = Date.now(), record }) {
  let lastBeat = now, lastPoll = now, started = false, paused = false, hung = false, clean = false, ended = false;
  let context = {};
  return {
    receive(message, at = Date.now()) {
      if (ended || !message) return;
      if (message.type === 'shutdown') { clean = true; return; }
      if (message.type === 'suspend') { paused = true; return; }
      if (message.type === 'resume') { paused = false; lastBeat = lastPoll = at; hung = false; return; }
      if (message.type !== 'heartbeat') return;
      if (hung) record('info', '主进程恢复心跳', { event: 'main_responsive', silentMs: at - lastBeat, context });
      started = true; hung = false; lastBeat = at;
      context = message.context || {};
    },
    tick(at = Date.now()) {
      if (ended || clean) return;
      // If the monitor itself was paused, do not attribute an OS sleep/pause to the app.
      if (at - lastPoll > timeoutMs) { lastBeat = at; hung = false; }
      lastPoll = at;
      if (paused || hung || at - lastBeat < (started ? timeoutMs : startupTimeoutMs)) return;
      hung = true;
      record('error', '主进程长时间没有心跳，可能卡死', { event: 'main_unresponsive', phase: started ? 'running' : 'startup', silentMs: at - lastBeat, context });
    },
    disconnect(at = Date.now()) {
      if (ended) return;
      ended = true;
      record(clean ? 'info' : 'error', clean ? '应用正常退出' : '主进程未发送正常退出标记即断开', {
        event: clean ? 'normal_exit' : 'unexpected_exit', silentMs: at - lastBeat, context,
      });
    },
  };
}

module.exports = { createTracker };

if (require.main === module) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { createLogger } = require('./logger');
  const [dir, parentPid, runId, timeout, poll] = process.argv.slice(2);
  const log = createLogger(dir, { prefix: 'watchdog-' });
  const stateFile = path.join(dir, 'last-runtime-session.json');
  try {
    const previous = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (['running', 'main_unresponsive'].includes(previous.state)) log.critical('warn', '上次运行没有结束记录，可能异常终止或断电', { event: 'previous_unfinished_session', previous });
  } catch { /* First run, or no readable session marker. */ }
  const save = (state) => {
    try {
      fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ runId, parentPid: Number(parentPid), state, at: new Date().toISOString() }));
      fs.renameSync(stateFile + '.tmp', stateFile);
    } catch (error) { log('warn', '运行状态标记写入失败', { error }); }
  };
  save('running');
  const tracker = createTracker({
    timeoutMs: Number(timeout) || 15000,
    record(level, message, details) {
      log.critical(level, message, { runId, parentPid: Number(parentPid), ...details });
      save(details.event === 'main_responsive' ? 'running' : details.event);
    },
  });
  log('info', '独立运行监测启动', { event: 'watchdog_started', runId, parentPid: Number(parentPid) });
  const timer = setInterval(() => {
    // IPC can disappear during bootstrap before Node dispatches disconnect.
    try { process.kill(Number(parentPid), 0); }
    catch (error) { if (error.code === 'ESRCH') { disconnected(); return; } }
    tracker.tick();
  }, Number(poll) || 1000);
  process.on('message', (message) => {
    tracker.receive(message);
    if (message?.type === 'shutdown') {
      clearInterval(timer);
      tracker.disconnect();
      log.flush().finally(() => process.exit(0));
    }
  });
  const disconnected = () => {
    clearInterval(timer); tracker.disconnect();
    log.flush().finally(() => process.exit(0));
  };
  process.on('disconnect', disconnected);
  if (process.connected) process.send?.({ type: 'watchdog_ready' }, () => {});
  else disconnected(); // A bootstrap failure may close IPC before this script loads.
}
