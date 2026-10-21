// 提醒设置（设置页中的折叠卡片）：喝水 / 起立 / 护眼频率、上下班时间
import { h, api, run, WEEK } from '../lib.js';

let open = true; // 默认展开；刷新后保持用户的展开状态

const save = (patch) => run(() => api('settingsSave', patch));

function slider(key, label, c) {
  const val = h('b', `${c.intervalMin} 分钟`);
  const range = h('input', {
    type: 'range', min: 10, max: 120, step: 5, value: c.intervalMin, style: { width: '100%', accentColor: 'var(--accent)' },
    oninput: () => (val.textContent = `${range.value} 分钟`),
    onchange: () => save({ reminders: { [key]: { intervalMin: +range.value } } }),
  });
  const sw = h('input', { type: 'checkbox', checked: c.enabled, onchange: () => save({ reminders: { [key]: { enabled: sw.checked } } }) });
  return h('div.rem-row', h('div.row', h('label.switch', sw, label), h('div.grow'), h('span.small.muted', '每 '), val), range);
}

export async function reminderSettingsCard() {
  const { settings: s } = await api('settingsGet');
  const r = s.reminders;
  const w = s.work;
  const num = (v, onchange) => h('input.input.num', { type: 'number', min: 0, max: 180, value: v, onchange: (e) => onchange(+e.target.value) });
  const time = (v, onchange) => h('input.input.time', { type: 'time', value: v, onchange: (e) => onchange(e.target.value) });
  const check = (v, onchange) => h('input', { type: 'checkbox', checked: v, onchange: (e) => onchange(e.target.checked) });
  const days = WEEK.map((d, i) => {
    const cb = h('input', { type: 'checkbox', value: i, checked: w.workdays.includes(i) });
    cb.onchange = () => save({ work: { workdays: days.map((l) => l.firstChild).filter((x) => x.checked).map((x) => +x.value) } });
    return h('label.switch.small', cb, d);
  });
  const on = (c) => (c.enabled ? `${c.intervalMin}分` : '关');

  return h(
    'details.card.fold',
    { open, ontoggle: (e) => (open = e.currentTarget.open) },
    h('summary.card-title', '提醒设置', h('span.sub', `喝水 ${on(r.water)} · 起立 ${on(r.stand)} · ${w.start}–${w.end}`)),
    slider('water', '喝水', r.water),
    slider('stand', '起立', r.stand),
    slider('eyes', '护眼', r.eyes),
    h('div.rem-grid',
      h('span', '上班'), time(w.start, (v) => save({ work: { start: v } })),
      h('span', '下班'), time(w.end, (v) => save({ work: { end: v } })),
      h('span', '下班预告'), h('span.row', num(r.offwork.preMin, (v) => save({ reminders: { offwork: { preMin: v } } })), '分钟前', check(r.offwork.enabled, (v) => save({ reminders: { offwork: { enabled: v } } }))),
      h('span', '日程提前'), h('span.row', num(r.meetingBeforeMin, (v) => save({ reminders: { meetingBeforeMin: v } })), '分钟'),
      h('span', '喝水目标'), h('span.row', num(r.water.goal, (v) => save({ reminders: { water: { goal: v } } })), '杯'),
      h('span', '稍后提醒'), h('span.row', num(r.snoozeMin, (v) => save({ reminders: { snoozeMin: v } })), '分钟')
    ),
    h('div.row.wrap.small', { style: { marginTop: '8px' } }, '工作日', ...days),
    h('div.row.wrap.small', { style: { marginTop: '8px' } },
      h('label.switch', check(r.onlyWorkHours, (v) => save({ reminders: { onlyWorkHours: v } })), '只在上班时间提醒'),
      h('label.switch', check(r.mode === 'active', (v) => save({ reminders: { mode: v ? 'active' : 'fixed' } })), '按实际用电脑时长计时'),
      h('label.switch', check(r.morning.enabled, (v) => save({ reminders: { morning: { enabled: v } } })), '上班早报')
    ),
    h('div.row.end', { style: { marginTop: '6px' } }, h('button.btn.sm.ghost', { onclick: () => api('remindTest') }, '试一下'))
  );
}
