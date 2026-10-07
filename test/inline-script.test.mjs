// 内联 <script> 的内容绝不能被当作正文送去翻译。
// 实测在 Reddit 上，web component 里有 <span> 包着 <script> 的结构，
// 早先版本用 textContent 取文本，会把 JS 源码吃进来、再插回页面，整页冒代码。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><head><title>Inline Script Test</title></head><body>
<p id="p1">A normal sentence with <b>bold</b> text inside it.</p>
<p id="p2">Inline script host: <span id="host">visible words<script>var SECRET_CODE = "SML.load([1,2,3])";</script></span></p>
<p id="p3"><span>Another one <script>function hidden(){return 42;}</script>with trailing text</span></p>
<pre id="p4"><code>const keep = 1; // must not translate</code></pre>
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
sentTexts.forEach((t, i) => console.log(`  [${i}] ${t.slice(0, 80)}`));

check('正文照常被翻译', sentTexts.some((t) => /A normal sentence/.test(t)));

const leaked = sentTexts.filter((t) => /SECRET_CODE|SML\.load|function hidden|return 42/.test(t));
check('内联 script 的内容没有被送去翻译', leaked.length === 0, leaked.map((t) => t.slice(0, 60)).join(' | '));

// 注意：body.textContent 天然包含 <script> 的文本（script 在 DOM 里，只是不渲染），
// 所以要先把 script 摘掉再看「页面上真正会显示的文本」里有没有代码。
const visibleClone = doc.body.cloneNode(true);
visibleClone.querySelectorAll('script').forEach((n) => n.remove());
const bodyText = visibleClone.textContent || '';
check('页面可见文本里没有冒出 JS 源码', !/SECRET_CODE|SML\.load|function hidden/.test(bodyText),
  (bodyText.match(/.{0,30}(SECRET_CODE|SML\.load)/) || [''])[0]);

const p2trans = doc.getElementById('p2')?.querySelector(':scope > .irt-translation')?.textContent || '';
check('含 script 的段落译文里也没有代码', !/SECRET_CODE|SML\.load/.test(p2trans), p2trans.slice(0, 60));
check('该段落的可见文字仍然被翻译', /visible words/.test(p2trans), p2trans.slice(0, 60));

check('script 标签本身没有被破坏', doc.querySelectorAll('script').length >= 2,
  String(doc.querySelectorAll('script').length));
check('code/pre 内容照旧不翻译', !sentTexts.some((t) => /const keep/.test(t)));

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
