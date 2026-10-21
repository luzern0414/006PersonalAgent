'use strict';
// Agent：多轮 Tool-use 循环。LangSmith 链路结构：
//   PersonalAgent (chain)
//     ├─ ChatOpenAI (llm)          ← wrapOpenAI 自动记录
//     ├─ <tool_name> (tool)        ← 每次工具调用
//     └─ ChatOpenAI (llm) ...
const fs = require('node:fs');
const path = require('node:path');
const { buildTools } = require('./tools');
const { CONFIG_DIR } = require('./paths');

const MAX_RESULT_CHARS = 6000;

class Agent {
  /** @param {import('./services').Core} core */
  constructor(core) {
    this.core = core;
    this.tools = buildTools(core);
    this.active = new Map(); // convId → AbortController
  }

  systemPrompt() {
    const s = this.core.s;
    let tpl;
    try {
      tpl = fs.readFileSync(path.join(CONFIG_DIR, 'prompts', 'system.md'), 'utf8');
    } catch {
      tpl = '你是用户的桌面工作助理。\n\n{{today_snapshot}}';
    }
    const vars = {
      'app.name': '小管家',
      'user.nickname': s.user.nickname,
      today_snapshot: this.core.todayText(),
      memories: this.core.memoriesText(),
    };
    return tpl.replace(/\{\{([\w.]+)\}\}/g, (_, k) => vars[k] ?? '');
  }

  /** 只有一个连续的对话（id 固定为 main），历史全部保留 */
  conversation(id = 'main') {
    const store = this.core.store;
    return store.conversations.get(id) || store.conversations.add({ id, title: '对话' });
  }

  /** 取最近 N 轮历史（仅 user/assistant 文本，节省 token） */
  history(convId) {
    const file = this.core.store.messagesFile(convId);
    const turns = this.core.s.llm.historyTurns * 2;
    return { file, recent: file.data.messages.filter((m) => m.role === 'user' || m.role === 'assistant').slice(-turns) };
  }

  stop(convId) {
    this.active.get(convId)?.abort();
  }

  /**
   * @param {{conversationId?:string, text:string}} input
   * @param {{onEvent:(e:object)=>void, confirm:(c:{tool:string,args:object,preview:string})=>Promise<boolean>}} hooks
   */
  async run({ conversationId, text }, hooks) {
    const core = this.core;
    if (!core.llm.configured) throw new Error('模型未配置：请在「设置 → 模型」中填写 API 地址、Key 与模型名');
    const conv = this.conversation(conversationId);
    const { file, recent } = this.history(conv.id);
    const ac = new AbortController();
    this.active.set(conv.id, ac);
    const s = core.s.llm;

    const userMsg = { role: 'user', content: text, at: new Date().toISOString() };
    file.data.messages.push(userMsg);

    const runTool = (name) =>
      core.llm.traceable(async (args) => this.tools.map.get(name).run(args), { name, run_type: 'tool' });

    const loop = async (input) => {
      const messages = [
        { role: 'system', content: this.systemPrompt() },
        ...recent.map(({ role, content }) => ({ role, content })),
        { role: 'user', content: input.text },
      ];
      const steps = [];
      let finalText = '';
      for (let step = 0; step < s.maxSteps; step++) {
        ac.signal.throwIfAborted();
        hooks.onEvent({ type: 'thinking', step });
        const r = await core.llm.chatStream({
          messages,
          tools: this.tools.schemas,
          temperature: s.temperature,
          signal: ac.signal,
          onDelta: (d) => hooks.onEvent({ type: 'delta', text: d }),
        });
        ac.signal.throwIfAborted();
        finalText += r.content;
        if (!r.toolCalls.length) break;
        messages.push({
          role: 'assistant',
          content: r.content || null,
          tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
        });
        for (const call of r.toolCalls) {
          ac.signal.throwIfAborted();
          const tool = this.tools.map.get(call.name);
          let args = {};
          let result;
          try {
            args = JSON.parse(call.arguments || '{}');
          } catch {
            /* 模型给了非法 JSON */
          }
          hooks.onEvent({ type: 'tool_start', id: call.id, name: call.name, args });
          ac.signal.throwIfAborted();
          try {
            if (!tool) throw new Error(`未知工具 ${call.name}`);
            if (tool.confirm) {
              const ok = await hooks.confirm({ tool: call.name, args, preview: tool.confirm(args) });
              ac.signal.throwIfAborted();
              if (!ok) {
                result = { cancelled: true, message: '用户取消了该操作' };
                hooks.onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: false, result });
                messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
                continue;
              }
            }
            ac.signal.throwIfAborted();
            result = await runTool(call.name)(args);
            hooks.onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: true, result });
          } catch (e) {
            // An aborted run must escape this recovery path; ordinary tool/confirmation errors can recover.
            ac.signal.throwIfAborted();
            result = { error: e.message };
            hooks.onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: false, result });
          }
          ac.signal.throwIfAborted();
          steps.push({ name: call.name, args, ok: !result?.error });
          let content = JSON.stringify(result ?? null);
          if (content.length > MAX_RESULT_CHARS) content = content.slice(0, MAX_RESULT_CHARS) + '…(已截断)';
          messages.push({ role: 'tool', tool_call_id: call.id, content });
        }
        ac.signal.throwIfAborted();
        if (finalText && !finalText.endsWith('\n')) {
          finalText += '\n\n';
          hooks.onEvent({ type: 'delta', text: '\n\n' });
        }
      }
      const run = core.llm.currentRun();
      return { text: finalText.trim(), steps, runId: run?.id || run?.trace_id || '' };
    };

    try {
      const traced = core.llm.traceable(loop, {
        name: 'PersonalAgent',
        run_type: 'chain',
        tags: ['desktop-agent'],
        metadata: { conversation_id: conv.id, model: core.llm.getCreds().model },
      });
      const out = await traced({ text, conversation_id: conv.id });
      ac.signal.throwIfAborted();
      file.data.messages.push({ role: 'assistant', content: out.text, steps: out.steps, runId: out.runId, at: new Date().toISOString() });
      file.save();
      core.store.conversations.update(conv.id, {});
      hooks.onEvent({ type: 'done', conversationId: conv.id, ...out });
      return { conversationId: conv.id, ...out };
    } catch (e) {
      const msg = ac.signal.aborted ? '已停止' : e.message;
      // 失败/停止也留一条回复，避免历史里出现「只有提问、没有回答」
      file.data.messages.push({ role: 'assistant', content: `（${ac.signal.aborted ? '已停止' : `没有完成：${msg}`}）`, error: true, at: new Date().toISOString() });
      file.save();
      hooks.onEvent({ type: 'error', conversationId: conv.id, message: msg });
      throw e;
    } finally {
      this.active.delete(conv.id);
      core.llm.flush(); // 后台上传 trace，不阻塞
    }
  }
}

module.exports = { Agent };
