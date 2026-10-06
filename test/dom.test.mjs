import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<article>
  <h1>Machine Translation</h1>
  <p id="p1">Machine translation investigates the use of <a href="/cl">software</a> to translate text.</p>
  <div class="wrap">
    <div><p id="p2">Nested paragraph with <b>bold</b> and <i>italic</i> text inside.</p></div>
    <ul><li id="li1">First list item here.</li><li id="li2">Second list item goes here.</li></ul>
  </div>
  <pre><code id="code1">const x = 1; // must not translate</code></pre>
  <p id="num">123 456 789</p>
  <p id="cn">这是一段中文，不应被翻译。</p>
  <p id="blank">   </p>
  <table><tr><td id="td1">Cell text one</td><td id="td2">Cell text two</td></tr></table>
  <blockquote id="bq">A quoted sentence for testing.</blockquote>
  <div id="deep"><div><div><span id="sp">Deeply nested inline text content.</span></div></div></div>
</article></body></html>`;

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://example.com/page' });
const { window } = dom;

// jsdom 不做布局：给所有元素一个非零尺寸，否则 isVisible 全判 false
window.Element.prototype.getBoundingClientRect = function () {
  return { width: 600, height: 20, top: 0, left: 0, right: 600, bottom: 20, x: 0, y: 0 };
};

let listener = null;
const calls = [];
window.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      const res = handle(msg);
      cb ? cb(res) : null;
      return Promise.resolve(res);
    },
  },
};

function handle(msg) {
  if (msg.type === 'getConfig') return { ok: true, data: {
    engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'], displayStyle: 'dashed',
    mode: 'bilingual', autoTranslate: false, hoverTranslate: true, hoverHotkey: 'Shift',
    selectionTranslate: true, inputTranslate: true, showFloatBall: true, fontScale: 1,
    siteRules: {}, deepl: {}, openai: {} } };
  if (msg.type === 'translate') {
    calls.push(...msg.texts);
    // 模拟译文：保留 <bN> 占位，正文加【译】前缀
    return { ok: true, data: msg.texts.map((t) =>
      t.replace(/(^|>)([^<>]+)(?=<|$)/g, (m, lead, body) =>
        body.trim() ? lead + '【译】' + body.trim() : m)) };
  }
  return { ok: true };
}

// IntersectionObserver：立即判定为可见，模拟滚动到视口
window.chrome.i18n = makeI18n();
window.IntersectionObserver = class {
  constructor(cb) { this.cb = cb; }
  observe(el) { setTimeout(() => this.cb([{ isIntersecting: true, target: el }], this), 0); }
  unobserve() {} disconnect() {}
};

const code = readFileSync(new URL('../src/content/index.js', import.meta.url), 'utf8');
window.eval(code);
await sleep(60);

// 触发整页翻译
await new Promise((resolve) => listener({ type: 'translatePage' }, {}, resolve));
await sleep(400);

const doc = window.document;
const T = (id) => doc.getElementById(id);
const hasTrans = (id) => !!T(id)?.querySelector(':scope > .irt-translation');
const transText = (id) => T(id)?.querySelector(':scope > .irt-translation')?.textContent || '';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};

console.log('=== 段落切分与注入 ===');
check('普通段落被翻译', hasTrans('p1'), transText('p1').slice(0, 40));
check('嵌套段落被翻译', hasTrans('p2'), transText('p2').slice(0, 40));
check('列表项各自成单元', hasTrans('li1') && hasTrans('li2'));
check('表格单元格被翻译', hasTrans('td1') && hasTrans('td2'));
check('引用块被翻译', hasTrans('bq'));
check('深层嵌套文本被翻译', T('deep').querySelectorAll('.irt-translation').length > 0,
  'HTML: ' + T('deep').innerHTML.replace(/\s+/g,' ').slice(0,160));
check('code/pre 不翻译', !hasTrans('code1') && !calls.some((t) => t.includes('const x = 1')));
check('纯数字段落跳过', !hasTrans('num'));
check('中文段落跳过（目标为中文）', !hasTrans('cn'));
check('空白段落跳过', !hasTrans('blank'));

console.log('\n=== 内联标签保留 ===');
const p1Trans = T('p1').querySelector(':scope > .irt-translation');
check('译文中链接被还原为 <a>', !!p1Trans?.querySelector('a'), p1Trans?.querySelector('a')?.getAttribute('href') || '');
const p2Trans = T('p2').querySelector(':scope > .irt-translation');
check('译文中 <b>/<i> 被还原', !!p2Trans?.querySelector('b') && !!p2Trans?.querySelector('i'));
check('译文不含裸露占位符', !doc.body.textContent.includes('<b0>') && !/【译】.*b\d>/.test(transText('p1')));

console.log('\n=== 去重与还原 ===');
const before = doc.querySelectorAll('.irt-translation').length;
await new Promise((r) => listener({ type: 'translatePage' }, {}, r));
await sleep(200);
check('重复翻译不产生重复译文节点', doc.querySelectorAll('.irt-translation').length === before,
  `${before} → ${doc.querySelectorAll('.irt-translation').length}`);

await new Promise((r) => listener({ type: 'restorePage' }, {}, r));
await sleep(50);
check('还原后译文节点清空', doc.querySelectorAll('.irt-translation').length === 0);
check('还原后原文完整', T('p1').textContent.includes('Machine translation investigates'));
check('还原后标记属性清除', doc.querySelectorAll('[data-irt-unit]').length === 0);

console.log('\n=== 汇总 ===');
console.log(`通过 ${pass} / 失败 ${fail}`);
console.log('实际送翻译的文本条数:', new Set(calls).size);
console.log('样例:', [...new Set(calls)].slice(0, 4).map(s => JSON.stringify(s.slice(0, 70))).join('\n       '));
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
