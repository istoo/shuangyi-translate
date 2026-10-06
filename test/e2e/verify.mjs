// 真机端到端验证。自己通过 CDP 的 Extensions.loadUnpacked 加载扩展（Chrome 137+ 起
// --load-extension 已失效，但该 CDP 命令仍可用），然后验证：
//   1. service worker 能加载、设置页能渲染
//   2. 把翻译服务指向本地假接口后，真实网页能被整页翻译
//
// 用法：
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9336 --user-data-dir=/tmp/irt-v about:blank &
//   node test/e2e/verify.mjs 9336
import { createServer } from 'node:http';
import { connect, sleep } from './cdp.mjs';

const PORT = process.argv[2] || '9336';
// 也可以指向解压后的发布包，用来验证打包产物本身是否完整可用
const EXT_PATH = process.argv[3] || new URL('../../', import.meta.url).pathname;

let upstreamHits = 0;
const page = (title, body) => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body}</body></html>`;

// 本地服务：GET 返回待翻译网页，POST 扮演 OpenAI 兼容翻译接口
const server = createServer((req, res) => {
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        upstreamHits += 1;
        const payload = JSON.parse(raw);
        const texts = JSON.parse(payload.messages[1].content);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((t) => `【译】${t}`)) } }] }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message } }));
      }
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page('Translation Test', `
    <h1>Machine Translation Test Page</h1>
    <p id="p1">Machine translation investigates the use of software to translate text.</p>
    <p id="p2">Second paragraph with a <a href="/x">link</a> and a <b>bold</b> word inside.</p>
    <ul><li>First list item here.</li><li>Second list item goes here.</li></ul>
    <blockquote>A quoted sentence for testing purposes.</blockquote>`));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
};
const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

// ---------- 加载扩展 ----------
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(version.webSocketDebuggerUrl);

let extId = null;
const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT_PATH });
if (loaded.result?.id) extId = loaded.result.id;
else console.log('   loadUnpacked 未返回 id（可能已加载过）:', JSON.stringify(loaded.error || loaded.result));

// 从扩展的 service worker target 里认领出自己的 id
await sleep(2000);
let swTarget = null;
let sw = null;
for (const t of (await listing()).filter((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
  const client = await Promise.race([connect(t.webSocketDebuggerUrl).catch(() => null), sleep(2000).then(() => null)]);
  if (!client) continue;
  await Promise.race([client.send('Runtime.enable').catch(() => null), sleep(2000)]);
  const name = await Promise.race([client.evalJs('chrome.runtime.getManifest().name').catch(() => ({})), sleep(2000).then(() => ({}))]);
  if (/栖译|翻译/.test(name.value || '')) {
    swTarget = t;
    sw = client;
    extId = extId || t.url.split('/')[2];
    break;
  }
  client.close();
}

check('扩展被 Chrome 接受并启动 service worker', !!sw, swTarget?.url || '(未找到)');
if (!sw) {
  console.log('\n提示：若加载失败，可能是 Chrome 需要 --enable-unsafe-extension-debugging 允许调试扩展。');
  server.close();
  process.exit(1);
}

await sleep(300);
const info = JSON.parse((await sw.evalJs(`JSON.stringify({
  name: chrome.runtime.getManifest().name,
  version: chrome.runtime.getManifest().version,
  id: chrome.runtime.id,
})`)).value || '{}');
console.log('   扩展:', info.name, 'v' + info.version, info.id);
check('service worker 能读到自身 manifest', !!info.name);

// ---------- 打开设置页（同时也是消息客户端） ----------
await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
await sleep(1500);
const optTarget = (await listing()).find((t) => t.url.includes('options.html'));
check('设置页已打开', !!optTarget, optTarget?.url || '');
const opt = await connect(optTarget.webSocketDebuggerUrl);
await opt.send('Runtime.enable');
await sleep(900);

// 消息必须从扩展页面发，service worker 自己发的消息不会分发给它自己
const sendBg = (msg) => opt.evalJs(`new Promise(res => {
  chrome.runtime.sendMessage(${JSON.stringify(msg)}, (r) => {
    if (chrome.runtime.lastError) return res(JSON.stringify({ ok: false, error: chrome.runtime.lastError.message }));
    res(JSON.stringify(r ?? null));
  });
})`);

const cfg = JSON.parse((await sendBg({ type: 'getConfig' })).value || 'null') || {};
check('后台消息链路正常（getConfig）', cfg.ok === true, cfg.error || '');
check('配置是 v2 结构且含档案数组',
  cfg.data?.version === 2 && Array.isArray(cfg.data?.providers),
  (cfg.data?.providers || []).map((p) => p.name).join(' / '));

const errRes = JSON.parse((await sendBg({
  type: 'translate', texts: ['hello'], to: 'zh-CN',
  provider: {
    id: 'x', type: 'custom', name: '不存在的服务', url: 'http://127.0.0.1:9/nope',
    urlTemplate: '{{url}}', headersTemplate: 'Content-Type: application/json',
    bodyTemplate: '{ "q": {{textsJson}} }', responsePath: '',
  },
})).value || '{}');
check('自定义引擎报错信息可读', errRes.ok === false && /不存在的服务/.test(errRes.error || ''), (errRes.error || '').slice(0, 80));

// ---------- 设置页 UI ----------
const dom = JSON.parse((await opt.evalJs(`JSON.stringify({
  engines: [...document.querySelectorAll('#engineSel option')].map(o => o.textContent),
  types: [...document.querySelectorAll('#providerForm select option')].map(o => o.value),
})`)).value || '{}');
check('服务下拉列出档案', (dom.engines || []).length >= 2, (dom.engines || []).join(' / '));
check('类型下拉含全部服务类型', (dom.types || []).length >= 7, (dom.types || []).join(','));

const after = JSON.parse((await opt.evalJs(`(() => {
  const sel = document.getElementById('engineSel');
  sel.value = 'openai';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return new Promise(res => setTimeout(() => res(JSON.stringify({
    labels: [...document.querySelectorAll('#providerForm label')].map(l => l.textContent.trim()),
    adv: !!document.querySelector('#providerForm details'),
    base: document.querySelectorAll('#providerForm input')[1]?.value,
  })), 400));
})()`)).value || '{}');
check('切换档案后动态生成表单字段',
  (after.labels || []).includes('Base URL') && (after.labels || []).includes('术语库'),
  (after.labels || []).join(' / '));
check('高级设置折叠区存在且预填模板', after.adv === true);
check('Base URL 预填默认值', after.base === 'https://api.openai.com/v1', after.base || '');

// ---------- 真实网页翻译 ----------
await sendBg({ type: 'setConfig', patch: { engine: 'e2e', providers: [{
  id: 'e2e', type: 'openai', name: 'E2E 假接口', url: `${SITE}/v1`, apiKey: 'sk-e2e', model: 'mock',
}] } });

await browser.send('Target.createTarget', { url: SITE });
await sleep(2500);
const siteTarget = (await listing()).find((t) => t.url.startsWith(SITE));
check('测试网页已打开', !!siteTarget, siteTarget?.url || '');
const site = await connect(siteTarget.webSocketDebuggerUrl);
await site.send('Runtime.enable');
await sleep(1200);

const injected = JSON.parse((await site.evalJs(`JSON.stringify({
  ball: !!document.querySelector('.irt-ball'),
  styled: !!document.querySelector('style[data-irt], #irt-style') || !!document.querySelector('.irt-ball')?.shadowRoot,
})`)).value || '{}');
check('内容脚本已注入到网页（悬浮球存在）', injected.ball === true);

await site.evalJs(`(() => { document.querySelector('.irt-ball')?.click(); return 1; })()`);
for (let i = 0; i < 25; i++) {
  const n = Number((await site.evalJs(`document.querySelectorAll('.irt-translation').length`)).value || 0);
  if (n >= 5) break;
  await sleep(600);
}

const res = JSON.parse((await site.evalJs(`(() => {
  const nodes = [...document.querySelectorAll('.irt-translation')];
  const t = (sel) => document.querySelector(sel)?.querySelector(':scope > .irt-translation')?.textContent?.trim() || null;
  return JSON.stringify({
    count: nodes.length,
    p1: t('#p1'),
    p2: t('#p2'),
    linkKept: !!document.querySelector('#p2 .irt-translation a'),
    boldKept: !!document.querySelector('#p2 .irt-translation b'),
    noRawPlaceholder: !document.body.textContent.includes('<b0>'),
    upstreamHits: ${upstreamHits},
  });
})()`)).value || '{}');

check('整页翻译产出译文节点', res.count >= 5, String(res.count));
check('首段译文由配置的模型返回', (res.p1 || '').includes('【译】'), (res.p1 || '').slice(0, 50));
check('句中的链接在译文里被保留', res.linkKept === true);
check('句中的加粗标签在译文里被保留', res.boldKept === true);
check('译文不含裸露占位符', res.noRawPlaceholder === true);
check('翻译请求确实打到了配置的服务上', res.upstreamHits > 0, `${res.upstreamHits} 次请求`);

// 还原
await site.evalJs(`(() => { document.querySelector('.irt-ball')?.click(); return 1; })()`);
await sleep(800);
const restored = JSON.parse((await site.evalJs(`JSON.stringify({
  n: document.querySelectorAll('.irt-translation').length,
  original: document.querySelector('#p1')?.textContent.includes('Machine translation investigates'),
  marks: document.querySelectorAll('[data-irt-unit]').length,
})`)).value || '{}');
check('还原后译文清空、原文完好、标记清除',
  restored.n === 0 && restored.original === true && restored.marks === 0, JSON.stringify(restored));

// 控制台错误
const errors = [...opt.events, ...site.events]
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params?.entry?.text || e.params?.exceptionDetails?.text)
  .filter((t) => t && !/favicon/.test(t));
check('页面与设置页无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '));

opt.close();
site.close();
sw.close();
browser.close();
server.close();
console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);