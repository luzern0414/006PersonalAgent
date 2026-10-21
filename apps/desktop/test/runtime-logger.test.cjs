const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const loggerPath = path.join(__dirname, '../src/main/logger.js');
const source = fs.readFileSync(loggerPath, 'utf8');
const actualRequire = createRequire(loggerPath);
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('logger did not reach the expected IO state');
}

function fixture(t, fsOverride = fs, writeStderr) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-runtime-logger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = new Date(2026, 9, 12, 10, 11, 12, 345).getTime();
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const stderr = [];
  const context = vm.createContext({
    require: (name) => name === 'node:fs' ? fsOverride : actualRequire(name),
    module: { exports: {} }, Date: ClockDate, Buffer, DOMException,
    process: { pid: process.pid, stderr: { write: (text) => { stderr.push(text); return writeStderr?.(text); } } },
  });
  vm.runInContext(source, context, { filename: loggerPath });
  return {
    dir, stderr,
    create: (options) => context.module.exports.createLogger(dir, options),
    read: (name = '2026-10-12.log') => fs.readFileSync(path.join(dir, name), 'utf8'),
    setDay(day) { now = new Date(2026, 9, day, 10, 11, 12, 345).getTime(); },
  };
}

async function flush(log, dir, filename = '2026-10-12.log') {
  if (typeof log.flush === 'function') await log.flush();
  else await until(() => fs.existsSync(path.join(dir, filename)) && fs.statSync(path.join(dir, filename)).size > 0);
}

test('runtime lines include seconds, milliseconds, PID and structured details', async (t) => {
  const f = fixture(t);
  const log = f.create();
  log('info', 'runtime ready', { window: 'panel', lagMs: 1200 });
  await flush(log, f.dir);
  const line = f.read();
  assert.match(line, /^2026-10-12 10:11:12\.345 \[pid=\d+\] \[info\] runtime ready details=/);
  assert.match(line, new RegExp(`\\[pid=${process.pid}\\]`));
  assert.deepEqual(JSON.parse(line.split(' details=')[1]), { window: 'panel', lagMs: 1200 });
});

test('keys and authorization are redacted in messages, nested fields and error stacks', async (t) => {
  const f = fixture(t);
  const log = f.create();
  const apiKey = 'opaque-api-key-987654321';
  const bearer = 'header-access-token-987654';
  const error = new Error('request used sk-proj-super-secret-key');
  error.stack = 'Error: request used sk-proj-super-secret-key\n    at run (worker.js:12:3)';
  error.cause = new Error('authorization=Bearer other-secret-token');
  log('error', `API_KEY=${apiKey}; Authorization: Bearer ${bearer}`, {
    headers: { Authorization: `Bearer ${bearer}` },
    nested: [{ apiKey, token: 'nested-token-secret', password: 'password with spaces', secret: 'nested-secret-value' }],
    note: `echo ${apiKey}`, error,
  });
  await flush(log, f.dir);
  const output = f.read() + f.stderr.join('');
  for (const secret of [apiKey, bearer, 'super-secret-key', 'other-secret-token', 'nested-token-secret', 'password with spaces', 'nested-secret-value']) {
    assert.ok(!output.includes(secret), `leaked ${secret}`);
  }
  assert.match(output, /REDACTED/);
  assert.match(output, /worker\.js:12:3/);
  const details = JSON.parse(f.read().split(' details=')[1]);
  assert.equal(details.error.name, 'Error');
  assert.match(details.error.stack, /worker\.js:12:3/);
  assert.equal(details.nested[0].apiKey, '[REDACTED]');
});

test('normal append is serialized and flush waits until every queued record is written', async (t) => {
  const releases = [];
  let active = 0;
  let maxActive = 0;
  const begin = (file, data, done) => {
    active++;
    maxActive = Math.max(maxActive, active);
    releases.push(async () => {
      await fs.promises.appendFile(file, data);
      active--;
      done();
    });
  };
  const io = Object.create(fs);
  io.appendFile = (file, data, callback) => begin(file, data, () => callback(null));
  Object.defineProperty(io, 'promises', { value: {
    ...fs.promises,
    appendFile: (file, data) => new Promise((resolve) => begin(file, data, resolve)),
  } });
  const f = fixture(t, io);
  const log = f.create();
  log('info', 'first');
  log('info', 'second');
  await until(() => releases.length > 0);
  assert.equal(maxActive, 1);
  assert.equal(typeof log.flush, 'function');
  let flushed = false;
  const completion = log.flush().then(() => { flushed = true; });
  await tick();
  assert.equal(flushed, false);
  await releases.shift()();
  await until(() => releases.length > 0);
  assert.equal(flushed, false);
  await releases.shift()();
  await completion;
  assert.equal(maxActive, 1);
  assert.deepEqual(f.read().trim().split('\n').map((line) => line.split('] ').at(-1)), ['first', 'second']);
});

test('critical writes are immediately readable and synced before returning', async (t) => {
  let synced = 0;
  const io = Object.create(fs);
  io.fsyncSync = (fd) => { synced++; fs.fsyncSync(fd); };
  const f = fixture(t, io);
  const log = f.create({ prefix: 'watchdog-' });
  assert.equal(typeof log.critical, 'function');
  log.critical('error', 'fatal exception', new Error('fatal token=do-not-print-this'));
  const line = f.read('watchdog-2026-10-12.log');
  assert.match(line, /fatal exception/);
  assert.match(line, /"stack"/);
  assert.ok(!line.includes('do-not-print-this'));
  assert.equal(synced, 1);
  await log.flush();
});

test('successful warn, error and critical records bypass hostile stderr sinks', async (t) => {
  let invoked = 0;
  const f = fixture(t, fs, () => { invoked++; throw new Error('stderr sink must not run'); });
  const log = f.create();
  log('warn', 'ordinary warning');
  log('error', 'ordinary error');
  log.critical('error', 'durable fatal record');
  assert.equal(invoked, 0);
  assert.match(f.read(), /durable fatal record/);
  await log.flush();
  assert.equal(invoked, 0);
  const lines = f.read().trim().split('\n');
  assert.equal(lines.length, 3);
  for (const message of ['ordinary warning', 'ordinary error', 'durable fatal record']) {
    assert.ok(lines.some((line) => line.endsWith(message)), message);
  }
});

test('retention removes only valid own-prefix daily files older than 14 calendar days', async (t) => {
  const f = fixture(t);
  const files = ['2025-01-01.log', 'watchdog-2026-09-28.log', 'watchdog-2026-09-29.log', 'watchdog-2026-10-13.log', 'watchdog-2026-02-30.log', 'watchdog-events.log', 'vendor.log'];
  for (const file of files) fs.writeFileSync(path.join(f.dir, file), 'existing\n');
  const log = f.create({ prefix: 'watchdog-' });
  log('info', 'retention pass');
  await flush(log, f.dir, 'watchdog-2026-10-12.log');
  assert.ok(!fs.existsSync(path.join(f.dir, 'watchdog-2026-09-28.log')));
  for (const file of files.filter((name) => name !== 'watchdog-2026-09-28.log')) assert.ok(fs.existsSync(path.join(f.dir, file)), file);
  f.setDay(13);
  log('info', 'next day');
  await log.flush();
  assert.ok(!fs.existsSync(path.join(f.dir, 'watchdog-2026-09-29.log')));
  assert.ok(fs.existsSync(path.join(f.dir, '2025-01-01.log')));
});

test('default logger retention preserves prefixed files and unrelated logs', async (t) => {
  const f = fixture(t);
  for (const file of ['2026-09-28.log', '2026-09-29.log', 'watchdog-2025-01-01.log', 'notes.log']) fs.writeFileSync(path.join(f.dir, file), 'existing\n');
  const log = f.create();
  log('info', 'default retention');
  await flush(log, f.dir);
  assert.ok(!fs.existsSync(path.join(f.dir, '2026-09-28.log')));
  for (const file of ['2026-09-29.log', 'watchdog-2025-01-01.log', 'notes.log']) assert.ok(fs.existsSync(path.join(f.dir, file)), file);
});

test('circular and huge payloads remain bounded, single-line and valid JSON without invoking getters', async (t) => {
  const f = fixture(t);
  const log = f.create();
  const details = { text: 'x'.repeat(2e6), apiKey: 'opaque-secret-bounded' };
  details.self = details;
  Object.defineProperty(details, 'unsafe', { enumerable: true, get() { throw new Error('getter must not run'); } });
  assert.doesNotThrow(() => log('info', 'message\nspoofed line', details));
  await flush(log, f.dir);
  const line = f.read();
  assert.equal(line.trim().split('\n').length, 1);
  assert.ok(Buffer.byteLength(line) <= 20000);
  assert.doesNotThrow(() => JSON.parse(line.split(' details=')[1]));
  assert.ok(!line.includes('opaque-secret-bounded'));
});

test('IO failures never reject flush or throw critical and emit bounded sanitized stderr', async (t) => {
  const failure = new Error('cannot append API_KEY=private-failure-key');
  const io = Object.create(fs);
  io.mkdirSync = () => { throw failure; };
  Object.defineProperty(io, 'promises', { value: { ...fs.promises, mkdir: async () => { throw failure; } } });
  const f = fixture(t, io);
  let log;
  assert.doesNotThrow(() => { log = f.create(); });
  assert.doesNotThrow(() => log('info', 'record', { authorization: 'sensitive' }));
  await assert.doesNotReject(() => log.flush());
  assert.doesNotThrow(() => log.critical('error', 'fatal'));
  assert.ok(f.stderr.length > 0);
  assert.ok(!f.stderr.join('').includes('private-failure-key'));
  assert.ok(f.stderr.every((line) => Buffer.byteLength(line) <= 20000));
});

test('combined message and details bounds preserve a complete JSON details payload', async (t) => {
  const f = fixture(t);
  const log = f.create();
  const message = {}, details = { apiKey: 'abcdef' };
  for (let i = 0; i < 32; i++) {
    message['message-' + 'm'.repeat(100) + i] = 'abcdef'.repeat(50);
    details['details-' + 'd'.repeat(100) + i] = 'tail';
  }
  log('info', message, details);
  await log.flush();
  const line = f.read();
  assert.ok(Buffer.byteLength(line) <= 16384);
  assert.doesNotThrow(() => JSON.parse(line.split(' details=')[1]));
});

test('LangSmith lsv2 keys are redacted in free text and Error stacks', async (t) => {
  const f = fixture(t);
  const log = f.create();
  const key = 'lsv2_pt_0123456789abcdef-super-secret';
  const error = new Error(`trace credential ${key}`);
  error.stack = `Error: trace credential ${key}\n    at trace (tracing.js:22:4)`;
  log('warn', `trace failed using ${key}`, error);
  await log.flush();
  const output = f.read() + f.stderr.join('');
  assert.ok(!output.includes(key));
  assert.match(output, /REDACTED/);
  assert.match(output, /tracing\.js:22:4/);
});

test('DOMException timeout metadata and stack survive runtime operation logging with secrets redacted', async (t) => {
  const f = fixture(t);
  const log = f.create();
  const key = 'lsv2_pt_timeout-private-trace-key';
  const error = new DOMException(`fetch timed out using ${key}; token=private-dom-token`, 'TimeoutError');
  error.stack = `TimeoutError: fetch used ${key}\n    at fetch (request.js:8:2)`;
  log('warn', 'operation failed', { event: 'operation_error', error });
  await log.flush();
  const line = f.read();
  const details = JSON.parse(line.split(' details=')[1]);
  assert.equal(details.error.name, 'TimeoutError');
  assert.match(details.error.message, /fetch timed out/);
  assert.match(details.error.stack, /request\.js:8:2/);
  assert.ok(!(line + f.stderr.join('')).includes(key));
  assert.ok(!(line + f.stderr.join('')).includes('private-dom-token'));
});

test('real AbortSignal.timeout reason is logged as TimeoutError with message and stack', async (t) => {
  const f = fixture(t);
  const log = f.create();
  const signal = AbortSignal.timeout(1);
  await tick();
  assert.ok(signal.reason instanceof DOMException);
  log('warn', 'timed operation', { error: signal.reason });
  await log.flush();
  const { error } = JSON.parse(f.read().split(' details=')[1]);
  assert.equal(error.name, 'TimeoutError');
  assert.equal(error.message, signal.reason.message);
  assert.match(error.stack, /TimeoutError/);
});

test('plain objects spoofing DOMException never invoke name, message or stack getters', async (t) => {
  const f = fixture(t);
  const log = f.create();
  let invoked = 0;
  const hostile = {};
  Object.defineProperty(hostile, Symbol.toStringTag, {
    get() { invoked++; throw new Error('arbitrary brand getter'); },
  });
  for (const key of ['name', 'message', 'stack']) Object.defineProperty(hostile, key, {
    enumerable: true, get() { invoked++; throw new Error('arbitrary getter'); },
  });
  log('info', 'hostile input', { error: hostile });
  await log.flush();
  assert.equal(invoked, 0);
  const { error } = JSON.parse(f.read().split(' details=')[1]);
  assert.equal(error.name, '[Getter]');
  assert.equal(error.message, '[Getter]');
  assert.equal(error.stack, '[Getter]');
});

test('native errors with overridden name or message getters do not invoke them while reading stacks', async (t) => {
  const f = fixture(t);
  const log = f.create();
  let invoked = 0;
  const error = new Error('sample');
  Object.defineProperty(error, 'name', {
    get() { invoked++; throw new Error('arbitrary error name getter'); },
  });
  const timeout = new DOMException('fetch timed out', 'TimeoutError');
  Object.defineProperty(timeout, 'message', {
    get() { invoked++; throw new Error('arbitrary timeout message getter'); },
  });
  log('info', 'hostile native errors', { error, timeout });
  await log.flush();
  assert.equal(invoked, 0);
  const details = JSON.parse(f.read().split(' details=')[1]);
  assert.equal(details.error.name, '[Getter]');
  assert.equal(details.error.stack, '[Getter]');
  assert.equal(details.timeout.name, 'TimeoutError');
  assert.equal(details.timeout.message, 'fetch timed out');
  assert.equal(details.timeout.stack, '[Getter]');
});

test('bound custom error stack getters never execute', async (t) => {
  const f = fixture(t);
  const log = f.create();
  let invoked = 0;
  const error = new Error('sample');
  Object.defineProperty(error, 'stack', {
    get: (() => { invoked++; throw new Error('arbitrary bound stack getter'); }).bind(null),
  });
  log('info', 'hostile stack', { error });
  await log.flush();
  assert.equal(invoked, 0);
  const details = JSON.parse(f.read().split(' details=')[1]);
  assert.match(details.error.stack, /sample/);
});
