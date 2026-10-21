'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const storeSource = fs.readFileSync(path.join(__dirname, '../src/core/store.js'), 'utf8');
const servicesSource = fs.readFileSync(path.join(__dirname, '../src/core/services.js'), 'utf8');

function fixture() {
  let now = 0, nextTimer = 0, failure;
  const timers = new Map(), files = new Map(), calls = [], observations = [], active = [];
  const boundary = (stage, args) => {
    calls.push({ stage, args, at: now, active: [...active] });
    if (failure?.stage === stage) throw failure.error;
  };
  const fakeFs = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error('fixture file missing');
      return files.get(file);
    },
    mkdirSync(...args) { boundary('mkdir', args); },
    writeFileSync(file, content) {
      boundary('write', [file, content]);
      files.set(file, content);
    },
    renameSync(from, to) {
      boundary('replace', [from, to]);
      assert.ok(files.has(from), 'the temporary file must exist before replacement');
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  const observeSync = (name, fn) => {
    active.push(name);
    observations.push({ type: 'enter', name, at: now });
    try { return fn(); }
    finally {
      assert.equal(active.pop(), name);
      observations.push({ type: 'exit', name, at: now });
    }
  };
  const context = {
    module: { exports: {} }, structuredClone,
    require: name => name === 'node:fs' ? fakeFs : require(name),
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(storeSource, context, { filename: 'store.js' });
  const advance = ms => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = until;
  };
  return { ...context.module.exports, fakeFs, files, calls, observations, active, timers, observeSync, advance,
    fail(stage, error) { failure = { stage, error }; }, recover() { failure = undefined; } };
}

test('the 300ms debounced write retains diagnostics after its caller returns and preserves atomic ordering', () => {
  const f = fixture(), store = new f.Store('/private-data', { observeSync: f.observeSync });
  const target = store.state.file;
  f.files.set(target, 'old persisted state');
  f.calls.length = 0;
  f.observeSync('api:request', () => store.state.save());
  f.advance(200);
  store.state.data.daily = { updated: true };
  store.state.save();
  f.advance(299);
  assert.equal(f.calls.length, 0, 'a second save must restart the debounce');
  assert.equal(f.active.length, 0, 'the original caller has already returned');
  f.advance(1);
  assert.deepEqual(f.observations.filter(row => row.type === 'enter').map(row => row.name), [
    'api:request', 'store:state:flush', 'store:state:mkdir', 'store:state:serialize', 'store:state:write', 'store:state:replace',
  ]);
  assert.deepEqual(f.calls.map(row => [row.stage, row.at]), [['mkdir', 500], ['write', 500], ['replace', 500]]);
  assert.deepEqual(f.calls.find(row => row.stage === 'write').active, ['store:state:flush', 'store:state:write']);
  assert.equal(f.calls.find(row => row.stage === 'write').args[0], target + '.tmp');
  assert.deepEqual(f.calls.find(row => row.stage === 'replace').args, [target + '.tmp', target]);
  assert.equal(f.files.get(target), JSON.stringify(store.state.data, null, 1));
  assert.equal(f.files.has(target + '.tmp'), false);
  assert.equal(store.state.timer, null);
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.active, []);
});

for (const stage of ['mkdir', 'serialize', 'write', 'replace']) {
  test(`a debounced ${stage} failure preserves the error and releases nested diagnostic context`, () => {
    const f = fixture(), store = new f.Store('/private-data', { observeSync: f.observeSync });
    const error = new Error('injected storage failure');
    const target = store.state.file;
    f.files.set(target, 'old persisted state');
    f.calls.length = 0;
    if (stage === 'serialize') store.state.data.toJSON = () => { throw error; };
    else f.fail(stage, error);
    store.state.save();
    assert.throws(() => f.advance(300), thrown => thrown === error);
    const entries = f.observations.filter(row => row.type === 'enter').map(row => row.name);
    assert.equal(entries[0], 'store:state:flush');
    assert.equal(entries.at(-1), `store:state:${stage}`);
    assert.equal(f.observations.at(-1).name, 'store:state:flush');
    assert.equal(f.observations.at(-1).type, 'exit');
    assert.equal(store.state.timer, null);
    assert.equal(f.timers.size, 0);
    assert.deepEqual(f.active, []);
    assert.equal(f.files.get(target), 'old persisted state');
    if (stage !== 'replace') assert.ok(!f.calls.some(row => row.stage === 'replace'));
    f.recover();
    delete store.state.data.toJSON;
    store.state.save(true);
    assert.equal(f.files.get(target), JSON.stringify(store.state.data, null, 1));
    assert.deepEqual(f.active, []);
  });
}

test('all store collections and message files use fixed labels without private paths or conversation IDs', () => {
  const f = fixture(), store = new f.Store('/secret-directory', { observeSync: f.observeSync });
  const labels = ['tasks', 'events', 'reminders', 'memories', 'outbox', 'conversations', 'state'];
  for (const label of labels) store[label].save(true);
  const messages = store.messagesFile('secret-conversation-id');
  messages.data.messages.push({ content: 'secret-chat-content' });
  messages.save(true);
  new f.JsonFile('/secret-directory/direct.json', {}, { observeSync: f.observeSync, label: 'secret-conversation-id' }).flush();
  const flushLabels = f.observations.filter(row => row.type === 'enter' && row.name.endsWith(':flush')).map(row => row.name);
  assert.deepEqual(flushLabels, [...labels, 'messages', 'json'].map(label => `store:${label}:flush`));
  assert.doesNotMatch(JSON.stringify(f.observations), /secret-directory|secret-conversation-id|secret-chat-content/);
});

test('Core passes its optional observer to delayed store writes without creating real external clients', () => {
  const f = fixture();
  const inert = class {};
  const imports = {
    'node:fs': f.fakeFs, 'node:path': path, './store': { Store: f.Store },
    './kb/kb': { KnowledgeBase: inert }, './kb/ocr': { OCR: inert }, './llm': { LLM: inert },
    './credentials': {}, './weather': {}, './messenger': {}, './time': {}, './paths': { CONFIG_DIR: '/fixture' },
  };
  const context = { module: { exports: {} }, console, require: name => {
    assert.ok(Object.hasOwn(imports, name), 'unexpected Core dependency: ' + name);
    return imports[name];
  } };
  vm.runInNewContext(servicesSource, context, { filename: 'services.js' });
  const core = new context.module.exports.Core({ paths: () => ({ dataDir: '/fixture' }) }, { observeSync: f.observeSync });
  core.store.state.save();
  f.advance(300);
  assert.ok(f.calls.find(row => row.stage === 'write').active.includes('store:state:write'));
  assert.deepEqual(f.active, []);
});

test('existing constructors and immediate/manual/flushAll writes retain their synchronous behavior without an observer', () => {
  const f = fixture(), store = new f.Store('/fixture');
  f.calls.length = 0;
  store.state.save();
  store.tasks.add({ title: 'fixture task' });
  assert.equal(f.timers.size, 2);
  assert.equal(store.state.save(true), undefined);
  assert.equal(f.timers.size, 1);
  store.flushAll();
  assert.equal(f.timers.size, 0);
  assert.equal(f.files.get(store.tasks.file), JSON.stringify(store.tasks.data, null, 1));
  const collection = new f.Collection('/fixture/custom.json');
  collection.flush();
  const json = new f.JsonFile('/fixture/custom-state.json', { ok: true });
  assert.equal(json.flush(), undefined);
  assert.equal(f.files.get(json.file), JSON.stringify({ ok: true }, null, 1));
  assert.equal(f.calls.filter(row => row.stage === 'write').length, 4);
  assert.deepEqual(f.observations, []);
});
