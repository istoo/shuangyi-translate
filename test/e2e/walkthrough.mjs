// 功能走查：把各个交互路径真实跑一遍，找 bug。
// 覆盖：整页翻译/还原/模式切换、悬停、划词、输入框三连空格、悬浮球拖拽、
//       单段操作、站点规则、快捷键。
//
// 用法：先启动带调试端口的 Chrome，再 node test/e2e/walkthrough.mjs <port>
import { createServer } from 'node:http';
import { connect, sleep } from './cdp.mjs';
import { setTestConfig } from './state.mjs';

const PORT = process.argv[2] || '9357';
const EXT = new URL('../../', import.meta.url).pathname;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Walkthrough Page</title>
<style>body{margin:0;font:16px/1.7 Georgia,serif;padding:40px 60px;max-width:900px}
h1{font-size:26px}p{margin:0 0 16px}textarea,input{width:100%;font:14px/1.5 monospace;padding:8px;margin-bottom:14px}
.row{margin:30px 0 14px;padding-top:14px;border-top:1px solid #ddd}</style></head><body>
<h1>Walkthrough Test Page</h1>
<p id="p1">The first paragraph explains what this page is for and why it exists.</p>
<p id="p2">The second paragraph gives a little more detail about the subject matter.</p>
<div class="row"><textarea id="ta" placeholder="textarea"></textarea></div>
<div class="row"><input id="inp" type="text" placeholder="input" /></div>
</body></html>`;

const mock = createServer((req, res) => {
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const texts = JSON.parse(JSON.parse(raw).messages[1].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((x) => `【译】${x}`)) } }] }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${mock.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);
const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
const extId = loaded.result?.id;
console.log('扩展:', extId);
await sleep(2500);

// 先把翻译服务指向假接口
await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
await sleep(1800);
const optTarget = (await listing()).find((t) => t.url.includes('options.html'));
const opt = await connect(optTarget.webSocketDebuggerUrl);
await opt.send('Runtime.enable');
await sleep(600);
await setTestConfig(opt, {
  engine: 'e2e',
  providers: [{ id: 'e2e', type: 'openai', name: 'E2E', url: SITE, apiKey: 'k', model: 'm' }],
  autoTranslate: false, showFloatBall: true, hoverTranslate: true, hoverHotkey: 'Shift',
  selectionTranslate: true, inputTranslate: true, subtitleTranslate: false,
  targetLang: 'zh-CN', mode: 'bilingual',
});

const askTab = (msg) => opt.evalJs(`new Promise(res => {
  chrome.tabs.query({}, (tabs) => {
    const t = tabs.find((x) => (x.url || '').startsWith(${JSON.stringify(SITE)}));
    if (!t) return res(JSON.stringify({ ok:false, error:'no tab' }));
    chrome.tabs.sendMessage(t.id, ${JSON.stringify(msg)}, (r) => {
      if (chrome.runtime.lastError) return res(JSON.stringify({ ok:false, error: chrome.runtime.lastError.message }));
      res(JSON.stringify(r ?? null));
    });
  });
})`);

await browser.send('Target.createTarget', { url: SITE });
await sleep(2500);
const pageTarget = (await listing()).find((t) => t.url.startsWith(SITE));
const c = await connect(pageTarget.webSocketDebuggerUrl);
await c.send('Runtime.enable');
await c.send('Input.enable').catch(() => {});
await sleep(1200);

const ev = async (expr) => JSON.parse((await c.evalJs(expr)).value || '{}');
const click = (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  .then(() => c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }));
const key = (type, opts) => c.send('Input.dispatchKeyEvent', { type, ...opts });

// ---------- 1. 整页翻译 ----------
console.log('\n=== 整页翻译 ===');
{
  const r = await askTab({ type: 'togglePage' });
  check('翻译命令返回成功', JSON.parse(r.value || '{}').ok !== false, r.value || '');
  for (let i = 0; i < 20; i += 1) {
    const n = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value;
    if (n >= 2) break;
    await sleep(600);
  }
  const st = await ev(`JSON.stringify({
    count: document.querySelectorAll('.irt-translation').length,
    p1: document.querySelector('#p1 > .irt-translation')?.textContent || '',
    ballOn: !!document.querySelector('.irt-ball-on'),
    badge: document.querySelector('.irt-ball-badge')?.textContent || '',
    on: document.documentElement.getAttribute('data-irt-on'),
  })`);
  check('段落被翻译', st.count >= 2, `${st.count} 段`);
  check('译文内容正确', st.p1.includes('【译】'), st.p1.slice(0, 50));
  check('悬浮球进入开启态', st.ballOn === true);
  check('翻译完成后徽标清空', st.badge === '', `徽标「${st.badge}」`);
  check('根元素标记了翻译状态', st.on === 'bilingual', st.on);
}

// ---------- 2. 切换仅译文 ----------
console.log('\n=== 模式切换 ===');
{
  await askTab({ type: 'toggleMode' });
  await sleep(500);
  const st = await ev(`JSON.stringify({ on: document.documentElement.getAttribute('data-irt-on'),
    hidden: document.querySelectorAll('[data-irt-hide-origin]').length })`);
  check('切到仅译文模式', st.on === 'translation', st.on);
  check('原文被隐藏（标记了 hide-origin）', st.hidden >= 2, `${st.hidden} 段`);
  await askTab({ type: 'toggleMode' });
  await sleep(400);
  const back = await ev(`JSON.stringify({ on: document.documentElement.getAttribute('data-irt-on') })`);
  check('切回双语对照', back.on === 'bilingual', back.on);
}

// ---------- 3. 还原 ----------
console.log('\n=== 还原 ===');
{
  await askTab({ type: 'togglePage' });
  await sleep(700);
  const st = await ev(`JSON.stringify({
    count: document.querySelectorAll('.irt-translation').length,
    units: document.querySelectorAll('[data-irt-unit]').length,
    text: document.querySelector('#p1')?.textContent || '',
  })`);
  check('译文全部移除', st.count === 0, `${st.count} 个`);
  check('单元标记清除', st.units === 0, `${st.units} 个`);
  check('原文完好', st.text.startsWith('The first paragraph'), st.text.slice(0, 40));
}

// ---------- 4. 悬停翻译 ----------
console.log('\n=== 悬停翻译 ===');
{
  const box = await ev(`(() => { const r = document.querySelector('#p2').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }); })()`);
  // 不按 Shift 先悬停：不应触发
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(500);
  const before = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value;
  check('未按热键时悬停不翻译', before === 0, `${before} 段`);

  // 按住 Shift 再悬停
  await key('keyDown', { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await sleep(900);
  const after = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value;
  check('按住 Shift 悬停触发单段翻译', after >= 1, `${after} 段`);
  await key('keyUp', { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
}

// ---------- 5. 划词翻译 ----------
console.log('\n=== 划词翻译 ===');
{
  await c.evalJs(`(() => {
    const p = document.querySelector('#p1');
    const node = [...p.childNodes].find(n => n.nodeType === 3 && n.nodeValue.trim().length > 10);
    const range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 30);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return 1;
  })()`);
  await sleep(900);
  const st = await ev(`JSON.stringify({
    bubble: !!document.querySelector('.irt-bubble'),
    body: document.querySelector('.irt-bubble-body')?.textContent || '',
    title: document.querySelector('.irt-bubble-title')?.textContent || '',
    copyBtn: !!document.querySelector('.irt-bubble-copy'),
  })`);
  check('划词后弹出气泡', st.bubble === true);
  check('气泡里有译文', st.body.includes('【译】'), st.body.slice(0, 40));
  check('气泡标题正确', st.title.length > 0, st.title);
  check('气泡有复制按钮', st.copyBtn === true);

  await c.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(300);
  const gone = (await c.evalJs(`!!document.querySelector('.irt-bubble')`)).value;
  check('Esc 关闭气泡', gone === false);
}

// ---------- 6. 输入框三连空格 ----------
console.log('\n=== 输入框翻译 ===');
{
  await c.evalJs(`(() => { const t = document.getElementById('ta'); t.focus(); t.value = 'Hello from textarea'; return 1; })()`);
  for (let i = 0; i < 3; i += 1) {
    await key('keyDown', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await key('keyUp', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await sleep(80);
  }
  await sleep(1000);
  const st = await ev(`JSON.stringify({ v: document.getElementById('ta')?.value || '' })`);
  check('三连空格把输入内容译成译文', st.v.includes('【译】'), st.v.slice(0, 50));

  await c.evalJs(`(() => { const t = document.getElementById('inp'); t.focus(); t.value = 'Hello from input'; return 1; })()`);
  await sleep(150);
  for (let i = 0; i < 2; i += 1) {
    await key('keyDown', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await key('keyUp', { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await sleep(80);
  }
  await sleep(900);
  const st2 = await ev(`JSON.stringify({ v: document.getElementById('inp')?.value || '' })`);
  check('两次空格不触发翻译', !st2.v.includes('【译】'), st2.v.slice(0, 40));
}

// ---------- 7. 悬浮球拖拽 ----------
console.log('\n=== 悬浮球拖拽 ===');
{
  await askTab({ type: 'restorePage' });   // 先把悬停留下的译文清掉，避免误判
  await sleep(500);
  const before = await ev(`(() => { const r = document.querySelector('.irt-ball').getBoundingClientRect();
    return JSON.stringify({ y: Math.round(r.top), x: Math.round(r.left + r.width/2) }); })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y - 160, button: 'left' });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: before.x, y: before.y - 160, button: 'left', clickCount: 1 });
  await sleep(500);
  const after = await ev(`(() => { const r = document.querySelector('.irt-ball').getBoundingClientRect();
    return JSON.stringify({ y: Math.round(r.top), translated: document.querySelectorAll('.irt-translation').length }); })()`);
  check('悬浮球可以被拖动', Math.abs(after.y - before.y) > 100, `${before.y} → ${after.y}`);
  check('拖动后没有误触发翻译', after.translated === 0, `${after.translated} 段`);
}

// ---------- 8. 快捷键 ----------
console.log('\n=== 快捷键 ===');
{
  // 注意：CDP 合成的按键不会触发浏览器级的扩展 commands，这里只能验证命令已正确注册。
  // 真实按键需要人工确认（见 README 的手动验收清单）。
  const cmds = JSON.parse((await opt.evalJs(`new Promise(res => chrome.commands.getAll((list) =>
    res(JSON.stringify(list.map((c) => ({ name: c.name, shortcut: c.shortcut }))))))`)).value || '[]');
  const byName = Object.fromEntries(cmds.map((x) => [x.name, x.shortcut]));
  check('翻译/还原命令已注册且绑定了快捷键', !!byName['toggle-translate'], JSON.stringify(byName));
  check('模式切换命令已注册且绑定了快捷键', !!byName['toggle-compare'], JSON.stringify(byName));
  check('两个命令的快捷键不相同', byName['toggle-translate'] !== byName['toggle-compare']);
}

// ---------- 9. 站点规则 ----------
console.log('\n=== 站点规则 ===');
{
  const host = (await c.evalJs(`location.hostname`)).value;
  await opt.evalJs(`new Promise(res => chrome.runtime.sendMessage({ type:'setConfig',
    patch: { siteRules: { [${JSON.stringify(host)}]: 'never' } } }, () => res(1)))`);
  const st = JSON.parse((await askTab({ type: 'getState' })).value || '{}');
  check('站点规则写入并可读回', st.rule === 'never', JSON.stringify(st.rule));
  await opt.evalJs(`new Promise(res => chrome.runtime.sendMessage({ type:'setConfig',
    patch: { siteRules: {} } }, () => res(1)))`);
}

c.close();
opt.close();
browser.close();
mock.close();
console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
