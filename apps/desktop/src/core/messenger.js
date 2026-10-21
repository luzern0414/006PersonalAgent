'use strict';
// 消息发送：飞书 / 企业微信 / 钉钉 群机器人 Webhook，以及通用 JSON Webhook
const crypto = require('node:crypto');

const TYPES = {
  feishu: '飞书群机器人',
  wecom: '企业微信群机器人',
  dingtalk: '钉钉群机器人',
  webhook: '通用 Webhook（POST JSON）',
};

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
  // 三家的错误码字段各不相同
  const code = j.code ?? j.errcode ?? j.StatusCode ?? 0;
  if (code !== 0) throw new Error(j.msg || j.errmsg || j.StatusMessage || `错误码 ${code}`);
  return j;
}

/**
 * @param {{type:string, webhook:string, secret?:string}} ch  已解密的渠道配置
 * @param {{title?:string, text:string}} msg  text 为 Markdown
 */
async function send(ch, { title = '', text }) {
  if (!ch.webhook) throw new Error('该渠道未配置 Webhook 地址');
  const full = title ? `**${title}**\n\n${text}` : text;
  switch (ch.type) {
    case 'feishu': {
      const body = {
        msg_type: 'interactive',
        card: {
          header: title ? { title: { tag: 'plain_text', content: title }, template: 'blue' } : undefined,
          elements: [{ tag: 'markdown', content: text }],
        },
      };
      if (ch.secret) {
        const ts = Math.floor(Date.now() / 1000);
        body.timestamp = String(ts);
        body.sign = crypto.createHmac('sha256', `${ts}\n${ch.secret}`).update('').digest('base64');
      }
      return post(ch.webhook, body);
    }
    case 'wecom':
      return post(ch.webhook, { msgtype: 'markdown', markdown: { content: full } });
    case 'dingtalk': {
      let url = ch.webhook;
      if (ch.secret) {
        const ts = Date.now();
        const sign = crypto.createHmac('sha256', ch.secret).update(`${ts}\n${ch.secret}`).digest('base64');
        url += `${url.includes('?') ? '&' : '?'}timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
      }
      return post(url, { msgtype: 'markdown', markdown: { title: title || '消息', text: full } });
    }
    default:
      return post(ch.webhook, { title, text, markdown: full });
  }
}

module.exports = { send, TYPES };
