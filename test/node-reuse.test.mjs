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

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);