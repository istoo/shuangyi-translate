// 第三组：维基百科式的公式、引用角标、编辑链接
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<p id="p1">It is the dominant approach today<sup id="ref1" class="reference"><a href="#c1">[1]</a></sup><sup id="ref2" class="reference"><a href="#c2">[2]</a>:&nbsp;1</sup> and can produce translations that rival human output.</p>
<p id="p2">In the translation task, a sentence <span id="math1" class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y"><math><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">{\\displaystyle \\mathbf {x} }</annotation></semantics></math></span><img class="mwe-math-fallback-image-inline" src="x.png" alt="x"></span> is translated into another language.</p>
<h2 id="h1">Approaches<span id="edit1" class="mw-editsection"><a href="/edit">[edit]</a></span></h2>
<p id="p3">A KaTeX case with <span id="k1" class="katex"><span class="katex-mathml">P(y|x)</span></span> inside the sentence.</p>
<p id="p4">Plain paragraph without any special markup at all here.</p>
</body></html>`;

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://en.wikipedia.org/wiki/X' });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const st = window.getComputedStyle(this);
  if (st.display === 'none') return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  return { width: 600, height: 20, top: 0, left: 0, right: 600, bottom: 20, x: 0, y: 0 };
};

let listener = null;
const calls = [];
window.chrome = { runtime: {
  lastError: null,
  onMessage: { addListener: (fn) => { listener = fn; } },
  sendMessage: (msg, cb) => { const r = handle(msg); cb && cb(r); return Promise.resolve(r); },
} };
function handle(msg) {
  if (msg.type === 'getConfig') return { ok: true, data: {
    engine:'google', targetLang:'zh-CN', skipLangs:['zh-CN'], displayStyle:'dashed', mode:'bilingual',
    autoTranslate:false, hoverTranslate:true, hoverHotkey:'Shift', selectionTranslate:true,
    inputTranslate:true, showFloatBall:true, fontScale:1, siteRules:{}, deepl:{}, openai:{} } };
  if (msg.type === 'translate') {
    calls.push(...msg.texts);
    return { ok: true, data: msg.texts.map(t => t.replace(/(^|>)([^<>]+)(?=<|$)/g,
      (m, lead, body) => body.trim() ? lead + '【译】' + body.trim() : m)) };
  }
  return { ok: true };
}
window.chrome.i18n = makeI18n();
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { setTimeout(() => this.cb([{ isIntersecting: true, target: el }], this), 0); }
  unobserve() {} disconnect() {}
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

window.eval(readFileSync('src/content/index.js', 'utf8'));
await sleep(60);
await new Promise(r => listener({ type: 'translatePage' }, {}, r));
await sleep(500);

const doc = window.document;
const T = id => doc.getElementById(id);
const trans = id => T(id)?.querySelector(':scope > .irt-translation')?.textContent || '';
const sent = calls.join('\n');

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };

console.log('=== 引用角标 ===');
check('送翻译的文本不含 "[1]"', !/\[1\]/.test(sent));
check('译文中角标是原节点克隆而非译出的文字',
  T('p1').querySelectorAll('.irt-translation sup.reference').length === 2,
  trans('p1').slice(0, 46));
check('角标本身不被单独翻译', !T('ref1').querySelector('.irt-translation'));
check('译文保留角标占位元素', !!T('p1').querySelector('.irt-translation sup.reference'));

console.log('\n=== 数学公式 ===');
check('送翻译的文本不含 displaystyle', !/displaystyle/.test(sent), sent.match(/.{0,20}displaystyle.{0,10}/)?.[0] || '(无)');
check('译文中公式是原节点克隆（保留 math 结构）',
  !!T('p2').querySelector('.irt-translation .mwe-math-element math'),
  trans('p2').slice(0, 46));
check('公式容器不被单独翻译', !T('math1').querySelector('.irt-translation'));
check('KaTeX 节点原样保留',
  !!T('p3').querySelector('.irt-translation .katex'), trans('p3').slice(0, 46));

console.log('\n=== 编辑链接 ===');
check('[edit] 不送翻译', !/\[edit\]/.test(sent));
check('标题仍被翻译', trans('h1').includes('【译】'), trans('h1').slice(0, 30));

console.log('\n=== 回归 ===');
check('普通段落照常翻译', trans('p4').includes('【译】'));
check('含角标的段落仍被翻译', trans('p1').includes('【译】'));
check('含公式的段落仍被翻译', trans('p2').includes('【译】'));

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
