'use strict';
// 时间与工作日工具

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** 'HH:MM' → 当天该时刻的 Date */
function atTime(str, base = new Date()) {
  const [h, m] = String(str).split(':').map(Number);
  const d = new Date(base);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

function isWorkday(work, d = new Date()) {
  const k = dateKey(d);
  if ((work.extraWorkdays || []).includes(k)) return true;
  if ((work.extraHolidays || []).includes(k)) return false;
  return (work.workdays || [1, 2, 3, 4, 5]).includes(d.getDay());
}

function inWorkHours(work, d = new Date()) {
  return isWorkday(work, d) && d >= atTime(work.start, d) && d < atTime(work.end, d);
}

/** 是否在 [start, end) 区间，支持跨午夜（如 22:00–08:00） */
function inRange(start, end, d = new Date()) {
  const t = hm(d);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** 本地时间 ISO（带时区偏移），给模型看更直观 */
function localISO(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${dateKey(d)}T${hm(d)}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

function fmtDuration(min) {
  min = Math.round(min);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} 小时 ${min % 60} 分` : `${h} 小时`;
}

module.exports = { WEEK, pad, dateKey, hm, atTime, isWorkday, inWorkHours, inRange, startOfDay, addDays, localISO, fmtDuration };
