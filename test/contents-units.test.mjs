// display:contents 的容器必须被"穿过"，不能把整块 UI 收成一个单元。
//
// 真机上下文（Reddit 帖子的右侧栏与正文）：Reddit 大量使用 Tailwind 的 contents
// 工具类，自绘组件（faceplate-tracker 等）默认也是 inline 排布。旧实现把 contents
// 子元素当成内联元素、用 visibleTextOf 递归收文本，于是
//   <div class="right-sidebar-contents">  → 8927 字 → 一个单元
//   <shreddit-post>                       → 4153 字 → 一个单元
// 整条右侧栏塌成一句话；在「仅译文」模式下这个单元还会把内部原文全部隐藏，
// 于是侧栏直接空掉、正文整篇消失。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

// 结构照着真实页面抄：contents 套 contents，卡片是块级；自定义元素是 inline 却装着整块内容
const HTML = `<!doctype html><html lang="en"><body>
<div id="rail" class="right-sidebar-contents flex-auto">
  <aside style="display:contents">
    <div class="contents" style="display:contents">
      <div class="card" id="c1"><a href="/support">How to Get Support</a></div>
      <div class="card" id="c2"><a href="/discord">Official Discord Server</a></div>
    </div>
  </aside>
</div>
<faceplate-tracker>
  <games-section style="display:inline">
    <div class="game" id="g1">Word Grid daily puzzle</div>
    <div class="game" id="g2">Dice Fight daily puzzle</div>
  </games-section>
</faceplate-tracker>
<p id="plain">A normal paragraph with a <a href="/l">link</a> inside the sentence.</p>
</body></html>`;

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed', mode: 'bilingual',
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
const has = (a, b) => sent.some((t) => t.includes(a) && t.includes(b));
const any = (a) => sent.some((t) => t.includes(a));

await new Promise((r) => { listener({ type: 'translatePage' }, {}, () => r()); });
await sleep(300);

console.log('=== contents 容器 ===');
check('右侧栏没有塌成一个单元', !has('How to Get Support', 'Official Discord Server'),
  sent.find((t) => t.includes('How to Get Support')) || '(没送翻译)');
check('右侧栏每一项各自成单元', any('How to Get Support') && any('Official Discord Server'));
check('容器本身不承载译文', !doc.querySelector('#rail > .irt-translation')
  && !doc.querySelector('faceplate-tracker > .irt-translation'));

console.log('\n=== 内联却装块级内容的自定义元素 ===');
check('游戏区没有塌成一个单元', !has('Word Grid', 'Dice Fight'));
check('游戏区每一项各自成单元', any('Word Grid') && any('Dice Fight'));

console.log('\n=== 回归 ===');
check('段落里的链接仍留在同一句', has('A normal paragraph', 'link'),
  sent.find((t) => t.includes('A normal paragraph')) || '(没送翻译)');
check('段落译文渲染到段落里', !!doc.querySelector('#plain > .irt-translation'));
check('卡片译文渲染到卡片里', !!doc.querySelector('#c1')?.textContent.includes('【译】'));

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
