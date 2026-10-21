'use strict';
// 主进程侧：启动并管理后台业务进程（utilityProcess），提供 call() 远程调用；后台崩溃后自动重启
const { utilityProcess } = require('electron');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'worker', 'core-host.js');

class CoreClient {
  /**
   * @param {{log: Function, onMessage: (msg: object) => void, onReady: () => void}} opts
   *   onMessage：后台主动发来的消息（emit / deliver / chat-event / confirm / mainCall）
   *   onReady：每次（重新）启动、后台发来 hello 时调用，用来下发设置与密钥（后台据此初始化，随后回 ready）
   */
  constructor({ log, onMessage, onReady }) {
    this.log = log;
    this.onMessage = onMessage;
    this.onReady = onReady;
    this.seq = 0;
    this.waiters = new Map();
    this.proc = null;
    this.stopping = false;
    this.restarts = 0;
    this.readyPromise = null;
  }

  start() {
    // 重启期间发起的调用会等到新进程就绪
    if (!this.markReady) this.readyPromise = new Promise((r) => (this.markReady = r));
    const proc = utilityProcess.fork(SCRIPT, [], { serviceName: '小管家后台', stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout?.on('data', (d) => this.log('info', `[后台] ${String(d).trim()}`));
    proc.stderr?.on('data', (d) => this.log('warn', `[后台] ${String(d).trim()}`));
    proc.on('message', (msg) => {
      if (msg?.type === 'hello') {
        this.onReady();
      } else if (msg?.type === 'ready') {
        this.restarts = 0;
        this.markReady?.();
        this.markReady = null;
      } else if (msg?.type === 'result') {
        const w = this.waiters.get(msg.id);
        if (!w) return;
        this.waiters.delete(msg.id);
        clearTimeout(w.timer);
        msg.ok ? w.resolve(msg.value) : w.reject(new Error(msg.error));
      } else if (msg?.type === 'log') {
        this.log(msg.level, `[后台] ${msg.msg}`, msg.details);
      } else this.onMessage(msg);
    });
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const w of this.waiters.values()) {
        clearTimeout(w.timer);
        w.reject(new Error('后台进程已退出'));
      }
      this.waiters.clear();
      if (this.stopping) return;
      this.readyPromise = new Promise((r) => (this.markReady = r));
      const delay = Math.min(30_000, 1000 * 2 ** this.restarts++);
      this.log('error', `后台进程退出（code=${code}），${delay / 1000} 秒后重启`);
      setTimeout(() => !this.stopping && this.start(), delay);
    });
  }

  post(msg) {
    this.proc?.postMessage(msg);
  }

  /** 远程调用后台方法；timeoutMs=0 表示不限时（对话） */
  async call(method, args = [], { timeoutMs = 120_000 } = {}) {
    await this.readyPromise;
    if (!this.proc) throw new Error('后台进程未运行');
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = timeoutMs ? setTimeout(() => (this.waiters.delete(id), reject(new Error(`后台调用超时：${method}`))), timeoutMs) : null;
      this.waiters.set(id, { resolve, reject, timer });
      this.proc.postMessage({ type: 'call', id, method, args });
    });
  }

  async stop(graceMs = 4000) {
    if (!this.proc) return;
    try {
      await Promise.race([this.call('shutdown', [], { timeoutMs: graceMs }), new Promise((r) => setTimeout(r, graceMs))]);
    } catch {
      /* 超时或已退出 */
    }
    this.stopping = true;
    this.proc?.kill();
  }
}

module.exports = { CoreClient };
