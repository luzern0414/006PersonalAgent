'use strict';
// 列出 apikey 文件中模型网关可用的模型：node scripts/list-models.js
const { Settings } = require('../src/core/settings');
const { resolveCredentials, mask } = require('../src/core/credentials');
const { LLM } = require('../src/core/llm');

(async () => {
  const settings = new Settings();
  const c = resolveCredentials(settings.get());
  console.log(`apikey 文件：${c.keyFile.path}（${c.keyFile.ok ? '已读取' : '读取失败 ' + c.keyFile.error}）`);
  console.log(`地址：${c.baseUrl || '(空)'}  Key：${mask(c.apiKey)}  LangSmith Key：${mask(c.langsmith.apiKey) || '(无)'}`);
  const llm = new LLM(() => ({ ...c, langsmith: { ...c.langsmith, enabled: false } }));
  const ids = await llm.listModels();
  console.log(`共 ${ids.length} 个模型：\n` + ids.join('\n'));
})().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
