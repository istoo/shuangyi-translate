// 译文操作条：复制、就地编辑、带上下文重译。
// 重译的关键是「绕过缓存 + 带上前后文」——否则 temperature 0 下拿回来的还是同一份旧译文。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><head><title>Retranslate Test</title></head><body>
<p id="p1">First paragraph that only serves as context.</p>
<p id="p2">Second paragraph which will be retranslated.</p>
<p id="p3">Third paragraph that also serves as context.</p>
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
const sent = [];
let translateRound = 0;
window.chrome = {
  i18n: makeI18n(),
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg, cb) => {
      let res = { ok: true };
      if (msg.type === 'getConfig') res = { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
      else if (msg.type === 'translate') {
        sent.push(msg);
        translateRound += 1;
        res = { ok: true, data: msg.texts.map((x) => `【译${translateRound}】${x.replace(/<\/?b\d+>/g, '')}`) };
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
const clipboard = [];
window.navigator.clipboard = { writeText: (text) => { clipboard.push(text); return Promise.resolve(); } };

let exportedText = null;
window.Blob = class { constructor(parts) { exportedText = parts.join(''); } };
window.URL.createObjectURL = () => 'blob:fake';
window.URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () {};

window.eval(readFileSync('src/content/index.js', 'utf8'));
await new Promise((r) => setTimeout(r, 80));

const doc = window.document;
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const send = (msg) => new Promise((r) => listener(msg, {}, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transOf = (id) => doc.getElementById(id)?.querySelector(':scope > .irt-translation')?.textContent || '';
const click = (elm) => elm.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

await send({ type: 'translatePage' });
await sleep(600);
check('页面已翻译', transOf('p2').includes('【译'), transOf('p2'));

// ---------- 操作条 ----------
console.log('\n=== 操作条 ===');
{
  const actions = doc.querySelector('#p2 > .irt-translation > .irt-trans-actions');
  check('译文上挂了操作条', !!actions);
  const acts = [...(actions?.querySelectorAll('.irt-act') || [])].map((b) => b.className.replace('irt-act ', ''));
  check('包含复制 / 编辑 / 重译三个动作',
    acts.includes('irt-act-copy') && acts.includes('irt-act-edit') && acts.includes('irt-act-retranslate'),
    acts.join(', '));
  check('操作条本身不会被整页翻译当成正文', actions?.hasAttribute('data-irt-ignore'));

  // 导出时必须把操作条的符号排除掉
  exportedText = null;
  const r = await send({ type: 'exportPage' });
  check('导出成功', r.ok === true);
  check('导出内容里不含操作条符号', !!exportedText && !/[⧉✎↻]/.test(exportedText),
    JSON.stringify((exportedText || '').slice(0, 80)));
  check('导出内容里含原文与译文',
    (exportedText || '').includes('Second paragraph which will be retranslated.')
    && (exportedText || '').includes('【译'));
}

// ---------- 复制单段 ----------
console.log('\n=== 复制单段 ===');
{
  clipboard.length = 0;
  click(doc.querySelector('#p2 .irt-act-copy'));
  await sleep(120);
  check('复制到了剪贴板', clipboard.length === 1, clipboard.join(' | '));
  check('复制的是纯译文，不含操作条符号',
    clipboard[0].includes('【译') && !/[⧉✎↻]/.test(clipboard[0]), JSON.stringify(clipboard[0]));
}

// ---------- 就地编辑 ----------
console.log('\n=== 就地编辑 ===');
{
  const trans = doc.querySelector('#p2 > .irt-translation');
  click(doc.querySelector('#p2 .irt-act-edit'));
  check('进入编辑态（contenteditable）', trans.getAttribute('contenteditable') === 'true');

  // 模拟真人编辑：只动文本节点，不重建整个节点（重建会把内部元素一并清掉）
  const textNode = [...trans.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim());
  textNode.nodeValue = '我自己改的译文';
  trans.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);

  check('退出编辑态', trans.getAttribute('contenteditable') !== 'true');
  check('译文被替换成修改后的内容', transOf('p2').includes('我自己改的译文'), transOf('p2'));
  check('编辑后仍保留操作条', !!doc.querySelector('#p2 > .irt-translation > .irt-trans-actions'));

  // 编辑过的内容要经得起再次渲染（例如页面里别的段落触发重排）
  const before = transOf('p2');
  await send({ type: 'translatePage' });
  await sleep(400);
  check('再次翻译不会冲掉用户手改的译文', transOf('p2').includes('我自己改的译文'), transOf('p2') || before);
}

// ---------- 带上下文重译 ----------
console.log('\n=== 带上下文重译 ===');
{
  sent.length = 0;
  click(doc.querySelector('#p2 .irt-act-retranslate'));
  await sleep(400);

  const msg = sent.find((m) => m.texts?.length === 1 && /Second paragraph/.test(m.texts[0]));
  check('发出了单段重译请求', !!msg);
  check('重译绕过缓存（noCache）', msg?.noCache === true, String(msg?.noCache));
  check('重译带上前后段落作为上下文',
    Array.isArray(msg?.context) && msg.context.length === 2
    && msg.context.some((x) => /First paragraph/.test(x))
    && msg.context.some((x) => /Third paragraph/.test(x)),
    JSON.stringify(msg?.context || []).slice(0, 120));
  check('重译带上文档标题', msg?.docTitle === 'Retranslate Test', msg?.docTitle || '');
  check('重译结果替换了手动编辑', transOf('p2').includes('【译') && !transOf('p2').includes('我自己改的译文'),
    transOf('p2'));
  check('重译后操作条仍在', !!doc.querySelector('#p2 > .irt-translation > .irt-trans-actions'));
}

// ---------- 首次整页翻译不带 noCache ----------
console.log('\n=== 常规翻译不受影响 ===');
{
  sent.length = 0;
  await send({ type: 'translatePage' });
  await sleep(400);
  check('常规整页翻译不带 noCache', sent.every((m) => !m.noCache), JSON.stringify(sent.map((m) => m.noCache)));
  check('常规整页翻译不带 context', sent.every((m) => m.context === undefined));
}

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);