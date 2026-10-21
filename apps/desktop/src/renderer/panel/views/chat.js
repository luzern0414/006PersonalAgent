// 对话：一个连续的对话，展示全部历史；流式输出、工具调用过程、外发操作确认卡
import { h, api, md, empty, relTime } from '../lib.js';

const TOOL_NAMES = {
  get_today_overview: '查看今日概览', list_tasks: '查看待办', add_task: '新建待办', complete_task: '完成待办', update_task: '修改待办',
  delete_task: '删除待办', list_events: '查看日程', add_event: '新建日程', delete_event: '删除日程', sync_calendars: '同步日历',
  add_reminder: '设置提醒', list_reminders: '查看提醒', delete_reminder: '删除提醒', get_weather: '查天气', search_knowledge: '检索知识库',
  save_note: '保存笔记', remember: '记住偏好', list_channels: '查看群', send_message: '发送消息', get_schedule_text: '整理日程',
  generate_daily_report: '生成日报', update_event: '修改日程', update_reminder: '修改提醒', add_to_knowledge: '收录到知识库', get_agenda: '查看安排',
};
const SUGGESTS = ['今天我有哪些安排？', '帮我记个待办：周五前提交报销', '明天上午10点提醒我开周会', '知识库里有关于接口规范的内容吗？'];

const DRAFT_KEY = 'pa.chat.main.draft';
let draft = readDraft();
let draftRevision = 0;
const messages = [];
let pending = null;
let view = null;
let unlisten = null;
let historyTask = null;
let historyError = '';
let renderTimer = null;

function readDraft() {
  try {
    return window.localStorage.getItem(DRAFT_KEY) || '';
  } catch {
    return '';
  }
}

function saveDraft(text) {
  if (draft !== text) draftRevision++;
  draft = text;
  try {
    if (text) window.localStorage.setItem(DRAFT_KEY, text);
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage can be unavailable; keep the current renderer's draft in memory.
  }
}

function resizeInput(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(140, input.scrollHeight) + 'px';
}

function errorText(error) {
  return String(error?.message || error || '发送失败');
}

function clearRenderTimer() {
  clearTimeout(renderTimer);
  renderTimer = null;
}

export function render(el, opts = {}) {
  unmount();
  const v = { replies: new Map(), focusTimer: null };
  const list = h('div.messages');
  const input = h('textarea.input', { rows: 2, value: draft });
  const sendBtn = h('button.btn.primary', { onclick: () => send(v) }, '发送');
  const stopBtn = h('button.btn.hidden', { onclick: stop }, '停止');
  const sug = h('div.suggests');
  Object.assign(v, { list, input, sendBtn, stopBtn, sug });
  view = v;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(v);
    }
  });
  input.addEventListener('input', () => {
    if (view !== v) return;
    saveDraft(input.value);
    resizeInput(input);
  });
  el.append(list, h('div.composer', sug, h('div.row', input, h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, sendBtn, stopBtn))));
  // The transcript and stream belong to this renderer, not to a mounted tab.
  // Keep one listener while navigating so tools and confirmations are not lost.
  unlisten ||= window.pa.on('chat:event', onEvent);
  paintMessages(v);
  resizeInput(input);
  loadHistory();
  if (opts.send) send(v, opts.send); // 其他页面交给对话的请求（如写日报），不影响输入框里的草稿
  else if (opts.focusInput !== false) v.focusTimer = setTimeout(() => view === v && input.focus(), 50);
}
export function unmount() {
  if (view) {
    saveDraft(view.input.value);
    clearTimeout(view.focusTimer);
  }
  view = null;
  clearRenderTimer();
}

window.addEventListener('pagehide', () => {
  unmount();
  unlisten?.();
  unlisten = null;
});

function loadHistory() {
  if (!historyTask) {
    historyTask = (async () => {
      try {
        // Sends await this snapshot before invoking IPC. It cannot contain the
        // optimistic turn already in messages, so prepending does not duplicate it.
        const history = await api('chatHistory');
        messages.unshift(...history);
      } catch (error) {
        historyError = errorText(error);
      } finally {
        if (view) paintMessages(view);
      }
    })();
  }
  return historyTask;
}

function paintMessages(v) {
  if (view !== v) return;
  v.list.replaceChildren();
  v.replies.clear();
  v.sug.replaceChildren();
  if (historyError) v.list.append(h('div.small', { style: { color: 'var(--err)' } }, '⚠️ 历史加载失败：' + historyError));
  if (!messages.length) {
    v.list.append(empty('有什么事，直接跟我说'));
    v.sug.append(...SUGGESTS.map((s) => h('button', {
      onclick: () => {
        if (view !== v || pending) return;
        v.input.value = s;
        saveDraft(s);
        resizeInput(v.input);
        return send(v);
      },
    }, s)));
  }
  v.lastDay = '';
  for (const m of messages) appendMessage(v, m);
  paintControls(v);
  scroll(v);
}

function appendMessage(v, m) {
  const day = (m.at || '').slice(0, 10);
  if (day && day !== v.lastDay) {
    v.list.append(h('div.day-sep', relTime(day)));
    v.lastDay = day;
  }
  if (m.role === 'user') v.list.append(h('div.msg.user', h('div.bubble', m.content)));
  else if (m.role === 'assistant') {
    const steps = h('div.steps.hidden');
    const body = h('div.body');
    const confirmations = h('div');
    const bubble = h('div.bubble', steps, body, confirmations);
    v.list.append(h('div.msg.assistant', bubble));
    v.replies.set(m, { steps, body, confirmations });
    paintReply(v, m);
  }
}

function scroll(v) {
  if (view === v) v.list.scrollTop = v.list.scrollHeight;
}

function paintControls(v) {
  if (view !== v) return;
  v.sendBtn.disabled = !!pending;
  v.stopBtn.classList.toggle('hidden', !pending);
}

function paintReply(v, reply) {
  if (view !== v) return;
  const b = v.replies.get(reply);
  if (!b) return;
  b.body.innerHTML = md(reply.content);
  b.body.classList.toggle('typing', !!reply.running && !reply.done && !reply.error);
  if (reply.error) b.body.append(h('div', { style: { color: 'var(--err)' } }, '⚠️ ' + reply.error));
  b.steps.replaceChildren(...(reply.steps || []).map((s) => {
    const state = s.state || (s.ok ? 'ok' : 'fail');
    return h('span.step' + (state === 'run' ? '.run' : state === 'fail' ? '.fail' : ''),
      (state === 'fail' ? '✗ ' : state === 'run' ? '… ' : '✓ ') + (TOOL_NAMES[s.name] || s.name));
  }));
  b.steps.classList.toggle('hidden', !reply.steps?.length);
  b.confirmations.replaceChildren(...(reply.confirmations || []).map((c) => confirmCard(reply, c)));
}

function paintCurrentReply(reply) {
  if (view) {
    paintReply(view, reply);
    scroll(view);
  }
}

function onEvent(e) {
  const request = pending;
  if (!request?.started || (e.conversationId && e.conversationId !== 'main')) return;
  const reply = request.reply;
  if (e.type === 'delta') {
    reply.content += e.text;
    if (renderTimer === null) {
      renderTimer = setTimeout(() => {
        renderTimer = null;
        if (pending === request) paintCurrentReply(reply);
      }, 40); // 合并高频增量；连续输出也按固定间隔绘制
    }
    return;
  } else if (e.type === 'tool_start') {
    reply.steps.push({ id: e.id, name: e.name, state: 'run' });
  } else if (e.type === 'tool_end') {
    const s = reply.steps.find((step) => step.id === e.id);
    if (s) {
      s.state = e.ok ? 'ok' : 'fail';
      s.ok = e.ok;
    }
  } else if (e.type === 'confirm') {
    reply.confirmations.push({ id: e.id, preview: e.preview, answered: null, answering: false });
  } else if (e.type === 'done') {
    clearRenderTimer();
    reply.done = true;
    if (typeof e.text === 'string') reply.content = e.text;
  } else if (e.type === 'error') {
    clearRenderTimer();
    reply.error = errorText(e.message);
  }
  paintCurrentReply(reply);
}

function confirmCard(reply, c) {
  if (c.answered !== null) return h('div.small.muted', c.answered ? '✓ 已确认' : '✗ 已取消');
  const answer = async (ok) => {
    if (c.answering || c.answered !== null || !reply.running) return;
    c.answering = true;
    paintCurrentReply(reply);
    try {
      await window.pa.confirm(c.id, ok);
      c.answered = ok;
      c.error = '';
    } catch (error) {
      c.error = errorText(error);
    } finally {
      c.answering = false;
      paintCurrentReply(reply);
    }
  };
  return h(
    'div.confirm-card',
    h('div', h('b', '⚠️ 需要你确认')),
    h('div.preview', { html: md(c.preview) }),
    c.error ? h('div.small', { style: { color: 'var(--err)' } }, c.error) : null,
    h('div.row.end',
      h('button.btn', { disabled: c.answering || !reply.running, onclick: () => answer(false) }, '取消'),
      h('button.btn.primary', { disabled: c.answering || !reply.running, onclick: () => answer(true) }, '确认执行'))
  );
}

async function stop() {
  const request = pending;
  if (!request) return;
  if (!request.started) {
    request.cancelled = true;
    request.reply.error = '已停止';
    request.cancelPreflight();
    return;
  }
  try {
    await api('chatStop', 'main');
  } catch (error) {
    request.reply.error = errorText(error);
    paintCurrentReply(request.reply);
  }
}

async function send(v, preset) {
  if (view !== v || pending) return;
  const text = (preset ?? v.input.value).trim();
  if (!text) return;
  if (!preset) saveDraft(v.input.value);
  const at = new Date().toISOString();
  const reply = { role: 'assistant', content: '', steps: [], confirmations: [], running: true, done: false, error: '', at };
  const request = { reply, draft, revision: draftRevision, started: false, cancelled: false, preset: !!preset };
  const cancelled = new Promise((resolve) => { request.cancelPreflight = resolve; });
  pending = request;
  const user = { role: 'user', content: text, at };
  messages.push(user, reply);
  v.sug.replaceChildren();
  v.list.querySelector('.empty')?.remove();
  appendMessage(v, user);
  appendMessage(v, reply);
  paintControls(v);
  scroll(v);
  try {
    // Stop must release the composer even if the history IPC has not resolved.
    await Promise.race([loadHistory(), cancelled]);
    if (request.cancelled) return;
    request.started = true;
    request.cancelPreflight = null;
    const result = await window.pa.chat({ conversationId: 'main', text });
    if (result?.error) reply.error ||= errorText(result.error);
    else if (!reply.error) {
      if (typeof result?.text === 'string') reply.content = result.text;
      if (Array.isArray(result?.steps)) reply.steps = result.steps;
      // A new draft typed during the request belongs to the next send.
      if (!request.preset && draftRevision === request.revision && draft === request.draft) {
        saveDraft('');
        if (view) {
          view.input.value = '';
          resizeInput(view.input);
        }
      }
    }
  } catch (error) {
    reply.error ||= errorText(error);
  } finally {
    request.cancelPreflight = null;
    clearRenderTimer();
    reply.running = false;
    if (pending === request) pending = null;
    paintCurrentReply(reply);
    if (view) {
      paintControls(view);
      view.input.focus();
    }
  }
}
