// 设置：昵称、AI 服务、提醒、保存位置、群机器人。修改即自动保存
import { h, api, run, toast } from '../lib.js';
import { icon } from '../icons.js';
import { reminderSettingsCard } from './reminders.js';
import { manageChannels } from './channels.js';

let modelCache = null; // 模型列表只在首次打开设置时联网获取

let root = null;
let revision = 0;
export function render(el) {
  root = el;
  draw();
}
export function unmount() {
  root = null;
  revision++;
}

async function save(patch) {
  const r = await run(() => api('settingsSave', patch));
  if (r) toast('已保存', 'ok', 1200);
  for (const n of r?.notes || []) toast(n, 'info', 3500);
  return r;
}

/** 输入框：停止输入 0.8 秒或失焦时保存（值未变不保存） */
function autoInput(props, toPatch) {
  const input = h('input.input', props);
  let last = input.value;
  let timer = null;
  const commit = () => {
    clearTimeout(timer);
    if (input.value === last) return;
    last = input.value;
    save(toPatch(input.value.trim()));
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(commit, 800);
  });
  input.addEventListener('change', commit);
  return input;
}

const row = (label, ...control) => h('div.set-row', h('label', label), h('div.set-ctl', control));

async function draw() {
  const target = root;
  if (!target?.isConnected) return;
  const ticket = ++revision;
  const current = () => root === target && target.isConnected && ticket === revision;
  const [{ settings: s, resolved: r }, remCard] = await Promise.all([api('settingsGet'), reminderSettingsCard()]);
  if (!current()) return;

  const model = h('select.input', { onchange: () => save({ llm: { model: model.value } }) }, h('option', { value: s.llm.model || r.model }, s.llm.model || r.model || '—'));
  // 首次打开时拉一次模型列表并缓存，失败就保持当前值
  (modelCache ||= api('llmModels').catch((e) => ((modelCache = null), Promise.reject(e))))
    .then((ids) => {
      if (!current()) return;
      const cur = model.value;
      const list = ids.filter((x) => !/image|embed|audio|tts|whisper|review/i.test(x));
      if (!list.includes(cur) && cur !== '—') list.unshift(cur);
      model.replaceChildren(...list.map((id) => h('option', { value: id }, id)));
      model.value = cur;
    })
    .catch(() => {});

  const test = h('button.btn.sm', {
    onclick: async () => {
      test.disabled = true;
      test.textContent = '…';
      const t = await run(() => api('llmTest'));
      test.textContent = t ? `✓ ${(t.ms / 1000).toFixed(1)}s` : '✗';
      setTimeout(() => ((test.textContent = '测试'), (test.disabled = false)), 2500);
    },
  }, '测试');

  const pathCtl = (key, value, resolvedPath) => {
    const input = autoInput({ value }, (v) => ({ paths: { [key]: v } }));
    return [
      input,
      h('button.btn.sm', {
        onclick: async () => {
          const p = await api('pickDir', resolvedPath);
          if (p) {
            input.value = p;
            input.dispatchEvent(new Event('change'));
          }
        },
      }, '选择'),
      h('button.icon-btn', { title: '打开文件夹', onclick: () => api('openPath', resolvedPath) }, icon('open', 15)),
    ];
  };

  target.replaceChildren(
    h('div.card', row('昵称', autoInput({ value: s.user.nickname }, (v) => ({ user: { nickname: v || '老大' } })))),
    h(
      'div.card',
      h('div.card-title', 'AI 服务'),
      row('地址', autoInput({ value: s.llm.baseUrl, placeholder: r.baseUrl }, (v) => ({ llm: { baseUrl: v } }))),
      row('Key', autoInput({ type: 'password', value: s.llm.apiKey, placeholder: r.apiKey }, (v) => ({ llm: { apiKey: v } }))),
      row('模型', model, test)
    ),
    remCard,
    h('div.card', h('div.card-title', '保存位置'), row('知识库', ...pathCtl('knowledgeDir', s.paths.knowledgeDir, r.paths.knowledgeDir)), row('文档', ...pathCtl('docsDir', s.paths.docsDir, r.paths.docsDir))),
    h(
      'div.card',
      row('群机器人', h('span.grow.muted', (s.channels || []).length ? (s.channels || []).map((c) => c.name).join('、') : '未添加'), h('button.btn.sm', { onclick: () => manageChannels(() => draw()) }, '管理'))
    )
  );
}
