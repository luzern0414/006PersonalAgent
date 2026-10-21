'use strict';
const { randomUUID } = require('node:crypto');

// Confirmation promises belong to the renderer that received them. Every exit
// path settles false so an abandoned prompt cannot keep the Agent waiting.
function createChatConfirmations({ maxPending = 64, timeoutMs = 300000 } = {}) {
  const limit = Number.isFinite(maxPending) && maxPending > 0 ? Math.min(1024, Math.floor(maxPending)) : 64;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(86400000, timeoutMs) : 300000;
  const pending = new Map();

  function settle(id, ok) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(!!ok);
    return true;
  }

  return {
    request({ senderId, conversationId = 'main', payload = {}, send } = {}) {
      if (senderId == null || typeof send !== 'function' || pending.size >= limit) return Promise.resolve(false);
      return new Promise((resolve) => {
        const id = randomUUID();
        const entry = { senderId, conversationId, resolve, timer: null };
        pending.set(id, entry);
        entry.timer = setTimeout(() => settle(id, false), timeout);
        entry.timer.unref?.();
        try {
          if (send({ ...payload, id }) === false) settle(id, false);
        } catch {
          settle(id, false);
        }
      });
    },

    answer(senderId, id, ok) {
      const entry = pending.get(id);
      if (!entry || entry.senderId !== senderId) return false;
      return settle(id, ok);
    },

    cancel({ senderId, conversationId } = {}) {
      let cancelled = 0;
      for (const [id, entry] of pending) {
        if (senderId !== undefined && entry.senderId !== senderId) continue;
        if (conversationId !== undefined && entry.conversationId !== conversationId) continue;
        if (settle(id, false)) cancelled++;
      }
      return cancelled;
    },

    get size() { return pending.size; },
  };
}

module.exports = { createChatConfirmations };
