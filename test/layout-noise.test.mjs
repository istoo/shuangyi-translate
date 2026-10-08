// 翻译后页面不能被撑乱（真机：Reddit 帖子页，对照沉浸式翻译的效果）。
//
// 旧实现的三个问题：
//   1. 用户名、版块名、域名、徽标被当句子翻：UnusualCompany1191 → 不寻常的公司1191，r/ClaudeAI → r/克劳德AI；
//   2. 导航项、按钮这类两三个词的短标签也另起一块译文并挂操作条，每项都多出一行；
//   3. 导航、按钮这类页面框架被整页翻译（沉浸式翻译跳过它们）；
//   4. 按钮里没分配 slot 的提示文案（看不见）也被收进单元，凭空塞出一大块译文。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<div id="user">UnusualCompany1191</div>
<div id="sub">r/ClaudeAI</div>
<span id="bot" style="display:block">ClaudeAI-mod-bot</span>
<span id="badge" style="display:block">MOD</span>
<div id="domain">tradestation.com</div>
<div id="ago"><faceplate-timeago>3h ago</faceplate-timeago></div>
<div id="label">Official Claude Discord Server</div>
<div id="tiny">Weekly visitors</div>
<nav><a id="navlink" href="/home">Go to the home page</a></nav>
<button id="realbtn">Submit your application</button>
<p id="para" style="font-size:15px">Just noticed a brand new perk in the billing section of your account.</p>
<p id="short">Hey guys,</p>
<h2 id="rule" style="display:flex">Do not come here to fix your account problem</h2>
<div id="btn">Open the profile menu here<span id="hint" style="display:none">Expand the user drawer</span></div>
</body></html>`;

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed', mode: 'translation',
  autoTranslate: false, hoverTranslate: false, hoverHotkey: 'Shift', selectionTranslate: false,
  inputTranslate: false, showFloatBall: false, fontScale: 1, siteRules: {}, deepl: {}, openai: {},
};

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://example.com/a' });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  if (window.getComputedStyle(this).display === 'none') {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  }
  return { width: 400, height: 20, top: 100, left: 50, right: 450, bottom: 120, x: 50, y: 100 };
};

let listener = null;
const sent = [];
window.chrome = { runtime: {
  lastError: null,
  onMessage: { addListener: (fn) => { listener = fn; } },
  sendMessage: (msg, cb) => { const r = handle(msg); cb && cb(r); return Promise.resolve(r); },
} };
function handle(msg) {
  if (msg.type === 'getConfig') return { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
  if (msg.type === 'translate') {
    sent.push(...msg.texts);
    return { ok: true, data: msg.texts.map((t) => '【译】' + t.replace(/<\/?b\d+>/g, '')) };
  }
  return { ok: true };
}
window.chrome.i18n = makeI18n();
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { setTimeout(() => this.cb([{ isIntersecting: true, target: el }], this), 0); }
  unobserve() {}
  disconnect() {}
};

window.eval(readFileSync('src/content/index.js', 'utf8'));
await sleep(80);

const doc = window.document;
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const any = (a) => sent.some((t) => t.includes(a));
const T = (id) => doc.getElementById(id);
const trans = (id) => doc.querySelector(`#${id} > .irt-translation`);

await new Promise((r) => { listener({ type: 'translatePage' }, {}, () => r()); });
await sleep(300);

console.log('=== 标识不翻译 ===');
for (const [id, text] of [['user', 'UnusualCompany1191'], ['sub', 'r/ClaudeAI'], ['bot', 'ClaudeAI-mod-bot'],
  ['badge', 'MOD'], ['domain', 'tradestation.com'], ['ago', '3h ago']]) {
  check(`${text} 不送翻译`, !any(text) && !trans(id));
}

console.log('\n=== 短标签就地替换 ===');
check('短标签仍然翻译', !!trans('label'));
check('短标签译文与原文同行', trans('label')?.classList.contains('irt-inline'), trans('label')?.tagName);
check('短标签不挂操作条', !trans('label')?.querySelector('.irt-trans-actions'));
check('正文段落仍另起一块并带操作条', trans('para') && !trans('para').classList.contains('irt-inline')
  && !!trans('para').querySelector('.irt-trans-actions'));
check('很短的 <p> 仍按段落处理', trans('short') && !trans('short').classList.contains('irt-inline'));

check('flex 单元的译文换行独占一行', T('rule').classList.contains('irt-flex-host') && !!trans('rule'));
await new Promise((r) => { listener({ type: 'togglePage' }, {}, () => r()); });
check('还原后去掉 flex 换行标记', !T('rule').classList.contains('irt-flex-host'));
await new Promise((r) => { listener({ type: 'togglePage' }, {}, () => r()); });
await sleep(300);

console.log('\n=== 看不见的文字不进单元 ===');
check('隐藏提示不送翻译', !any('Expand the user drawer'), sent.find((t) => t.includes('Open the profile')) || '');
check('可见文字仍翻译', any('Open the profile menu here'));

console.log('\n=== 页面框架不整页翻译 ===');
check('两三个词的零碎标签跳过', !any('Weekly visitors'));
check('导航里的链接跳过', !any('Go to the home page'));
check('按钮跳过', !any('Submit your application'));

console.log('\n=== 仅译文模式沿用原文字号 ===');
check('译文记录了原文字号', trans('para')?.style.getPropertyValue('--irt-origin-fs') === '15px');

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
