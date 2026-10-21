// 某一天的安排（日程 + 提醒 + 待办）：按时间排列，只读展示 + 勾选完成 / 删除；完成的条目划线保留
// 新增、修改统一通过对话完成，界面上不再提供输入框
import { h, api, run, modal, empty } from '../lib.js';
import { icon } from '../icons.js';

const ICON = { todo: '', reminder: 'bell', event: 'calendar' };
const REPEAT = { none: '', daily: '每天', workdays: '工作日', weekly: '每周' };

/** 条目列表 */
export function agendaList(ag, { emptyText = '没有安排', compact = false } = {}) {
  if (!ag.items.length) return empty(emptyText);
  return h(
    'div.agenda' + (compact ? '.compact' : ''),
    ag.items.map((x) => {
      const checkable = x.type !== 'event';
      const toggle = () =>
        run(() => (x.type === 'todo' ? api('tasksUpdate', x.id, { status: x.done ? 'open' : 'done' }) : api('reminderDone', x.id, ag.date, !x.done)));
      const time = x.allDay ? '全天' : x.time ? x.time + (x.end ? `–${x.end}` : '') : '';
      const meta = [REPEAT[x.repeat] || '', x.location || '', x.carried ? `顺延 ${x.carried} 天` : '', x.priority <= 1 ? (x.priority === 0 ? '紧急' : '重要') : ''].filter(Boolean);
      return h(
        `div.ag-item.t-${x.type}` + (x.done ? '.done' : ''),
        checkable ? h('button.check', { title: x.done ? '标记未完成' : '完成', onclick: toggle }, x.done ? '✓' : '') : h('span.ag-dot'),
        h(
          'div.grow',
          h('div.ag-title', ICON[x.type] ? icon(ICON[x.type], 13, 'ag-ico') : '', x.title),
          time || meta.length ? h('div.ag-meta', time ? h('span', time) : '', meta.map((m) => h('span', m))) : ''
        ),
        h('button.icon-btn.ag-del', { title: '删除', onclick: () => remove(x) }, icon('x', 14))
      );
    })
  );
}

async function remove(x) {
  if (x.type === 'todo') return run(() => api('tasksRemove', x.id));
  if (x.type === 'event') return run(() => api('eventsRemove', x.id));
  if (x.repeat && x.repeat !== 'none') {
    // 重复提醒：跳过某一天用勾选，这里是整条删除
    return modal('删除重复提醒', h('div', `「${x.title}」是${REPEAT[x.repeat]}重复的提醒`), [
      { label: '取消', onClick: (c) => c() },
      { label: '全部删除', onClick: (c) => (c(), run(() => api('remindersRemove', x.id))) },
    ]);
  }
  return run(() => api('remindersRemove', x.id));
}
