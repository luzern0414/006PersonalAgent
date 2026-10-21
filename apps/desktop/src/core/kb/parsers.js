'use strict';
// 文档解析 → Markdown 文本。全部为纯 JS 实现，重型库按需加载
const fs = require('node:fs');
const path = require('node:path');

const TEXT_EXT = new Set(
  ('txt md markdown csv tsv json jsonl log yaml yml toml xml ini conf cfg env properties ' +
    'js mjs cjs ts tsx jsx vue py java kt go rs c h cpp hpp cs sql sh ps1 bat cmd rb php swift lua r scala css scss less')
    .split(' ')
);
const { IMAGE_EXT, MIME } = require('./ocr');
const { encodePng } = require('../png');

const SUPPORTED = new Set([...TEXT_EXT, 'html', 'htm', 'docx', 'pdf', 'pptx', 'xlsx', ...IMAGE_EXT]);

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}

/** 简易 HTML → Markdown：保留标题、列表、段落、表格行 */
function htmlToText(html) {
  let s = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(+n)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`);
  s = s
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleFromHtml(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

/** PDF：逐页取文字层；文字过少的页面视为扫描件，提取页内图片做 OCR */
async function parsePdf(buf, ocr) {
  const { extractText, extractImages, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = [];
  let ocrPages = 0;
  for (const [i, raw] of text.entries()) {
    let t = raw.trim();
    if (t.replace(/\s/g, '').length < 20 && ocr?.enabled) {
      const imgs = (await extractImages(pdf, i + 1)).filter((im) => im.width * im.height >= 200 * 200);
      const parts = [];
      for (const im of imgs.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 4)) {
        const png = encodePng(im.width, im.height, im.data, im.channels);
        parts.push((await ocr.recognize(png, 'image/png')).text);
      }
      if (parts.length) {
        t = [t, ...parts].filter(Boolean).join('\n\n');
        ocrPages++;
      }
    }
    pages.push(`## 第 ${i + 1} 页\n\n${t}`);
  }
  return { text: pages.join('\n\n'), ocrPages };
}

async function parseDocx(buf) {
  const mammoth = require('mammoth');
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  return htmlToText(value);
}

async function parsePptx(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  const parts = [];
  for (const [i, f] of slides.entries()) {
    const xml = await zip.file(f).async('string');
    const paras = xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')).filter(Boolean);
    parts.push(`## 第 ${i + 1} 页\n\n${decodeEntities(paras.join('\n'))}`);
  }
  return parts.join('\n\n');
}

async function parseXlsx(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const sharedXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeEntities([...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''))
  );
  const wb = (await zip.file('xl/workbook.xml')?.async('string')) || '';
  const names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => decodeEntities(m[1]));
  const sheets = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    .sort((a, b) => +a.match(/(\d+)\.xml/)[1] - +b.match(/(\d+)\.xml/)[1]);
  const out = [];
  for (const [i, f] of sheets.entries()) {
    const xml = await zip.file(f).async('string');
    const rows = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] || '';
        const v = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? inner.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? '';
        cells.push(/t="s"/.test(attrs) ? shared[+v] ?? '' : decodeEntities(v));
      }
      if (cells.some((x) => x !== '')) rows.push(cells.join(' | '));
      if (rows.length >= 5000) break; // 超大表只取前 5000 行
    }
    out.push(`## 工作表：${names[i] || i + 1}\n\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

/** 解析本地文件 → { title, text, ocr? } */
async function parseFile(file, { ocr } = {}) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const title = path.basename(file);
  if (!SUPPORTED.has(ext)) throw new Error(`暂不支持 .${ext} 文件`);
  const buf = fs.readFileSync(file);
  if (TEXT_EXT.has(ext)) {
    const text = buf.toString('utf8');
    return { title, text: ['md', 'markdown', 'txt'].includes(ext) ? text : '```' + ext + '\n' + text + '\n```' };
  }
  if (ext === 'html' || ext === 'htm') {
    const html = buf.toString('utf8');
    return { title: titleFromHtml(html) || title, text: htmlToText(html) };
  }
  if (IMAGE_EXT.has(ext)) {
    if (!ocr?.enabled) throw new Error('图片需要 OCR，请在设置中开启');
    const r = await ocr.recognize(buf, MIME[ext]);
    return { title, text: r.text, ocr: r.engine };
  }
  if (ext === 'pdf') {
    const r = await parsePdf(buf, ocr);
    return { title, text: r.text, ocr: r.ocrPages ? `${r.ocrPages} 页` : undefined };
  }
  if (ext === 'docx') return { title, text: await parseDocx(buf) };
  if (ext === 'pptx') return { title, text: await parsePptx(buf) };
  if (ext === 'xlsx') return { title, text: await parseXlsx(buf) };
  throw new Error(`暂不支持 .${ext}`);
}

async function parseUrl(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0 PersonalAgent' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  return { title: titleFromHtml(html) || url, text: htmlToText(html) };
}

module.exports = { parseFile, parseUrl, htmlToText, SUPPORTED };
