const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const views = path.join(__dirname, '../src/renderer/panel/views');
const libSource = fs.readFileSync(path.join(views, '../lib.js'), 'utf8');
const hSource = libSource.slice(libSource.indexOf('export function h('), libSource.indexOf('export function toast(')).replace(/^export /gm, '');

// The actual view modules and h() run here. Only the DOM and IPC boundary are isolated.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.style = {};
    this.className = '';
    this.value = '';
    this.connected = false;
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
  get isConnected() { return this.connected || !!this.parentNode?.isConnected; }
  append(...children) {
    for (const child of children) {
      if (child instanceof Element) child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) if (child instanceof Element) child.parentNode = null;
    this.children = [];
    this._html = '';
    this._text = '';
    this.append(...children);
  }
  setAttribute(name, value) { this[name] = String(value); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, event = {}) {
    return this.listeners.get(type)?.map((listener) => listener({ target: this, currentTarget: this, ...event })) || [];
  }
  focus() {}
  contains(element) { return element === this || this.children.some((child) => child instanceof Element && child.contains(element)); }
  set innerHTML(value) { this.replaceChildren(); this._html = String(value); }
  get innerHTML() { return this._html || ''; }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return (this._text || this._html || '') + this.children.map((child) => child instanceof Element ? child.textContent : String(child)).join(''); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith('.') ? selector.slice(1).split('.').every((name) => node.classList.contains(name)) : node.tagName === selector.toUpperCase();
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
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const pageContent = (root) => root.textContent + ' ' + root.querySelectorAll('input').map((input) => input.value).join(' ');
const settings = (name = 'NEW PAGE') => ({
  settings: { user: { nickname: name }, llm: { model: 'test', baseUrl: '', apiKey: '' }, paths: { knowledgeDir: '', docsDir: '' }, work: { start: '00:00', end: '23:59' }, home: { tomorrowLeadMin: -1 } },
  resolved: { model: 'test', baseUrl: '', apiKey: '', paths: { knowledgeDir: '', docsDir: '' } },
});
const agenda = (label = 'NEW PAGE') => ({ workday: true, weekday: '周一', items: [{ type: 'todo', title: label, done: false }] });
const docs = (label = 'NEW PAGE') => [{ id: label, title: label, type: 'text', createdAt: '2026-10-12T12:00:00' }];

function harness(view, responses = {}) {
  const calls = [];
  const events = new Map();
  const timers = new Map();
  const intervals = new Map();
  let timerId = 0;
  const defaults = {
    settingsGet: () => settings(), agenda: () => agenda(), kbList: () => docs(), kbStats: () => ({ docs: 1, dir: '' }), notesList: () => [], llmModels: () => [],
    weather: () => ({ city: 'test', now: { temp: 20, feels: 20, text: '晴', kind: 'clear', humidity: 50, wind: 0 }, days: ['2026-10-12', '2026-10-13'].map((date) => ({ date, min: 18, max: 22, rain: 0, uv: 0, text: '晴', kind: 'clear', sunrise: '06:00', sunset: '18:00' })), hourly: [] }),
  };
  const window = { pa: {
    api: (method, ...args) => { calls.push([method, ...args]); return Promise.resolve((responses[method] || defaults[method] || (() => true))(...args)); },
    on: (name, listener) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(listener);
      return () => events.get(name).delete(listener);
    },
  } };
  const context = vm.createContext({
    window, Node: Element, document: { createElement: (tag) => new Element(tag), querySelector: () => null, activeElement: null }, exports: {}, console,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; }, clearInterval: (id) => intervals.delete(id),
  });
  vm.runInContext(hSource + `
    const api = (method, ...args) => window.pa.api(method, ...args);
    const run = async (fn) => { try { return await fn(); } catch { return undefined; } };
    const md = (text) => text || ''; const toast = () => {}; const empty = (text) => h('div.empty', text); const relTime = (date) => date || '';
    const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
    const dateKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const icon = () => h('span.ico'); const weatherIcon = icon; const skyGradient = () => '';
    const agendaList = (ag) => h('div.agenda', ag.items.map(x => h('div.ag-item', x.title)));
    const quickAdder = () => h('div.adder'); const channelSelect = async () => h('select'); const modal = () => {};
  `, context);
  const source = fs.readFileSync(path.join(views, view + '.js'), 'utf8');
  vm.runInContext(source.replace(/^import .*?;\r?\n/gm, '').replace(/^export /gm, '') + '\nexports.render = render; exports.unmount = typeof unmount === "function" ? unmount : () => {}; exports.refresh = typeof refresh === "function" ? refresh : () => {};', context, { filename: view + '.js' });
  const root = new Element();
  root.connected = true; // The panel router reuses this connected #view across every route.
  return { root, calls, mount: () => context.exports.render(root), unmount: () => context.exports.unmount(), refresh: () => context.exports.refresh(), intervals };
}

const boundaries = [
  { view: 'today', method: 'agenda', value: agenda },
  { view: 'settings', method: 'settingsGet', value: settings },
  { view: 'knowledge', method: 'kbList', value: docs },
];

for (const { view, method, value } of boundaries) {
  test(view + ' delayed load cannot repaint another route in the same connected #view', async () => {
    const pending = deferred();
    const app = harness(view, { [method]: () => pending.promise });
    app.mount();
    app.unmount();
    app.root.replaceChildren('OTHER ROUTE');
    pending.resolve(value('STALE RESPONSE'));
    await settle();
    assert.equal(app.root.textContent, 'OTHER ROUTE');
    assert.equal(app.intervals.size, 0);
  });

  test(view + ' remount uses the latest response when an older load finishes last', async () => {
    const pending = deferred();
    let count = 0;
    const app = harness(view, { [method]: () => ++count === 1 ? pending.promise : value('LATEST RESPONSE') });
    app.mount();
    app.unmount();
    app.mount();
    await settle();
    assert.match(pageContent(app.root), /LATEST RESPONSE/);
    pending.resolve(value('STALE RESPONSE'));
    await settle();
    assert.match(pageContent(app.root), /LATEST RESPONSE/);
    assert.doesNotMatch(pageContent(app.root), /STALE RESPONSE/);
    app.unmount();
  });
}

test('today cannot repaint another route after its second-stage tomorrow agenda load', async () => {
  const pending = deferred();
  let agendaCount = 0;
  const app = harness('today', {
    settingsGet: () => { const s = settings(); s.settings.work.end = '00:00'; return s; },
    agenda: () => ++agendaCount === 1 ? agenda() : pending.promise,
  });
  app.mount();
  await settle();
  assert.equal(agendaCount, 2);
  app.unmount();
  app.root.replaceChildren('OTHER ROUTE');
  pending.resolve(agenda('STALE TOMORROW'));
  await settle();
  assert.equal(app.root.textContent, 'OTHER ROUTE');
});

test('knowledge remove completing after navigation cannot trigger an off-page redraw', async () => {
  const pending = deferred();
  const app = harness('knowledge', { kbRemove: () => pending.promise });
  app.mount();
  await settle();
  app.root.querySelectorAll('button').find((button) => button.title === '移除').dispatch('click');
  app.unmount();
  app.root.replaceChildren('OTHER ROUTE');
  pending.resolve(true);
  await settle();
  assert.equal(app.root.textContent, 'OTHER ROUTE');
});
