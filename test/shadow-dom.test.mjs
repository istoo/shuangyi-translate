// shadow DOM 支持：Reddit、YouTube 这类 web component 站点把正文放在 shadow root 里，
// 只走 light DOM 会漏掉绝大部分内容（Reddit 实测遗漏 21 条内容区域）。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><head><title>Shadow DOM Test</title></head><body>
<p id="light">A plain paragraph living in the light DOM.</p>
<my-widget id="w1"></my-widget>
<my-widget id="w2"></my-widget>
</body></html>`;

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

// 自建两个带 shadow root 的组件
const doc0 = window.document;
for (const [id, text] of [['w1', 'Content that lives inside a shadow root of the first widget.'],
                          ['w2', 'Second shadow host carrying its own separate paragraph text.']]) {
  const host = doc0.getElementById(id);
  const sr = host.attachShadow({ mode: 'open' });
  const p = doc0.createElement('p');
  p.textContent = text;
  sr.appendChild(p);
}

let listener = null;
const sentTexts = [];
window.chrome = {
  i18n: makeI18n(),
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      let res = { ok: true };
      if (msg.type === 'getConfig') res = { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
      else if (msg.type === 'translate') {
        sentTexts.push(...msg.texts);
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

await send({ type: 'translatePage' });
await sleep(600);

console.log('=== 送给翻译的文本 ===');
sentTexts.forEach((t, i) => console.log(`  [${i}] ${t.slice(0, 70)}`));

check('light DOM 的段落照常翻译', doc.getElementById('light')?.querySelector(':scope > .irt-translation')?.textContent?.includes('【译】'));
check('shadow root 里的文本被送去翻译',
  sentTexts.some((t) => /inside a shadow root/.test(t)), sentTexts.join(' | ').slice(0, 80));
check('第二个 shadow host 也被处理',
  sentTexts.some((t) => /Second shadow host/.test(t)));

const sr1 = doc.getElementById('w1').shadowRoot;
const sr2 = doc.getElementById('w2').shadowRoot;
check('译文注入到了 shadow root 内部（而不是宿主外面）',
  sr1.querySelector('.irt-translation')?.textContent?.includes('【译】'),
  sr1.querySelector('.irt-translation')?.textContent?.slice(0, 50) || '(无)');
check('两个 shadow host 都有译文',
  !!sr1.querySelector('.irt-translation') && !!sr2.querySelector('.irt-translation'));
check('译文没有跑到宿主外层的 light DOM 里',
  doc.getElementById('w1').querySelectorAll(':scope > .irt-translation').length === 0);

await send({ type: 'restorePage' });
await sleep(300);

check('还原时 shadow root 里的译文被清理',
  sr1.querySelectorAll('.irt-translation').length === 0 && sr2.querySelectorAll('.irt-translation').length === 0,
  `w1=${sr1.querySelectorAll('.irt-translation').length} w2=${sr2.querySelectorAll('.irt-translation').length}`);
check('还原时 shadow 里的单元标记也被清理',
  sr1.querySelectorAll('[data-irt-unit]').length === 0,
  String(sr1.querySelectorAll('[data-irt-unit]').length));
check('还原后 shadow 里的原文完好',
  /inside a shadow root/.test(sr1.textContent || ''), (sr1.textContent || '').slice(0, 50));

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);