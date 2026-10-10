// 翻译后页面不能被撑乱（真机：Reddit 帖子页，对照沉浸式翻译的效果）。
//
// 旧实现的三个问题：
//   1. 用户名、版块名、域名、徽标被当句子翻：UnusualCompany1191 → 不寻常的公司1191，r/ClaudeAI → r/克劳德AI；
//   2. 导航项、按钮这类两三个词的短标签也另起一块译文并挂操作条，每项都多出一行；
//   3. 导航、按钮这类页面框架被整页翻译（沉浸式翻译跳过它们）；
//   4. 按钮里没分配 slot 的提示文案（看不见）也被收进单元，凭空塞出一大块译文。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const HTML = `<!doctype html><html lang="en"><body>
<div id="user">UnusualCompany1191</div>
<div id="sub">r/ClaudeAI</div>
<span id="bot" style="display:block">ClaudeAI-mod-bot</span>
<span id="badge" style="display:block">MOD</span>
<div id="domain">tradestation.com</div>
<div id="ago"><faceplate-timeago>3h ago</faceplate-timeago></div>
<div id="label">Official Claude Discord Server</div>
<div id="tiny">Weekly visitors</div>
<nav><a id="navlink" href="/home">Go to the home page</a><button id="navbtn">Log in now</button><h3><button id="navfilter"><span>Input modalities</span></button></h3><div id="checkrow"><span role="checkbox"></span>Text</div></nav>
<button id="realbtn">Submit your application</button>
<button id="filter"><div style="display:flex"><svg></svg><span>Input modalities</span></div><svg></svg></button>
<p id="para" style="font-size:15px">Just noticed a brand new perk in the billing section of your account.</p>
<p id="short">Hey guys,</p>
<p id="inl">Click <button id="inlbtn">here</button> to continue reading the whole article right now.</p>
<div id="card" role="button"><div>An interesting post title about many things</div><div id="cmt">42 comments</div></div>
<div role="menu" id="menu"></div>
<div id="brand">This build is powered by TurboQuant</div>
<div id="wrap"><div id="inner"><div id="clamp2" style="-webkit-line-clamp:2;overflow:hidden"><p id="discp">A model description that the page folds behind a show more control.</p></div></div><button id="more" aria-expanded="false">Show more</button></div>
<div id="clamp" style="-webkit-line-clamp:2;overflow:hidden"><p id="clampp">A long model description that the card clamps to two lines of text.</p></div>
<h2 id="rule" style="display:flex">Do not come here to fix your account problem</h2>
<div id="btn">Open the profile menu here<span id="hint" style="display:none">Expand the user drawer</span></div>
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
    // 模型对品牌名常常原样返回，用来验证「原文照旧显示，不插重复的译文节点」
    return { ok: true, data: msg.texts.map((t) => (/TurboQuant/.test(t) ? t.replace(/<\/?b\d+>/g, '') : '【译】' + t.replace(/<\/?b\d+>/g, ''))) };
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
const any = (a) => sent.some((t) => t.includes(a));
const T = (id) => doc.getElementById(id);
const trans = (id) => doc.querySelector(`#${id} > .irt-translation`);

T('more').addEventListener('click', () => { T('more').__clicked = true; });
await new Promise((r) => { listener({ type: 'translatePage' }, {}, () => r()); });
await sleep(300);

console.log('=== 标识不翻译 ===');
for (const [id, text] of [['user', 'UnusualCompany1191'], ['sub', 'r/ClaudeAI'], ['bot', 'ClaudeAI-mod-bot'],
  ['badge', 'MOD'], ['domain', 'tradestation.com'], ['ago', '3h ago']]) {
  check(`${text} 不送翻译`, !any(text) && !trans(id));
}

console.log('\n=== 短标签就地替换 ===');
check('短标签仍然翻译', !!trans('label'));
check('短标签译文与原文同行', trans('label')?.classList.contains('irt-inline'), trans('label')?.tagName);
check('短标签不挂操作条', !trans('label')?.querySelector('.irt-trans-actions'));
check('正文段落仍另起一块并带操作条', trans('para') && !trans('para').classList.contains('irt-inline')
  && !!trans('para').querySelector('.irt-trans-actions'));
check('很短的 <p> 仍按段落处理', trans('short') && !trans('short').classList.contains('irt-inline'));

check('flex 单元的译文换行独占一行', T('rule').classList.contains('irt-flex-host') && !!trans('rule'));
check('摘要的 line-clamp 被解除，译文不会被裁掉', !!trans('clampp') && T('clamp').classList.contains('irt-unclamp'));
await new Promise((r) => { listener({ type: 'togglePage' }, {}, () => r()); });
check('还原后去掉 flex 换行标记', !T('rule').classList.contains('irt-flex-host'));
check('旁边有页面自己的展开控件时，替用户点展开而不是拆掉折叠', T('more').__clicked === true && !T('clamp2').classList.contains('irt-unclamp'));
check('还原后恢复 line-clamp', !T('clamp').classList.contains('irt-unclamp'));
await new Promise((r) => { listener({ type: 'togglePage' }, {}, () => r()); });
await sleep(300);

console.log('\n=== 看不见的文字不进单元 ===');
check('隐藏提示不送翻译', !any('Expand the user drawer'), sent.find((t) => t.includes('Open the profile')) || '');
check('可见文字仍翻译', any('Open the profile menu here'));

console.log('\n=== 双语模式：页面框架不整页翻译 ===');
check('两三个词的零碎标签跳过', !any('Weekly visitors'));
check('导航里的链接跳过', !any('Go to the home page'));
check('导航里的普通按钮跳过', !any('Log in now'));
check('句子中间的按钮留在句子里', any('Click to continue') === false && sent.some((t) => /^Click <b0>here<\/b0> to continue/.test(t)) && !sent.includes('here'));
check('整张可点击卡片里的零碎文字不翻', any('An interesting post title') && !any('42 comments'));
check('导航里的筛选按钮要翻译', !!trans('navfilter') && trans('navfilter').classList.contains('irt-inline'));
check('导航里的筛选项要翻译', !!trans('checkrow'));
check('按钮以行内方式翻译', any('Submit your application') && trans('realbtn')?.classList.contains('irt-inline')
  && !trans('realbtn')?.querySelector('.irt-trans-actions'));
{
  // 下拉菜单展开：新插入的节点落在 role=menu 里，不能翻
  const item = doc.createElement('p');
  item.textContent = 'Account settings for your profile';
  T('menu').appendChild(item);
  await sleep(200);
  check('菜单里动态插入的项不翻译', !any('Account settings for your profile'));
}
check('模型原样返回时不插重复译文，原文照旧显示',
  T('brand').getAttribute('data-irt-state') === 'done' && !T('brand').querySelector('.irt-translation')
  && T('brand').textContent.trim() === 'This build is powered by TurboQuant');
check('译文记录了原文字号', trans('para')?.style.getPropertyValue('--irt-origin-fs') === '15px');

// 仅译文模式：就地替换，不新增行，所以导航和短标签也翻（对照沉浸式翻译）
console.log('\n=== 仅译文模式：就地替换 ===');
await new Promise((r) => { listener({ type: 'togglePage' }, {}, () => r()); });
cfg.mode = 'translation';
sent.length = 0;
await new Promise((r) => { listener({ type: 'togglePage' }, {}, () => r()); });
await sleep(300);
check('导航链接翻译', any('Go to the home page'));
check('零碎标签翻译', any('Weekly visitors'));
check('按钮文字也翻译', any('Submit your application'));
check('按钮里嵌套的筛选栏标题也翻译', any('Input modalities'));
check('用户名仍不翻译', !any('UnusualCompany1191'));
check('仅译文模式下原样返回的原文不被隐藏', !T('brand').hasAttribute('data-irt-hide-origin'));
check('原文元素记录字号供列表序号使用', T('para').style.getPropertyValue('--irt-origin-fs') === '15px');
const css0 = readFileSync('src/content/styles.css', 'utf8');
check('原文文本节点被单独藏起来（不压字号，免得 ch/em 单位塌掉）',
  /\[data-irt-hide-text\] \{[^}]*display: none !important/.test(css0));
check('译文以行内方式顶替原文', /\[data-irt-hide-origin\] > \.irt-translation \{[^}]*display: inline !important/.test(css0));
check('操作条不占排版空间', /\.irt-trans-actions \{[^}]*position: absolute/.test(css0));
{
  // 原文必须原样留在隐藏 span 里：页面自身的相对单位（14ch、1em）才能照常解析，盒子不会被挤成 0 宽
  const wraps = T('para').querySelectorAll(':scope > [data-irt-hide-text]');
  check('仅译文模式把原文包进隐藏 span', wraps.length > 0 && wraps[0].textContent.includes('Just noticed'),
    `wrap ${wraps.length} 个`);
  check('藏原文时不再给元素压字号', !T('para').style.getPropertyPriority('font-size') && T('para').style.getPropertyValue('font-size') === '15px');
}
{
  // 模拟真实页面：我们的样式表会把仅译文模式下的原文子元素 display:none 藏起来。
  // 若内容指纹因此变化，每次重扫都会误判「内容变了」→ 反复重译、译文节点反复重建。
  const before = sent.length;
  for (const el of doc.querySelectorAll('[data-irt-hide-origin]')) {
    for (const child of el.children) {
      if (!child.classList.contains('irt-translation')) child.style.display = 'none';
    }
  }
  window.dispatchEvent(new window.Event('scroll'));
  await sleep(900);
  check('原文被样式藏起来后，重扫不再误判为内容变化', sent.length === before,
    `又发了 ${sent.length - before} 条`);
}
await new Promise((r) => { listener({ type: 'togglePage' }, {}, () => r()); });
check('还原后清掉原文上的字号变量，原文也合并回普通文本节点',
  !T('para').getAttribute('style')?.includes('--irt-origin-fs')
  && !T('para').querySelector('[data-irt-hide-text]')
  && T('para').childNodes[0].nodeType === 3
  && T('para').textContent.includes('Just noticed'));

console.log('\n=== 译文外观与原文一致 ===');
const css = readFileSync('src/content/styles.css', 'utf8');
const rule = css.match(/\n\.irt-translation \{[^}]*\}/)?.[0] || '';
check('译文继承原文字体与行高', /font: inherit/.test(rule) && /line-height: inherit/.test(rule) && !/line-height: 1\.6/.test(rule));
check('shadow root 内同样继承', /\.irt-translation \{[^}]*font: inherit[^}]*line-height: inherit/.test(
  readFileSync('src/content/index.js', 'utf8')));

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
