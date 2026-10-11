// 弹窗回归测试：档案列表渲染 + 缺 Key 提示。
// 弹窗是用户最常用的入口，这里坏了整个扩展就没法用。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeI18n } from './helpers/i18n.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { DEFAULTS } = await import(`${ROOT}src/shared/config.js`);

const html = readFileSync(`${ROOT}src/popup/popup.html`, 'utf8');
const dom = new JSDOM(html, { url: 'chrome-extension://test/popup.html', pretendToBeVisual: true });

const stored = { config: structuredClone(DEFAULTS) };
let lastTranslateMsg = null;

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Option = dom.window.Option;
globalThis.Event = dom.window.Event;
globalThis.chrome = {
  i18n: makeI18n(),
  runtime: {
    sendMessage: async (msg) => {
      if (msg.type === 'getConfig') return { ok: true, data: structuredClone(stored.config) };
      if (msg.type === 'setConfig') {
        Object.assign(stored.config, msg.patch);
        return { ok: true, data: structuredClone(stored.config) };
      }
      if (msg.type === 'translate') { lastTranslateMsg = msg; return { ok: true, data: ['【译】x'] }; }
      return { ok: true };
    },
    openOptionsPage: () => {},
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://example.com/a' }],
    sendMessage: async (id, msg) => (msg.type === 'getState'
      ? { ok: true, translated: false, host: 'example.com', rule: '' }
      : { ok: true }),
  },
};

await import(`${ROOT}src/popup/popup.js`);

const doc = dom.window.document;
const $ = (id) => doc.getElementById(id);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const fire = (elm, type) => elm.dispatchEvent(new dom.window.Event(type, { bubbles: true }));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
}

await tick(80);

const engineNames = () => [...$('engine').options].map((o) => o.textContent);

check('翻译服务下拉列出全部档案', engineNames().join('|') === stored.config.providers.map((p) => p.name).join('|'),
  engineNames().join(' / '));
check('默认选中当前档案', $('engine').value === stored.config.engine, $('engine').value);
check('目标语言下拉已填充', $('targetLang').options.length > 10, String($('targetLang').options.length));
check('站点域名已显示', $('host').textContent === 'example.com', $('host').textContent);
check('初始无错误提示', !$('err').classList.contains('show'));

// 切到需要 Key 且没填 Key 的服务 → 提示
$('engine').value = 'openai';
fire($('engine'), 'change');
await tick(80);
check('切到缺 API Key 的服务给出提示', $('err').classList.contains('show'), $('err').textContent);
check('切换结果已写入配置', stored.config.engine === 'openai', stored.config.engine);

// 填上 Key 后再切回 → 不提示
stored.config.providers.find((p) => p.id === 'openai').apiKey = 'sk-x';
$('engine').value = 'google';
fire($('engine'), 'change');
await tick(80);
check('切到免费服务不提示', !$('err').classList.contains('show'), $('err').textContent);

check('Google 档案本身不需要 Key（模板里没有 {{apiKey}}）',
  !/\{\{apiKey\}\}/.test(
    (stored.config.providers.find((p) => p.id === 'google').headersTemplate || '')
    + (stored.config.providers.find((p) => p.id === 'google').urlTemplate || '')));


// 漏翻的文案会直接以 key 的形态出现在界面上（i18n 的 t() 取不到时返回 key），这里兜住
const KEY_LIKE = /\b(?:sec|opt|field|adv|pop|wel|cs|bg|err|type|url|placeholder|test|confirm|hotkey|style|mode|site|app|common|urlLabel|urlHint|btn|provider|shortcut|currentService|serviceHint|sitesHint|cacheHint|deleted|cacheCleared|resetDone|createdProvider|needOneProvider)[A-Z][A-Za-z]{2,}\b/g;

check('界面上没有漏翻的文案', () => {
  const text = (doc.body.innerText || doc.body.textContent || '');
  const leak = [...new Set(text.match(KEY_LIKE) || [])];
  assert.deepEqual(leak, [], `以下文案没有翻译，直接显示成了 key：${leak.join(', ')}`);
});

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);