// 日程待办：默认周历、可展开月历；当天合并安排与不受日期范围限制的全部待办
// 只读展示 + 勾选 / 删除；新增和修改通过对话完成
import { h, api, dateKey, WEEK, hm } from '../lib.js';
import { agendaList } from './agenda.js';
import { calendarDates, shiftCalendarDate, taskGroups } from './plan-model.mjs';

export const refreshOn = ['events', 'tasks', 'reminders'];

let root = null;
let selected = dateKey();
let expanded = false;
let view = 'day';
let taskFilter = 'all';
let revision = 0;

export function render(el, opts = {}) {
  root = el;
  selected = opts.date || dateKey();
  expanded = false;
  view = 'day';
  taskFilter = 'all';
  draw();
}

export function unmount() {
  root = null;
  revision++;
}

export function refresh() {
  if (root?.isConnected) draw();
}

async function draw() {
  const target = root;
  if (!target) return false;
  const ticket = ++revision;
  const state = { selected, expanded, view, taskFilter };
  const dates = calendarDates(state.selected, state.expanded);
  const current = () => target === root && target.isConnected && ticket === revision;
  try {
    const [summary, body] = await Promise.all([
      calendarSummary(dates),
      state.view === 'tasks' ? allTasksView(state.taskFilter) : dayView(state.selected),
    ]);
    if (!current()) return false;
    const tabs = h('div.seg.plan-tabs',
      h('button' + (state.view === 'day' ? '.on' : ''), { onclick: () => changeView('day'), 'aria-pressed': state.view === 'day' ? 'true' : 'false' }, '当天安排'),
      h('button' + (state.view === 'tasks' ? '.on' : ''), { onclick: () => changeView('tasks'), 'aria-pressed': state.view === 'tasks' ? 'true' : 'false' }, '全部待办')
    );
    target.replaceChildren(
      calendar(summary, dates, state),
      h('div.card.plan-arrangements',
        h('div.card-title', tabs),
        state.view === 'day'
          ? h('div.plan-day-title', dayLabel(state.selected))
          : '',
        body
      )
    );
    return true;
  } catch (e) {
    if (!current()) return false;
    target.replaceChildren(h('div.card', h('div.empty', '安排加载失败'), h('div.row.end', h('button.btn.sm', { onclick: () => draw() }, '重试'))));
    console.error('日程待办加载失败', e);
    return false;
  }
}

async function calendarSummary(dates) {
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
  const summaries = await Promise.all(months.map((month) => {
    const [y, m] = month.split('-').map(Number);
    return api('monthSummary', y, m);
  }));
  return Object.assign({}, ...summaries);
}

async function dayView(date) {
  const ag = await api('agenda', date);
  return agendaList(ag, { emptyText: date < dateKey() ? '这天没有记录' : '还没有安排' });
}

async function allTasksView(filter) {
  const tasks = await api('tasksList', { view: 'all' });
  const counts = { all: tasks.length, done: tasks.filter((t) => t.status === 'done').length };
  counts.open = counts.all - counts.done;
  const groups = taskGroups(tasks, filter);
  const filters = h('div.seg',
    [['all', '全部'], ['open', '未完成'], ['done', '已完成']].map(([value, label]) =>
      h('button' + (filter === value ? '.on' : ''), {
        'aria-pressed': filter === value ? 'true' : 'false',
        onclick: () => { taskFilter = value; draw(); },
      }, `${label} ${counts[value]}`)
    )
  );
  return h('div.plan-all-tasks',
    h('div.row.plan-task-filters', filters),
    groups.length ? groups.map(({ date, tasks: items }) => h('div.future-day',
      date ? h('button.future-head.plan-task-date', { onclick: () => select(date), title: '查看当天安排' }, dayLabel(date), h('span.muted', ` · ${items.length} 项 ›`)) : h('div.future-head', '未设日期'),
      agendaList({ date, items: items.map((t) => ({
        type: 'todo', id: t.id, title: t.title,
        time: t.due && dateKey(new Date(t.due)) === date ? hm(new Date(t.due)) : '',
        done: t.status === 'done', priority: t.priority ?? 2, carried: t.carried || 0, raw: t,
      })) })
    )) : h('div.empty', filter === 'done' ? '还没有已完成待办' : filter === 'open' ? '没有未完成待办' : '还没有待办')
  );
}

function changeView(next) {
  view = next;
  draw();
}

function select(date) {
  selected = date;
  view = 'day';
  draw();
}

function dayLabel(date) {
  const d = new Date(`${date}T00:00:00`);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
}

function rangeLabel(dates) {
  const start = new Date(`${dates[0]}T00:00:00`);
  const end = new Date(`${dates.at(-1)}T00:00:00`);
  if (start.getFullYear() !== end.getFullYear()) return `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()}–${end.getFullYear()}/${end.getMonth() + 1}/${end.getDate()}`;
  return `${start.getMonth() + 1}月${start.getDate()}日–${start.getMonth() === end.getMonth() ? '' : `${end.getMonth() + 1}月`}${end.getDate()}日`;
}

/** 周一开头；圆点沿用月汇总：待办、已完成、日程、一次性提醒。 */
function calendar(summary, dates, state) {
  const d = new Date(`${state.selected}T00:00:00`);
  const today = dateKey();
  const title = state.expanded ? `${d.getFullYear()}年${d.getMonth() + 1}月` : rangeLabel(dates);
  const shift = (n) => select(shiftCalendarDate(selected, n, expanded));
  const cells = dates.map((date) => {
    const day = new Date(`${date}T00:00:00`);
    const s = summary[date];
    const cls = [state.expanded && day.getMonth() !== d.getMonth() && 'out', date === today && 'today', date === state.selected && 'sel', day.getDay() % 6 === 0 && 'weekend']
      .filter(Boolean).map((c) => '.' + c).join('');
    const dots = s ? [s.todo ? h('i.dot-todo') : s.done ? h('i.dot-done') : '', s.event ? h('i.dot-event') : '', s.reminder ? h('i.dot-rem') : ''] : [];
    const detail = s ? [s.todo && `${s.todo} 项未完成待办`, s.done && `${s.done} 项已完成待办`, s.event && `${s.event} 项日程`, s.reminder && `${s.reminder} 项提醒`].filter(Boolean).join('，') : '';
    return h('button.cal-cell' + cls, {
      onclick: () => select(date), title: dayLabel(date) + (detail ? `，${detail}` : ''), 'aria-label': dayLabel(date), 'aria-pressed': date === state.selected ? 'true' : 'false',
    }, h('span.cal-num', day.getDate()), h('span.cal-dots', dots));
  });
  return h('div.card.cal' + (state.expanded ? '.cal-month' : '.cal-week'),
    h('div.cal-head',
      h('button.icon-btn', { onclick: () => shift(-1), title: state.expanded ? '上个月' : '上一周' }, '‹'),
      h('b', { title: dayLabel(dates[0]) }, title),
      h('button.icon-btn', { onclick: () => shift(1), title: state.expanded ? '下个月' : '下一周' }, '›'),
      h('span.spacer'),
      state.selected !== today ? h('button.btn.sm.ghost', { onclick: () => select(today) }, '今天') : ''
    ),
    h('div.cal-grid', ['一', '二', '三', '四', '五', '六', '日'].map((w) => h('span.cal-wk', w)), cells),
    h('div.cal-foot',
      h('span.small.muted', state.expanded ? '月历' : '周一至周日'),
      h('button.btn.sm.ghost', { onclick: () => { expanded = !expanded; draw(); }, 'aria-expanded': state.expanded ? 'true' : 'false' }, state.expanded ? '收起月历' : '展开月历')
    )
  );
}
