'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTracker } = require('../src/main/runtime-watchdog');

function monitor() {
  const records = [];
  const tracker = createTracker({ timeoutMs: 5000, startupTimeoutMs: 10000, now: 0, record: (level, message, details) => records.push({ level, ...details }) });
  return { tracker, records, ticks: (from, to) => { for (let now = from; now <= to; now += 1000) tracker.tick(now); } };
}

test('an independent monitor records missed heartbeats once and records recovery', () => {
  const { tracker, records, ticks } = monitor();
  tracker.receive({ type: 'heartbeat', context: { rssMB: 120, operations: ['api:agenda'] } }, 0);
  ticks(1000, 8000);
  assert.equal(records.filter(r => r.event === 'main_unresponsive').length, 1);
  assert.equal(records[0].context.rssMB, 120);
  tracker.receive({ type: 'heartbeat' }, 9000);
  assert.equal(records.at(-1).event, 'main_responsive');
  assert.equal(records.at(-1).silentMs, 9000);
});

test('suspend/resume and a system-wide scheduling pause do not claim a hang', () => {
  const { tracker, records, ticks } = monitor();
  tracker.receive({ type: 'heartbeat' }, 0);
  tracker.receive({ type: 'suspend' }, 1000);
  ticks(2000, 20000);
  tracker.receive({ type: 'resume' }, 21000);
  tracker.tick(22000);
  tracker.tick(60000); // The monitor itself was paused as well.
  tracker.receive({ type: 'heartbeat' }, 61000);
  assert.ok(!records.some(r => r.event === 'main_unresponsive'));
});

test('startup delay is distinct from an active run hang', () => {
  const { records, ticks } = monitor();
  ticks(1000, 11000);
  assert.equal(records.at(-1).event, 'main_unresponsive');
  assert.equal(records.at(-1).phase, 'startup');
});

test('normal quit marker and unexpected disconnect produce different exit records', () => {
  const clean = monitor();
  clean.tracker.receive({ type: 'shutdown' }, 1000);
  clean.tracker.disconnect(1001);
  assert.equal(clean.records.at(-1).event, 'normal_exit');
  assert.ok(!clean.records.some(r => r.event === 'unexpected_exit'));
  const failed = monitor();
  failed.tracker.disconnect(1000);
  assert.equal(failed.records.at(-1).event, 'unexpected_exit');
});
