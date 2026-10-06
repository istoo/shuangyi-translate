// 失败恢复：自动重投一次、连续失败后给出可点击的重试入口、不会无限重试。
// 这是最容易在真实网络环境下暴露问题的路径。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<p id="p1">First paragraph to translate for the retry test.</p>
<p id="p2">Second paragraph to translate for the retry test.</p>
</body></html>`;

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed', mode: 'bilingual',
  autoTranslate: false, hoverTranslate: true, hoverHotkey: 'Shift', selectionTranslate: true,
  inputTranslate: true, showFloatBall: true, fontScale: 1, siteRules: {},
};

let failNext = 0;          // 接下来多少次翻译请求要失败
let requestCount = 0;
const sentTexts = [];

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://example.com/a' });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const st = window.getComputedStyle(this);
  if (st.display === 'none') return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  return { width: 400, height: 20, top: 100, left: 50, right: 450, bottom: 120, x: 50, y: 100 };
};

let listener = null;
window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => { const r = handle(msg); cb && cb(r); return Promise.resolve(r); },
  },
};
function handle(msg) {
  if (msg.type === 'getConfig') return { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
  if (msg.type === 'setConfig') { Object.assign(cfg, msg.patch); return { ok: true, data: cfg }; }
  if (msg.type === 'translate') {
    requestCount += 1;
    sentTexts.push(...msg.texts);
    if (failNext > 0) {
      failNext -= 1;
      return { ok: false, error: '模拟网络故障' };
    }
    return { ok: true, data: msg.texts.map((t) => '【译文】' + t) };
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
await sleep(80);

const doc = window.document;
let pass = 0;
let fail = 0;
const check = (n, c, e = '') => { c ? pass++ : fail++; console.log(`${c ? '✅' : '❌'} ${n}${e ? '  ' + e : ''}`); };

const transCount = () => doc.querySelectorAll('.irt-translation').length;
const retryCount = () => doc.querySelectorAll('.irt-retry').length;

const translatePage = () => new Promise((r) => listener({ type: 'translatePage' }, {}, r));
const restorePage = () => new Promise((r) => listener({ type: 'restorePage' }, {}, r));
const errCount = () => doc.querySelectorAll('[data-irt-state="error"]').length;

// ---------- 场景 1：失败一次后自动重投成功 ----------
console.log('=== 失败一次：自动重投 ===');
failNext = 1;
requestCount = 0;
await translatePage();
await sleep(2600);   // 等待 120ms 批处理 + 1500ms 重投延迟

check('失败后自动重投，最终翻译成功', transCount() === 2, `译文节点 ${transCount()} 个`);
check('重投成功时不显示重试入口', retryCount() === 0, `重试入口 ${retryCount()} 个`);
check('确实重试了（共 2 次请求）', requestCount === 2, `请求 ${requestCount} 次`);
check('没有段落被标记为失败', errCount() === 0, `失败标记 ${errCount()} 个`);

// ---------- 场景 2：连续失败后给出重试入口 ----------
console.log('\n=== 连续失败：可点击重试 ===');
await restorePage();
failNext = 5;        // 足够让「首次 + 自动重投」全部失败
requestCount = 0;
await translatePage();
await sleep(2600);

check('连续失败后段落被标记为错误', errCount() === 2, `失败标记 ${errCount()} 个`);
check('给出可点击的重试入口', retryCount() === 2, `重试入口 ${retryCount()} 个`);
check('自动重投只做一次，不会无限重试', requestCount === 2, `请求 ${requestCount} 次`);
check('重试入口可键盘聚焦（无障碍）',
  doc.querySelector('.irt-retry')?.getAttribute('role') === 'button'
  && doc.querySelector('.irt-retry')?.getAttribute('tabindex') === '0');

// 点击重试（此时服务已恢复）
const retryEl = doc.querySelector('.irt-retry');
retryEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
await sleep(700);

check('点击重试后该段翻译成功', transCount() >= 1, `译文节点 ${transCount()} 个`);
check('重试成功后入口消失', retryCount() <= 1, `剩余入口 ${retryCount()} 个`);
check('重试请求带上了原文', sentTexts.some((t) => /First paragraph to translate/.test(t)));

// ---------- 场景 3：还原时清理干净 ----------
console.log('\n=== 还原清理 ===');
failNext = 99;
await restorePage();
await translatePage();
await sleep(2600);
check('失败状态下确实留下了标记', retryCount() > 0);
await restorePage();
check('还原后重试入口被清理', retryCount() === 0 && errCount() === 0,
  `入口 ${retryCount()}，错误标记 ${errCount()}`);
check('还原后单元标记也被清理', doc.querySelectorAll('[data-irt-unit]').length === 0);

// ---------- 场景 4：悬浮球错误提示 ----------
console.log('\n=== 悬浮球状态 ===');
failNext = 99;
await translatePage();
await sleep(2600);
check('全部失败时悬浮球显示错误态', !!doc.querySelector('.irt-ball-error'));
check('悬浮球徽标提示失败', doc.querySelector('.irt-ball-badge')?.textContent === '!',
  doc.querySelector('.irt-ball-badge')?.textContent);
await restorePage();
check('还原后错误态清除', !doc.querySelector('.irt-ball-error'));

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }