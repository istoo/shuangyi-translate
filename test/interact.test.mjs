// 第三组：交互路径 —— 划词气泡、输入框翻译、悬停翻译、站点规则
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<p id="para">The quick brown fox jumps over the lazy dog near the river bank.</p>
<textarea id="ta"></textarea>
<input id="inp" type="text" />
<div id="ce" contenteditable="true"></div>
<p id="hoverP">A paragraph that should be translated only on hover.</p>
</body></html>`;

let cfg = {
  engine:'google', targetLang:'zh-CN', skipLangs:['zh-CN'], displayStyle:'dashed', mode:'bilingual',
  autoTranslate:false, hoverTranslate:true, hoverHotkey:'Shift', selectionTranslate:true,
  inputTranslate:true, showFloatBall:true, fontScale:1, siteRules:{}, deepl:{}, openai:{},
};

const dom = new JSDOM(HTML, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://example.com/a' });
const { window } = dom;
window.Element.prototype.getBoundingClientRect = function () {
  const st = window.getComputedStyle(this);
  if (st.display === 'none') return { width:0,height:0,top:0,left:0,right:0,bottom:0,x:0,y:0 };
  return { width: 400, height: 20, top: 100, left: 50, right: 450, bottom: 120, x: 50, y: 100 };
};
window.Range.prototype.getBoundingClientRect = () => ({ width:200,height:18,top:100,left:60,right:260,bottom:118,x:60,y:100 });

let listener = null;
const translateCalls = [];
window.chrome = { runtime: {
  lastError: null,
  onMessage: { addListener: fn => { listener = fn; } },
  sendMessage: (msg, cb) => { const r = handle(msg); cb && cb(r); return Promise.resolve(r); },
} };
function handle(msg) {
  if (msg.type === 'getConfig') return { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
  if (msg.type === 'setConfig') { Object.assign(cfg, msg.patch); return { ok:true, data: cfg }; }
  if (msg.type === 'translate') {
    translateCalls.push(msg.texts);
    return { ok: true, data: msg.texts.map(t => '【译文】' + t.replace(/<\/?b\d+>/g, '')) };
  }
  return { ok: true };
}
window.chrome.i18n = makeI18n();
window.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(el){ setTimeout(()=>this.cb([{isIntersecting:true,target:el}],this),0);} unobserve(){} disconnect(){} };
window.navigator.clipboard = { writeText: () => Promise.resolve() };

window.eval(readFileSync('src/content/index.js', 'utf8'));
await sleep(80);

const doc = window.document;
let pass = 0, fail = 0;
const check = (n, c, e='') => { c ? pass++ : fail++; console.log(`${c?'✅':'❌'} ${n}${e?'  '+e:''}`); };

console.log('=== 悬浮球 ===');
check('悬浮球已注入', !!doc.querySelector('.irt-ball'));
check('悬浮球在 html 下（不受 body 样式影响）', doc.documentElement.querySelector(':scope > .irt-ball') !== null);

console.log('\n=== 划词翻译 ===');
// 模拟选中 #para 的部分文本
const para = doc.getElementById('para');
const range = doc.createRange();
range.selectNodeContents(para);
const sel = window.getSelection();
sel.removeAllRanges(); sel.addRange(range);
para.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
await sleep(150);
const bubble = doc.querySelector('.irt-bubble');
check('划词后出现气泡', !!bubble);
check('气泡内含译文', (bubble?.querySelector('.irt-bubble-body')?.textContent || '').includes('【译文】'),
  (bubble?.querySelector('.irt-bubble-body')?.textContent || '').slice(0, 30));
check('气泡带 data-irt-ignore（不会被自身翻译）', bubble?.hasAttribute('data-irt-ignore'));
// Esc 关闭
doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await sleep(30);
check('Esc 关闭气泡', !doc.querySelector('.irt-bubble'));

console.log('\n=== 输入框翻译（三连空格） ===');
const ta = doc.getElementById('ta');
ta.value = 'Hello world from the input box';
const fireSpace = (el) => el.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
fireSpace(ta); fireSpace(ta); fireSpace(ta);
await sleep(200);
check('textarea 内容被替换为译文', ta.value.startsWith('【译文】'), JSON.stringify(ta.value.slice(0, 34)));

const inp = doc.getElementById('inp');
inp.value = 'Translate this input field please';
fireSpace(inp); fireSpace(inp); fireSpace(inp);
await sleep(200);
check('input 内容被替换为译文', inp.value.startsWith('【译文】'), JSON.stringify(inp.value.slice(0, 30)));

// 只按两次不触发
const before = translateCalls.length;
inp.value = 'Should not translate on two spaces';
fireSpace(inp); fireSpace(inp);
await sleep(150);
check('两次空格不触发翻译', translateCalls.length === before);

// contenteditable
const ce = doc.getElementById('ce');
ce.innerText = 'Editable div content here';
Object.defineProperty(ce, 'isContentEditable', { value: true, configurable: true });
fireSpace(ce); fireSpace(ce); fireSpace(ce);
await sleep(200);
check('contenteditable 被翻译', (ce.innerText || '').startsWith('【译文】'), JSON.stringify((ce.innerText||'').slice(0,28)));

console.log('\n=== 悬停翻译 ===');
const hp = doc.getElementById('hoverP');
// 未按 Shift 时不翻译
hp.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
await sleep(150);
check('未按热键时不翻译', !hp.querySelector('.irt-translation'));
// 按下 Shift 后悬停
doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
hp.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
await sleep(250);
check('按住 Shift 悬停触发翻译', !!hp.querySelector('.irt-translation'),
  (hp.querySelector('.irt-translation')?.textContent || '(无)').slice(0, 28));

console.log('\n=== 站点规则 ===');
cfg.siteRules = { 'example.com': 'never' };
await new Promise(r => listener({ type: 'getState' }, {}, res => { 
  check('getState 返回站点规则', res.rule === 'never', String(res.rule));
  check('getState 返回 host', res.host === 'example.com', res.host);
  r();
}));

console.log('\n=== 汇总 ===');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
