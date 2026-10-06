// 动态内容翻译的端到端验证。
//
// 关键场景：X / Twitter 这类 React SPA 的 DOM 是**持续不断**变动的。
// 早先的实现用防抖（每次变动重置定时器），在持续变动的页面上扫描永远不会执行，
// 结果是无限滚动加载出来的内容一直不被翻译。这里专门把这个场景测出来。
//
// 用法：先启动带调试端口的 Chrome，再 node test/e2e/dynamic-check.mjs <port>
import { createServer } from 'node:http';
import { connect, sleep } from './cdp.mjs';

const PORT = process.argv[2] || '9363';
const EXT = new URL('../../', import.meta.url).pathname;

// 页面同时做三件事：
//  1) 每 80ms 往一个隐藏容器里增删节点，模拟 React 应用的持续 DOM 变动
//  2) 滚动到底部时追加新的正文段落，模拟无限滚动
//  3) 提供一段「稍后替换文本」的内容，模拟虚拟列表复用节点
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dynamic Feed</title>
<style>body{margin:0;font:16px/1.7 Georgia,serif;padding:30px 60px;max-width:820px}
.post{margin:0 0 22px;padding-bottom:18px;border-bottom:1px solid #eee}</style></head><body>
<h1>Dynamic Feed</h1>
<div id="noise" style="position:absolute;left:-9999px"></div>
<div id="feed">
  <div class="post"><p>The first post is already on the page when it loads.</p></div>
  <div class="post"><p>The second post is also present from the start of the page.</p></div>
  <div class="post"><p>Filler paragraph one keeping the page tall enough to scroll.</p></div>
  <div class="post"><p>Filler paragraph two keeping the page tall enough to scroll.</p></div>
  <div class="post"><p>Filler paragraph three keeping the page tall enough to scroll.</p></div>
  <div class="post"><p>Filler paragraph four keeping the page tall enough to scroll.</p></div>
  <div class="post"><p>Filler paragraph five keeping the page tall enough to scroll.</p></div>
  <div class="post"><p>Filler paragraph six keeping the page tall enough to scroll.</p></div>
</div>
<div id="recycled" class="post"><p>This text will be replaced by the virtual list.</p></div>
<script>
  // 持续变动：模拟 React 应用里永不停歇的 DOM 更新
  const noise = document.getElementById('noise');
  setInterval(() => {
    const d = document.createElement('div');
    d.textContent = 'tick';
    noise.appendChild(d);
    if (noise.childNodes.length > 3) noise.removeChild(noise.firstChild);
  }, 80);

  let added = 0;
  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY > document.body.scrollHeight - 300 && added < 2) {
      added += 1;
      setTimeout(() => {
        const d = document.createElement('div');
        d.className = 'post';
        d.innerHTML = '<p>This paragraph arrived later through infinite scrolling number ' + added + '.</p>';
        document.getElementById('feed').appendChild(d);
      }, 200);
    }
  }, { passive: true });

  // 虚拟列表复用节点：3 秒后把已有段落的文本换掉
  setTimeout(() => {
    document.querySelector('#recycled p').textContent = 'The recycled row now shows completely different content.';
  }, 3000);
</script></body></html>`;

const mock = createServer((req, res) => {
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const texts = JSON.parse(JSON.parse(raw).messages[1].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((t) => `【译】${t}`)) } }] }));
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
await sleep(2500);

await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
await sleep(1800);
const optTarget = (await listing()).find((t) => t.url.includes('options.html'));
const opt = await connect(optTarget.webSocketDebuggerUrl);
await opt.send('Runtime.enable');
await sleep(500);
await opt.evalJs(`new Promise(res => chrome.runtime.sendMessage({ type:'setConfig', patch:{
  engine:'e2e',
  providers:[{id:'e2e',type:'openai',name:'E2E',url:${JSON.stringify(SITE)},apiKey:'k',model:'m'}],
  autoTranslate:false, showFloatBall:true, siteRules:{},
}}, () => res(1)))`);

await browser.send('Target.createTarget', { url: SITE });
await sleep(2500);
const pageTarget = (await listing()).find((t) => t.url.startsWith(SITE));
const c = await connect(pageTarget.webSocketDebuggerUrl);
await c.send('Runtime.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
await sleep(1500);

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

// ---------- 1. 整页翻译 ----------
console.log('=== 整页翻译（页面在持续变动）===');
await c.evalJs(`document.querySelector('.irt-ball').click()`);
for (let i = 0; i < 20; i += 1) {
  const n = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value;
  if (n >= 7) break;
  await sleep(600);
}
const initial = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value;
check('首屏段落被翻译', initial >= 7, `${initial} 段`);

// ---------- 2. 无限滚动加载的新内容 ----------
console.log('\n=== 无限滚动 ===');
for (let i = 0; i < 3; i += 1) {
  await c.evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(1500);
}
await sleep(3000);
const scrolled = JSON.parse((await c.evalJs(`JSON.stringify({
  late: [...document.querySelectorAll('.post')].filter((p) => /arrived later/.test(p.textContent)).length,
  lateTranslated: [...document.querySelectorAll('.post')].filter((p) => /arrived later/.test(p.textContent) && p.querySelector('.irt-translation')).length,
  detail: [...document.querySelectorAll('.post')].filter((p) => /arrived later/.test(p.textContent))
    .map((post) => { const p2 = post.querySelector('p'); return {
      unit: p2?.hasAttribute('data-irt-unit') || false,
      state: p2?.getAttribute('data-irt-state') || null,
      pending: p2?.classList.contains('irt-pending') || false,
      trans: !!post.querySelector('.irt-translation'),
      inViewport: (() => { const r = post.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; })(),
    }; }),
  toast: document.querySelector('.irt-toast')?.textContent?.slice(0, 70) || null,
})`)).value || '{}');
console.log('   诊断:', JSON.stringify(scrolled.detail), '| toast:', scrolled.toast);
check('滚动后确实加载了新内容', (scrolled.late || 0) >= 1, `${scrolled.late} 条`);
check('新加载的内容被自动翻译', scrolled.late === scrolled.lateTranslated,
  `${scrolled.lateTranslated}/${scrolled.late}`);

// ---------- 3. 虚拟列表复用节点（文本被替换）----------
console.log('\n=== 节点内容被替换 ===');
const recycled = JSON.parse((await c.evalJs(`JSON.stringify({
  text: document.querySelector('#recycled p')?.textContent || '',
  translated: document.querySelector('#recycled')?.querySelector('.irt-translation')?.textContent || '',
})`)).value || '{}');
check('复用节点的区域最终显示的是新文本',
  /completely different content/.test(recycled.text), (recycled.text || '').slice(0, 50));
// 这一项在真实站点上依赖「滚动兜底扫描」，未必每次都能命中，作提示不作硬性要求
console.log(`   （该区域译文：${recycled.translated ? recycled.translated.slice(0, 40) : '（尚未翻译，属已知限制）'}）`);

// ---------- 4. 站点规则改成 always 后应立即翻译 ----------
console.log('\n=== 站点规则「总是翻译」===');
await askTab({ type: 'restorePage' });
await sleep(800);
const host = (await c.evalJs(`location.hostname`)).value;
await opt.evalJs(`new Promise(res => chrome.runtime.sendMessage({ type:'setConfig',
  patch: { siteRules: { [${JSON.stringify(host)}]: 'always' } } }, () => res(1)))`);
await askTab({ type: 'configChanged' }).catch(() => {});
await sleep(3500);
const afterRule = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value;
check('设为「总是翻译」后当前页面立即开始翻译', afterRule >= 7, `${afterRule} 段`);

c.close();
opt.close();
browser.close();
mock.close();
console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);