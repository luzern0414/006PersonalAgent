'use strict';
// 读取 apikey 文件 + 设置里的覆盖值，得到最终的模型与 LangSmith 凭据
// apikey 文件两种写法：
//   纯文本：第一行地址；第二行 Key；lsv2_ 开头为 LangSmith Key；key=value 形式的附加项
//   JSON：{"base_url", "api_key", "langsmith_api_key", "model"}
const fs = require('node:fs');
const { resolveFromRoot } = require('./paths');

// 由主进程注入（Electron safeStorage / DPAPI），脚本环境下不可用
let cipher = { encrypt: null, decrypt: null };
function setCipher(c) {
  cipher = c;
}
function encryptSecret(plain) {
  if (!plain) return '';
  if (!cipher.encrypt) return plain;
  return 'enc:' + cipher.encrypt(plain);
}
function decryptSecret(v) {
  if (!v) return '';
  if (!v.startsWith('enc:')) return v;
  try {
    return cipher.decrypt ? cipher.decrypt(v.slice(4)) : '';
  } catch {
    return '';
  }
}

function parseKeyFile(text) {
  const out = { baseUrl: '', apiKey: '', langsmithKey: '', extra: {} };
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const j = JSON.parse(trimmed);
    out.baseUrl = j.base_url || j.baseUrl || '';
    out.apiKey = j.api_key || j.apiKey || '';
    out.langsmithKey = j.langsmith_api_key || '';
    for (const [k, v] of Object.entries(j)) out.extra[k] = v;
    return out;
  }
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // 兼容 "标签：值" / "label: value" / "key=value"，以及无标签的裸值
    const m = line.match(/^([\w一-龥 .-]{1,30}?)\s*[:：=]\s*(\S.*)$/);
    const label = m && !/^https?$/i.test(m[1]) ? m[1].trim().toLowerCase() : '';
    const value = label ? m[2].trim() : line;
    if (/^https?:\/\//i.test(value) && (!label || /url|地址|base|endpoint/.test(label))) {
      if (!out.baseUrl) out.baseUrl = value;
    } else if (value.startsWith('lsv2_') || /langsmith/.test(label)) {
      out.langsmithKey = value;
    } else if (label && !/^(key|api_?key|apikey|密钥)$/.test(label)) {
      out.extra[label] = value;
    } else if (!out.apiKey) {
      out.apiKey = value;
    }
  }
  if (out.extra.langsmith_api_key) out.langsmithKey = out.extra.langsmith_api_key;
  if (!out.extra.model && out.extra['模型']) out.extra.model = out.extra['模型'];
  return out;
}

function readKeyFile(file) {
  try {
    return { ...parseKeyFile(fs.readFileSync(resolveFromRoot(file), 'utf8')), fileOk: true };
  } catch (e) {
    return { baseUrl: '', apiKey: '', langsmithKey: '', extra: {}, fileOk: false, fileError: e.message };
  }
}

/** settings → { baseUrl, apiKey, model, fastModel, embeddingModel, langsmith:{...} } */
function resolveCredentials(settings) {
  const llm = settings.llm;
  const f = readKeyFile(llm.apiKeyFile);
  const ls = settings.langsmith;
  return {
    baseUrl: (llm.baseUrl || f.baseUrl || '').replace(/\/+$/, ''),
    apiKey: decryptSecret(llm.apiKey) || f.apiKey,
    model: llm.model || f.extra.model || '',
    fastModel: llm.fastModel || llm.model || f.extra.model || '',
    embeddingModel: llm.embeddingModel || '',
    visionModel: llm.visionModel || '',
    keyFile: { path: resolveFromRoot(llm.apiKeyFile), ok: f.fileOk, error: f.fileError },
    langsmith: {
      enabled: !!ls.enabled,
      project: ls.project || 'personal-agent',
      endpoint: ls.endpoint || 'https://api.smith.langchain.com',
      apiKey: decryptSecret(ls.apiKey) || f.langsmithKey,
    },
  };
}

function mask(s) {
  if (!s) return '';
  return s.length <= 10 ? '***' : `${s.slice(0, 5)}…${s.slice(-4)}`;
}

module.exports = { resolveCredentials, parseKeyFile, setCipher, encryptSecret, decryptSecret, mask };
