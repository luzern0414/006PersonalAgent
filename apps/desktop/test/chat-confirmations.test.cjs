const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatConfirmations } = require('../src/main/chat-confirmations');

function fixture(t, options) {
  const registry = createChatConfirmations(options);
  t.after(() => registry.cancel());
  const delivered = [];
  const request = (senderId, conversationId = 'main', send = (payload) => delivered.push(payload)) => registry.request({
    senderId, conversationId, payload: { type: 'confirm', preview: 'send message', id: 'untrusted-payload-id' }, send,
  });
  return { registry, delivered, request };
}

test('owner answers resolve their request once and preserve payload with a unique registry ID', async (t) => {
  const { registry, delivered, request } = fixture(t);
  const first = request(101), second = request(101);
  assert.equal(registry.size, 2);
  assert.equal(delivered[0].type, 'confirm');
  assert.equal(delivered[0].preview, 'send message');
  assert.notEqual(delivered[0].id, 'untrusted-payload-id');
  assert.notEqual(delivered[0].id, delivered[1].id);
  assert.equal(registry.answer(101, delivered[0].id, true), true);
  assert.equal(await first, true);
  assert.equal(registry.answer(101, delivered[0].id, false), false);
  assert.equal(registry.answer(101, delivered[1].id, false), true);
  assert.equal(await second, false);
  assert.equal(registry.size, 0);
});

test('a different sender cannot answer or remove another renderer confirmation', async (t) => {
  const { registry, delivered, request } = fixture(t);
  const confirmation = request(101);
  assert.equal(registry.answer(202, delivered[0].id, true), false);
  assert.equal(registry.answer('101', delivered[0].id, true), false);
  assert.equal(registry.answer(101, 'unknown-id', true), false);
  assert.equal(registry.size, 1);
  registry.cancel({ senderId: 101 });
  assert.equal(await confirmation, false);
});

test('renderer crash cancellation resolves every sender-owned promise and preserves other senders', async (t) => {
  const { registry, delivered, request } = fixture(t);
  const first = request(101, 'main'), second = request(101, 'other'), unaffected = request(202, 'main');
  assert.equal(registry.cancel({ senderId: 101 }), 2);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(registry.size, 1);
  assert.equal(registry.answer(101, delivered[0].id, true), false);
  registry.answer(202, delivered[2].id, true);
  assert.equal(await unaffected, true);
});

test('Stop cancellation resolves every pending confirmation for only that conversation', async (t) => {
  const { registry, delivered, request } = fixture(t);
  const first = request(101), second = request(202), other = request(101, 'other');
  assert.equal(registry.cancel({ conversationId: 'main' }), 2);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(registry.size, 1);
  registry.answer(101, delivered[2].id, false);
  assert.equal(await other, false);
});

test('combined cancellation filters intersect and unfiltered cancellation clears everything idempotently', async (t) => {
  const { registry, request } = fixture(t);
  const selected = request(101), otherConversation = request(101, 'other'), otherSender = request(202);
  assert.equal(registry.cancel({ senderId: 101, conversationId: 'main' }), 1);
  assert.equal(await selected, false);
  assert.equal(registry.size, 2);
  assert.equal(registry.cancel(), 2);
  assert.deepEqual(await Promise.all([otherConversation, otherSender]), [false, false]);
  assert.equal(registry.cancel(), 0);
});

test('failed or throwing delivery resolves false immediately without leaked entries', async (t) => {
  const { registry, request } = fixture(t);
  assert.equal(await request(101, 'main', () => false), false);
  assert.equal(registry.size, 0);
  assert.equal(await request(101, 'main', () => { throw new Error('webContents destroyed'); }), false);
  assert.equal(registry.size, 0);
  assert.equal(registry.cancel(), 0);
});

test('capacity is bounded without evicting existing user confirmations, and released capacity is reusable', async (t) => {
  const { registry, delivered, request } = fixture(t, { maxPending: 2 });
  const first = request(101), second = request(101);
  assert.equal(await request(101), false);
  assert.equal(registry.size, 2);
  assert.equal(delivered.length, 2);
  registry.answer(101, delivered[0].id, false);
  assert.equal(await first, false);
  const replacement = request(202);
  assert.equal(delivered.length, 3);
  assert.equal(registry.size, 2);
  registry.cancel();
  assert.deepEqual(await Promise.all([second, replacement]), [false, false]);
});

test('orphaned confirmation timeout settles false and removes the pending entry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { registry, request } = fixture(t, { timeoutMs: 100 });
  const confirmation = request(101);
  t.mock.timers.tick(99);
  assert.equal(registry.size, 1);
  t.mock.timers.tick(1);
  assert.equal(await confirmation, false);
  assert.equal(registry.size, 0);
});

test('delivery may synchronously answer because ownership is registered before sending', async (t) => {
  const { registry, request } = fixture(t);
  const confirmation = request(101, 'main', ({ id }) => { registry.answer(101, id, true); });
  assert.equal(await confirmation, true);
  assert.equal(registry.size, 0);
});
