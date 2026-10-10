// 节点复用（虚拟列表）检测。
// X / Reddit 会回收 DOM 节点再填新内容，元素上的 data-irt-unit 还留着，
// 只看标记就会一直跳过它，新内容永远不翻译（Reddit 实测漏 20 多条）。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><head><title>Reuse Test</title></head><body>
<div id="feed">
  <p id="p1">The original paragraph text that will be replaced later on.</p>
  <p id="p2">A second paragraph that stays untouched the whole time.</p>
</div></body></html>`;

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed', mode: 'bilingual',
  autoTranslate: false, hoverTranslate: false, hoverHotkey: 'Shift', selectionTranslate: false,
  inputTranslate: false, showFloatBall: false, fontScale: 1, siteRules: {},
  subtitleTranslate: false, subtitleMode: 'bilingual', subtitleFontScale: 1,
};

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://example.com/a' });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const st = window.getComputedStyle(this);
  if (st.display === 'none') return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  return { width: 600, height: 20, top: 100, left: 50, right: 650, bottom: 120, x: 50, y: 100 };
};

let listener = null;
let failNext = 0;          // 让接下来 N 次翻译请求失败
const sent = [];
window.chrome = {
  i18n: makeI18n(),
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      let res = { ok: true };
      if (msg.type === 'getConfig') res = { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
      else if (msg.type === 'translate') {
        sent.push(...msg.texts);
        if (failNext > 0) { failNext -= 1; res = { ok: false, error: '模拟失败' }; }
        else res = { ok: true, data: msg.texts.map((x) => '【译】' + x.replace(/<\/?b\d+>/g, '')) };
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

window.eval(readFileSync(new URL('../src/content/index.js', import.meta.url), 'utf8'));
await new Promise((r) => setTimeout(r, 80));

const doc = window.document;
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const send = (msg) => new Promise((r) => listener(msg, {}, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transOf = (id) => doc.getElementById(id)?.querySelector(':scope > .irt-translation')?.textContent || '';

await send({ type: 'translatePage' });
await sleep(500);
check('首次翻译成功', transOf('p1').includes('【译】'), transOf('p1').slice(0, 40));

// 模拟虚拟列表复用：抹掉译文、换掉原文文本，但保留元素上的标记
const p1 = doc.getElementById('p1');
p1.removeAttribute('data-irt-state');
p1.querySelector(':scope > .irt-translation')?.remove();
p1.firstChild.nodeValue = 'A completely different paragraph inserted by the virtual list.';

await send({ type: 'translatePage' });
await sleep(800);

check('节点内容被换掉后会重新翻译',
  transOf('p1').includes('【译】') && transOf('p1').includes('completely different'),
  transOf('p1').slice(0, 60));
check('没有被复用的段落不会重复翻译（译文没有叠加）',
  (doc.getElementById('p2').querySelectorAll(':scope > .irt-translation').length === 1),
  String(doc.getElementById('p2').querySelectorAll(':scope > .irt-translation').length));
check('新内容确实被送去了翻译',
  sent.some((t) => /completely different paragraph/.test(t)));

// 用户手改译文不应被误判成「内容变了」
const p2 = doc.getElementById('p2');
const t2 = p2.querySelector(':scope > .irt-translation');
const textNode = [...t2.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
if (textNode) textNode.nodeValue = '我自己改的译文';
await send({ type: 'translatePage' });
await sleep(600);
check('手改译文不会被「复用检测」误判而冲掉',
  transOf('p2').includes('我自己改的译文'), transOf('p2').slice(0, 50));

// 失败过的段落被虚拟列表复用、重译成功后，失败计数必须跟着退回，
// 否则悬浮球会一直挂着失败徽标（stats 只在还原时清零）。
console.log('\n=== 失败计数随重置退回 ===');
{
  failNext = 99;
  const p3 = doc.createElement('p');
  p3.id = 'p3';
  p3.textContent = 'A paragraph that fails first and succeeds after being reused.';
  doc.getElementById('feed').appendChild(p3);
  await send({ type: 'translatePage' });
  await sleep(1400);
  const st1 = await send({ type: 'getState' });
  check('失败后计数记录了错误', st1.stats.error === 1, JSON.stringify(st1.stats));

  failNext = 0;
  // 只换内容，不动我们自己的标记：虚拟列表复用的是节点内容，属性还留着
  p3.textContent = 'A reused node with brand new content that translates just fine.';
  // 走真实的兜底扫描（滚动触发），不能用 translatePage —— 那会顺手把 stats 清零，掩盖问题
  window.dispatchEvent(new window.Event('scroll'));
  await sleep(1000);
  const st2 = await send({ type: 'getState' });
  check('重译成功后错误计数退回', st2.stats.error === 0, JSON.stringify(st2.stats));
  check('重译成功后的译文已就位', transOf('p3').includes('【译】'), transOf('p3').slice(0, 40));
}

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);