// 站点规则与「设置变更」的联动。
//
// 真机反馈的两个问题：
//   1. 页面已经翻好的时候，在弹窗里把站点设成「从不翻译」，页面仍然是译文。
//      configChanged 的分支只判断了「之前开着就重启一次翻译」，没看新规则是不是 never，
//      于是 restorePage() 之后又 translatePage() 把整页重翻了一遍。
//   2. 只改译文样式（虚线下划线 → 实线下划线）也会整页重译：restorePage() 会清掉
//      用户手改过的译文，改个样式就把编辑成果弄丢了。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HOST = 'example.com';
const HTML = `<!doctype html><html lang="en"><body>
<p id="p1">The first paragraph explains what this page is about.</p>
<p id="p2">The second paragraph gives a little more detail here.</p>
</body></html>`;

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed', mode: 'bilingual',
  autoTranslate: false, hoverTranslate: false, hoverHotkey: 'Shift', selectionTranslate: false,
  inputTranslate: false, showFloatBall: false, fontScale: 1, siteRules: {}, deepl: {}, openai: {},
};

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: `https://${HOST}/a` });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  if (window.getComputedStyle(this).display === 'none') {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  }
  return { width: 400, height: 20, top: 100, left: 50, right: 450, bottom: 120, x: 50, y: 100 };
};

let listener = null;
const translateCalls = [];
window.chrome = { runtime: {
  lastError: null,
  onMessage: { addListener: (fn) => { listener = fn; } },
  sendMessage: (msg, cb) => { const r = handle(msg); cb && cb(r); return Promise.resolve(r); },
} };
function handle(msg) {
  if (msg.type === 'getConfig') return { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
  if (msg.type === 'setConfig') { Object.assign(cfg, msg.patch); return { ok: true, data: cfg }; }
  if (msg.type === 'translate') {
    translateCalls.push(...msg.texts);
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
const ask = (msg) => new Promise((res) => { listener(msg, {}, res); });
const transCount = () => doc.querySelectorAll('.irt-translation').length;
const styleOf = (id) => doc.querySelector(`#${id} > .irt-translation`)?.className || '';

// ---------- 1. 设成「从不翻译」应当把页面恢复成原文 ----------
console.log('=== 站点规则：从不翻译 ===');
await ask({ type: 'togglePage' });
await sleep(300);
check('先翻译成功', transCount() >= 2, `${transCount()} 段译文`);

translateCalls.length = 0;
cfg.siteRules[HOST] = 'never';
await ask({ type: 'configChanged' });
await sleep(300);
check('页面回到原文（译文节点被清掉）', transCount() === 0, `还剩 ${transCount()} 段`);
check('去掉 data-irt-on 标记', !doc.documentElement.getAttribute('data-irt-on'),
  String(doc.documentElement.getAttribute('data-irt-on')));
check('还原后没有再发翻译请求（不能边还原边重译）', translateCalls.length === 0,
  JSON.stringify(translateCalls.slice(0, 2)));

// ---------- 2. 设成「总是翻译」应当立刻翻 ----------
console.log('\n=== 站点规则：总是翻译 ===');
delete cfg.siteRules[HOST];
await ask({ type: 'configChanged' });
await sleep(200);
check('清掉规则后仍保持原文', transCount() === 0);

cfg.siteRules[HOST] = 'always';
await ask({ type: 'configChanged' });
await sleep(300);
check('设成总是翻译后立刻翻译', transCount() >= 2, `${transCount()} 段译文`);

// ---------- 3. 只改样式不该整页重译 ----------
console.log('\n=== 改样式不该重译 ===');
translateCalls.length = 0;
cfg.displayStyle = 'underline';
await ask({ type: 'configChanged' });
await sleep(300);
check('没有重新发翻译请求', translateCalls.length === 0, JSON.stringify(translateCalls.slice(0, 2)));
check('译文还在', transCount() >= 2, `${transCount()} 段`);
check('译文样式跟着设置走（无虚线下划线，改实线下划线）',
  /irt-style-underline/.test(styleOf('p1')) && !/irt-style-dashed/.test(styleOf('p1')), styleOf('p1'));

// ---------- 4. 改样式不能冲掉用户手改的译文 ----------
console.log('\n=== 改样式不丢用户编辑 ===');
{
  const trans = doc.querySelector('#p2 > .irt-translation');
  trans.querySelector('.irt-act-edit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(60);
  const textNode = [...trans.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
  textNode.nodeValue = '我自己改的译文';
  trans.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);

  cfg.displayStyle = 'highlight';
  await ask({ type: 'configChanged' });
  await sleep(300);
  check('改样式后手改的译文还在',
    (doc.querySelector('#p2 > .irt-translation')?.textContent || '').includes('我自己改的译文'),
    doc.querySelector('#p2 > .irt-translation')?.textContent || '(没有译文)');
  check('改样式后译文样式已更新',
    /irt-style-highlight/.test(styleOf('p2')) && !/irt-style-underline/.test(styleOf('p2')), styleOf('p2'));
}

// ---------- 5. 改目标语言必须重译 ----------
console.log('\n=== 改目标语言要重译 ===');
translateCalls.length = 0;
cfg.targetLang = 'ja';
await ask({ type: 'configChanged' });
await sleep(300);
check('换目标语言后重新发请求', translateCalls.length > 0);
check('换语言后译文还在（不是空页）', transCount() >= 2, `${transCount()} 段`);

// ---------- 6. 弹窗里切换双语/仅译文也走 configChanged ----------
console.log('\n=== 切换显示模式（走 configChanged） ===');
translateCalls.length = 0;
cfg.mode = 'translation';
await ask({ type: 'configChanged' });
await sleep(200);
check('切到仅译文：html 标记为 translation',
  doc.documentElement.getAttribute('data-irt-on') === 'translation',
  String(doc.documentElement.getAttribute('data-irt-on')));
check('切到仅译文：原文被标记隐藏', doc.querySelectorAll('[data-irt-hide-origin]').length >= 2,
  `${doc.querySelectorAll('[data-irt-hide-origin]').length} 个`);
check('切到仅译文：译文仍在页面上', transCount() >= 2, `${transCount()} 段`);
check('切模式不重译', translateCalls.length === 0, JSON.stringify(translateCalls.slice(0, 2)));

cfg.mode = 'bilingual';
await ask({ type: 'configChanged' });
await sleep(200);
check('切回双语：隐藏标记被清掉', doc.querySelectorAll('[data-irt-hide-origin]').length === 0,
  `${doc.querySelectorAll('[data-irt-hide-origin]').length} 个`);
check('切回双语：译文仍在', transCount() >= 2);

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
