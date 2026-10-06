// 引擎层验证：
// 1) 模板驱动引擎端到端 —— 起一个本地 mock 服务，走完整的模板渲染 → 请求 → 取值 → 归一化链路（必须通过）
// 2) Google 真实调用 —— 依赖网络，失败只提示不视为错误
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { translateTexts } from '../src/bg/engines.js';
import { makeProvider, fillProvider } from '../src/shared/providers.js';

// 引擎的错误消息走 i18n，Node 里需要把它接上
if (!globalThis.chrome) globalThis.chrome = {};
globalThis.chrome.i18n = makeI18n();
import { makeI18n } from './helpers/i18n.mjs';

let fail = 0;

function check(name, fn) {
  try {
    fn();
    console.log('✅', name);
  } catch (e) {
    fail += 1;
    console.log('❌', name, '\n   ', e.message);
  }
}

// ---------- 1. 模板驱动引擎（本地 mock） ----------
let seenRequest = null;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const payload = JSON.parse(raw);
    seenRequest = { url: req.url, auth: req.headers.authorization, payload };
    // 按 OpenAI 协议回包：把待翻译文本原样加前缀，便于校验一一对应
    const texts = JSON.parse(payload.messages[1].content);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(texts.map((t) => `【译】${t}`)) } }],
    }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const provider = fillProvider(makeProvider('openai', {
  id: 'mock', name: 'Mock 服务', url: base, apiKey: 'sk-mock', model: 'mock-model',
}));
const config = { engine: 'mock', providers: [provider] };

const samples = [
  'This is a <b0>bold word</b0> and a <b1>link here</b1> in one sentence.',
  'Machine translation is a sub-field of computational linguistics.',
  'Only one short line.',
];

let out = [];
try {
  out = await translateTexts(samples, { from: 'auto', to: 'zh-CN', config });
} catch (e) {
  console.log('❌ 模板驱动引擎请求失败\n   ', e.message);
  fail += 1;
}

check('返回长度与输入一致', () => assert.equal(out.length, samples.length));
check('逐条对应、占位标签保留', () => {
  assert.deepEqual(out, samples.map((t) => `【译】${t}`));
  assert.ok(/<b0>.*<\/b0>/.test(out[0]));
});
check('请求按预设模板组装（地址、鉴权头、system/user 消息）', () => {
  assert.ok(seenRequest, '服务端应收到请求');
  assert.equal(seenRequest.url, '/v1/chat/completions');
  assert.equal(seenRequest.auth, 'Bearer sk-mock');
  assert.equal(seenRequest.payload.model, 'mock-model');
  assert.equal(seenRequest.payload.temperature, 0);
  assert.equal(seenRequest.payload.messages[0].role, 'system');
  assert.ok(seenRequest.payload.messages[0].content.includes('简体中文'));
  assert.deepEqual(JSON.parse(seenRequest.payload.messages[1].content), samples);
});

{
  const customServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { list: [{ translated: '甲' }, { translated: '乙' }] } }));
  });
  await new Promise((r) => customServer.listen(0, '127.0.0.1', r));
  const custom = {
    id: 'x', type: 'custom', name: '自定义', url: `http://127.0.0.1:${customServer.address().port}/t`,
    urlTemplate: '{{url}}', headersTemplate: 'Content-Type: application/json',
    bodyTemplate: '{"q": {{textsJson}}}', responsePath: 'data.list', method: 'POST',
  };
  try {
    const res = await translateTexts(['a', 'b'], { to: 'zh-CN', config: { engine: 'x', providers: [custom] } });
    check('自定义接口：真数组入参 + 对象数组出参', () => assert.deepEqual(res, ['甲', '乙']));
  } catch (e) {
    fail += 1;
    console.log('❌ 自定义接口调用失败\n   ', e.message);
  }
  customServer.close();
}

{
  // 取值路径配错是最常见的接入失败，必须给出可诊断的错误而不是一片空白
  const badServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"unexpected":"shape"}');
  });
  await new Promise((r) => badServer.listen(0, '127.0.0.1', r));
  const bad = {
    id: 'bad', type: 'custom', name: '错路径', url: `http://127.0.0.1:${badServer.address().port}/t`,
    urlTemplate: '{{url}}', headersTemplate: 'Content-Type: application/json',
    bodyTemplate: '{"q": {{textsJson}}}', responsePath: 'data.list', method: 'POST',
  };
  try {
    await translateTexts(['a'], { to: 'zh-CN', config: { engine: 'bad', providers: [bad] } });
    fail += 1;
    console.log('❌ 取值路径配错时本应抛错');
  } catch (e) {
    check('取值路径配错时报出可诊断的错误', () => assert.ok(e.message.includes('没取到译文'), e.message));
  }
  badServer.close();
}

// 标题要真的传进请求，而不只是停留在提示词函数里
{
  const before = seenRequest;
  await translateTexts(['a paragraph'], { to: 'zh-CN', config, docTitle: 'How RAG Actually Works' });
  check('文档标题随请求一起发给模型', () => {
    assert.notEqual(seenRequest, before, '应当发出新请求');
    assert.ok(seenRequest.payload.messages[0].content.includes('How RAG Actually Works'),
      '系统提示词里应带上文档标题');
    assert.ok(!JSON.parse(seenRequest.payload.messages[1].content).includes('How RAG'),
      '标题不应混进待翻译的正文里');
  });
}

// ---------- 1.5 失败重试 ----------
{
  let hits = 0;
  // 前两次限流，第三次放行，验证退避重试确实生效
  const flaky = createServer((req, res) => {
    hits += 1;
    if (hits <= 2) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const payload = JSON.parse(raw);
      const texts = JSON.parse(payload.messages[1].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((t) => `重试后:${t}`)) } }] }));
    });
  });
  await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
  const flakyProvider = fillProvider(makeProvider('openai', {
    id: 'flaky', name: '限流服务', url: `http://127.0.0.1:${flaky.address().port}/v1`, apiKey: 'sk', model: 'm',
  }));
  try {
    const out = await translateTexts(['hello'], { to: 'zh-CN', config: { engine: 'flaky', providers: [flakyProvider] } });
    check('限流（429）后自动重试并成功', () => {
      assert.deepEqual(out, ['重试后:hello']);
      assert.equal(hits, 3, `应当请求 3 次（首次 + 2 次重试），实际 ${hits} 次`);
    });
  } catch (e) {
    fail += 1;
    console.log('❌ 限流重试测试异常\n   ', e.message);
  }
  flaky.close();
}

{
  let hits = 0;
  const denied = createServer((req, res) => {
    hits += 1;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"invalid api key"}}');
  });
  await new Promise((r) => denied.listen(0, '127.0.0.1', r));
  const deniedProvider = fillProvider(makeProvider('openai', {
    id: 'denied', name: '鉴权失败服务', url: `http://127.0.0.1:${denied.address().port}/v1`, apiKey: 'bad', model: 'm',
  }));
  try {
    await translateTexts(['x'], { to: 'zh-CN', config: { engine: 'denied', providers: [deniedProvider] } });
    fail += 1;
    console.log('❌ 401 本应直接报错');
  } catch (e) {
    check('鉴权失败（401）不重试，立即报错', () => {
      assert.equal(hits, 1, `401 不应重试，实际请求 ${hits} 次`);
      assert.ok(e.message.includes('401'), e.message);
    });
  }
  denied.close();
}

{
  const noKey = fillProvider(makeProvider('openai', { url: base, apiKey: '' }));
  try {
    await translateTexts(['a'], { to: 'zh-CN', config: { engine: 'google', providers: [noKey] }, provider: noKey });
    fail += 1;
    console.log('❌ 未填 API Key 时本应抛错');
  } catch (e) {
    check('未填 API Key 的报错信息明确', () => assert.ok(e.message.includes('API Key'), e.message));
  }
}

server.close();

// ---------- 2. Google 真实调用（依赖网络） ----------
const googleConfig = { engine: 'google', providers: [{ id: 'google', type: 'google', name: 'Google 翻译' }] };
try {
  const real = await translateTexts(samples.slice(0, 2), { from: 'auto', to: 'zh-CN', config: googleConfig });
  console.log('ℹ️  Google 真实调用:', real.length === 2 ? '正常' : `异常（${real.length}/2）`);
  real.forEach((t, i) => console.log(`   [${i}] ${t}`));
} catch (e) {
  console.log('ℹ️  Google 真实调用跳过（无网络或被限流）:', e.message);
}

console.log(`\n=== 汇总 ===\n失败 ${fail}`);
if (fail) process.exit(1);