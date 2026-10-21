'use strict';
// 用户设置：config/settings.json（首次运行自动生成），与默认值深合并
const fs = require('node:fs');
const path = require('node:path');
const { CONFIG_DIR, resolveFromRoot } = require('./paths');

const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');

const DEFAULTS = {
  user: { nickname: '老大', city: '深圳' },
  work: {
    start: '09:00',
    end: '18:00',
    workdays: [1, 2, 3, 4, 5],
    extraHolidays: [], // 'YYYY-MM-DD'：法定节假日（工作日也放假）
    extraWorkdays: [], // 'YYYY-MM-DD'：调休上班的周末
  },
  paths: {
    dataDir: './data', // 业务数据（任务/日程/对话/日志）
    knowledgeDir: './data/knowledge', // 知识库：原文件、Markdown、索引
    docsDir: './data/notes', // 文档：随手记、日报
  },
  llm: {
    apiKeyFile: './config/apikey.txt', // 第一行地址、第二行 Key、lsv2_ 开头为 LangSmith Key
    baseUrl: '', // 留空则读 apiKeyFile
    apiKey: '', // 留空则读 apiKeyFile（界面中填写时加密保存）
    model: '',
    fastModel: '',
    embeddingModel: '',
    visionModel: '', // 图片 OCR 用的多模态模型，留空同对话模型
    temperature: 0.4,
    maxSteps: 8,
    historyTurns: 10,
  },
  langsmith: {
    enabled: true,
    project: 'personal-agent',
    endpoint: 'https://api.smith.langchain.com',
    apiKey: '', // 留空则读 apiKeyFile 里的 lsv2_ 行
  },
  reminders: {
    water: { enabled: true, intervalMin: 45, goal: 8 },
    stand: { enabled: true, intervalMin: 50 },
    eyes: { enabled: false, intervalMin: 20 },
    mode: 'active', // active = 按实际键鼠活跃时长计时；fixed = 按固定钟点间隔
    onlyWorkHours: true,
    snoozeMin: 10,
    breakResetMin: 5, // 离开电脑超过 N 分钟视为已经起身活动
    offwork: { enabled: true, preMin: 30 },
    morning: { enabled: true },
    meetingBeforeMin: 10,
    taskDueBeforeMin: 15,
    quietHours: { enabled: true, start: '22:00', end: '08:00' },
    dndFullscreen: true,
    toast: 'hidden', // 何时同时发系统通知：never | hidden（宠物隐藏或免打扰时）| always
    bubbleSeconds: 12,
  },
  focus: { minutes: 25, breakMinutes: 5 },
  pet: { scale: 1, alwaysOnTop: true, eyeFollow: true, visible: true, position: null, panelPosition: null },
  home: {
    tomorrowLeadMin: 60, // 工作日距下班不足 N 分钟（或已下班）时，首页切到「明天」视角
    restDayTomorrowAt: '18:00', // 休息日几点后切到「明天」视角
  },
  performance: { disableGpu: true, panelReleaseMin: 3 },
  hotkeys: {
    togglePanel: 'Alt+Shift+P',
    quickChat: 'Alt+Shift+Space',
    newTodo: 'Alt+Shift+T',
    togglePet: 'Alt+Shift+H',
  },
  channels: [], // { id, name, type: feishu|wecom|dingtalk|webhook, webhook, secret }
  kb: {
    chunkSize: 600,
    overlap: 80,
    topK: 6,
    maxFileMB: 100,
    ocr: 'auto', // auto = 优先视觉模型、失败用本地 | vision | local（离线，不上传）| off
  },
  report: { channelId: '', autoDraftAt: '17:40' },
  autostart: false,
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

class Settings {
  constructor() {
    this.listeners = new Set();
    this.data = this.load();
  }
  load() {
    let user = {};
    try {
      user = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
      /* 首次运行 */
    }
    const merged = deepMerge(DEFAULTS, user);
    if (!fs.existsSync(SETTINGS_FILE)) this.write(merged);
    return merged;
  }
  write(data) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE);
  }
  get() {
    return this.data;
  }
  /** 局部更新并持久化，通知监听者（旧值, 新值） */
  update(patch) {
    const prev = this.data;
    this.data = deepMerge(prev, patch); // 数组（channels / workdays 等）整体替换
    this.write(this.data);
    for (const fn of this.listeners) fn(prev, this.data);
    return this.data;
  }
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  paths() {
    const p = this.data.paths;
    return {
      dataDir: resolveFromRoot(p.dataDir),
      knowledgeDir: resolveFromRoot(p.knowledgeDir),
      docsDir: resolveFromRoot(p.docsDir),
      logsDir: path.join(resolveFromRoot(p.dataDir), 'logs'),
    };
  }
}

module.exports = { Settings, DEFAULTS, SETTINGS_FILE, deepMerge };
