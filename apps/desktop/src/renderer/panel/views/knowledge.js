// 知识库：收录（拖拽 / 选择文件 / 剪贴板截图）、搜索、列表；文档只读查看
// 网址、文本、随手记都通过对话收录（例如「把这段话记到知识库」），界面上不再提供手动填写
import { h, api, run, empty, relTime, modal, md } from '../lib.js';
import { icon } from '../icons.js';

export const refreshOn = ['kb', 'notes'];
let root = null;
let revision = 0;
let tab = 'kb';
let unlisten = null;

const DOC_ICON = { file: 'file', url: 'link', text: 'text', note: 'note', image: 'image' };

export function render(el) {
  root = el;
  unlisten?.();
  unlisten = window.pa.on('kb:progress', (p) => {
    const el = root?.querySelector('.progress');
    if (el) el.textContent = `${p.file} · ${{ parsing: '识别中', indexed: '已收录', embedding: '索引中' }[p.stage] || p.stage}`;
  });
  draw();
}
export function unmount() {
  unlisten?.();
  unlisten = null;
  root = null;
  revision++;
}
export function refresh() {
  if (root?.isConnected) draw();
}

async function draw() {
  const target = root;
  if (!target?.isConnected) return;
  const ticket = ++revision;
  const activeTab = tab;
  const seg = h('div.seg', [['kb', '资料'], ['notes', '文档']].map(([id, label]) => h('button' + (id === activeTab ? '.on' : ''), { onclick: () => ((tab = id), draw()) }, label)));
  const body = activeTab === 'kb' ? await kbView() : await notesView();
  if (root !== target || !target.isConnected || ticket !== revision) return;
  target.replaceChildren(h('div.page-head', seg, h('span.spacer'), ...(activeTab === 'kb' ? kbActions() : [])), ...body);
}

function kbActions() {
  return [
    h('button.icon-btn', { title: '收藏剪贴板截图', onclick: () => run(() => api('kbClipboard')) }, icon('image', 16)),
  ];
}

const row = (ico, title, sub, onclick, actions = []) =>
  h('div.kb-row', icon(ico, 16, 'kb-ico'), h('div.grow', { onclick }, h('div.kb-title', title), sub ? h('div.kb-sub', sub) : ''), ...actions);

async function kbView() {
  const [docs, stats] = await Promise.all([api('kbList'), api('kbStats')]);
  const drop = h('div.dropzone', { onclick: () => run(() => api('kbPickFiles')) }, icon('upload', 18), h('span', '拖入或点击添加文件'), h('div.progress'));
  const input = h('input.input.search', { placeholder: '搜索' });
  const list = h('div.kb-list');
  const showAll = () =>
    list.replaceChildren(
      ...(docs.length
        ? docs.map((d) =>
            row(DOC_ICON[d.type] || 'file', d.title, relTime(d.createdAt), () => api('kbOpen', d.id), [
              h('button.icon-btn.row-act', { title: '移除', onclick: () => run(() => api('kbRemove', d.id)).then(draw) }, icon('x', 14)),
            ])
          )
        : [empty('还没有资料')])
    );
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const q = input.value.trim();
    if (!q) return showAll();
    const r = (await run(() => api('kbSearch', q, 8))) || [];
    list.replaceChildren(...(r.length ? r.map((x) => row('file', x.title + (x.heading ? ' › ' + x.heading : ''), x.text.replace(/\s+/g, ' ').slice(0, 80), () => api('kbOpen', x.docId))) : [empty('没找到')]));
  });
  input.addEventListener('input', () => !input.value && showAll());
  showAll();
  return [
    drop,
    h('section.card', h('div.sec-head', h('h3', '全部资料'), h('span.sec-sub', stats.docs ? `${stats.docs} 篇` : ''), h('span.spacer'), h('button.icon-btn', { title: '打开文件夹', onclick: () => api('openPath', stats.dir) }, icon('open', 15))), h('div.search-wrap', icon('search', 15), input), list),
  ];
}

async function notesView() {
  const [notes, { resolved }] = await Promise.all([api('notesList'), api('settingsGet')]);
  return [
    h(
      'section.card',
      h('div.sec-head', h('h3', '文档'), h('span.sec-sub', notes.length ? `${notes.length} 篇` : ''), h('span.spacer'), h('button.icon-btn', { title: '打开文件夹', onclick: () => api('openPath', resolved.paths.docsDir) }, icon('open', 15))),
      h(
        'div.kb-list',
        notes.length
          ? notes.map((n) =>
              row('note', n.name.replace(/\.md$/, ''), relTime(n.updatedAt), () => viewNote(n), [
                h('button.icon-btn.row-act', { title: '删除', onclick: () => run(() => api('notesRemove', n.name)).then(draw) }, icon('x', 14)),
              ])
            )
          : empty('还没有文档')
      )
    ),
  ];
}

async function viewNote(n) {
  const text = await api('notesRead', n.name);
  modal(n.name.replace(/\.md$/, ''), h('div.report-box', { html: md(text) }), [
    { label: '打开文件', onClick: () => api('openPath', n.path) },
    { label: '关闭', kind: 'primary', onClick: (c) => c() },
  ]);
}
