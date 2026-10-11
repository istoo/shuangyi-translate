// 英文界面下的渲染冒烟测试。
// macOS 上 Chrome 的界面语言跟随系统，没法用 --lang 强制切换，所以这里直接在 jsdom 里
// 加载 en 语言包渲染真实页面，验证语言包真的接得上、且不会漏翻。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { makeI18n } from './helpers/i18n.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { DEFAULTS } = await import(`${ROOT}src/shared/config.js`);

const html = readFileSync(`${ROOT}src/options/options.html`, 'utf8');
const dom = new JSDOM(html, { url: 'chrome-extension://test/options.html', pretendToBeVisual: true });

const stored = { config: structuredClone(DEFAULTS) };

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Option = dom.window.Option;
globalThis.Event = dom.window.Event;
globalThis.confirm = () => true;
globalThis.chrome = {
  i18n: makeI18n('en'),
  runtime: {
    sendMessage: async (msg) => {
      if (msg.type === 'getConfig') return { ok: true, data: structuredClone(stored.config) };
      if (msg.type === 'setConfig') { Object.assign(stored.config, msg.patch); return { ok: true, data: structuredClone(stored.config) }; }
      return { ok: true };
    },
    openOptionsPage: () => {},
  },
  storage: { local: { get: async () => ({ config: structuredClone(stored.config) }), set: async (o) => { stored.config = structuredClone(o.config); } } },
  tabs: { query: async () => [], sendMessage: async () => ({ ok: true }), create: async () => ({}) },
  commands: { getAll: async () => ([
    { name: 'toggle-translate', shortcut: 'Alt+A' },
    { name: 'toggle-compare', shortcut: 'Alt+W' },
  ]) },
};

await import(`${ROOT}src/options/options.js`);
await new Promise((r) => setTimeout(r, 140));

const doc = dom.window.document;
const $ = (id) => doc.getElementById(id);
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };

const bodyText = doc.body.innerText || doc.body.textContent || '';
const KEY_LIKE = /\b(?:sec|opt|field|adv|pop|wel|cs|bg|err|type|url|placeholder|test|confirm|hotkey|style|mode|site|app|common|btn|provider|shortcut)[A-Z][A-Za-z]{2,}\b/g;

console.log('=== 英文界面渲染 ===');
check('界面没有漏翻的 key', !KEY_LIKE.test(bodyText),
  [...new Set(bodyText.match(KEY_LIKE) || [])].join(', '));

check('标题是英文', $('saved') && bodyText.includes('Shuangyi · Settings'), bodyText.slice(0, 40).replace(/\n/g, ' '));
check('区块标题是英文', bodyText.includes('Translation services') && bodyText.includes('Shortcuts'),
  bodyText.slice(0, 80).replace(/\n/g, ' | '));

const labels = [...doc.querySelectorAll('#providerForm label')].map((l) => l.textContent.trim());
check('类型下拉渲染成英文名', doc.querySelector('#providerForm select')?.options[0]?.textContent.includes('Google Translate'),
  doc.querySelector('#providerForm select')?.options[0]?.textContent || '');

// 切到 OpenAI 档案，检查动态字段的文案
$('engineSel').value = 'openai';
$('engineSel').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await new Promise((r) => setTimeout(r, 120));

const fieldLabels = [...doc.querySelectorAll('#providerForm label')].map((l) => l.textContent.trim());
check('动态字段文案是英文', fieldLabels.includes('Base URL') && fieldLabels.includes('Glossary'),
  fieldLabels.join(' / '));
check('高级设置是英文', doc.querySelector('#providerForm details summary')?.textContent.includes('Advanced'),
  doc.querySelector('#providerForm details summary')?.textContent || '');
check('字段提示是英文（不是 key）',
  (doc.querySelector('#providerForm .hint')?.textContent || '').length > 10
  && !KEY_LIKE.test(doc.querySelector('#providerForm .hint')?.textContent || ''));

// 快捷键区块
const kbds = [...doc.querySelectorAll('#shortcutList kbd')].map((k) => k.textContent);
check('快捷键区块把绑定拆成按键块显示',
  kbds.filter((k) => k === 'Alt').length === 2 && kbds.includes('A') && kbds.includes('W'), kbds.join(' '));
check('快捷键说明是英文', ($('openShortcuts').textContent || '').length > 3 && /[A-Za-z]/.test($('openShortcuts').textContent),
  $('openShortcuts').textContent);

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);