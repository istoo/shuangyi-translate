// 导出双语对照的端到端验证：真实翻译一个页面 → 触发导出 → 检查落盘的 Markdown。
//
// 用法：先启动带调试端口的 Chrome，再 node test/e2e/export-check.mjs <port>
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { connect, sleep } from './cdp.mjs';
import { setTestConfig } from './state.mjs';

const PORT = process.argv[2] || '9353';
const EXT = new URL('../../', import.meta.url).pathname;
const DOWNLOADS = '/tmp/shuangyi-export-test';

rmSync(DOWNLOADS, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>How Retrieval Augmented Generation Works</title></head><body>
<article>
<h1>How Retrieval Augmented Generation Works</h1>
<p>Retrieval augmented generation lets a language model answer questions using documents it was never trained on.</p>
<p>Chunk size matters more than most teams expect, and top_k should be treated as a tunable parameter.</p>
</article></body></html>`;

// 同一个服务器既提供测试页面，也扮演 OpenAI 兼容的假翻译接口，
// 这样端到端验证不依赖外部翻译服务（免费接口容易限流）
const server = createServer((req, res) => {
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);
await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });

const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
const extId = loaded.result?.id;
check('扩展加载成功', !!extId, extId || JSON.stringify(loaded.error));
await sleep(2500);

// 用一个扩展页面当"客户端"：既给内容脚本发消息，也用来改配置
await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
await sleep(1800);
const cliTarget = (await listing()).find((t) => t.url.includes('options.html'));
const cli = await connect(cliTarget.webSocketDebuggerUrl);
await cli.send('Runtime.enable');
await sleep(600);

const setCfg = await setTestConfig(cli, { engine: 'e2e', providers: [{ id: 'e2e', type: 'openai',
  name: 'E2E 假接口', url: SITE, apiKey: 'sk-e2e', model: 'mock' }] });
check('把翻译服务指向本地假接口', JSON.parse(setCfg.value || '{}').ok === true, setCfg.value || '');

await browser.send('Target.createTarget', { url: SITE });
await sleep(2500);
const pageTarget = (await listing()).find((t) => t.url.startsWith(SITE));
check('测试页面已打开', !!pageTarget);
await sleep(1200);

const askTab = (msg) => cli.evalJs(`new Promise(res => {
  chrome.tabs.query({}, (tabs) => {
    const t = tabs.find((x) => (x.url || '').startsWith(${JSON.stringify(SITE)}));
    if (!t) return res(JSON.stringify({ ok: false, error: 'tab not found' }));
    chrome.tabs.sendMessage(t.id, ${JSON.stringify(msg)}, (r) => {
      if (chrome.runtime.lastError) return res(JSON.stringify({ ok: false, error: chrome.runtime.lastError.message }));
      res(JSON.stringify(r ?? null));
    });
  });
})`);

const before = JSON.parse((await askTab({ type: 'exportPage' })).value || '{}');
check('未翻译时导出被拒绝并给出提示', before.ok === false && /翻译/.test(before.error || ''), before.error || '');

const tr = JSON.parse((await askTab({ type: 'translatePage' })).value || '{}');
check('已触发整页翻译', tr.ok === true);

// 等篇幅翻完
for (let i = 0; i < 30; i += 1) {
  const st = JSON.parse((await askTab({ type: 'getState' })).value || '{}');
  if ((st.stats?.done || 0) >= 3) break;
  await sleep(800);
}

const exported = JSON.parse((await askTab({ type: 'exportPage' })).value || '{}');
check('导出成功并报告段数', exported.ok === true && exported.count >= 3, JSON.stringify(exported));

// 等文件落盘
let files = [];
for (let i = 0; i < 20; i += 1) {
  files = readdirSync(DOWNLOADS).filter((f) => f.endsWith('.md'));
  if (files.length) break;
  await sleep(500);
}
check('Markdown 文件已下载', files.length === 1, files.join(', ') || '(无)');

if (files.length) {
  const md = readFileSync(`${DOWNLOADS}/${files[0]}`, 'utf8');
  check('文件名取自页面标题', files[0] === 'How Retrieval Augmented Generation Works.md', files[0]);
  check('包含标题与来源', md.startsWith('# How Retrieval Augmented Generation Works') && md.includes('> 来源：'));
  check('原文与译文成对出现',
    md.includes('Retrieval augmented generation lets a language model')
    && md.includes('【译】Retrieval augmented generation lets a language model'), '');
  console.log('  导出内容预览:\n' + md.split('\n').slice(0, 10).map((l) => '    ' + l.slice(0, 100)).join('\n'));
}

cli.close();
browser.close();
server.close();
rmSync(DOWNLOADS, { recursive: true, force: true });
console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
