'use strict';
// 按天滚动：普通日志异步串行写入；致命错误可同步落盘。
const fs = require('node:fs');
const path = require('node:path');
const { types } = require('node:util');
const { dateKey } = require('../core/time');

const REDACTED = '[REDACTED]';
const MAX_LINE_BYTES = 16384;
const MAX_DETAILS_BYTES = 12000;
const MAX_SCAN_CHARS = 16384;
const SENSITIVE_FIELD = /^(?:apikey|token|authorization|secret|password|passwd|accesstoken|refreshtoken|authtoken|clientsecret)$/i;
const pad = (n, width = 2) => String(n).padStart(width, '0');
const ERROR_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const DOM_EXCEPTION_GETTERS = typeof DOMException === 'undefined' ? null : {
  name: Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get,
  message: Object.getOwnPropertyDescriptor(DOMException.prototype, 'message')?.get,
};

function bounded(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  // Leave room for a replacement character if the cut crosses a UTF-8 sequence.
  return Buffer.from(text, 'utf8').subarray(0, Math.max(0, limit - 6)).toString('utf8') + '…';
}

function replaceSecrets(text, secrets) {
  let safe = text;
  for (const secret of secrets) {
    safe = safe.split(secret).join(REDACTED);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) safe = safe.split(escaped).join(REDACTED);
  }
  return safe;
}

function redact(text) {
  return text
    .replace(/\bsk-[a-z0-9_-]+/gi, REDACTED)
    .replace(/\blsv2_[a-z0-9_-]+/gi, REDACTED)
    .replace(/\b(api[_ -]?key|authorization|(?:access|refresh|auth)[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic)[ \t]+[^,\r\n;}]+|[^\s,;}]+)/gi, '$1=' + REDACTED)
    .replace(/\bBearer[ \t]+[a-z0-9._~+/=-]+/gi, 'Bearer ' + REDACTED);
}

function safeText(text, limit = 2048) {
  return bounded(redact(text.slice(0, MAX_SCAN_CHARS)), limit);
}

function replaceKnownSecrets(value, secrets) {
  if (typeof value === 'string') return replaceSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => replaceKnownSecrets(item, secrets));
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value)) out[replaceSecrets(key, secrets)] = replaceKnownSecrets(item, secrets);
    return out;
  }
  return value;
}

function propertyDescriptor(value, key) {
  let current = value;
  for (let depth = 0; current && depth < 8; depth++, current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function safeStackProperties(value) {
  // V8 formats lazy stacks by reading name and message from the receiver.
  return ['name', 'message'].every((key) => {
    const descriptor = propertyDescriptor(value, key);
    if (!descriptor) return false;
    if ('value' in descriptor) return descriptor.value === undefined || typeof descriptor.value === 'string';
    return descriptor.get && descriptor.get === DOM_EXCEPTION_GETTERS?.[key];
  });
}

function sanitize(value, state, depth = 0, field = '') {
  if (SENSITIVE_FIELD.test(field.replace(/[_ -]/g, ''))) {
    if (typeof value === 'string' && value.length >= 6 && state.secrets.length < 64) {
      state.secrets.push(value.slice(0, MAX_SCAN_CHARS));
      // Echoes elsewhere may already have been truncated to the string limit.
      if (value.length > 2048) state.secrets.push(value.slice(0, 2048));
    }
    return REDACTED;
  }
  if (state.nodes-- <= 0 || depth > 6) return '[Truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const text = safeText(value, Math.max(0, Math.min(field === 'stack' ? 8192 : 2048, state.bytes)));
    state.bytes = Math.max(0, state.bytes - Buffer.byteLength(text));
    return text;
  }
  if (typeof value !== 'object') return safeText(String(value));
  if (state.seen.has(value)) return '[Circular]';
  state.seen.add(value);
  try {
    if (types.isDate(value)) return Date.prototype.toISOString.call(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const error = types.isNativeError(value);
    const out = Array.isArray(value) ? [] : Object.create(null);
    if (error) {
      if (DOM_EXCEPTION_GETTERS?.name && DOM_EXCEPTION_GETTERS.message) {
        try {
          // These trusted getters enforce the DOMException brand and ignore
          // arbitrary overrides on the instance or its prototype.
          descriptors.name = { value: DOM_EXCEPTION_GETTERS.name.call(value) };
          descriptors.message = { value: DOM_EXCEPTION_GETTERS.message.call(value) };
        } catch {
          // Ordinary native Errors do not carry the DOMException brand.
        }
      }
      const name = descriptors.name || propertyDescriptor(value, 'name');
      out.name = name && !('value' in name) ? '[Getter]' : safeText(typeof name?.value === 'string' ? name.value : 'Error', 128);
    }
    const keys = error
      ? [...new Set(['message', 'stack', 'cause', ...Object.keys(descriptors)])].filter((key) => key !== 'name')
      : Object.keys(descriptors);
    let count = 0;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || (!error && !descriptor.enumerable)) continue;
      if (count++ >= 32 || state.nodes <= 0) {
        if (Array.isArray(out)) out.push('[Truncated]');
        else out._truncated = true;
        break;
      }
      let item = '[Getter]';
      if ('value' in descriptor) item = sanitize(descriptor.value, state, depth + 1, key);
      else if (error && key === 'stack' && ERROR_STACK_GETTER && descriptor.get &&
        Function.prototype.toString.call(descriptor.get).includes('[native code]') && safeStackProperties(value)) {
        // V8 exposes lazy Error.stack as a native accessor in current Node.
        // Use our trusted accessor, since bound custom getters also look native.
        try { item = sanitize(ERROR_STACK_GETTER.call(value), state, depth + 1, key); } catch { item = '[Unavailable]'; }
      }
      if (Array.isArray(out)) out.push(item);
      else out[safeText(key, 128)] = SENSITIVE_FIELD.test(key.replace(/[_ -]/g, '')) ? REDACTED : item;
    }
    return out;
  } catch {
    return '[Unserializable]';
  }
}

function timestamp(now) {
  return `${dateKey(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function record(level, msg, details) {
  const now = new Date();
  const state = { seen: new WeakSet(), nodes: 128, bytes: 8192, secrets: [] };
  const cleanMsg = sanitize(msg, state);
  const cleanDetails = details === undefined ? undefined : sanitize(details, state);
  const cleanLevel = replaceSecrets(safeText(String(level), 32), state.secrets).replace(/[\r\n]/g, ' ');
  const redactedMsg = replaceKnownSecrets(cleanMsg, state.secrets);
  const message = bounded((typeof redactedMsg === 'string' ? redactedMsg : JSON.stringify(redactedMsg) ?? '').replace(/\r/g, '\\r').replace(/\n/g, '\\n'), 8192);
  const head = `${timestamp(now)} [pid=${process.pid}] [${cleanLevel}] ${message}`;
  const detailLimit = Math.min(MAX_DETAILS_BYTES, MAX_LINE_BYTES - Buffer.byteLength(head) - 10);
  let detailText = cleanDetails === undefined ? '' : JSON.stringify(replaceKnownSecrets(cleanDetails, state.secrets));
  if (Buffer.byteLength(detailText) > detailLimit) {
    detailText = JSON.stringify({ truncated: true, preview: bounded(detailText, detailLimit / 2 - 128) });
  }
  const line = `${head}${detailText ? ' details=' + detailText : ''}`;
  return { now, day: dateKey(now), level: cleanLevel, line: bounded(line, MAX_LINE_BYTES - 1) + '\n' };
}

function stderr(line) {
  try {
    process.stderr.write(bounded(line, MAX_LINE_BYTES));
  } catch {
    // Logging must not turn an IO failure into an application failure.
  }
}

function reportFailure(error, line = '') {
  let reason = '日志写入失败';
  try {
    reason += ': ' + safeText(String(error?.message || error), 1024).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  } catch {
    // Even a hostile error getter must not escape the logger.
  }
  stderr(`${timestamp(new Date())} [pid=${process.pid}] [error] ${reason}${line ? ' record=' + line.trimEnd() : ''}\n`);
}

function createLogger(dir, { prefix = '' } = {}) {
  const filePrefix = typeof prefix === 'string' ? prefix.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80) : '';
  const pattern = new RegExp('^' + filePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d{4}-\\d{2}-\\d{2})\\.log$');
  let queue = Promise.resolve();
  let initialized = false;
  let retentionDay = null;

  function expiredFiles(files, now) {
    const cutoff = dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13));
    return files.filter((file) => {
      const match = pattern.exec(file);
      if (!match || match[1] >= cutoff) return false;
      const date = new Date(match[1] + 'T00:00:00');
      return !Number.isNaN(date.getTime()) && dateKey(date) === match[1];
    });
  }

  async function prepare(entry) {
    if (!initialized) {
      await fs.promises.mkdir(dir, { recursive: true });
      initialized = true;
    }
    if (retentionDay === entry.day) return;
    retentionDay = entry.day;
    try {
      for (const file of expiredFiles(await fs.promises.readdir(dir), entry.now)) {
        await fs.promises.rm(path.join(dir, file), { force: true });
      }
    } catch (error) {
      reportFailure(error);
    }
  }

  function makeEntry(level, msg, details) {
    try {
      return record(level, msg, details);
    } catch (error) {
      reportFailure(error);
      return null;
    }
  }

  const log = (level, msg, details) => {
    const entry = makeEntry(level, msg, details);
    if (!entry) return;
    queue = queue.then(async () => {
      await prepare(entry);
      await fs.promises.appendFile(path.join(dir, `${filePrefix}${entry.day}.log`), entry.line, 'utf8');
    }).catch((error) => reportFailure(error, entry.line));
  };

  log.flush = () => queue;
  log.critical = (level, msg, details) => {
    const entry = makeEntry(level, msg, details);
    if (!entry) return;
    let fd;
    try {
      fs.mkdirSync(dir, { recursive: true });
      initialized = true;
      if (retentionDay !== entry.day) {
        retentionDay = entry.day;
        try {
          for (const file of expiredFiles(fs.readdirSync(dir), entry.now)) fs.rmSync(path.join(dir, file), { force: true });
        } catch (error) {
          reportFailure(error);
        }
      }
      // Fatal records are durable before returning; they may overtake queued
      // normal records. Call flush() first when an orderly shutdown permits it.
      fd = fs.openSync(path.join(dir, `${filePrefix}${entry.day}.log`), 'a');
      fs.writeFileSync(fd, entry.line, 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      reportFailure(error, entry.line);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (error) { reportFailure(error); }
      }
    }
  };
  return log;
}

module.exports = { createLogger };
