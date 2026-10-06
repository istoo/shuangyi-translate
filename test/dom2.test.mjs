// 第二组：真实站点常见的棘手结构
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<!-- 社交媒体式深层 div 嵌套 -->
<div class="feed">
  <div class="tweet"><div><div><div dir="auto" id="tw1">Just shipped a new feature today. Feeling great about it!</div></div></div>
    <div class="meta"><span id="tm1">2h</span><span id="tm2">1.2K</span></div></div>
  <div class="tweet"><div><div><div dir="auto" id="tw2">Another post with a <a href="/x" id="tl">link inside</a> the body text.</div></div></div></div>
</div>
<!-- 导航与按钮 -->
<nav><a href="/home" id="nav1">Home</a><a href="/about" id="nav2">About us</a></nav>
<button id="btn1">Submit your application</button>
<!-- 表单 -->
<form><label id="lb1" for="i1">Your email address</label><input id="i1" type="email" placeholder="Enter email" /></form>
<!-- 混合内联块 -->
<p id="mix">Price is <span class="price" id="pr">$42.00</span> per month, billed annually.</p>
<!-- 已含译文的重复翻译场景 -->
<p id="rep">Repeat translation guard test sentence.</p>
<!-- 极短文本 -->
<p id="short">OK</p><p id="short2">a</p>
<!-- 超长文本 -->
<p id="long">${'This is a very long paragraph. '.repeat(80)}</p>
<!-- 带 style 隐藏 -->
<p id="hidden" style="display:none">Hidden text should be skipped.</p>
</body></html>`;

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://x.com/home' });
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
    calls.push({ batch: msg.texts.length, texts: msg.texts });
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

window.eval(readFileSync('src/content/index.js', 'utf8'));
await sleep(60);
await new Promise(r => listener({ type: 'translatePage' }, {}, r));
await sleep(500);

const doc = window.document;
const T = id => doc.getElementById(id);
const has = id => !!T(id)?.querySelector(':scope > .irt-translation');
const allTexts = () => calls.flatMap(c => c.texts);

let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };

console.log('=== 社交媒体式深层嵌套 ===');
check('推文正文成为独立单元', has('tw1'), (T('tw1').querySelector('.irt-translation')?.textContent || '').slice(0, 30));
check('两条推文各自翻译', has('tw1') && has('tw2'));
check('推文内链接被保留', !!T('tw2')?.querySelector('.irt-translation a'));
check('时间戳"2h"不翻译', !has('tm1'));
check('数字"1.2K"不翻译', !has('tm2'));

console.log('\n=== 导航/按钮/表单 ===');
check('导航长文本翻译', has('nav2'), '(About us)');
check('按钮文本翻译', has('btn1'));
check('label 文本翻译', has('lb1'));
check('input 不被注入译文', !T('i1').querySelector('.irt-translation') && T('i1').children.length === 0);

console.log('\n=== 边界情况 ===');
check('极短文本 "OK" 跳过', !has('short'));
check('单字符跳过', !has('short2'));
check('隐藏元素跳过', !has('hidden'));
check('内联 span 不单独成单元（随父段落一起）', !has('pr') && has('mix'),
  '父段落译文: ' + (T('mix').querySelector('.irt-translation')?.textContent || '').slice(0, 36));
check('超长段落被送翻译', allTexts().some(t => t.length > 500));

console.log('\n=== 批处理 ===');
check('单次请求条数 ≤ 12', calls.every(c => c.batch <= 12), '各批: ' + calls.map(c => c.batch).join(','));
check('无重复送翻译', new Set(allTexts()).size === allTexts().length,
  `${new Set(allTexts()).size}/${allTexts().length}`);

console.log('\n=== 动态内容（无限滚动） ===');
const feed = doc.querySelector('.feed');
const nu = doc.createElement('div');
nu.className = 'tweet';
nu.innerHTML = '<div><div dir="auto" id="tw3">A dynamically appended post arriving after scroll.</div></div>';
feed.appendChild(nu);
await sleep(700);
check('动态插入的节点被自动翻译', has('tw3'),
  (T('tw3')?.querySelector('.irt-translation')?.textContent || '(未翻译)').slice(0, 34));

console.log('\n=== 仅译文模式 ===');
await new Promise(r => listener({ type: 'toggleMode' }, {}, r));
await sleep(80);
check('切换后 html 标记为 translation',
  doc.documentElement.getAttribute('data-irt-on') === 'translation',
  doc.documentElement.getAttribute('data-irt-on') || '(空)');
check('原文节点被标记隐藏', doc.querySelectorAll('[data-irt-hide-origin]').length > 0,
  String(doc.querySelectorAll('[data-irt-hide-origin]').length) + ' 个');

console.log('\n=== 汇总 ===');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
