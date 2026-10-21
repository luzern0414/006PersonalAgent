'use strict';
// 图片文字识别（OCR）
//   vision：调用多模态模型（识别质量高，支持表格/手写/图表描述；图片会发送到模型服务）
//   local ：tesseract.js（WASM，离线、不上传；中英文 LSTM 模型随依赖附带）
//   auto  ：模型已配置时优先 vision，失败再用 local
// 本地引擎按需启动，空闲 60 秒后自动销毁释放内存（运行时约 100MB）
const fs = require('node:fs');
const path = require('node:path');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff' };
const IMAGE_EXT = new Set(Object.keys(MIME));
const VISION_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_VISION_BYTES = 8 * 1024 * 1024;

const PROMPT =
  '你是 OCR 引擎。请完整、准确地提取图片中的全部文字，保持原有的段落、列表和表格结构，用 Markdown 输出。' +
  '不要翻译、不要总结、不要补充解释。如果图片中几乎没有文字，用一两句话描述图片内容，并以「[图片描述]」开头。';

/** tesseract 会在中文字符之间插入空格，这里去掉 */
const tidy = (t) =>
  t
    .replace(/([㐀-鿿　-〿＀-￯]) +(?=[㐀-鿿　-〿＀-￯])/g, '$1')
    .replace(/ ([:：,，;；])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

class OCR {
  /**
   * @param {{llm: import('../llm').LLM, getMode: () => string, cacheDir: () => string, log?: Function}} opts
   */
  constructor({ llm, getMode, cacheDir, log = () => {} }) {
    this.llm = llm;
    this.getMode = getMode;
    this.cacheDir = cacheDir;
    this.log = log;
    this.worker = null;
    this.idleTimer = null;
    this.prepare = null; // 可由主进程注入：大图压缩 (buf, mime) => {buf, mime}
  }

  get enabled() {
    return this.getMode() !== 'off';
  }

  /** @returns {Promise<{text: string, engine: 'vision'|'local'}>} */
  async recognize(buf, mime) {
    const mode = this.getMode();
    if (mode === 'off') throw new Error('OCR 已关闭（设置 → 知识库与 OCR）');
    const canVision = this.llm.configured;
    if (mode === 'vision' || (mode === 'auto' && canVision)) {
      try {
        return { text: await this._vision(buf, mime), engine: 'vision' };
      } catch (e) {
        if (mode === 'vision') throw e;
        this.log('warn', `视觉模型 OCR 失败，改用本地引擎：${e.message}`);
      }
    }
    return { text: await this._local(buf), engine: 'local' };
  }

  async _vision(buf, mime) {
    if (this.prepare) ({ buf, mime } = await this.prepare(buf, mime));
    if (!VISION_MIME.has(mime)) throw new Error(`视觉模型不支持 ${mime}`);
    if (buf.length > MAX_VISION_BYTES) throw new Error('图片过大');
    const run = this.llm.traceable((input) => this.llm.vision({ image: buf, mime, prompt: input.prompt }), {
      name: 'ocr_vision',
      run_type: 'chain',
      metadata: { mime, bytes: buf.length },
    });
    const text = (await run({ prompt: PROMPT, mime, bytes: buf.length })).trim();
    this.llm.flush();
    return text.replace(/^```(?:markdown)?\n([\s\S]*?)\n```$/, '$1');
  }

  /** 把随依赖附带的语言模型放到同一目录（tesseract 要求） */
  _langPath() {
    const dir = path.join(this.cacheDir(), 'tessdata');
    fs.mkdirSync(dir, { recursive: true });
    for (const lang of ['chi_sim', 'eng']) {
      const dst = path.join(dir, `${lang}.traineddata.gz`);
      if (fs.existsSync(dst)) continue;
      const src = path.join(path.dirname(require.resolve(`@tesseract.js-data/${lang}`)), '4.0.0_best_int', `${lang}.traineddata.gz`);
      fs.copyFileSync(src, dst);
    }
    return dir;
  }

  async _local(buf) {
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      const T = require('tesseract.js');
      this.worker = T.createWorker('chi_sim+eng', 1, { langPath: this._langPath(), gzip: true, cacheMethod: 'none', logger: () => {} });
    }
    try {
      const w = await this.worker;
      const r = await w.recognize(buf);
      return tidy(r.data.text || '');
    } finally {
      this.idleTimer = setTimeout(() => this.dispose(), 60_000);
    }
  }

  async dispose() {
    clearTimeout(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) (await w.catch(() => null))?.terminate();
  }
}

module.exports = { OCR, IMAGE_EXT, MIME };
