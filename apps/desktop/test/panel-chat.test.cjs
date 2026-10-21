const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const views = path.join(__dirname, '../src/renderer/panel/views');
const chatSource = fs.readFileSync(path.join(views, 'chat.js'), 'utf8');
const libSource = fs.readFileSync(path.join(views, '../lib.js'), 'utf8');
const hSource = libSource.slice(libSource.indexOf('export function h('), libSource.indexOf('export function toast(')).replace(/^export /gm, '');

// Minimal DOM boundary; rendering, listeners, state and async work run from the real chat module.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = {};
    this.className = '';
    this.value = '';
    this.disabled = false;
    this.scrollHeight = 40;
    this.classList = {
      contains: (name) => this.className.split(' ').includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  append(...children) {
    for (const child of children) {
      if (child instanceof Element) child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this._html = ''; this._text = ''; this.append(...children); }
  replaceWith(node) {
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1, node);
    node.parentNode = this.parentNode;
    this.parentNode = null;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, event = {}) { return this.listeners.get(type)?.map((listener) => listener({ target: this, ...event })) || []; }
  focus() { this.focused = true; }
  set innerHTML(value) { this.replaceChildren(); this._html = String(value); }
  get innerHTML() { return this._html || ''; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return (this._text || this._html || '') + this.children.map((child) => child instanceof Element ? child.textContent : String(child)).join(''); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith('.') ? selector.slice(1).split('.').every((name) => node.classList.contains(name)) : node.tagName === selector;
    const found = [];
    const visit = (node) => {
      for (const child of node.children) if (child instanceof Element) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ storage = new Map(), history = () => Promise.resolve([]), chat = () => Promise.resolve({ text: '完成', steps: [] }), storageThrows = false } = {}) {
  const events = new Map();
  const timers = new Map();
  const calls = { chat: [], confirm: [], api: [] };
  let nextTimer = 0;
  let timerNow = 0;
  const window = {
    localStorage: {
      getItem: (key) => { if (storageThrows) throw new Error('storage blocked'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageThrows) throw new Error('storage blocked'); storage.set(key, value); },
      removeItem: (key) => { if (storageThrows) throw new Error('storage blocked'); storage.delete(key); },
    },
    addEventListener() {},
    pa: {
      on: (name, listener) => {
        if (!events.has(name)) events.set(name, new Set());
        events.get(name).add(listener);
        return () => events.get(name).delete(listener);
      },
      api: (method, ...args) => { calls.api.push([method, ...args]); return method === 'chatHistory' ? history() : Promise.resolve(); },
      chat: (payload) => { calls.chat.push(payload); return chat(payload); },
      confirm: (id, ok) => { calls.confirm.push([id, ok]); return Promise.resolve(); },
    },
  };
  const context = vm.createContext({
    window, Node: Element, document: { createElement: (tag) => new Element(tag) }, exports: {},
    setTimeout: (fn, delay = 0) => { timers.set(++nextTimer, { fn, at: timerNow + delay }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(hSource + '\nconst api = (method, ...args) => window.pa.api(method, ...args); const md = (text) => text || ""; const empty = (text) => h("div.empty", text); const relTime = (day) => day;', context);
  vm.runInContext(chatSource.replace(/^import .*?;\r?\n/m, '').replace(/^export /gm, '') + '\nexports.render = render; exports.unmount = unmount;', context, { filename: 'chat.js' });
  let root;
  return {
    storage, calls,
    get root() { return root; },
    mount() { root = new Element(); context.exports.render(root, { focusInput: false }); return root; },
    unmount() { context.exports.unmount(); },
    input(value) { const input = root.querySelector('textarea'); input.value = value; input.dispatch('input'); return input; },
    send() { return root.querySelectorAll('button').find((button) => button.textContent === '发送').dispatch('click')[0]; },
    stop() { return root.querySelectorAll('button').find((button) => button.textContent === '停止').dispatch('click')[0]; },
    emit(event) { for (const listener of events.get('chat:event') || []) listener(event); },
    advance(ms) {
      const end = timerNow + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timerNow = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      timerNow = end;
    },
    flushTimers() { const queued = [...timers.values()]; timers.clear(); queued.forEach((timer) => timer.fn()); },
    listeners() { return events.get('chat:event')?.size || 0; },
  };
}

test('chat composer has no placeholder and preserves raw draft across navigation and a new renderer', async () => {
  const app = harness();
  app.mount();
  await settle();
  assert.ok(!app.root.querySelector('textarea').placeholder);
  app.input('\n  还没发出的草稿\n第二行  ');
  app.unmount();
  app.mount();
  assert.equal(app.root.querySelector('textarea').value, '\n  还没发出的草稿\n第二行  ');
  const restarted = harness({ storage: app.storage });
  restarted.mount();
  assert.equal(restarted.root.querySelector('textarea').value, '\n  还没发出的草稿\n第二行  ');
});

test('history settling during a send keeps both existing history and the pending turn', async () => {
  const load = deferred();
  const reply = deferred();
  const app = harness({ history: () => load.promise, chat: () => reply.promise });
  app.mount();
  app.input('新问题');
  const sending = app.send();
  load.resolve([{ role: 'user', content: '以前的问题', at: '2026-10-11T12:00:00Z' }]);
  await settle();
  assert.match(app.root.textContent, /以前的问题/);
  assert.match(app.root.textContent, /新问题/);
  assert.equal(app.root.querySelectorAll('.msg.user').length, 2);
  reply.resolve({ text: '新回答', steps: [] });
  await sending;
  assert.match(app.root.textContent, /新回答/);
});

test('off-page stream, tools and confirmation survive remount without duplicate listeners or turns', async () => {
  const reply = deferred();
  const app = harness({ chat: () => reply.promise });
  app.mount();
  await settle();
  app.input('发送期间保留');
  const sending = app.send();
  await settle();
  app.emit({ type: 'delta', text: '先' });
  app.unmount();
  app.emit({ type: 'delta', text: '后' });
  app.emit({ type: 'tool_start', id: 'tool-1', name: 'send_message' });
  app.emit({ type: 'confirm', id: 'confirm-1', preview: '待发送内容' });
  app.mount();
  await settle();
  assert.equal(app.listeners(), 1);
  assert.equal(app.root.querySelectorAll('button').find((button) => button.textContent === '发送').disabled, true);
  assert.equal(app.root.querySelectorAll('.msg.user').length, 1);
  assert.match(app.root.textContent, /先后/);
  assert.match(app.root.textContent, /发送消息/);
  assert.match(app.root.textContent, /待发送内容/);
  app.root.querySelector('.confirm-card').querySelector('.primary').dispatch('click');
  await settle();
  assert.deepEqual(app.calls.confirm, [['confirm-1', true]]);
  app.root.querySelectorAll('button').find((button) => button.textContent === '停止').dispatch('click');
  assert.ok(app.calls.api.some((call) => call[0] === 'chatStop' && call[1] === 'main'));
  app.emit({ type: 'tool_end', id: 'tool-1', name: 'send_message', ok: true });
  app.emit({ type: 'done', text: '完整回答', conversationId: 'main' });
  reply.resolve({ text: '完整回答', steps: [{ name: 'send_message', ok: true }] });
  await sending;
  app.flushTimers();
  assert.match(app.root.textContent, /完整回答/);
  assert.equal(app.root.querySelectorAll('button').find((button) => button.textContent === '发送').disabled, false);
  assert.equal(app.root.querySelector('textarea').value, '');
  const recreated = harness({ storage: app.storage });
  recreated.mount();
  assert.equal(recreated.root.querySelector('textarea').value, '');
  app.unmount();
  app.mount();
  assert.equal(app.root.querySelectorAll('.msg.user').length, 1);
  assert.match(app.root.textContent, /完整回答/);
});

test('a rejected send restores controls and retains the draft for renderer recreation', async () => {
  const reply = deferred();
  const app = harness({ chat: () => reply.promise });
  app.mount();
  await settle();
  app.input('网络出错也要保留');
  const sending = app.send();
  await settle();
  reply.reject(new Error('network lost'));
  await sending;
  assert.equal(app.root.querySelectorAll('button').find((button) => button.textContent === '发送').disabled, false);
  assert.equal(app.root.querySelector('textarea').value, '网络出错也要保留');
  assert.match(app.root.textContent, /network lost/);
  const recreated = harness({ storage: app.storage });
  recreated.mount();
  assert.equal(recreated.root.querySelector('textarea').value, '网络出错也要保留');
});

test('successful completion preserves a newer draft and uses the final IPC text', async () => {
  const reply = deferred();
  const app = harness({ chat: () => reply.promise });
  app.mount();
  await settle();
  app.input('第一条');
  const sending = app.send();
  await settle();
  app.input('下一条草稿');
  app.unmount();
  reply.resolve({ text: '最终回答', steps: [] });
  await sending;
  app.mount();
  assert.equal(app.root.querySelector('textarea').value, '下一条草稿');
  assert.match(app.root.textContent, /最终回答/);
  assert.equal(app.root.querySelectorAll('button').find((button) => button.textContent === '发送').disabled, false);
});

test('returned errors retain a draft even after partial streaming output', async () => {
  const reply = deferred();
  const app = harness({ chat: () => reply.promise });
  app.mount();
  await settle();
  app.input('出错后重试');
  const sending = app.send();
  await settle();
  app.emit({ type: 'delta', text: '部分回答' });
  app.emit({ type: 'error', message: '已停止', conversationId: 'main' });
  reply.resolve({ error: 'AbortError' });
  await sending;
  assert.match(app.root.textContent, /部分回答/);
  assert.match(app.root.textContent, /已停止/);
  assert.equal(app.root.querySelector('textarea').value, '出错后重试');
  assert.ok(!app.root.querySelector('.body').classList.contains('typing'));
});

test('history completion only paints the currently mounted view', async () => {
  const load = deferred();
  const app = harness({ history: () => load.promise });
  const oldView = app.mount();
  app.unmount();
  app.mount();
  load.resolve([{ role: 'user', content: '已存历史', at: '2026-10-12T10:00:00Z' }]);
  await settle();
  assert.match(app.root.textContent, /已存历史/);
  assert.doesNotMatch(oldView.textContent, /已存历史/);
  assert.equal(app.listeners(), 1);
});

test('starting a turn preserves existing message nodes instead of rerendering the entire history', async () => {
  const reply = deferred();
  const app = harness({
    history: () => Promise.resolve([{ role: 'assistant', content: '已有回答', steps: [] }]),
    chat: () => reply.promise,
  });
  app.mount();
  await settle();
  const existing = app.root.querySelector('.msg.assistant');
  app.input('再问一下');
  const sending = app.send();
  assert.equal(app.root.querySelector('.msg.assistant'), existing);
  reply.resolve({ text: '新的回答', steps: [] });
  await sending;
});

test('continuous 10ms deltas paint at 40ms intervals while the send is still pending', async () => {
  const reply = deferred();
  const app = harness({ chat: () => reply.promise });
  app.mount();
  await settle();
  app.input('持续流式输出');
  const sending = app.send();
  await settle();
  for (let i = 0; i < 4; i++) {
    app.emit({ type: 'delta', text: String(i) });
    app.advance(10);
  }
  assert.equal(app.root.querySelector('.body').innerHTML, '0123');
  assert.ok(app.root.querySelector('.body').classList.contains('typing'));
  for (let i = 4; i < 8; i++) {
    app.emit({ type: 'delta', text: String(i) });
    app.advance(10);
  }
  assert.equal(app.root.querySelector('.body').innerHTML, '01234567');
  reply.resolve({ text: '01234567', steps: [] });
  await sending;
});

test('Stop during history loading cancels preflight immediately and never starts chat IPC', async () => {
  const load = deferred();
  const app = harness({ history: () => load.promise });
  app.mount();
  app.input('还没开始的发送');
  const sending = app.send();
  assert.equal(app.calls.chat.length, 0);
  await app.stop();
  await settle();
  assert.equal(app.root.querySelectorAll('button').find((button) => button.textContent === '发送').disabled, false);
  assert.ok(app.root.querySelectorAll('button').find((button) => button.textContent === '停止').classList.contains('hidden'));
  assert.equal(app.root.querySelector('textarea').value, '还没开始的发送');
  assert.ok(!app.root.querySelector('.body').classList.contains('typing'));
  assert.match(app.root.textContent, /已停止/);
  await sending;
  app.unmount();
  app.mount();
  load.resolve([{ role: 'user', content: '之前保存的对话' }]);
  await settle();
  assert.equal(app.calls.chat.length, 0);
  assert.equal(app.calls.api.filter((call) => call[0] === 'chatStop').length, 0);
  assert.equal(app.root.querySelector('textarea').value, '还没开始的发送');
  assert.match(app.root.textContent, /之前保存的对话/);
});
