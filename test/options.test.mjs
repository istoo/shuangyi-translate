// 设置页回归测试：用 jsdom 加载真实的 options.html + options.js，
// 只 mock chrome API。覆盖最容易悄悄坏掉的部分——档案的增删改与动态表单。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { makeI18n } from './helpers/i18n.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const { DEFAULTS } = await import(`${ROOT}src/shared/config.js`);
const { PROVIDER_TYPES } = await import(`${ROOT}src/shared/providers.js`);

const html = readFileSync(`${ROOT}src/options/options.html`, 'utf8');
const dom = new JSDOM(html, { url: 'chrome-extension://test/options.html', pretendToBeVisual: true });

// ---- mock chrome ----
const stored = { config: structuredClone(DEFAULTS) };
const sent = { translate: [], setConfig: [] };

function merge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      merge(base[k], v);
    } else if (v !== undefined) base[k] = v;
  }
  return base;
}

const chromeMock = {
  runtime: {
    sendMessage: async (msg) => {
      switch (msg.type) {
        case 'getConfig': return { ok: true, data: structuredClone(stored.config) };
        case 'setConfig':
          sent.setConfig.push(msg.patch);
          stored.config = merge(structuredClone(stored.config), msg.patch);
          return { ok: true, data: structuredClone(stored.config) };
        case 'translate':
          sent.translate.push(msg);
          return { ok: true, data: msg.texts.map((t) => `【译】${t}`) };
        case 'clearCache': return { ok: true };
        default: return { ok: false, error: '未知消息 ' + msg.type };
      }
    },
    openOptionsPage: () => {},
  },
  storage: {
    local: {
      get: async () => ({ config: structuredClone(stored.config) }),
      set: async (obj) => { stored.config = structuredClone(obj.config); },
    },
  },
  tabs: { query: async () => [], sendMessage: async () => ({ ok: true }) },
};

// ---- 把 jsdom 环境铺到全局，让 options.js 能作为普通 ES module 加载 ----
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Option = dom.window.Option;
globalThis.Event = dom.window.Event;
globalThis.confirm = () => true;
chromeMock.i18n = makeI18n();
globalThis.chrome = chromeMock;

await import(`${ROOT}src/options/options.js`);

const doc = dom.window.document;
const $ = (id) => doc.getElementById(id);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

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

async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('✅', name);
  } catch (e) {
    fail += 1;
    console.log('❌', name, '\n   ', e.message);
  }
}

const fire = (elm, type) => elm.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const typeSelect = () => doc.querySelector('#providerForm select');
const formLabels = () => [...doc.querySelectorAll('#providerForm label')].map((l) => l.textContent.trim());
const advancedLabels = () => [...doc.querySelectorAll('#providerForm details label')].map((l) => l.textContent.trim());
function fieldInput(labelText) {
  const field = [...doc.querySelectorAll('#providerForm .field')]
    .find((f) => f.querySelector('label')?.textContent.trim() === labelText);
  return field?.querySelector('input, textarea, select') || null;
}
function pickEngine(id) {
  $('engineSel').value = id;
  fire($('engineSel'), 'change');
}

await tick(60);

// ---------- 初始渲染 ----------
check('服务下拉列出所有档案', () => {
  const names = [...$('engineSel').options].map((o) => o.textContent);
  assert.deepEqual(names, stored.config.providers.map((p) => p.name));
  assert.ok(names.includes('Google'));
});

check('Google 档案不显示任何配置字段', () => {
  assert.deepEqual(formLabels(), ['名称', '类型']);
});

check('类型下拉包含全部服务类型', () => {
  const types = [...typeSelect().options].map((o) => o.value);
  assert.deepEqual(types.sort(), Object.keys(PROVIDER_TYPES).sort());
});

// ---------- 切换档案 ----------
await checkAsync('切到 OpenAI 档案后渲染出所有该有的字段', async () => {
  pickEngine('openai');
  await tick(60);
  const labels = formLabels();
  for (const want of ['名称', '类型', 'Base URL', 'API Key', '模型', 'Temperature', '系统提示词', 'AI 专家身份', '术语库']) {
    assert.ok(labels.includes(want), `缺少字段「${want}」，实际：${labels.join(' / ')}`);
  }
  assert.equal(fieldInput('Base URL').value, 'https://api.openai.com/v1');
  assert.equal(fieldInput('模型').value, 'gpt-4o-mini');
});

await checkAsync('高级区预填了预设模板，可展开查看', async () => {
  const adv = doc.querySelector('#providerForm details');
  assert.ok(adv, '应存在高级设置折叠区');
  assert.deepEqual(advancedLabels(), ['请求方法', '请求地址模板', '请求头', '请求体模板', '结果取值路径']);
  assert.equal(fieldInput('请求地址模板').value, '{{url}}/chat/completions');
  assert.ok(fieldInput('请求体模板').value.includes('{{texts}}'));
});

await checkAsync('切换类型会换成该类型的地址与模板', async () => {
  const typeSel = typeSelect();
  typeSel.value = 'anthropic';
  fire(typeSel, 'change');
  await tick(60);
  const labels = formLabels();
  assert.ok(labels.includes('服务地址'), 'Anthropic 的地址字段标签应为「服务地址」');
  assert.equal(fieldInput('服务地址').value, 'https://api.anthropic.com');
  assert.ok(fieldInput('请求头').value.includes('anthropic-version'));
  assert.ok(fieldInput('请求体模板').value.includes('max_tokens'));
});

await checkAsync('切回 OpenAI 后仍能正确渲染（反复切换不残留）', async () => {
  const typeSel = typeSelect();
  typeSel.value = 'openai';
  fire(typeSel, 'change');
  await tick(60);
  assert.equal(fieldInput('Base URL').value, 'https://api.openai.com/v1');
  assert.deepEqual(advancedLabels().length, 5);
});

// ---------- 编辑并保存 ----------
await checkAsync('改模型名会自动保存回配置', async () => {
  const input = fieldInput('模型');
  input.value = 'deepseek-chat';
  fire(input, 'input');
  await tick(500); // 等过 400ms 防抖
  assert.equal(stored.config.providers.find((p) => p.id === 'openai').model, 'deepseek-chat');
});

await checkAsync('改 API Key 与术语库都会保存', async () => {
  const key = fieldInput('API Key');
  key.value = 'sk-test-key';
  fire(key, 'input');
  const gl = fieldInput('术语库');
  gl.value = 'prompt=提示词';
  fire(gl, 'input');
  await tick(500);
  const p = stored.config.providers.find((x) => x.id === 'openai');
  assert.equal(p.apiKey, 'sk-test-key');
  assert.equal(p.glossary, 'prompt=提示词');
});

// ---------- 新建 / 删除 ----------
await checkAsync('新建档案后出现在下拉里并成为当前档案', async () => {
  const before = stored.config.providers.length;
  $('btnNew').click();
  await tick(80);
  assert.equal(stored.config.providers.length, before + 1);
  assert.equal([...$('engineSel').options].length, before + 1);
  assert.equal(stored.config.engine, stored.config.providers.at(-1).id);
  assert.equal($('engineSel').value, stored.config.engine);
  assert.ok(formLabels().includes('Base URL'), '新档案应渲染出表单');
});

await checkAsync('重名的新档案会自动编号', async () => {
  $('btnNew').click();
  await tick(80);
  const names = stored.config.providers.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, `档案名重复：${names.join(' / ')}`);
});

await checkAsync('删除档案后当前档案回退到第一个', async () => {
  const doomed = stored.config.engine;
  $('btnDel').click();
  await tick(80);
  assert.ok(!stored.config.providers.some((p) => p.id === doomed));
  assert.equal(stored.config.engine, stored.config.providers[0].id);
  assert.equal($('engineSel').value, stored.config.engine);
});

// ---------- 测试按钮 ----------
await checkAsync('测试按钮用当前编辑中的草稿，而不是已保存的旧值', async () => {
  pickEngine('openai');
  await tick(60);
  const model = fieldInput('模型');
  model.value = 'draft-model-not-saved-yet';
  fire(model, 'input'); // 故意不等防抖保存
  $('testBtn').click();
  await tick(80);

  const sentMsg = sent.translate.at(-1);
  assert.ok(sentMsg, '应发出翻译请求');
  assert.equal(sentMsg.provider.model, 'draft-model-not-saved-yet');
  assert.ok($('testOut').textContent.includes('【译】'), '应显示译文结果');
  assert.ok($('testOut').classList.contains('ok'));
});

await checkAsync('测试失败时把后台的错误原样显示出来', async () => {
  const originalSend = chromeMock.runtime.sendMessage;
  chromeMock.runtime.sendMessage = async (msg) => (msg.type === 'translate'
    ? { ok: false, error: '「OpenAI」未填写 API Key' }
    : originalSend(msg));
  $('testBtn').click();
  await tick(80);
  chromeMock.runtime.sendMessage = originalSend;
  assert.ok($('testOut').textContent.includes('未填写 API Key'), $('testOut').textContent);
  assert.ok($('testOut').classList.contains('fail'));
});

await checkAsync('下拉处于未选中状态时不会把 engine 写坏', async () => {
  const before = stored.config.engine;
  const sel = $('engineSel');
  sel.value = '__不存在的档案__'; // 不在选项里，浏览器会把 value 置空
  assert.equal(sel.value, '', '前提：此时下拉应处于未选中状态');
  fire(sel, 'change');
  await tick(300);
  assert.equal(stored.config.engine, before,
    `engine 被写成了 ${JSON.stringify(stored.config.engine)}，应当是 ${JSON.stringify(before)}`);
});


// 漏翻的文案会直接以 key 的形态出现在界面上（i18n 的 t() 取不到时返回 key），这里兜住
const KEY_LIKE = /\b(?:sec|opt|field|adv|pop|wel|cs|bg|err|type|url|placeholder|test|confirm|hotkey|style|mode|site|app|common|urlLabel|urlHint|btn|provider|shortcut|currentService|serviceHint|sitesHint|cacheHint|deleted|cacheCleared|resetDone|createdProvider|needOneProvider)[A-Z][A-Za-z]{2,}\b/g;

check('界面上没有漏翻的文案', () => {
  const text = (doc.body.innerText || doc.body.textContent || '');
  const leak = [...new Set(text.match(KEY_LIKE) || [])];
  assert.deepEqual(leak, [], `以下文案没有翻译，直接显示成了 key：${leak.join(', ')}`);
});

console.log('\n=== 字段标签与输入框关联 ===');
{
  const input = fieldInput('模型');
  const label = [...document.querySelectorAll('label')].find((l) => l.textContent === '模型');
  check('标签用 for 关联到输入框', () => {
    assert.ok(input.id, '输入框没有 id');
    assert.equal(label.getAttribute('for'), input.id);
  });
  check('每个字段的 id 互不重复', () => {
    const ids = [...document.querySelectorAll('[id^="f_"]')].map((n) => n.id);
    assert.equal(ids.length, new Set(ids).size, `重复 id: ${ids.join(',')}`);
  });
}

console.log('\n=== 改名不重建服务下拉 ===');
{
  const sel = $('engineSel');
  const nodesBefore = [...sel.options];
  const namesBefore = nodesBefore.map((o) => o.textContent);
  const nameInput = fieldInput('名称');
  nameInput.value = '我的服务';
  fire(nameInput, 'input');
  check('改名时下拉不被整个重建', () => {
    assert.ok([...sel.options].every((o, i) => o === nodesBefore[i]), '下拉被整个重建了');
  });
  check('下拉里那一项跟着改名', () => {
    const changed = [...sel.options].filter((o, i) => o.textContent !== namesBefore[i]);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].textContent, '我的服务');
  });
}

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);