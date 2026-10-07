// PDF 翻译的端到端验证：现场生成一个真实 PDF → 注入阅读页 → 解析 → 翻译 → 检查结果。
// PDF 由 Chrome 的 printToPDF 生成，保证是真实带文本层的文件。
//
// 用法：先启动带调试端口的 Chrome，再 node test/e2e/pdf-check.mjs <port>
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect, sleep } from './cdp.mjs';
import { setTestConfig } from './state.mjs';

const PORT = process.argv[2] || '9355';
const EXT = new URL('../../', import.meta.url).pathname;
const TMP = '/tmp/shuangyi-pdf-test';

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// 用来生成 PDF 的内容：一个标题 + 两段正文 + 一个小标题
const SOURCE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:12pt/1.6 Georgia,serif;margin:60px}
h1{font-size:20pt;margin:0 0 18px}
h2{font-size:14pt;margin:26px 0 10px}
p{margin:0 0 14px}
</style></head><body>
<h1>Working with Vector Embeddings</h1>
<p>A vector embedding is a dense numeric representation that places semantically similar
items close together in a high dimensional space. Most practical systems rely on them.</p>
<p>Distance metrics matter more than most tutorials admit. Cosine similarity ignores
magnitude entirely, which is usually what you want when comparing text documents.</p>
<h2>Practical Notes</h2>
<p>Normalise your vectors before you compare them, and treat the choice of metric as a
detail you can revisit once the retrieval quality has been measured end to end.</p>
</body></html>`;

// 假翻译服务：让链路不依赖外部接口
const mock = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try {
      const texts = JSON.parse(JSON.parse(raw).messages[1].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((x) => `【译】${x}`)) } }] }));
    } catch (e) {
      res.writeHead(400); res.end('{}');
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK_URL = `http://127.0.0.1:${mock.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);
const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
const extId = loaded.result?.id;
check('扩展加载成功', !!extId, extId || JSON.stringify(loaded.error));
await sleep(2500);

// ---------- 1. 生成真实 PDF ----------
const src = await browser.send('Target.createTarget', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(SOURCE_HTML) });
await sleep(1200);
const srcTarget = (await listing()).find((t) => t.id === src.result.targetId);
const sc = await connect(srcTarget.webSocketDebuggerUrl);
await sc.send('Page.enable');
await sleep(500);
const pdf = await sc.send('Page.printToPDF', { printBackground: true });
const pdfPath = `${TMP}/sample.pdf`;
writeFileSync(pdfPath, Buffer.from(pdf.result.data, 'base64'));
check('生成了测试 PDF', existsSync(pdfPath));
sc.close();
await browser.send('Target.closeTarget', { targetId: src.result.targetId });

// ---------- 2. 打开 PDF 阅读页并注入文件 ----------
await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/pdf/pdf.html` });
await sleep(2200);
const pageTarget = (await listing()).find((t) => t.url.includes('src/pdf/pdf.html'));
check('PDF 阅读页已打开', !!pageTarget);
const c = await connect(pageTarget.webSocketDebuggerUrl);
await c.send('Runtime.enable');
await c.send('DOM.enable');
await c.send('Page.enable');

// 把翻译服务指向假接口
const cfg = await setTestConfig(c, { engine: 'e2e', providers: [{ id: 'e2e', type: 'openai',
  name: 'E2E 假接口', url: MOCK_URL, apiKey: 'k', model: 'm' }] });
check('翻译服务已指向本地假接口', JSON.parse(cfg.value || '{}').ok === true);

// 注入 PDF 文件
const doc = await c.send('DOM.getDocument', { depth: -1 });
const node = await c.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
await c.send('DOM.setFileInputFiles', { files: [pdfPath], nodeId: node.result.nodeId });
await c.evalJs(`document.getElementById('fileInput').dispatchEvent(new Event('change', { bubbles: true }))`);

// ---------- 3. 等解析 ----------
let parsed = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(700);
  const r = JSON.parse((await c.evalJs(`JSON.stringify({
    paras: document.querySelectorAll('.para').length,
    headings: document.querySelectorAll('.para.heading').length,
    status: document.getElementById('status')?.textContent || '',
    hidden: document.getElementById('content')?.hidden,
  })`)).value || '{}');
  if (r.paras > 0 || /失败/.test(r.status)) { parsed = r; break; }
}

check('PDF 解析出段落', (parsed?.paras || 0) >= 4, `段落 ${parsed?.paras}｜状态「${parsed?.status}」`);
// 只有明显更大的字号才算标题：测试文档里的 h2 只比正文大 17%，保守地不判为标题
check('主标题被单独识别出来', (parsed?.headings || 0) >= 1, `标题 ${parsed?.headings} 个`);

const texts = JSON.parse((await c.evalJs(`JSON.stringify({
  title: document.querySelector('.doc-title')?.textContent || '',
  headings: [...document.querySelectorAll('.para.heading .orig')].map((e) => e.textContent),
  firstBody: document.querySelector('.para:not(.heading) .orig')?.textContent || '',
  summary: document.getElementById('summary')?.textContent || '',
})`)).value || '{}');
check('文档标题取自文件名', texts.title === 'sample', texts.title);
check('识别出的标题内容正确',
  (texts.headings || []).some((h) => /Working with Vector Embeddings/.test(h)),
  JSON.stringify(texts.headings || []));
check('正文段落被合并完整（没有硬换行残留）',
  /dense numeric representation/.test(texts.firstBody) && !texts.firstBody.includes('\n'),
  (texts.firstBody || '').slice(0, 70));

// ---------- 4. 翻译 ----------
await c.evalJs(`document.getElementById('translateAll').click()`);
let translated = 0;
for (let i = 0; i < 25; i += 1) {
  await sleep(600);
  translated = Number((await c.evalJs(`document.querySelectorAll('.para .trans:not(:empty)').length`)).value || 0);
  const failed = Number((await c.evalJs(`document.querySelectorAll('.para .trans.error').length`)).value || 0);
  if (failed) break;
  if (translated >= (parsed?.paras || 0)) break;
}
check('所有段落都拿到了译文', translated >= (parsed?.paras || 0), `${translated}/${parsed?.paras}`);

const trans = JSON.parse((await c.evalJs(`JSON.stringify({
  sample: document.querySelector('.para:not(.heading) .trans')?.textContent || '',
  headingsTranslated: [...document.querySelectorAll('.para.heading .trans')].every((e) => e.textContent.trim().length > 0),
})`)).value || '{}');
check('译文内容正确', trans.sample.startsWith('【译】') && /dense numeric representation/.test(trans.sample),
  (trans.sample || '').slice(0, 60));
check('标题也被翻译', trans.headingsTranslated === true);

const shot = await c.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/pdf-page.png', Buffer.from(shot.result.data, 'base64'));
console.log('   截图: /tmp/pdf-page.png');

c.close();
browser.close();
mock.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
