// togglePage 消息的返回值必须是「切换之后」的页面状态。
//
// 曾经的 bug：translatePage 是 async，pageTranslated 要等 await loadConfig() 之后才置位，
// 而消息处理器没有等它，直接把当时的 pageTranslated 回给了弹窗。结果是：刚点「翻译页面」，
// 页面确实开始翻译了，弹窗按钮却仍显示「翻译页面」（translated 为 false），像是没生效。
// 真机走查（walkthrough.mjs）里这句话一直是 {"ok":true,"translated":false}。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<p id="p1">The first paragraph explains what this page is about.</p>
<p id="p2">The second paragraph gives a little more detail here.</p>
</body></html>`;

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed', mode: 'bilingual',
  autoTranslate: false, hoverTranslate: false, hoverHotkey: 'Shift', selectionTranslate: false,
  inputTranslate: false, showFloatBall: true, fontScale: 1, siteRules: {}, deepl: {}, openai: {},
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
let deferTranslate = false;
const deferred = [];
window.chrome = { runtime: {
  lastError: null,
  onMessage: { addListener: (fn) => { listener = fn; } },
  sendMessage: (msg, cb) => {
    // deferTranslate：把翻译响应压后，用来复现「请求在飞时用户点了还原」
    if (deferTranslate && msg.type === 'translate') {
      return new Promise((resolve) => {
        deferred.push(() => { const r = handle(msg); cb && cb(r); resolve(r); });
      });
    }
    const r = handle(msg); cb && cb(r); return Promise.resolve(r);
  },
} };
function handle(msg) {
  if (msg.type === 'getConfig') return { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
  if (msg.type === 'setConfig') { Object.assign(cfg, msg.patch); return { ok: true, data: cfg }; }
  if (msg.type === 'translate') {
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

console.log('=== togglePage 的返回状态 ===');

const on = await ask({ type: 'togglePage' });
check('开启翻译后 translated 为 true', on?.translated === true, JSON.stringify(on));

await sleep(200);
check('页面已标记为翻译中', doc.documentElement.getAttribute('data-irt-on') === 'bilingual',
  String(doc.documentElement.getAttribute('data-irt-on')));
check('段落已被翻译', doc.querySelectorAll('.irt-translation').length >= 2,
  `${doc.querySelectorAll('.irt-translation').length} 段`);

const off = await ask({ type: 'togglePage' });
check('再切一次（还原）后 translated 为 false', off?.translated === false, JSON.stringify(off));
check('还原后译文已清空', doc.querySelectorAll('.irt-translation').length === 0);

const again = await ask({ type: 'togglePage' });
check('反复切换后仍然准确', again?.translated === true, JSON.stringify(again));

console.log('\n=== 还原后迟到的响应 ===');
deferTranslate = true;
deferred.length = 0;
await ask({ type: 'translatePage' });
await sleep(120);
check('请求已发出但还没回来', deferred.length === 1, String(deferred.length));
await ask({ type: 'restorePage' });
check('还原后页面没有译文', doc.querySelectorAll('.irt-translation').length === 0);
while (deferred.length) deferred.shift()();
await sleep(200);
check('迟到的响应不再把译文写回页面', doc.querySelectorAll('.irt-translation').length === 0,
  `残留译文节点 ${doc.querySelectorAll('.irt-translation').length} 个`);
check('迟到的响应不留下状态标记', doc.querySelectorAll('[data-irt-state]').length === 0,
  `残留标记 ${doc.querySelectorAll('[data-irt-state]').length} 个`);
deferTranslate = false;

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
