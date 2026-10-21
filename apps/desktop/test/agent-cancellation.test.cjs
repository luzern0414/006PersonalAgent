const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/core/agent');
const { buildTools } = require('../src/core/tools');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(tools, chatStream) {
  const events = [];
  const counts = { models: 0, saves: 0, flushes: 0 };
  const file = { data: { messages: [] }, save: () => counts.saves++ };
  const conv = { id: 'main' };
  const core = {
    s: { user: { nickname: 'test' }, llm: { maxSteps: 3, historyTurns: 10, temperature: 0 } },
    todayText: () => '', memoriesText: () => '',
    store: { conversations: { get: () => conv, update: () => {} }, messagesFile: () => file },
    llm: {
      configured: true, traceable: (fn) => fn, getCreds: () => ({ model: 'mock-boundary' }), currentRun: () => null, flush: () => counts.flushes++,
      chatStream: (...args) => { counts.models++; return chatStream(counts.models, ...args); },
    },
  };
  const agent = new Agent(core);
  agent.tools = { map: new Map(tools.map((tool) => [tool.name, tool])), schemas: [] };
  const run = (confirm) => agent.run({ conversationId: 'main', text: 'test request' }, { confirm, onEvent: (event) => events.push(event) });
  return { agent, run, events, counts, file };
}

const call = (name) => ({ id: 'call-' + name, name, arguments: '{}' });
const response = (...names) => ({ content: '', toolCalls: names.map(call) });
const outcome = (promise) => promise.then((result) => ({ result }), (error) => ({ error }));

function assertStopped(app, result) {
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(app.agent.active.size, 0);
  assert.equal(app.events.filter((event) => event.type === 'done').length, 0);
  assert.equal(app.events.filter((event) => event.type === 'error' && event.message === '已停止').length, 1);
  assert.deepEqual(app.file.data.messages.map((message) => message.role), ['user']);
  assert.equal(app.counts.saves, 1);
  assert.equal(app.counts.flushes, 1);
}

for (const approved of [false, true]) {
  test('Stop during confirmation prevents the current and later tools even if confirmation resolves ' + approved, async () => {
    const waiting = deferred();
    const entered = deferred();
    let confirmedEffects = 0;
    let laterEffects = 0;
    const app = fixture([
      { name: 'confirmed', confirm: () => 'preview', run: () => ++confirmedEffects },
      { name: 'later_mutation', run: () => ++laterEffects },
    ], async (index) => index === 1 ? response('confirmed', 'later_mutation') : { content: 'finished', toolCalls: [] });
    const running = outcome(app.run(() => { entered.resolve(); return waiting.promise; }));
    await entered.promise;
    app.agent.stop('main');
    waiting.resolve(approved);
    const result = await running;
    assert.equal(confirmedEffects, 0);
    assert.equal(laterEffects, 0);
    assert.equal(app.events.filter((event) => event.type === 'tool_start' && event.name === 'later_mutation').length, 0);
    assert.equal(app.counts.models, 1);
    assertStopped(app, result);
  });
}

test('Stop after the first awaited tool prevents another mutation in the same batch and another model step', async () => {
  let firstEffects = 0;
  let laterEffects = 0;
  const app = fixture([
    { name: 'first', run: async () => { firstEffects++; app.agent.stop('main'); return { completed: true }; } },
    { name: 'later_mutation', run: () => ++laterEffects },
  ], async (index) => index === 1 ? response('first', 'later_mutation') : { content: 'finished', toolCalls: [] });
  const result = await outcome(app.run(async () => true));
  assert.equal(firstEffects, 1);
  assert.equal(laterEffects, 0);
  assert.equal(app.counts.models, 1);
  assertStopped(app, result);
});

test('Stop while awaiting a model response preserves cancellation even if the boundary returns final text', async () => {
  const waiting = deferred();
  const entered = deferred();
  const app = fixture([], () => { entered.resolve(); return waiting.promise; });
  const running = outcome(app.run(async () => true));
  await entered.promise;
  app.agent.stop('main');
  waiting.resolve({ content: 'late final text', toolCalls: [] });
  assertStopped(app, await running);
});

test('declining just one confirmation without Stop still allows the remaining authorized tool', async () => {
  let declinedEffects = 0;
  let laterEffects = 0;
  const app = fixture([
    { name: 'confirmed', confirm: () => 'preview', run: () => ++declinedEffects },
    { name: 'later_mutation', run: () => ++laterEffects },
  ], async (index) => index === 1 ? response('confirmed', 'later_mutation') : { content: 'finished', toolCalls: [] });
  const result = await app.run(async () => false);
  assert.equal(declinedEffects, 0);
  assert.equal(laterEffects, 1);
  assert.equal(result.text, 'finished');
  assert.equal(app.agent.active.size, 0);
});

test('a real delete_task preview error from null arguments remains recoverable by the model', async () => {
  let deleteEffects = 0;
  let laterEffects = 0;
  let confirmations = 0;
  const deleteTool = buildTools({ removeTask: () => ++deleteEffects }).map.get('delete_task');
  const app = fixture([
    deleteTool,
    { name: 'later_mutation', run: () => ++laterEffects },
  ], async (index) => index === 1
    ? { content: '', toolCalls: [{ ...call('delete_task'), arguments: 'null' }, call('later_mutation')] }
    : { content: 'finished', toolCalls: [] });
  const result = await app.run(async () => { confirmations++; return true; });
  assert.equal(deleteEffects, 0);
  assert.equal(confirmations, 0);
  assert.equal(laterEffects, 1);
  assert.equal(result.text, 'finished');
  assert.equal(result.steps[0].ok, false);
  const failure = app.events.find((event) => event.type === 'tool_end' && event.name === 'delete_task');
  assert.equal(failure.ok, false);
  assert.match(failure.result.error, /null/);
  assert.equal(app.counts.models, 2);
  assert.equal(app.events.filter((event) => event.type === 'error').length, 0);
  assert.equal(app.agent.active.size, 0);
});

test('a rejected confirmation hook remains a tool error and allows model recovery', async () => {
  let confirmedEffects = 0;
  let laterEffects = 0;
  const app = fixture([
    { name: 'confirmed', confirm: () => 'preview', run: () => ++confirmedEffects },
    { name: 'later_mutation', run: () => ++laterEffects },
  ], async (index) => index === 1 ? response('confirmed', 'later_mutation') : { content: 'finished', toolCalls: [] });
  const result = await app.run(async () => { throw new Error('confirmation unavailable'); });
  assert.equal(confirmedEffects, 0);
  assert.equal(laterEffects, 1);
  assert.equal(result.text, 'finished');
  assert.equal(result.steps[0].ok, false);
  const failure = app.events.find((event) => event.type === 'tool_end' && event.name === 'confirmed');
  assert.equal(failure.ok, false);
  assert.equal(failure.result.error, 'confirmation unavailable');
  assert.equal(app.counts.models, 2);
  assert.equal(app.events.filter((event) => event.type === 'error').length, 0);
  assert.equal(app.agent.active.size, 0);
});

test('a rejected confirmation after Stop propagates the signal AbortError and performs no later tools', async () => {
  const waiting = deferred();
  const entered = deferred();
  let effects = 0;
  const app = fixture([
    { name: 'confirmed', confirm: () => 'preview', run: () => ++effects },
    { name: 'later_mutation', run: () => ++effects },
  ], async (index) => index === 1 ? response('confirmed', 'later_mutation') : { content: 'finished', toolCalls: [] });
  const running = outcome(app.run(() => { entered.resolve(); return waiting.promise; }));
  await entered.promise;
  app.agent.stop('main');
  waiting.reject(new Error('renderer disconnected'));
  assertStopped(app, await running);
  assert.equal(effects, 0);
  assert.equal(app.counts.models, 1);
});
