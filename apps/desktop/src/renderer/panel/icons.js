// 图标：界面用线性图标（风格参考 Lucide，ISC 许可），天气用彩色图标；均为内联 SVG，无网络请求

const LINE = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.8 7L4 20.5l1.6-4.6A8 8 0 1 1 21 12Z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2Zm0 0A2 2 0 0 0 6 21.5h13"/><path d="M9 7h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  note: '<path d="M4 4h16v12l-4 4H4Z"/><path d="M16 20v-4h4M8 9h8M8 13h5"/>',
  text: '<path d="M4 7V5h16v2M9 19h6M12 5v14"/>',
  upload: '<path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevronL: '<path d="m15 6-6 6 6 6"/>',
  chevronR: '<path d="m9 6 6 6-6 6"/>',
  sunrise: '<path d="M12 3v4m-6.4 2.6 1.4 1.4m11.4-1.4L17 11M3 17h18M7 17a5 5 0 0 1 10 0"/>',
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h7"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4Z"/>',
  sparkle: '<path d="M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M18 6l-2.5 2.5m-7 7L6 18"/>',
};

/** 线性图标 */
export function icon(name, size = 18, cls = '') {
  const span = document.createElement('span');
  span.className = 'ico ' + cls;
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LINE[name] || ''}</svg>`;
  return span;
}

// ── 天气图标（彩色） ──
const SUN = (cx = 12, cy = 12, r = 4.6) =>
  `<g><circle cx="${cx}" cy="${cy}" r="${r}" fill="#FFC53D"/>${[0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => {
      const rad = (a * Math.PI) / 180;
      const x1 = cx + Math.cos(rad) * (r + 2.2), y1 = cy + Math.sin(rad) * (r + 2.2);
      const x2 = cx + Math.cos(rad) * (r + 4.2), y2 = cy + Math.sin(rad) * (r + 4.2);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#FFC53D" stroke-width="1.8" stroke-linecap="round"/>`;
    })
    .join('')}</g>`;
const MOON = (cx = 12, cy = 11) => `<path d="M${cx + 4.5} ${cy + 3.5}A6.5 6.5 0 1 1 ${cx - 1.5} ${cy - 6}a5 5 0 0 0 6 9.5Z" fill="#FFE08A"/>`;
const CLOUD = (fill = '#fff', dx = 0, dy = 0) =>
  `<path transform="translate(${dx} ${dy})" d="M7 19h10.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6-1.3A4.7 4.7 0 0 0 7 19Z" fill="${fill}"/>`;
const DROPS = '<path d="M8.5 20.5 7.5 23M12.5 20.5l-1 2.5M16.5 20.5l-1 2.5" stroke="#7CC4FF" stroke-width="1.8" stroke-linecap="round"/>';
const FLAKES = '<g fill="#E8F4FF"><circle cx="8.5" cy="22" r="1.1"/><circle cx="12.5" cy="22.6" r="1.1"/><circle cx="16.5" cy="22" r="1.1"/></g>';
const BOLT = '<path d="m12.5 17.5-2.2 3.6h2.4l-1.4 3" stroke="#FFD43B" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
const FOG = '<path d="M4 17h16M6 20.5h12M5 13.5h14" stroke="#E6ECF2" stroke-width="1.8" stroke-linecap="round"/>';

/** 天气图标：kind = clear | partly | cloudy | fog | rain | snow | thunder */
export function weatherIcon(kind, isDay = true, size = 28) {
  const sky = isDay ? SUN(9, 9, 3.6) : MOON(9, 9);
  const body = {
    clear: isDay ? SUN() : MOON(12, 12),
    partly: sky + CLOUD('#F4F7FB', 2, 2),
    cloudy: CLOUD('#DCE3EC', -2, -2) + CLOUD('#F4F7FB', 1.5, 1),
    fog: CLOUD('#E6ECF2', 0, -4) + FOG,
    rain: CLOUD('#E9EEF5', 0, -3) + DROPS,
    snow: CLOUD('#F2F6FA', 0, -3) + FLAKES,
    thunder: CLOUD('#D5DCE6', 0, -3) + BOLT,
  }[kind] || CLOUD();
  const span = document.createElement('span');
  span.className = 'wico';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 25" aria-hidden="true">${body}</svg>`;
  return span;
}

/** 天空渐变（按天气类型 × 白天/夜晚），用于天气卡背景 */
export function skyGradient(kind, isDay) {
  const day = {
    clear: ['#3D8BFD', '#7DB9FF'],
    partly: ['#4A86D9', '#93BCEB'],
    cloudy: ['#6C7F98', '#A5B4C6'],
    fog: ['#7E8B99', '#B4BEC9'],
    rain: ['#4D6177', '#7D92A9'],
    snow: ['#7C98B6', '#BFD0E2'],
    thunder: ['#3F4560', '#6E7491'],
  };
  const night = {
    clear: ['#14213D', '#2F4373'],
    partly: ['#1C2A47', '#3D5079'],
    cloudy: ['#262E3B', '#4B5567'],
    fog: ['#2C333D', '#545D69'],
    rain: ['#1E2733', '#3F4B5B'],
    snow: ['#2D3A4C', '#5A6B80'],
    thunder: ['#1A1C2B', '#3C3F57'],
  };
  const [a, b] = (isDay ? day : night)[kind] || day.cloudy;
  return `linear-gradient(160deg, ${a} 0%, ${b} 100%)`;
}
