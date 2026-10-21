const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (date) => new Date(`${date}T00:00:00`);

/** Planned date > deadline date > creation date; fallback is for a new or undated task. */
export function taskDate(task, fallback = '') {
  const source = task.due || task.createdAt;
  const d = source ? new Date(source) : null;
  return task.planDate || (d && !Number.isNaN(d.getTime()) ? key(d) : fallback);
}

/** Local calendar days; use setDate so daylight-saving changes do not skip a day. */
export function calendarDates(selected, expanded) {
  const first = parse(selected);
  if (expanded) first.setDate(1);
  first.setDate(first.getDate() - (first.getDay() + 6) % 7);
  return Array.from({ length: expanded ? 42 : 7 }, (_, i) => {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    return key(d);
  });
}

export function shiftCalendarDate(selected, amount, expanded) {
  const d = parse(selected);
  if (!expanded) d.setDate(d.getDate() + amount * 7);
  else {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + amount);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  }
  return key(d);
}

/** Match the service's date fallback for legacy tasks, preserving order within each date. */
export function taskGroups(tasks, filter = 'all') {
  const groups = new Map();
  for (const task of tasks) {
    const done = task.status === 'done';
    if ((filter === 'open' && done) || (filter === 'done' && !done)) continue;
    const date = taskDate(task);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(task);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
    .map(([date, items]) => ({ date, tasks: items }));
}
