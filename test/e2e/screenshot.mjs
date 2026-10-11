// 自动生成 Chrome Web Store 截图（1280×800）。
// 用真实的 Google 免费引擎翻译一个仿英文技术文章页面，保证截图呈现的是真实效果。
//
// 用法：先启动带调试端口的 Chrome 并加载扩展，再 node test/e2e/screenshot.mjs <port>
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from './cdp.mjs';
import { setTestConfig } from './state.mjs';

const PORT = process.argv[2] || '9338';
const OUT = fileURLToPath(new URL('../../store/screenshots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const ARTICLE = `<!doctype html><html lang="en"><head><title>How Retrieval Augmented Generation Works</title>
<style>
  body { margin:0; font:16px/1.7 Georgia, 'Times New Roman', serif; color:#1a1a1a; background:#fff; }
  .top { border-bottom:1px solid #e6e6e6; padding:14px 0; }
  .top .inner { max-width:760px; margin:0 auto; display:flex; gap:18px; align-items:center;
    font:13px/1 -apple-system, 'Segoe UI', sans-serif; color:#666; }
  .top b { color:#111; font-size:15px; }
  main { max-width:760px; margin:0 auto; padding:36px 0 60px; }
  h1 { font-size:32px; line-height:1.25; margin:0 0 10px; letter-spacing:-.4px; }
  .meta { color:#888; font-size:13px; font-family:-apple-system, sans-serif; margin-bottom:26px; }
  h2 { font-size:20px; margin:30px 0 10px; }
  p { margin:0 0 16px; }
  blockquote { margin:22px 0; padding:2px 0 2px 18px; border-left:3px solid #d8d8d8; color:#444; font-style:italic; }
  ul { padding-left:22px; } li { margin-bottom:7px; }
  code { background:#f4f4f5; padding:1px 5px; border-radius:4px; font:13px/1.4 ui-monospace, Menlo, monospace; }
  a { color:#1a56db; }
</style></head><body>
<div class="top"><div class="inner"><b>Field Notes</b><span>Engineering</span><span>Archive</span><span>About</span></div></div>
<main>
  <h1>How Retrieval Augmented Generation Actually Works</h1>
  <div class="meta">By Dana Whitfield · 8 min read · Updated March 2026</div>
  <p>Retrieval augmented generation, usually shortened to RAG, is a technique that lets a language model
     answer questions using documents it was never trained on. Instead of relying purely on parameters
     memorized during training, the system fetches relevant passages at query time and places them in the
     context window.</p>
  <h2>Why the naive approach fails</h2>
  <p>A model asked about your internal documentation will either refuse to answer or, worse, invent a
     plausible sounding response. This is not a bug in the model. It simply has no access to information
     that was never part of its training data.</p>
  <blockquote>The most common production failure is not retrieval quality. It is that teams never measure
     whether the retrieved passage was actually used in the final answer.</blockquote>
  <h2>The three stages</h2>
  <ul>
    <li><b>Indexing</b> — documents are split into overlapping chunks and embedded into vectors.</li>
    <li><b>Retrieval</b> — the query is embedded, and the nearest chunks are selected by similarity.</li>
    <li><b>Generation</b> — the chunks and the question are handed to the model as a single prompt.</li>
  </ul>
  <p>Chunk size matters more than most teams expect. A chunk that is too small loses the surrounding
     context, while one that is too large dilutes the embedding with irrelevant material. See the
     <a href="#">evaluation guide</a> for a practical starting point.</p>
  <p>Finally, treat <code>top_k</code> as a tunable parameter rather than a constant. Increasing it
     raises recall but also increases the chance that the model attends to a distractor passage.</p>
</main></body></html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(ARTICLE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

const shot = async (client, name) => {
  const r = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(r.result.data, 'base64');
  writeFileSync(OUT + name, buf);
  console.log(`  ${name}  ${(buf.length / 1024).toFixed(0)} KB`);
};

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);

// 找到扩展 id
const swTarget = (await listing()).find((t) => t.type === 'service_worker' && t.url.includes('service-worker.js'));
const extId = swTarget.url.split('/')[2];
console.log('扩展 id:', extId);

// ---------- 先把配置重置为干净的默认值 ----------
// （上一次 e2e 验证会把 providers 整个换成指向本地假接口的档案，
//   只改 engine 不够——对应的档案已经不存在了，会静默回退到第一个档案）
await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
await sleep(2200);
let optTarget = (await listing()).find((t) => t.url.includes('options.html'));
let oc = await connect(optTarget.webSocketDebuggerUrl);
await oc.send('Runtime.enable');
await sleep(600);
const reset = await setTestConfig(oc, {
  engine: 'google',
  providers: [
    { id: 'google', type: 'google', name: 'Google 翻译' },
    { id: 'openai', type: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini', apiKey: 'sk-demo-placeholder', temperature: 0 },
  ],
});
console.log('  配置重置:', reset.value);
await sleep(400);

// ---------- 截图 1：整页双语对照（真实 Google 翻译） ----------
await browser.send('Target.createTarget', { url: SITE });
await sleep(2500);
let page = (await listing()).find((t) => t.url.startsWith(SITE));
let c = await connect(page.webSocketDebuggerUrl);
await c.send('Page.enable');
await c.send('Runtime.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(1500);

// 确认用的是 Google 免费引擎（默认），然后触发整页翻译
const engineOk = await c.evalJs(`document.querySelector('.irt-ball') ? 1 : 0`);
if (!engineOk.value) {
  console.log('  ⚠️ 内容脚本未注入，跳过网页截图');
} else {
  await c.evalJs(`document.querySelector('.irt-ball').click()`);
  for (let i = 0; i < 40; i++) {
    const n = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value || 0;
    if (n >= 10) break;
    await sleep(700);
  }
  await c.evalJs(`window.scrollTo(0, 0)`);
  await sleep(600);
  const n = (await c.evalJs(`document.querySelectorAll('.irt-translation').length`)).value;
  console.log('  译入节点数:', n);
  if (!Number(n)) console.log('  ⚠️ 没有译文，截图无效——请检查引擎配置或网络');
  await shot(c, '01-bilingual-reading.png');
}
c.close();

// ---------- 截图 2：设置页的模型档案 ----------
await oc.send('Page.enable');
await oc.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await sleep(800);
// 选中 OpenAI 档案，并滚动到「翻译服务」区块——模型配置才是这个产品的卖点
await oc.evalJs(`(() => {
  const sel = document.getElementById('engineSel');
  sel.value = 'openai'; sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 1;
})()`);
await sleep(1400);
await oc.evalJs(`document.getElementById('serviceSec').scrollIntoView({ block: 'start' }); window.scrollBy(0, -14);`);
await sleep(700);
await shot(oc, '02-model-profiles.png');

// 再截一张快捷键区块（Chrome 不允许扩展改快捷键，这里展示当前绑定 + 跳转入口）
await oc.evalJs(`document.querySelectorAll('section')[4].scrollIntoView({ block: 'start' }); window.scrollBy(0, -14);`);
await sleep(700);
await shot(oc, '03-shortcuts.png');
oc.close();

// ---------- 截图 4：商店促销图 440×280 ----------
const PROMO = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:440px;height:280px;overflow:hidden}
  body{background:linear-gradient(135deg,#1c2436 0%,#0e1015 100%);color:#fff;
    font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
  .glow{position:absolute;right:-50px;bottom:-60px;width:240px;height:240px;border-radius:50%;
    background:radial-gradient(circle,rgba(56,132,255,.40),transparent 70%)}
  .wrap{position:relative;padding:36px 34px;box-sizing:border-box}
  .brand{display:flex;align-items:center;gap:13px}
  .logo{width:52px;height:52px;border-radius:13px;box-shadow:0 6px 20px rgba(56,132,255,.45);
    background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0%25' stop-color='%236aa9ff'/><stop offset='100%25' stop-color='%232f6ae8'/></linearGradient></defs><rect width='100' height='100' rx='23' fill='url(%23g)'/><rect x='21' y='27' width='58' height='46' rx='14' fill='%23fff'/><rect x='33' y='41' width='30' height='9' rx='4.5' fill='%232f6ae8'/><rect x='33' y='56' width='19' height='9' rx='4.5' fill='%232f6ae8' fill-opacity='.55'/></svg>") center/cover}
  .name{font-size:33px;font-weight:700;letter-spacing:3px}
  .tag{margin-top:19px;font-size:17px;line-height:1.55;color:#b9c4d4}
  .tag b{color:#fff}
  .sub{margin-top:15px;font-size:12.5px;color:#78859a;letter-spacing:.3px}
</style></head><body>
  <div class="glow"></div>
  <div class="wrap">
    <div class="brand"><div class="logo"></div><div class="name">双译</div></div>
    <div class="tag">让网页变成<b>双语对照</b><br>翻译模型由<b>你自己选</b></div>
    <div class="sub">OpenAI 兼容 · Claude · Gemini · Ollama · 自定义接口</div>
  </div>
</body></html>`;

await browser.send('Target.createTarget', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(PROMO) });
await sleep(1500);
const promoTarget = (await listing()).find((t) => t.url.startsWith('data:text/html'));
if (promoTarget) {
  const pc2 = await connect(promoTarget.webSocketDebuggerUrl);
  await pc2.send('Page.enable');
  await pc2.send('Emulation.setDeviceMetricsOverride', { width: 440, height: 280, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  await shot(pc2, '04-promo.png');
  pc2.close();
}

const list = (await listing()).filter((t) => t.type === 'page');
console.log('\n截图输出目录:', OUT);
console.log('页面 target 数:', list.length);
browser.close();
server.close();
process.exit(0);
