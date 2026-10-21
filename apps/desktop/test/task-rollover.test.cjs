const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Core } = require('../src/core/services');
const { Store } = require('../src/core/store');
const T = require('../src/core/time');
const schedulerSource = fs.readFileSync(path.join(__dirname, '../src/core/scheduler.js'), 'utf8');

function task(id, planDate, extra = {}) {
  return { id, title: 'private task text ' + id, planDate, due: '', status: 'open', carried: 0, createdAt: '2025-01-01T12:00:00Z', updatedAt: '2025-01-01T12:00:00Z', ...extra };
}

function coreFixture(t, items = [], schedulerState = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rollover-'));
  const core = Object.create(Core.prototype); // Actual Core methods, without creating any model/OCR clients.
  const events = [];
  const logs = [];
  core.store = new Store(dir);
  core.store.tasks.data.items = structuredClone(items);
  core.store.tasks.save(true);
  core.store.state.data.scheduler = structuredClone(schedulerState);
  core.settings = { get: () => ({}) };
  core.emitter = (name, data) => events.push([name, data]);
  core.log = (...args) => logs.push(args);
  t.after(() => { core.store.flushAll(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { core, events, logs, dir };
}

function schedulerFixture(core, now, clock = () => 0) {
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  const intervals = [];
  const timeouts = [];
  const context = vm.createContext({
    module: { exports: {} }, Date: ClockDate,
    require: (name) => {
      if (name === './time') return T;
      if (name === 'node:perf_hooks') return { performance: { now: clock } };
      throw new Error('Unexpected scheduler dependency: ' + name);
    },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
  });
  vm.runInContext(schedulerSource, context, { filename: 'scheduler.js' });
  const scheduler = new context.module.exports.Scheduler(core, {});
  // Isolate the rollover stage; notifications and their model/weather paths are outside this test.
  for (const method of ['focusTick', 'healthTick', 'morningTick', 'offworkTick', 'eventTick', 'taskDueTick', 'customTick']) scheduler[method] = () => {};
  return { scheduler, intervals, timeouts };
}

test('rollover moves only unfinished past plans and preserves deadline, future, today, and completed tasks', (t) => {
  const now = new Date('2032-10-12T00:00:30');
  const original = [
    task('old', '2032-10-10', { due: '2032-10-10T17:00:00+08:00', carried: 3 }),
    task('future-deadline', '2032-10-11', { due: '2032-12-01T17:00:00+08:00' }),
    task('done', '2032-10-01', { status: 'done', completedAt: '2032-10-01T12:00:00Z' }),
    task('future', '2032-10-20'), task('today', '2032-10-12'),
  ];
  const { core, events, logs, dir } = coreFixture(t, original);
  assert.equal(core.carryOver(now), 2);
  assert.equal(core.store.tasks.get('old').planDate, '2032-10-12');
  assert.equal(core.store.tasks.get('old').due, original[0].due);
  assert.equal(core.store.tasks.get('old').carried, 5);
  assert.equal(core.store.tasks.get('old').updatedAt, now.toISOString());
  assert.equal(core.store.tasks.get('future-deadline').due, original[1].due);
  for (const item of original.slice(2)) assert.deepEqual(core.store.tasks.get(item.id), item);
  assert.deepEqual(events, [['data.changed', { kind: 'tasks' }]]);
  core.store.flushAll();
  const reloaded = new Store(dir);
  assert.equal(reloaded.tasks.get('old').planDate, '2032-10-12');
  assert.equal(reloaded.tasks.get('old').carried, 5);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2].event, 'tasks_rollover');
  assert.equal(logs[0][2].date, '2032-10-12');
  assert.equal(logs[0][2].count, 2);
  assert.deepEqual(logs[0][2].tasks.map(({ id, from, to, days }) => ({ id, from, to, days })), [
    { id: 'old', from: '2032-10-10', to: '2032-10-12', days: 2 },
    { id: 'future-deadline', from: '2032-10-11', to: '2032-10-12', days: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private task text/);
});

test('repeated rollover checks are idempotent and emit or save only on a real change', (t) => {
  const now = new Date('2032-10-12T09:00:00');
  const { core, events, logs } = coreFixture(t, [task('old', '2032-10-11')]);
  let saves = 0;
  const save = core.store.tasks.save.bind(core.store.tasks);
  core.store.tasks.save = (...args) => { saves++; return save(...args); };
  assert.equal(core.carryOver(now), 1);
  const changed = structuredClone(core.store.tasks.items);
  assert.equal(core.carryOver(new Date('2032-10-12T23:59:00')), 0);
  assert.deepEqual(core.store.tasks.items, changed);
  assert.equal(saves, 1);
  assert.equal(events.length, 1);
  assert.equal(logs.length, 1);
});

test('legacy tasks use deadline or creation date and missed days include a leap-day boundary', (t) => {
  const now = new Date('2032-03-02T10:00:00');
  const { core } = coreFixture(t, [
    task('deadline', '', { due: '2032-02-28T12:00:00', carried: 1 }),
    task('created', '', { createdAt: '2032-02-29T12:00:00' }),
  ]);
  assert.equal(core.carryOver(now), 2);
  assert.equal(core.store.tasks.get('deadline').planDate, '2032-03-02');
  assert.equal(core.store.tasks.get('deadline').carried, 4);
  assert.equal(core.store.tasks.get('created').carried, 2);
});

test('midnight rollover refreshes tasks and resets daily reminder state exactly once', (t) => {
  const oldState = { day: '2032-10-11', fired: { morning: true }, acc: { water: 100, stand: 50, eyes: 10 } };
  const { core, events } = coreFixture(t, [task('old', '2032-10-11')], oldState);
  const now = new Date('2032-10-12T00:00:00');
  const { scheduler } = schedulerFixture(core, now);
  scheduler.dayRollover(now);
  assert.equal(core.store.tasks.get('old').planDate, '2032-10-12');
  assert.equal(scheduler.st.day, '2032-10-12');
  assert.equal(Object.keys(scheduler.st.fired).length, 0);
  scheduler.st.fired.morning = true;
  scheduler.st.acc.water = 45;
  scheduler.dayRollover(new Date('2032-10-12T01:00:00'));
  assert.equal(scheduler.st.fired.morning, true);
  assert.equal(scheduler.st.acc.water, 45);
  assert.equal(events.length, 1);
});

test('startup checks overdue tasks immediately even when the persisted scheduler day is already today', (t) => {
  const now = new Date('2032-10-12T09:00:00');
  const { core, events } = coreFixture(t, [task('old', '2032-10-11')], { day: '2032-10-12' });
  const { scheduler } = schedulerFixture(core, now);
  scheduler.start();
  assert.equal(core.store.tasks.get('old').planDate, '2032-10-12');
  assert.equal(events.length, 1);
});

test('a same-day reopen check picks up a backdated task without resetting daily counters', (t) => {
  const now = new Date('2032-10-12T09:00:00');
  const { core, events } = coreFixture(t, [], { day: '2032-10-12', fired: { morning: true }, acc: { water: 45, stand: 0, eyes: 0 } });
  const { scheduler } = schedulerFixture(core, now);
  core.addTask({ title: 'backdated task text', planDate: '2032-10-10' });
  events.length = 0;
  scheduler.dayRollover(now);
  assert.equal(core.store.tasks.items[0].planDate, '2032-10-12');
  assert.equal(core.store.tasks.items[0].carried, 2);
  assert.equal(scheduler.st.fired.morning, true);
  assert.equal(scheduler.st.acc.water, 45);
  assert.equal(events.length, 1);
});

test('resume tick catches multiple missed dates and passes the same clock into rollover', (t) => {
  const now = new Date('2032-10-15T09:00:00');
  const { core } = coreFixture(t, [task('old', '2032-10-10')], { day: '2032-10-10' });
  const { scheduler } = schedulerFixture(core, now);
  scheduler.lastTick = new Date('2032-10-10T09:00:00').getTime();
  scheduler.tick();
  assert.equal(core.store.tasks.get('old').planDate, '2032-10-15');
  assert.equal(core.store.tasks.get('old').carried, 5);
});

test('slow synchronous scheduler tick emits duration metadata, including when a stage throws', (t) => {
  const now = new Date('2032-10-12T09:00:00');
  const { core, logs } = coreFixture(t, [], { day: '2032-10-12' });
  const times = [0, 1501];
  const { scheduler } = schedulerFixture(core, now, () => times.shift());
  scheduler.healthTick = () => { throw new Error('stage failure'); };
  scheduler.tick();
  const slow = logs.find((entry) => entry[2]?.event === 'scheduler_slow_tick');
  assert.ok(slow);
  assert.equal(slow[2].elapsedMs, 1501);
  assert.ok(logs.some(([level, message]) => level === 'error' && message.includes('stage failure')));
});

test('ordinary fast scheduler tick adds no slow-tick diagnostic noise', (t) => {
  const now = new Date('2032-10-12T09:00:00');
  const { core, logs } = coreFixture(t, [], { day: '2032-10-12' });
  const times = [0, 100];
  const { scheduler } = schedulerFixture(core, now, () => times.shift());
  scheduler.tick();
  assert.equal(logs.length, 0);
});

test('slow-tick threshold compares the actual duration before rounding the logged value', (t) => {
  const now = new Date('2032-10-12T09:00:00');
  const { core, logs } = coreFixture(t, [], { day: '2032-10-12' });
  const times = [0, 1000.1];
  const { scheduler } = schedulerFixture(core, now, () => times.shift());
  scheduler.tick();
  assert.equal(logs.filter((entry) => entry[2]?.event === 'scheduler_slow_tick').length, 1);
});
