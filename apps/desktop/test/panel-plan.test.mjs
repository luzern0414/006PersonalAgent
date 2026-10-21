import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDates, shiftCalendarDate, taskGroups, taskDate } from '../src/renderer/panel/views/plan-model.mjs';

test('week is Monday through Sunday, including both sides of a month boundary', () => {
  assert.deepEqual(calendarDates('2026-11-01', false), [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
  ]);
});

test('week crosses a year boundary and a Monday starts its own week', () => {
  assert.deepEqual(calendarDates('2027-01-01', false), [
    '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03',
  ]);
  assert.equal(calendarDates('2026-10-12', false)[0], '2026-10-12');
});

test('expanded month is a six-week grid and contains leap day', () => {
  const dates = calendarDates('2028-02-15', true);
  assert.equal(dates.length, 42);
  assert.equal(dates[0], '2028-01-31');
  assert.equal(dates.at(-1), '2028-03-12');
  assert.ok(dates.includes('2028-02-29'));
});

test('week navigation keeps weekday and month navigation clamps the day', () => {
  assert.equal(shiftCalendarDate('2026-12-30', 1, false), '2027-01-06');
  assert.equal(shiftCalendarDate('2026-01-31', 1, true), '2026-02-28');
  assert.equal(shiftCalendarDate('2028-01-31', 1, true), '2028-02-29');
  assert.equal(shiftCalendarDate('2027-01-31', -1, true), '2026-12-31');
});

const tasks = [
  { id: 'future', planDate: '2027-02-01', status: 'open' },
  { id: 'past-done', planDate: '2024-01-01', status: 'done' },
  { id: 'undated', status: 'open' },
  { id: 'legacy', createdAt: '2023-04-01T12:00:00', status: 'done' },
  { id: 'due', due: '2025-03-07T09:00:00', status: 'open' },
  { id: 'same-date-done', planDate: '2027-02-01', status: 'done' },
];

test('all todos keep completed, distant, and undated tasks grouped by their date', () => {
  const groups = taskGroups(tasks, 'all');
  assert.deepEqual(groups.map((g) => g.date), ['2023-04-01', '2024-01-01', '2025-03-07', '2027-02-01', '']);
  assert.equal(groups.flatMap((g) => g.tasks).length, tasks.length);
  assert.deepEqual(groups[3].tasks.map((t) => t.id), ['future', 'same-date-done']);
});

test('open and completed filters partition the complete list without changing it', () => {
  const before = structuredClone(tasks);
  assert.deepEqual(taskGroups(tasks, 'open').flatMap((g) => g.tasks.map((t) => t.id)), ['due', 'future', 'undated']);
  assert.deepEqual(taskGroups(tasks, 'done').flatMap((g) => g.tasks.map((t) => t.id)), ['legacy', 'past-done', 'same-date-done']);
  assert.deepEqual(tasks, before);
});

test('editing a legacy todo keeps its created date when only the title changes', () => {
  const legacy = { id: 'legacy', title: 'old title', createdAt: '2023-04-01T12:00:00' };
  const originalDate = taskGroups([legacy], 'all')[0].date;
  const editDate = taskDate(legacy, '2026-10-12');
  assert.equal(editDate, originalDate);
  assert.equal(editDate, '2023-04-01');
});

test('task date uses plan date, due date, creation date, then the new-task default', () => {
  assert.equal(taskDate({ planDate: '2025-01-01', due: '2025-02-02T12:00:00', createdAt: '2025-03-03T12:00:00' }), '2025-01-01');
  assert.equal(taskDate({ due: '2025-02-02T12:00:00', createdAt: '2025-03-03T12:00:00' }), '2025-02-02');
  assert.equal(taskDate({}, '2026-10-12'), '2026-10-12');
  assert.equal(taskDate({ createdAt: 'invalid' }, '2026-10-12'), '2026-10-12');
});
