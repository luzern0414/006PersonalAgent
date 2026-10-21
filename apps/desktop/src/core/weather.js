'use strict';
// 天气：Open-Meteo（免费、免 Key），城市名经地理编码转经纬度；结果缓存 30 分钟
// 返回当前、逐小时（4 天）、逐日数据；kind 用于界面选择图标与天空渐变
const CODES = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};
/** 天气类型：clear | partly | cloudy | fog | rain | snow | thunder */
function kindOf(code) {
  if (code <= 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 95) return 'thunder';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}
const text = (code) => CODES[code] || '未知';
const isRainy = (code) => ['rain', 'thunder'].includes(kindOf(code));

const cache = new Map();
const geoCache = new Map();

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function geocode(city) {
  if (geoCache.has(city)) return geoCache.get(city);
  const j = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=${encodeURIComponent(city)}`);
  const g = j.results?.[0];
  if (!g) throw new Error(`找不到城市：${city}`);
  const v = { name: g.name, lat: g.latitude, lon: g.longitude };
  geoCache.set(city, v);
  return v;
}

async function getWeather(city, { force = false } = {}) {
  const hit = cache.get(city);
  if (!force && hit && Date.now() - hit.at < 30 * 60_000) return hit.value;
  const g = await geocode(city);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&timezone=auto&forecast_days=4` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
    '&hourly=temperature_2m,weather_code,precipitation_probability,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max';
  const j = await getJson(url);
  const cur = j.current;
  const h = j.hourly;
  const value = {
    city: g.name,
    now: {
      temp: Math.round(cur.temperature_2m),
      feels: Math.round(cur.apparent_temperature),
      humidity: cur.relative_humidity_2m,
      wind: Math.round(cur.wind_speed_10m),
      code: cur.weather_code,
      text: text(cur.weather_code),
      kind: kindOf(cur.weather_code),
      isDay: !!cur.is_day,
      rainy: isRainy(cur.weather_code),
    },
    // 本地时间字符串 'YYYY-MM-DDTHH:00'
    hourly: h.time.map((t, i) => ({
      time: t,
      temp: Math.round(h.temperature_2m[i]),
      code: h.weather_code[i],
      kind: kindOf(h.weather_code[i]),
      rain: h.precipitation_probability[i] ?? 0,
      isDay: !!h.is_day[i],
    })),
    days: j.daily.time.map((date, i) => ({
      date,
      code: j.daily.weather_code[i],
      text: text(j.daily.weather_code[i]),
      kind: kindOf(j.daily.weather_code[i]),
      max: Math.round(j.daily.temperature_2m_max[i]),
      min: Math.round(j.daily.temperature_2m_min[i]),
      rain: j.daily.precipitation_probability_max[i] ?? 0,
      sunrise: (j.daily.sunrise[i] || '').slice(11, 16),
      sunset: (j.daily.sunset[i] || '').slice(11, 16),
      uv: Math.round(j.daily.uv_index_max?.[i] ?? 0),
    })),
    updatedAt: new Date().toISOString(),
  };
  value.rainNext12h = Math.max(0, ...value.hourly.filter((x) => new Date(x.time) >= new Date(Date.now() - 36e5)).slice(0, 12).map((x) => x.rain));
  cache.set(city, { at: Date.now(), value });
  return value;
}

module.exports = { getWeather, kindOf };
