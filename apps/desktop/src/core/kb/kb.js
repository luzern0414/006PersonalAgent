'use strict';
// 本地知识库：
//   <knowledgeDir>/files/YYYY-MM/  原文件副本
//   <knowledgeDir>/md/<docId>.md    解析后的 Markdown（人可读、可迁移）
//   <knowledgeDir>/index.json       文档元数据 + 分块
//   <knowledgeDir>/vectors.json     （可选）分块向量
// 检索：BM25（中文按字二元组切分）+ 可选向量检索，RRF 融合
// 所有路径均以知识库目录为基准的相对路径，整个目录移动后仍可用
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseFile, parseUrl, SUPPORTED } = require('./parsers');
const { newId } = require('../store');

const CJK = /[㐀-鿿豈-﫿]/;

function tokenize(text) {
  const out = [];
  const s = text.toLowerCase();
  for (const m of s.matchAll(/[a-z0-9_]+|[㐀-鿿豈-﫿]+/g)) {
    const w = m[0];
    if (!CJK.test(w[0])) {
      if (w.length > 1) out.push(w);
    } else if (w.length === 1) {
      out.push(w);
    } else {
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    }
  }
  return out;
}

/** 按标题切分，再按长度切块（带重叠），每块记录所属标题路径 */
function chunkMarkdown(md, size, overlap) {
  const chunks = [];
  const heads = [];
  let buf = '';
  const push = () => {
    const t = buf.trim();
    if (t) chunks.push({ heading: heads.filter(Boolean).join(' > '), text: t });
    buf = '';
  };
  for (const para of md.split(/\n{2,}/)) {
    const h = para.match(/^(#{1,6})\s+(.+)/);
    if (h) {
      push();
      heads.length = h[1].length;
      heads[h[1].length - 1] = h[2].trim().slice(0, 60);
      continue;
    }
    if (buf.length + para.length > size && buf) {
      const tail = buf.slice(-overlap);
      push();
      buf = tail;
    }
    if (para.length > size * 1.5) {
      for (let i = 0; i < para.length; i += size - overlap) {
        buf += para.slice(i, i + size);
        push();
      }
    } else buf += (buf ? '\n\n' : '') + para;
  }
  push();
  return chunks;
}

class KnowledgeBase {
  constructor({ getDir, getOpts, llm, ocr, log = () => {} }) {
    this.getDir = getDir;
    this.ocr = ocr;
    this.getOpts = getOpts; // () => settings.kb
    this.llm = llm;
    this.log = log;
    this.index = null; // 懒加载
    this.vectors = null;
    this.queue = Promise.resolve(); // 入库串行，避免卡顿
  }

  get dir() {
    return this.getDir();
  }
  _file(name) {
    return path.join(this.dir, name);
  }

  load() {
    if (this.index && this.index.dir === this.dir) return this.index;
    let data = { docs: [], chunks: [] };
    try {
      data = JSON.parse(fs.readFileSync(this._file('index.json'), 'utf8'));
    } catch {
      /* 空库 */
    }
    this.index = { dir: this.dir, ...data, _tok: null };
    this.vectors = null;
    return this.index;
  }
  unload() {
    // 释放内存：长时间未用时调用
    this.index = null;
    this.vectors = null;
  }
  _save() {
    const { docs, chunks } = this.index;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this._file('index.json.tmp'), JSON.stringify({ docs, chunks }));
    fs.renameSync(this._file('index.json.tmp'), this._file('index.json'));
    this.index._tok = null;
  }
  _loadVectors() {
    if (this.vectors) return this.vectors;
    try {
      this.vectors = JSON.parse(fs.readFileSync(this._file('vectors.json'), 'utf8'));
    } catch {
      this.vectors = {};
    }
    return this.vectors;
  }

  listDocs() {
    return [...this.load().docs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  stats() {
    const ix = this.load();
    return { docs: ix.docs.length, chunks: ix.chunks.length, dir: this.dir };
  }

  /** 入库（串行队列）。source: {path} | {url} | {text, title} */
  ingest(source, { onProgress } = {}) {
    const job = this.queue.then(() => this._ingest(source, onProgress));
    this.queue = job.catch(() => {});
    return job;
  }

  async _ingest(source, onProgress = () => {}) {
    const ix = this.load();
    const { chunkSize, overlap, maxFileMB } = this.getOpts();
    let title, text, type, ocr = '', file = '';
    onProgress({ stage: 'parsing' });
    if (source.path) {
      const st = fs.statSync(source.path);
      if (st.size > maxFileMB * 1024 * 1024) throw new Error(`文件超过 ${maxFileMB}MB`);
      const sha = crypto.createHash('sha256').update(fs.readFileSync(source.path)).digest('hex');
      const dup = ix.docs.find((d) => d.sha === sha);
      if (dup) return { doc: dup, duplicate: true };
      ({ title, text, ocr = '' } = await parseFile(source.path, { ocr: this.ocr }));
      if (source.title) title = source.title;
      type = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(source.path) ? 'image' : 'file';
      const month = new Date().toISOString().slice(0, 7);
      const rel = path.join('files', month, `${sha.slice(0, 8)}_${path.basename(source.path)}`);
      fs.mkdirSync(path.dirname(this._file(rel)), { recursive: true });
      fs.copyFileSync(source.path, this._file(rel));
      file = rel;
      source.sha = sha;
    } else if (source.url) {
      ({ title, text } = await parseUrl(source.url));
      type = 'url';
    } else {
      title = source.title || source.text.split('\n')[0].slice(0, 30) || '文本片段';
      text = source.text;
      type = source.type || 'text';
    }
    if (!text || !text.trim()) throw new Error(this.ocr?.enabled ? '没有识别出文字内容' : '没有文字内容（扫描件/图片需要开启 OCR）');

    const id = newId();
    const mdRel = path.join('md', `${id}.md`);
    fs.mkdirSync(path.dirname(this._file(mdRel)), { recursive: true });
    fs.writeFileSync(this._file(mdRel), `# ${title}\n\n${text}`);
    const parts = chunkMarkdown(text, chunkSize, overlap);
    const chunks = parts.map((p, i) => ({ id: `${id}_${i}`, docId: id, seq: i, heading: p.heading, text: p.text }));
    const doc = {
      id,
      title,
      type,
      file,
      md: mdRel,
      url: source.url || '',
      notePath: source.notePath || '',
      sha: source.sha || '',
      chars: text.length,
      ocr,
      chunks: chunks.length,
      tags: source.tags || [],
      createdAt: new Date().toISOString(),
    };
    ix.docs.push(doc);
    ix.chunks.push(...chunks);
    this._save();
    onProgress({ stage: 'indexed', doc });

    // 可选：向量化（失败不影响入库）
    if (this.llm?.getCreds().embeddingModel) {
      try {
        onProgress({ stage: 'embedding', doc });
        const vec = this._loadVectors();
        for (let i = 0; i < chunks.length; i += 32) {
          const batch = chunks.slice(i, i + 32);
          const embs = await this.llm.embed(batch.map((c) => `${c.heading}\n${c.text}`));
          batch.forEach((c, j) => (vec[c.id] = Buffer.from(new Float32Array(embs[j]).buffer).toString('base64')));
        }
        fs.writeFileSync(this._file('vectors.json'), JSON.stringify(vec));
      } catch (e) {
        this.log('warn', `向量化失败：${e.message}`);
      }
    }
    return { doc, duplicate: false };
  }

  remove(docId) {
    const ix = this.load();
    const doc = ix.docs.find((d) => d.id === docId);
    if (!doc) return false;
    ix.docs = ix.docs.filter((d) => d.id !== docId);
    ix.chunks = ix.chunks.filter((c) => c.docId !== docId);
    for (const rel of [doc.md, doc.file]) if (rel) fs.rmSync(this._file(rel), { force: true });
    if (fs.existsSync(this._file('vectors.json'))) {
      const vec = this._loadVectors();
      for (const k of Object.keys(vec)) if (k.startsWith(docId + '_')) delete vec[k];
      fs.writeFileSync(this._file('vectors.json'), JSON.stringify(vec));
    }
    this._save();
    return true;
  }

  removeByNote(notePath) {
    const doc = this.load().docs.find((d) => d.notePath === notePath);
    if (doc) this.remove(doc.id);
  }

  docPath(doc) {
    return doc.file ? this._file(doc.file) : this._file(doc.md);
  }

  _bm25(query, k) {
    const ix = this.load();
    if (!ix._tok) {
      // 惰性构建倒排统计
      const df = new Map();
      const toks = ix.chunks.map((c) => {
        const t = tokenize(`${c.heading} ${c.text}`);
        new Set(t).forEach((w) => df.set(w, (df.get(w) || 0) + 1));
        return t;
      });
      const avg = toks.reduce((s, t) => s + t.length, 0) / (toks.length || 1);
      ix._tok = { df, toks, avg };
    }
    const { df, toks, avg } = ix._tok;
    const q = [...new Set(tokenize(query))];
    const N = toks.length;
    const scores = [];
    toks.forEach((t, i) => {
      let s = 0;
      const tf = new Map();
      for (const w of t) tf.set(w, (tf.get(w) || 0) + 1);
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
        s += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (t.length / avg)));
      }
      if (s > 0) scores.push([i, s]);
    });
    return scores.sort((a, b) => b[1] - a[1]).slice(0, k);
  }

  async _vector(query, k) {
    if (!this.llm?.getCreds().embeddingModel) return [];
    const vec = this._loadVectors();
    if (!Object.keys(vec).length) return [];
    const [qv] = await this.llm.embed([query]);
    const ix = this.load();
    const norm = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
    const qn = norm(qv);
    const res = [];
    ix.chunks.forEach((c, i) => {
      const b64 = vec[c.id];
      if (!b64) return;
      const buf = Buffer.from(b64, 'base64');
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      let dot = 0;
      for (let j = 0; j < v.length; j++) dot += v[j] * qv[j];
      res.push([i, dot / (norm(v) * qn)]);
    });
    return res.sort((a, b) => b[1] - a[1]).slice(0, k);
  }

  /** 混合检索 → [{docId, title, heading, text, score, ref}] */
  async search(query, topK) {
    const ix = this.load();
    if (!ix.chunks.length) return [];
    const k = topK || this.getOpts().topK;
    const lists = [this._bm25(query, 20)];
    try {
      lists.push(await this._vector(query, 20));
    } catch (e) {
      this.log('warn', `向量检索失败：${e.message}`);
    }
    const fused = new Map();
    for (const list of lists) list.forEach(([i], rank) => fused.set(i, (fused.get(i) || 0) + 1 / (60 + rank)));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([i, score]) => {
        const c = ix.chunks[i];
        const doc = ix.docs.find((d) => d.id === c.docId);
        return { docId: c.docId, title: doc?.title || '', heading: c.heading, text: c.text, score: +score.toFixed(4) };
      });
  }

  /** 迁移知识库目录：复制到新位置（新目录须为空或不存在） */
  static migrate(from, to) {
    if (path.resolve(from) === path.resolve(to) || !fs.existsSync(from)) return false;
    if (fs.existsSync(to) && fs.readdirSync(to).length) return false;
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    return true;
  }
}

module.exports = { KnowledgeBase, SUPPORTED, tokenize, chunkMarkdown };
