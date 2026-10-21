'use strict';
// LLM 网关：OpenAI 兼容接口 + LangSmith 全链路追踪（chain → llm → tool）
// openai / langsmith 均为懒加载，未使用对话时不占内存
let OpenAI, lsTraceable, lsWrappers, LsClient;

function lazy() {
  if (!OpenAI) {
    const m = require('openai');
    OpenAI = m.default || m.OpenAI || m;
    lsTraceable = require('langsmith/traceable');
    lsWrappers = require('langsmith/wrappers');
    LsClient = require('langsmith').Client;
  }
}

class LLM {
  constructor(getCreds) {
    this.getCreds = getCreds; // () => resolveCredentials(settings)
    this.cacheKey = '';
  }

  /** 凭据变化时重建客户端 */
  _ensure() {
    lazy();
    const c = this.getCreds();
    const key = JSON.stringify([c.baseUrl, c.apiKey, c.langsmith]);
    if (key === this.cacheKey) return this.state;
    this.cacheKey = key;
    const raw = new OpenAI({ apiKey: c.apiKey || 'missing', baseURL: c.baseUrl || undefined, timeout: 90_000, maxRetries: 1 });
    const ls = c.langsmith;
    const tracing = !!(ls.enabled && ls.apiKey);
    if (tracing) {
      // 部分代码路径读环境变量，这里同步设置
      process.env.LANGSMITH_TRACING = 'true';
      process.env.LANGSMITH_API_KEY = ls.apiKey;
      process.env.LANGSMITH_ENDPOINT = ls.endpoint;
      process.env.LANGSMITH_PROJECT = ls.project;
    } else {
      process.env.LANGSMITH_TRACING = 'false';
    }
    const lsClient = tracing ? new LsClient({ apiUrl: ls.endpoint, apiKey: ls.apiKey }) : null;
    const client = tracing ? lsWrappers.wrapOpenAI(raw, { client: lsClient, project_name: ls.project }) : raw;
    this.state = { raw, client, lsClient, tracing, creds: c };
    return this.state;
  }

  get configured() {
    const c = this.getCreds();
    return !!(c.baseUrl && c.apiKey && c.model);
  }

  /**
   * 包装成 LangSmith 可追踪函数。追踪关闭时原样返回。
   * @param {Function} fn  async 函数
   * @param {{name:string, run_type?:string, metadata?:object, tags?:string[]}} opts
   */
  traceable(fn, opts) {
    const s = this._ensure();
    if (!s.tracing) return fn;
    return lsTraceable.traceable(fn, { ...opts, client: s.lsClient, project_name: s.creds.langsmith.project });
  }

  /** 当前 LangSmith run（用于把 run id 回传给界面） */
  currentRun() {
    try {
      return lsTraceable.getCurrentRunTree(true) || null;
    } catch {
      return null;
    }
  }

  /**
   * 流式对话，支持工具调用。onDelta(text) 实时回调。
   * 返回 { content, toolCalls: [{id, name, arguments}], usage }
   */
  async chatStream({ messages, tools, model, temperature, onDelta, signal }) {
    const s = this._ensure();
    const m = model || s.creds.model;
    const body = { model: m, messages, tools: tools && tools.length ? tools : undefined, temperature };
    // 流式调用显式作为 llm 节点追踪：流读完、函数返回即结束该节点，不依赖包装器的异步收尾
    const call = this.traceable((input) => this._stream(s.raw, input, onDelta, signal), {
      name: 'ChatOpenAI',
      run_type: 'llm',
      metadata: { ls_provider: 'openai', ls_model_name: m, ls_temperature: temperature },
      processOutputs: (r) => ({
        choices: [{ message: { role: 'assistant', content: r.content, tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } }],
        usage_metadata: r.usage ? { input_tokens: r.usage.prompt_tokens, output_tokens: r.usage.completion_tokens, total_tokens: r.usage.total_tokens } : undefined,
      }),
    });
    return call(body);
  }

  async _stream(client, body, onDelta, signal) {
    let stream;
    try {
      stream = await client.chat.completions.create({ ...body, stream: true, stream_options: { include_usage: true } }, { signal });
    } catch (e) {
      if (e?.status !== 400) throw e;
      stream = await client.chat.completions.create({ ...body, stream: true }, { signal }); // 网关不支持 stream_options
    }
    let content = '';
    const calls = [];
    let usage = null;
    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] ||= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    }
    return { content, toolCalls: calls.filter(Boolean), usage };
  }

  /** 非流式简单补全（摘要、日报、标签等） */
  async complete({ messages, model, temperature = 0.3 }) {
    const s = this._ensure();
    const r = await s.client.chat.completions.create({ model: model || s.creds.fastModel || s.creds.model, messages, temperature });
    return r.choices?.[0]?.message?.content || '';
  }

  /** 多模态识别：图片（Buffer）+ 提示词 → 文本 */
  async vision({ image, mime, prompt, model }) {
    const s = this._ensure();
    const r = await s.client.chat.completions.create({
      model: model || s.creds.visionModel || s.creds.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
          ],
        },
      ],
    });
    return r.choices?.[0]?.message?.content || '';
  }

  async embed(texts) {
    const s = this._ensure();
    const model = s.creds.embeddingModel;
    if (!model) return null;
    const r = await s.raw.embeddings.create({ model, input: texts });
    return r.data.map((d) => d.embedding);
  }

  async listModels() {
    const s = this._ensure();
    const r = await s.raw.models.list();
    const ids = [];
    for await (const m of r) ids.push(m.id);
    return ids.sort();
  }

  /** 进程退出前把未上传的 trace 发出去 */
  async flush() {
    try {
      await this.state?.lsClient?.awaitPendingTraceBatches();
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { LLM };
