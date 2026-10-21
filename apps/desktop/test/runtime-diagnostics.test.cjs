'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
function fixture() {
  const app = new EventEmitter(), child = new EventEmitter(), logs = [], messages = [];
  child.stderr = new EventEmitter(); child.connected = true; child.send = message => messages.push(message);
  app.isReady = () => false; app.whenReady = () => Promise.resolve(); app.setPath = () => {}; app.exit = () => {};
  app.quit = () => app.emit('will-quit', { preventDefault() {} });
  const powerMonitor = new EventEmitter(), log = (level, message, details) => logs.push({ level, message, details });
  log.critical = log; log.flush = () => Promise.resolve();
  const context = { module: { exports: {} }, __dirname: '/fixture', console, performance, Symbol,
    setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout, clearTimeout,
    process: { pid: 1, versions: {}, env: {}, execPath: 'node', uptime: () => 1, memoryUsage: () => ({ rss: 100, heapUsed: 10 }), on() {} },
    require: name => name === 'node:child_process' ? { spawn: () => child } : name === 'node:fs' ? { mkdirSync() {} } : require(name),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/runtime-diagnostics.js'), 'utf8'), context);
  return { diagnostics: context.module.exports.installRuntimeDiagnostics({ app, powerMonitor, crashReporter: { start() {} }, log, dir: '/fixture' }), logs, messages };
}
test('synchronous native operations publish context before running and retain their return type', () => {
  const { diagnostics, messages } = fixture();
  const result = diagnostics.syncOperation('timer:native', () => {
    assert.equal(messages.at(-1).context.operations.at(-1).name, 'timer:native');
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(messages.at(-1).context.operations.length, 0, 'watchdog must see the operation finish before any unrelated hang');
  diagnostics.syncOperation('next', () => assert.equal(messages.at(-1).context.operations.length, 1));
});
test('failed synchronous native operations preserve the error and release diagnostic context', () => {
  const { diagnostics, messages, logs } = fixture();
  const error = new Error('native boundary failed');
  assert.throws(() => diagnostics.syncOperation('timer:native', () => { throw error; }), thrown => thrown === error);
  assert.equal(messages.at(-1).context.operations.length, 0);
  assert.ok(logs.some(row => row.details.event === 'operation_error' && row.details.name === 'timer:native'));
  diagnostics.syncOperation('next', () => assert.equal(messages.at(-1).context.operations.length, 1));
});
test('malformed renderer reports cannot throw on the main IPC handler', () => {
  const { diagnostics, logs } = fixture();
  const invalid = { toString: 0, valueOf: 0 };
  assert.doesNotThrow(() => diagnostics.rendererError({ id: 1 }, { message: invalid, stack: invalid, source: invalid, line: invalid }));
  assert.ok(logs.some(r => r.details.event === 'renderer_error'));
});
test('renderer error reports are bounded and throttled without growing each error', () => {
  const { diagnostics, logs } = fixture();
  for (let i = 0; i < 25; i++) diagnostics.rendererError({ id: 1 }, { kind: 'error', message: 'x'.repeat(10000), line: Infinity });
  const reports = logs.filter(r => r.details.event === 'renderer_error');
  assert.equal(reports.length, 20);
  assert.ok(reports.every(r => r.details.message.length <= 2000 && r.details.line === 0));
  assert.equal(logs.filter(r => r.details.event === 'renderer_errors_throttled').length, 1);
});
test('resource loading failures are captured even though error events do not bubble', () => {
  const listeners = [], reports = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/runtime-errors.js'), 'utf8'), {
    window: { pa: { reportError: r => reports.push(r) }, addEventListener: (...args) => listeners.push(args) },
  });
  const [name, handler, capture] = listeners.find(r => r[0] === 'error');
  assert.equal(capture, true);
  handler({ target: { src: 'missing-script.js' } });
  assert.equal(reports[0].source, 'missing-script.js');
});
