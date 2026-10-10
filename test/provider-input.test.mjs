// 服务档案里手填的地址与密钥要能容错。真机反馈：用户在设置页填了阿里云百炼
// （DashScope 兼容模式）的地址与密钥，点「测试当前服务」得到的却是一句
// 「Incorrect API key provided」，看不出是哪里填错了。这里锁住三类问题：
//   1. 粘贴带进来的空格换行 —— 密钥成了 "Bearer  sk-…"，服务端按无效密钥处理
//   2. 地址结尾多一个斜杠 —— 拼出 .../v1//chat/completions，网关直接 404
//   3. 失败响应只把整坨 JSON 甩给用户，不告诉他是密钥还是地址的问题
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeI18n } from './helpers/i18n.mjs';

// engines.js 的错误文案走 i18n，Node 里要先把它接上再 import
globalThis.chrome = { i18n: makeI18n() };
const { translateTexts } = await import('../src/bg/engines.js');
const { makeProvider, fillProvider } = await import('../src/shared/providers.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('✅', name);
  } catch (e) {
    fail += 1;
    console.log('❌', name, '\n   ', e.message);
  }
}

// ---------- mock 服务：按 OpenAI 协议回包，同时记下收到的请求 ----------
let seen = null;
let replyStatus = 200;
let replyBody = null;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const payload = JSON.parse(raw);
    seen = { url: req.url, auth: req.headers.authorization, model: payload.model, raw };
    if (replyBody) {
      res.writeHead(replyStatus, { 'Content-Type': 'application/json' });
      res.end(replyBody);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(['译文']) } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/compatible-mode/v1`;

const provider = (patch) => makeProvider('openai', { model: 'qwen-plus', apiKey: 'sk-abc', url: BASE, ...patch });
const run = async (patch, fake = null) => {
  seen = null;
  replyStatus = fake?.status || 200;
  replyBody = fake?.body || null;
  return translateTexts(['hello'], { to: 'zh-CN', provider: provider(patch) });
};
const rejects = async (patch, fake = null) => {
  try {
    await run(patch, fake);
    return null;
  } catch (e) {
    return e;
  }
};

// ---------- 地址与密钥的容错 ----------
await run({});
check('正常配置：请求路径不变', () => {
  assert.equal(seen.url, '/compatible-mode/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer sk-abc');
});

await run({ url: `${BASE}/` });
check('地址结尾多一个斜杠不再拼出双斜杠', () => {
  assert.equal(seen.url, '/compatible-mode/v1/chat/completions');
});

await run({ url: `${BASE}/` , urlTemplate: '' });
check('地址结尾多斜杠（模板走预设）同样只有一个斜杠', () => {
  assert.equal(seen.url, '/compatible-mode/v1/chat/completions');
});

await run({ url: `  ${BASE}/  ` });
check('地址两侧的空格被去掉（不会编码成 %20）', () => {
  assert.equal(seen.url, '/compatible-mode/v1/chat/completions');
  assert.ok(!seen.url.includes('%20'));
});

await run({ apiKey: '  sk-abc  ' });
check('密钥两侧的空格被去掉（不会出现 "Bearer  sk-abc"）', () => {
  assert.equal(seen.auth, 'Bearer sk-abc');
});

await run({ model: 'qwen-plus\n' });
check('模型名两侧的空白被去掉', () => {
  assert.equal(seen.model, 'qwen-plus');
});

const blankKey = await rejects({ apiKey: '   ' });
check('只填了空白的密钥时，报「未填 API Key」而不是 401', () => {
  assert.ok(blankKey, '应当抛错');
  assert.match(blankKey.message, /未填写 API Key/);
});

// ---------- 失败响应的可读性 ----------
const AUTH_401 = {
  status: 401,
  body: JSON.stringify({
    error: {
      message: 'Incorrect API key provided. For details, see: https://help.aliyun.com/zh/model-studio/error-code#apikey-error',
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
    request_id: 'abc-123',
  }),
};
const auth = await rejects({}, AUTH_401);
check('401 直接给出服务端的原因，而不是整坨 JSON', () => {
  assert.ok(auth, '应当抛错');
  assert.match(auth.message, /HTTP 401/);
  assert.match(auth.message, /Incorrect API key provided/);
  assert.ok(!/request_id|invalid_api_key|\{"/.test(auth.message), `不该残留原始 JSON：${auth.message}`);
});
check('401 附带「检查 API Key」的提示', () => {
  assert.match(auth.message, /请检查「API Key」/);
});
check('401 归为 fatal：不重试、不拆批', () => {
  assert.equal(auth.kind, 'fatal');
});

const notFound = await rejects({}, { status: 404, body: '{"error":{"message":"Not Found"}}' });
check('404 提示检查 Base URL', () => {
  assert.match(notFound.message, /HTTP 404/);
  assert.match(notFound.message, /请检查「Base URL」/);
});

// ---------- 干净的配置不受影响 ----------
check('fillProvider 不动正常的字段', () => {
  const p = fillProvider(provider({ url: 'https://api.deepseek.com/v1', apiKey: 'sk-ok' }));
  assert.equal(p.url, 'https://api.deepseek.com/v1');
  assert.equal(p.apiKey, 'sk-ok');
  assert.equal(p.urlTemplate, '{{url}}/chat/completions');
});
check('自定义类型只用 {{url}} 时保留结尾斜杠', () => {
  const p = fillProvider(makeProvider('custom', { url: 'https://gateway.internal/api/' }));
  assert.equal(p.url, 'https://gateway.internal/api/');
});

server.close();
console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
