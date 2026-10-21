'use strict';
// 端到端验证：用真实 Agent（真实工具、真实模型）跑一轮对话，然后从 LangSmith 拉回 trace 树
// 用法：node scripts/verify-langsmith.js ["自定义问题"]
// 使用独立的临时数据目录，不污染你的真实数据
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Settings } = require('../src/core/settings');
const { Core } = require('../src/core/services');
const { Agent } = require('../src/core/agent');
const { Client } = require('langsmith');

(async () => {
  const settings = new Settings();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-verify-'));
  // 只在内存中改路径，不写回 settings.json
  settings.data = { ...settings.get(), paths: { dataDir: tmp, knowledgeDir: path.join(tmp, 'kb'), docsDir: path.join(tmp, 'notes') } };
  const core = new Core(settings, { log: () => {} });
  const creds = core.llm.getCreds();
  if (!creds.langsmith.apiKey) throw new Error('没有 LangSmith Key（apikey 文件中 lsv2_ 开头的一行）');
  console.log(`模型：${creds.model}  LangSmith 项目：${creds.langsmith.project}`);

  // 准备一点知识库数据，让链路覆盖检索工具
  await core.kb.ingest({ title: '报销制度', text: '# 报销制度\n\n差旅报销需在出差结束后 7 个工作日内提交，超过 30 天不予受理。发票抬头为公司全称。' });

  const question =
    process.argv[2] ||
    '帮我加一个今天的任务"整理接口文档"，再查一下知识库里报销要在几天内提交，最后告诉我今天一共有几个任务。';
  console.log(`\n> ${question}\n`);
  const agent = new Agent(core);
  const out = await agent.run(
    { text: question },
    {
      onEvent: (e) => {
        if (e.type === 'delta') process.stdout.write(e.text);
        if (e.type === 'tool_start') console.log(`\n  [工具] ${e.name} ${JSON.stringify(e.args)}`);
      },
      confirm: async () => true,
    }
  );
  console.log(`\n\nrun id：${out.runId}`);
  await core.llm.flush();

  // 从 LangSmith 回读 trace 树
  const client = new Client({ apiUrl: creds.langsmith.endpoint, apiKey: creds.langsmith.apiKey });
  // LangSmith 异步入库：轮询直到节点数连续两次不变
  let runs = [];
  let prev = -1;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    runs = [];
    for await (const r of client.listRuns({ projectName: creds.langsmith.project, traceId: out.runId })) runs.push(r);
    if (runs.length && runs.length === prev) break;
    prev = runs.length;
  }
  if (!runs.length) throw new Error('LangSmith 中未查到该 trace');
  runs.sort((a, b) => (a.dotted_order || "").localeCompare(b.dotted_order || ""));
  const byId = new Map(runs.map((r) => [r.id, r]));
  const depth = (r) => (r.parent_run_id && byId.has(r.parent_run_id) ? depth(byId.get(r.parent_run_id)) + 1 : 0);
  console.log(`\nLangSmith trace（${runs.length} 个节点）：`);
  for (const r of runs) {
    const ms = r.end_time ? new Date(r.end_time) - new Date(r.start_time) : '-';
    const tok = r.total_tokens ? ` tokens=${r.total_tokens}` : '';
    console.log(`${'  '.repeat(depth(r))}- [${r.run_type}] ${r.name}  ${ms}ms${tok}${r.error ? ' ERROR ' + r.error : ''}`);
  }
  const root = runs.find((r) => !r.parent_run_id);
  if (root?.app_path) console.log(`\n查看：${creds.langsmith.endpoint.replace('api.', '')}${root.app_path}`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error('\n验证失败：', e.message);
  process.exit(1);
});
