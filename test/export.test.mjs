// 导出双语对照：生成的 Markdown 要忠实反映已翻译的段落，且嵌套结构不能重复。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><head><title>How RAG Works</title></head><body>
<article>
  <h1 id="h1">How Retrieval Augmented Generation Works</h1>
  <p id="p1">Retrieval augmented generation lets a model answer with documents it never saw.</p>
  <div class="wrap"><p id="p2">A nested paragraph that should appear exactly once.</p></div>
  <ul><li id="li1">First list item.</li><li id="li2">Second list item.</li></ul>
  <p id="num">12345</p>
</article></body></html>`;

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed', mode: 'bilingual',
  autoTranslate: false, hoverTranslate: false, hoverHotkey: 'Shift', selectionTranslate: false,
  inputTranslate: false, showFloatBall: false, fontScale: 1, siteRules: {},
  subtitleTranslate: false, subtitleMode: 'bilingual', subtitleFontScale: 1,
};

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://example.com/article' });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const st = window.getComputedStyle(this);
  if (st.display === 'none') return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  return { width: 600, height: 20, top: 100, left: 50, right: 650, bottom: 120, x: 50, y: 100 };
};

let listener = null;
const translateCalls = [];
window.chrome = {
  i18n: makeI18n(),
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      let res = { ok: true };
      if (msg.type === 'getConfig') res = { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
      else if (msg.type === 'translate') {
        translateCalls.push(msg);
        res = { ok: true, data: msg.texts.map((x) => '【译】' + x.replace(/<\/?b\d+>/g, '')) };
      } else if (msg.type === 'setConfig') res = { ok: true, data: cfg };
      cb && cb(res);
      return Promise.resolve(res);
    },
  },
};
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { setTimeout(() => this.cb([{ isIntersecting: true, target: el }], this), 0); }
  unobserve() {} disconnect() {}
};

// 拦截导出：捕获 Blob 内容与文件名
let capturedText = null;
let capturedName = null;
window.Blob = class {
  constructor(parts, opts) { capturedText = parts.join(''); this.type = opts?.type; }
};
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { capturedName = this.download; };

window.eval(readFileSync('src/content/index.js', 'utf8'));
await new Promise((r) => setTimeout(r, 80));

const doc = window.document;
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const send = (msg) => new Promise((r) => listener(msg, {}, r));

console.log('=== 未翻译时导出 ===');
{
  const r = await send({ type: 'exportPage' });
  check('没有译文时给出提示而不是导出空文件', r?.ok === false && /翻译/.test(r.error || ''), r?.error || '');
  check('没有译文时不产生下载', capturedText === null);
}

console.log('\n=== 翻译后导出 ===');
await send({ type: 'translatePage' });
await new Promise((r) => setTimeout(r, 600));

const done = doc.querySelectorAll('[data-irt-state="done"]').length;
check('页面已完成翻译', done >= 4, `${done} 个单元`);

let result = null;
{
  result = await send({ type: 'exportPage' });
  check('导出成功并报告段数', result?.ok === true && result.count >= 4, JSON.stringify(result));
}

const md = capturedText || '';
console.log('  生成内容片段:\n' + md.split('\n').slice(0, 12).map((l) => '    ' + l).join('\n'));

check('文件名取自页面标题', capturedName === 'How RAG Works.md', capturedName || '');
check('以一级标题开头', md.startsWith('# How RAG Works'), md.split('\n')[0]);
check('带来源链接', md.includes('> 来源：https://example.com/article'));
check('原页面标题降级为二级标题', md.includes('## How Retrieval Augmented Generation Works'));
check('正文原文与译文都在', md.includes('Retrieval augmented generation lets a model answer')
  && md.includes('【译】Retrieval augmented generation lets a model answer'));
check('列表项逐条导出', md.includes('First list item.') && md.includes('Second list item.'));
check('纯数字段落被跳过（本来就没被翻译）', !md.includes('12345'));

// 只数"独立成行的原文"：mock 译文是「【译】+ 原文」，直接全文匹配会连译文一起数进来
const nestedOrigLines = md.split('\n')
  .filter((l) => l.trim() === 'A nested paragraph that should appear exactly once.');
check('嵌套段落只导出一次，不重复', nestedOrigLines.length === 1, `独立成行出现 ${nestedOrigLines.length} 次`);

check('导出内容里不含 HTML 译文节点残留', !md.includes('irt-translation') && !md.includes('data-irt'));

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);