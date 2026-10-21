'use strict';
// 轻量 JSON 存储：内存常驻 + 防抖原子写入（先写 .tmp 再 rename），无原生依赖
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const observeDirect = (_name, fn) => fn();
const diagnosticLabels = new Set(['json', 'tasks', 'events', 'reminders', 'memories', 'outbox', 'conversations', 'state', 'messages']);

class JsonFile {
  constructor(file, defaults, { observeSync = observeDirect, label = 'json' } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.observeSync = observeSync;
    // Fixed collection names only; paths, IDs and stored content never become diagnostic labels.
    this.diagnosticLabel = `store:${diagnosticLabels.has(label) ? label : 'json'}`;
    this.timer = null;
    this.data = this._load();
  }
  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return structuredClone(this.defaults);
    }
  }
  save(immediate = false) {
    clearTimeout(this.timer);
    if (immediate) return this.flush();
    this.timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    // The debounce runs after its original API/scheduler callback has returned.
    return this.observeSync(`${this.diagnosticLabel}:flush`, () => {
      this.observeSync(`${this.diagnosticLabel}:mkdir`, () => fs.mkdirSync(path.dirname(this.file), { recursive: true }));
      const tmp = this.file + '.tmp';
      const serialized = this.observeSync(`${this.diagnosticLabel}:serialize`, () => JSON.stringify(this.data, null, 1));
      this.observeSync(`${this.diagnosticLabel}:write`, () => fs.writeFileSync(tmp, serialized));
      this.observeSync(`${this.diagnosticLabel}:replace`, () => fs.renameSync(tmp, this.file));
    });
  }
}

/** 记录集合：tasks / events / reminders ... */
class Collection extends JsonFile {
  constructor(file, options) {
    super(file, { items: [] }, options);
  }
  get items() {
    return this.data.items;
  }
  list(filter) {
    return filter ? this.items.filter(filter) : [...this.items];
  }
  get(id) {
    return this.items.find((x) => x.id === id) || null;
  }
  add(obj) {
    const now = new Date().toISOString();
    const item = { id: newId(), createdAt: now, updatedAt: now, ...obj };
    this.items.push(item);
    this.save();
    return item;
  }
  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    Object.assign(item, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return item;
  }
  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.save();
    return true;
  }
}

/** 数据库：每个集合一个文件，位于 <dataDir>/db */
class Store {
  constructor(dataDir, { observeSync = observeDirect } = {}) {
    this.dir = path.join(dataDir, 'db');
    this.observeSync = observeSync;
    fs.mkdirSync(this.dir, { recursive: true });
    this.tasks = new Collection(path.join(this.dir, 'tasks.json'), { observeSync, label: 'tasks' });
    this.events = new Collection(path.join(this.dir, 'events.json'), { observeSync, label: 'events' });
    this.reminders = new Collection(path.join(this.dir, 'reminders.json'), { observeSync, label: 'reminders' });
    this.memories = new Collection(path.join(this.dir, 'memories.json'), { observeSync, label: 'memories' });
    this.outbox = new Collection(path.join(this.dir, 'outbox.json'), { observeSync, label: 'outbox' });
    this.conversations = new Collection(path.join(this.dir, 'conversations.json'), { observeSync, label: 'conversations' });
    this.state = new JsonFile(path.join(this.dir, 'state.json'), { daily: {}, scheduler: {} }, { observeSync, label: 'state' });
  }
  /** 当日统计（喝水、起立、专注…），按日期分桶，只保留 60 天 */
  daily(dateKey) {
    const d = this.state.data.daily;
    if (!d[dateKey]) {
      d[dateKey] = { water: 0, stand: 0, focus: 0, eyes: 0 };
      const keys = Object.keys(d).sort();
      while (keys.length > 60) delete d[keys.shift()];
    }
    return d[dateKey];
  }
  /** 对话记录：每个会话一个文件，首次读取后常驻内存（避免每次对话都重新读盘解析） */
  messagesFile(convId) {
    this.msgFiles ||= new Map();
    if (!this.msgFiles.has(convId)) {
      this.msgFiles.set(convId, new JsonFile(path.join(this.dir, 'conversations', `${convId}.json`), { messages: [] }, { observeSync: this.observeSync, label: 'messages' }));
    }
    return this.msgFiles.get(convId);
  }
  flushAll() {
    for (const k of ['tasks', 'events', 'reminders', 'memories', 'outbox', 'conversations', 'state']) {
      if (this[k].timer) this[k].flush();
    }
    for (const f of this.msgFiles?.values() || []) if (f.timer) f.flush();
  }
}

module.exports = { Store, JsonFile, Collection, newId };
