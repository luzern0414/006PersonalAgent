'use strict';
// Agent 工具定义：OpenAI function calling schema + 执行函数
// confirm: true 的工具（外发 / 删除）执行前必须经用户确认

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

function obj(properties, required = []) {
  return { type: 'object', properties, required };
}

/** @param {import('./services').Core} core */
function buildTools(core) {
  const tools = [
    {
      name: 'get_today_overview',
      description: '获取今天的完整概览：日程、任务、待办、喝水/起立统计、距下班时间',
      parameters: obj({}),
      run: () => core.today(),
    },
    {
      name: 'list_tasks',
      description: '列出待办。view: today=今天（含逾期未完成）, day=指定 date 那天, open=全部未完成, done=已完成, all=全部',
      parameters: obj({ view: str('today|day|open|done|all', { enum: ['today', 'day', 'open', 'done', 'all'] }), date: str('view=day 时的日期 YYYY-MM-DD') }),
      run: (a) => core.listTasks(a).map(({ id, title, status, priority, due, planDate }) => ({ id, title, status, priority, due, planDate })),
    },
    {
      name: 'add_task',
      description: '新建待办。每个待办属于某一天（planDate，默认今天）；有具体截止时刻时填 due',
      parameters: obj(
        {
          title: str('标题，简洁动宾结构'),
          priority: int('0紧急 1高 2中 3低', { minimum: 0, maximum: 3 }),
          due: str('截止时间，ISO 8601 本地时间，如 2026-10-12T15:00:00+08:00；无则留空'),
          planDate: str('哪天做，YYYY-MM-DD，默认今天'),
          notes: str('备注'),
        },
        ['title']
      ),
      run: (a) => core.addTask(a),
    },
    {
      name: 'complete_task',
      description: '把任务/待办标记为完成（或用 undo=true 恢复为未完成）',
      parameters: obj({ id: str('任务 id'), undo: { type: 'boolean' } }, ['id']),
      run: ({ id, undo }) => core.updateTask(id, { status: undo ? 'open' : 'done' }),
    },
    {
      name: 'update_task',
      description: '修改任务的标题、优先级、截止时间、计划日期等',
      parameters: obj({ id: str('任务 id'), title: str(''), priority: int(''), due: str(''), planDate: str(''), notes: str('') }, ['id']),
      run: ({ id, ...patch }) => core.updateTask(id, patch),
    },
    {
      name: 'delete_task',
      description: '删除任务或待办（需用户确认）',
      parameters: obj({ id: str('任务 id'), title: str('任务标题，用于确认展示') }, ['id']),
      confirm: (a) => `删除任务「${a.title || a.id}」`,
      run: ({ id }) => ({ ok: core.removeTask(id) }),
    },
    {
      name: 'list_events',
      description: '查询日程。不填时间则返回今天',
      parameters: obj({ from: str('开始时间 ISO'), to: str('结束时间 ISO') }),
      run: (a) => core.listEvents(a),
    },
    {
      name: 'add_event',
      description: '新建日程/会议',
      parameters: obj(
        { title: str('标题'), start: str('开始时间 ISO 8601（含时区）'), end: str('结束时间 ISO，默认 1 小时'), location: str('地点'), remindBefore: int('提前几分钟提醒') },
        ['title', 'start']
      ),
      run: (a) => core.addEvent(a),
    },
    {
      name: 'update_event',
      description: '修改日程的标题、时间、地点、提前提醒分钟数（先用 list_events / get_agenda 拿到 id）',
      parameters: obj(
        { id: str('日程 id'), title: str('新标题'), start: str('新的开始时间 ISO 8601'), end: str('新的结束时间 ISO 8601'), location: str('地点'), remindBefore: int('提前几分钟提醒') },
        ['id']
      ),
      run: ({ id, ...patch }) => core.updateEvent(id, patch),
    },
    {
      name: 'delete_event',
      description: '删除日程（需用户确认）',
      parameters: obj({ id: str('日程 id'), title: str('标题，用于确认展示') }, ['id']),
      confirm: (a) => `删除日程「${a.title || a.id}」`,
      run: ({ id }) => ({ ok: core.removeEvent(id) }),
    },
    {
      name: 'add_reminder',
      description:
        '创建提醒。repeat=none 时必须给 at；daily/workdays/weekly 用 time(HH:MM)，weekly 还需 weekdays（0=周日…6=周六）；interval 用 intervalMin',
      parameters: obj(
        {
          text: str('提醒内容'),
          repeat: str('none|daily|workdays|weekly|interval', { enum: ['none', 'daily', 'workdays', 'weekly', 'interval'] }),
          at: str('一次性提醒的时间 ISO 8601'),
          time: str('重复提醒的时刻 HH:MM'),
          weekdays: { type: 'array', items: { type: 'integer' } },
          intervalMin: int('间隔分钟'),
        },
        ['text']
      ),
      run: (a) => core.addReminder(a),
    },
    {
      name: 'get_agenda',
      description: '查看某一天的全部安排（日程、提醒、待办，按时间排列，含完成状态）',
      parameters: obj({ date: str('YYYY-MM-DD，默认今天') }),
      run: ({ date }) => {
        const a = core.agenda(date);
        return { ...a, items: a.items.map(({ raw, ...x }) => x) };
      },
    },
    {
      name: 'list_reminders',
      description: '列出自定义提醒',
      parameters: obj({}),
      run: () => core.listReminders(),
    },
    {
      name: 'update_reminder',
      description: '修改提醒：内容、时间、重复方式，或暂停/恢复（enabled）。先用 list_reminders 拿到 id',
      parameters: obj(
        {
          id: str('提醒 id'),
          text: str('新的提醒内容'),
          repeat: str('none|daily|workdays|weekly|interval', { enum: ['none', 'daily', 'workdays', 'weekly', 'interval'] }),
          at: str('一次性提醒的新时间 ISO 8601'),
          time: str('重复提醒的新时刻 HH:MM'),
          weekdays: { type: 'array', items: { type: 'integer' } },
          intervalMin: int('间隔分钟'),
          enabled: { type: 'boolean', description: 'false 暂停，true 恢复' },
        },
        ['id']
      ),
      run: ({ id, ...patch }) => core.updateReminder(id, patch),
    },
    {
      name: 'delete_reminder',
      description: '删除提醒',
      parameters: obj({ id: str('提醒 id') }, ['id']),
      run: ({ id }) => ({ ok: core.removeReminder(id) }),
    },
    {
      name: 'get_weather',
      description: '查询天气（当前 + 未来 3 天），不填城市则用用户所在城市',
      parameters: obj({ city: str('城市名') }),
      run: ({ city }) => core.weather(city),
    },
    {
      name: 'search_knowledge',
      description: '在用户的个人知识库（上传的文档、随手记）中检索。回答涉及用户资料时先调用它，并在回答里用 [n] 标注引用',
      parameters: obj({ query: str('检索语句，提炼关键词'), top_k: int('返回条数，默认 6') }, ['query']),
      run: async ({ query, top_k }) => (await core.kb.search(query, top_k)).map((r, i) => ({ ref: i + 1, ...r })),
    },
    {
      name: 'add_to_knowledge',
      description: '把一个网页链接或一段文字收进知识库（网页会自动抓取正文）。用户说「收藏这个链接」「把这段记到知识库」时使用',
      parameters: obj({ url: str('网页地址（与 text 二选一）'), text: str('要收录的文字'), title: str('标题（收录文字时可选）') }),
      run: async ({ url, text, title }) => {
        if (!url && !text) throw new Error('需要 url 或 text');
        const r = await core.kb.ingest(url ? { url } : { text, title: title || text.split('\n')[0].slice(0, 30) });
        core.emit('data.changed', { kind: 'kb' });
        return { title: r.doc.title, chunks: r.doc.chunks, duplicate: r.duplicate };
      },
    },
    {
      name: 'save_note',
      description: '把内容保存为一篇随手记（Markdown 文档），同时收入知识库',
      parameters: obj({ title: str('标题'), content: str('Markdown 正文'), tags: { type: 'array', items: { type: 'string' } } }, ['title', 'content']),
      run: (a) => core.saveNote(a),
    },
    {
      name: 'remember',
      description: '记住关于用户的长期信息（偏好、习惯、常用联系人等），只记稳定事实',
      parameters: obj({ fact: str('一句话事实') }, ['fact']),
      run: ({ fact }) => core.remember(fact),
    },
    {
      name: 'list_channels',
      description: '列出可用的消息发送渠道（飞书/企业微信/钉钉群等）',
      parameters: obj({}),
      run: () => core.channels(),
    },
    {
      name: 'send_message',
      description: '发送消息到指定渠道（需用户确认）。text 为 Markdown',
      parameters: obj({ channelId: str('渠道 id 或名称'), title: str('标题'), text: str('正文 Markdown') }, ['channelId', 'text']),
      confirm: (a) => `发送到「${a.channelId}」：\n\n${a.title ? `**${a.title}**\n\n` : ''}${a.text}`,
      run: (a) => core.sendMessage(a),
    },
    {
      name: 'get_schedule_text',
      description: '把今日或本周日程整理成可发送的文本',
      parameters: obj({ range: str('today|week', { enum: ['today', 'week'] }) }),
      run: ({ range }) => core.formatSchedule(range),
    },
    {
      name: 'generate_daily_report',
      description: '根据今天完成的任务、会议、笔记生成工作日报草稿',
      parameters: obj({ date: str('YYYY-MM-DD，默认今天') }),
      run: ({ date }) => core.generateReport(date),
    },
  ];
  const map = new Map(tools.map((t) => [t.name, t]));
  const schemas = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  return { map, schemas };
}

module.exports = { buildTools };
