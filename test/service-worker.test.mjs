// 后台回归测试：mock chrome API 后加载真实的 service-worker.js。
// 覆盖模块链路能否加载、消息路由、译文缓存，以及新加的「配置指纹」缓存失效逻辑。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { makeI18n } from './helpers/i18n.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { DEFAULTS } = await import(`${ROOT}src/shared/config.js`);

// ---- mock chrome ----
const stored = { config: structuredClone(DEFAULTS) };
const listeners = {};
const menus = [];
const openedTabs = [];

let registeredScripts = [];
globalThis.chrome = {
  i18n: makeI18n(),
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
    onStartup: { addListener: (fn) => { listeners.startup = fn; } },
    openOptionsPage: () => {},
    getURL: (p) => `chrome-extension://test/${p}`,
  },
  contextMenus: {
    removeAll: (cb) => cb(),
    create: (m) => menus.push(m),
    onClicked: { addListener: (fn) => { listeners.menuClick = fn; } },
  },
  scripting: {
    getRegisteredContentScripts: async ({ ids }) => registeredScripts.filter((x) => ids.includes(x.id)),
    registerContentScripts: async (list) => { registeredScripts.push(...list); },
    unregisterContentScripts: async ({ ids }) => {
      registeredScripts = registeredScripts.filter((x) => !ids.includes(x.id));
    },
  },
  commands: { onCommand: { addListener: (fn) => { listeners.command = fn; } } },
  tabs: {
    query: async () => [],
    sendMessage: async () => ({}),
    create: ({ url }) => { openedTabs.push(url); return Promise.resolve({}); },
  },
  storage: {
    onChanged: { addListener: (fn) => { listeners.storageChanged = fn; } },
    local: {
      get: async (keys) => {
        const pick = (k) => (stored[k] === undefined ? undefined : structuredClone(stored[k]));
        if (keys == null) {
          const all = {};
          for (const k of Object.keys(stored)) all[k] = pick(k);
          return all;
        }
        if (typeof keys === 'string') return { [keys]: pick(keys) };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = pick(k);
          return out;
        }
        return { config: pick('config') };
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) stored[k] = structuredClone(v);
      },
      remove: async (key) => { delete stored[key]; },
    },
  },
};

// ---- mock 翻译服务 ----
let upstreamCalls = 0;
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    upstreamCalls += 1;
    const payload = JSON.parse(raw);
    const texts = JSON.parse(payload.messages[1].content);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((t) => `[${upstreamCalls}] ${t}`)) } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const provider = {
  id: 'mock', type: 'openai', name: 'Mock', url: `http://127.0.0.1:${server.address().port}/v1`,
  apiKey: 'sk', model: 'm',
};
stored.config = { ...structuredClone(DEFAULTS), engine: 'mock', providers: [provider] };

// ---- 加载真实的后台脚本 ----
await import(`${ROOT}src/bg/service-worker.js`);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('✅', name);
  } catch (e) {
    fail += 1;
    console.log('❌', name, '\n   ', e.message);
  }
}

function send(msg) {
  return new Promise((resolve) => {
    const kept = listeners.message(msg, {}, resolve);
    if (!kept) resolve({ ok: false, error: '未保持异步通道（sendResponse 会被丢弃）' });
  });
}

await check('后台脚本加载后注册了各类监听', async () => {
  for (const key of ['message', 'installed', 'startup', 'menuClick', 'command']) {
    assert.ok(listeners[key], `缺少监听：${key}`);
  }
});

await check('getConfig 返回 v2 结构', async () => {
  const r = await send({ type: 'getConfig' });
  assert.equal(r.ok, true);
  assert.equal(r.data.version, 2);
  assert.equal(r.data.engine, 'mock');
});

await check('未知消息类型返回错误而不是静默失败', async () => {
  const r = await send({ type: 'nonsense' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('nonsense'));
});

await check('翻译消息走通完整链路', async () => {
  const r = await send({ type: 'translate', texts: ['hello', 'world'], to: 'zh-CN' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, ['[1] hello', '[1] world']);
  assert.equal(upstreamCalls, 1, '两段文本应合并成一次请求');
});

await check('重复文本命中缓存，不再打上游', async () => {
  const before = upstreamCalls;
  const r = await send({ type: 'translate', texts: ['hello', 'world'], to: 'zh-CN' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, ['[1] hello', '[1] world']);
  assert.equal(upstreamCalls, before, '完全相同的请求应当直接命中缓存');
});

await check('页面标题不同时不复用上一篇文章的译文', async () => {
  // 系统提示词里带着页面标题，同一句话在两篇文章里的译文本来就可能不同，
  // 所以标题必须参与缓存 key（否则第一篇的译文会被搬到第二篇上）。
  const before = upstreamCalls;
  const first = await send({ type: 'translate', texts: ['cached-once'], to: 'zh-CN', docTitle: '第一篇' });
  assert.equal(upstreamCalls, before + 1, '第一次要真的打上游');
  const other = await send({ type: 'translate', texts: ['cached-once'], to: 'zh-CN', docTitle: '第二篇' });
  assert.equal(upstreamCalls, before + 2, '标题不同应当重新请求');
  assert.notEqual(other.data[0], first.data[0]);
  const again = await send({ type: 'translate', texts: ['cached-once'], to: 'zh-CN', docTitle: '第二篇' });
  assert.equal(upstreamCalls, before + 2, '同一标题第二次应当命中缓存');
  assert.equal(again.data[0], other.data[0]);
});

await check('Service Worker 重启后仍命中本地缓存', async () => {
  const { reloadFromDisk, cacheIdle } = await import(`${ROOT}src/bg/translation-cache.js`);
  await cacheIdle();
  await reloadFromDisk();
  const before = upstreamCalls;
  const r = await send({ type: 'translate', texts: ['hello', 'world'], to: 'zh-CN' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, ['[1] hello', '[1] world']);
  assert.equal(upstreamCalls, before, '磁盘上的译文应当在内存被清空后继续生效');
});

await check('一批译文只落盘一次，不是每条各写一遍', async () => {
  const { cacheIdle } = await import(`${ROOT}src/bg/translation-cache.js`);
  await cacheIdle();
  const realSet = chrome.storage.local.set;
  let cacheWrites = 0;
  chrome.storage.local.set = async (obj) => {
    if ('translationCache' in obj) cacheWrites += 1;
    return realSet(obj);
  };
  try {
    const r = await send({ type: 'translate', texts: ['w1', 'w2', 'w3', 'w4', 'w5'], to: 'zh-CN' });
    assert.equal(r.ok, true);
    await cacheIdle();
    assert.equal(cacheWrites, 1, `实际写了 ${cacheWrites} 次`);
  } finally {
    chrome.storage.local.set = realSet;
  }
});

await check('改目标语言不会复用缓存', async () => {
  const before = upstreamCalls;
  await send({ type: 'translate', texts: ['hello'], to: 'en' });
  assert.equal(upstreamCalls, before + 1);
});

await check('改了提示词/术语库后旧译文自动失效（配置指纹）', async () => {
  const before = upstreamCalls;
  // 只改术语库，其他都不变
  stored.config = {
    ...stored.config,
    providers: [{ ...stored.config.providers[0], glossary: 'hello=你好' }],
  };
  const r = await send({ type: 'translate', texts: ['hello'], to: 'zh-CN' });
  assert.equal(r.ok, true);
  assert.equal(upstreamCalls, before + 1, '配置变了必须重新请求，不能用旧模型的结果');
  assert.ok(r.data[0].includes('hello'));
});

await check('clearCache 后缓存清空', async () => {
  const before = upstreamCalls;
  await send({ type: 'clearCache' });
  await send({ type: 'translate', texts: ['hello'], to: 'zh-CN' });
  assert.equal(upstreamCalls, before + 1);
});

await check('翻译失败时错误经 sendResponse 回传', async () => {
  stored.config = {
    ...stored.config,
    providers: [{ ...stored.config.providers[0], url: 'http://127.0.0.1:9/none' }],
  };
  const r = await send({ type: 'translate', texts: ['x'], to: 'zh-CN' });
  assert.equal(r.ok, false);
  assert.ok(/Mock/.test(r.error), r.error);
});

await check('封闭 Shadow DOM 支持默认关闭，打开设置才注册 MAIN world 脚本', async () => {
  const flush = () => new Promise((r) => setTimeout(r, 20));
  listeners.storageChanged({ config: {} }, 'local');
  await flush();
  assert.equal(registeredScripts.length, 0, '默认不应注册');

  await send({ type: 'setConfig', patch: { openClosedShadow: true } });
  listeners.storageChanged({ config: {} }, 'local');
  await flush();
  assert.equal(registeredScripts.length, 1);
  const [script] = registeredScripts;
  assert.equal(script.world, 'MAIN');
  assert.equal(script.runAt, 'document_start');
  assert.equal(script.allFrames, false, '只在顶层文档注入');

  listeners.storageChanged({ config: {} }, 'local');
  await flush();
  assert.equal(registeredScripts.length, 1, '重复同步不会重复注册');

  await send({ type: 'setConfig', patch: { openClosedShadow: false } });
  listeners.storageChanged({ config: {} }, 'local');
  await flush();
  assert.equal(registeredScripts.length, 0, '关闭后应注销');
});

await check('onInstalled 会建右键菜单并迁移 v1 配置', async () => {
  menus.length = 0;
  stored.config = {
    engine: 'openai', targetLang: 'en',
    openai: { apiKey: 'sk-old', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    deepl: { apiKey: 'dk' },
  };
  listeners.installed();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(menus.length >= 4, `菜单数量异常：${menus.length}`);
  assert.equal(stored.config.version, 2, 'v1 配置应被迁移写回');
  assert.ok(stored.config.providers.some((p) => p.id === 'deepl' && p.apiKey === 'dk'));
  assert.equal(stored.config.providers.find((p) => p.id === 'openai').model, 'deepseek-chat');
});

await check('并发保存不会互相覆盖（读-改-写要串行）', async () => {
  // 设置页改模型名是防抖保存、勾选项是立即保存，两条消息可能同时在飞
  await Promise.all([
    send({ type: 'setConfig', patch: { targetLang: 'ja' } }),
    send({ type: 'setConfig', patch: { mode: 'translation' } }),
    send({ type: 'setConfig', patch: { fontScale: 1.3 } }),
  ]);
  const res = await send({ type: 'getConfig' });
  const cfg = res.data;
  assert.equal(cfg.targetLang, 'ja', '第一个补丁被覆盖了');
  assert.equal(cfg.mode, 'translation', '第二个补丁被覆盖了');
  assert.equal(cfg.fontScale, 1.3, '第三个补丁被覆盖了');
  await send({ type: 'setConfig', patch: { targetLang: 'zh-CN', mode: 'bilingual', fontScale: 1 } });
});

await check('setConfig 对 siteRules 是整体替换语义', async () => {
  await send({ type: 'setConfig', patch: { siteRules: { 'a.com': 'always', 'b.com': 'never' } } });
  let r = await send({ type: 'getConfig' });
  assert.deepEqual(r.data.siteRules, { 'a.com': 'always', 'b.com': 'never' });

  // 空对象必须能清空规则：深合并会把它当成「没有要改的键」，规则就永远删不掉
  await send({ type: 'setConfig', patch: { siteRules: {} } });
  r = await send({ type: 'getConfig' });
  assert.deepEqual(r.data.siteRules, {}, '空对象应当清空规则，而不是被深合并吞掉');

  await send({ type: 'setConfig', patch: { siteRules: { 'c.com': 'always' } } });
  r = await send({ type: 'getConfig' });
  assert.deepEqual(r.data.siteRules, { 'c.com': 'always' }, '替换语义：不应残留旧规则');
});

await check('首次安装会打开引导页', async () => {
  openedTabs.length = 0;
  listeners.installed({ reason: 'install' });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(openedTabs.some((u) => u.includes('welcome.html')), `打开的页面：${openedTabs.join(', ') || '(无)'}`);
});

await check('更新扩展时不会打扰用户打开引导页', async () => {
  openedTabs.length = 0;
  listeners.installed({ reason: 'update' });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(openedTabs, []);
});

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
server.close();
process.exit(fail ? 1 : 0);
