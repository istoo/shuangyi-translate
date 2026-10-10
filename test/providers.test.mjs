// 离线单测：模板渲染、结果归一化、预设合法性、配置迁移。
// 这些是最容易悄悄坏掉的部分（一个占位符写错，整条链路就发不出请求）。
import assert from 'node:assert/strict';
import {
  TEMPLATE_PRESETS, PROVIDER_TYPES, makeProvider, fillProvider, renderJsonTemplate,
  renderRawTemplate, parseHeaders, pickPath, normalizeTexts, buildSystemPrompt,
  buildRequestVars, fingerprint, resolveProvider,
} from '../src/shared/providers.js';
import { migrateConfig, DEFAULTS, CONFIG_VERSION, DISPLAY_STYLES } from '../src/shared/config.js';

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

// ---------- 预设 ----------
const TYPES = Object.keys(TEMPLATE_PRESETS);
assert.deepEqual(TYPES.sort(), Object.keys(PROVIDER_TYPES).filter((t) => PROVIDER_TYPES[t].kind !== 'builtin').sort(),
  '每个模板类服务类型都必须有请求预设');

for (const type of TYPES) {
  check(`预设「${type}」渲染出合法 JSON 请求体且地址无残留占位符`, () => {
    const p = fillProvider(makeProvider(type, {
      url: TEMPLATE_PRESETS[type].defaultUrl, apiKey: 'sk-test', model: 'test-model', temperature: 0,
    }));
    const vars = buildRequestVars(p, ['Hello <b0>world</b0>.', 'Second line.'], { from: 'en', to: 'zh-CN' });

    const body = JSON.parse(renderJsonTemplate(p.bodyTemplate, vars));
    assert.ok(body && typeof body === 'object', '请求体应为对象');

    const url = renderRawTemplate(p.urlTemplate, vars);
    assert.ok(!url.includes('{{'), `地址里还有未替换的占位符：${url}`);
    assert.ok(!url.includes('}}'), `地址里还有未替换的占位符：${url}`);

    const headers = parseHeaders(renderRawTemplate(p.headersTemplate, vars));
    for (const [k, v] of Object.entries(headers)) {
      assert.ok(!String(v).includes('{{'), `请求头 ${k} 里还有未替换的占位符`);
    }
    // 模型收到的必须是 JSON 数组字符串，提示词才要求得回等长数组
    const payload = JSON.stringify(body);
    assert.ok(payload.includes('\\"Hello <b0>world</b0>.\\"') || payload.includes('"Hello <b0>world</b0>."'),
      '请求体里应带上待翻译文本');
  });
}

// ---------- 模板渲染 ----------
check('请求体占位符按 JSON 值插入，加不加引号都合法', () => {
  const out = JSON.parse(renderJsonTemplate('{"a": {{texts}}, "b": "{{texts}}", "c": {{n}}}', {
    texts: '["甲","乙"]', n: 0,
  }));
  assert.deepEqual(out, { a: '["甲","乙"]', b: '["甲","乙"]', c: 0 });
});

check('{{textsJson}} 是真正的 JSON 数组', () => {
  const out = JSON.parse(renderJsonTemplate('{"texts": {{textsJson}}}', { textsJson: ['a', 'b'] }));
  assert.deepEqual(out.texts, ['a', 'b']);
});

check('文本里的引号与换行不会破坏请求体', () => {
  const vars = buildRequestVars(makeProvider('custom'), ['他说："你好"\n第二行'], { to: 'zh-CN' });
  const out = JSON.parse(renderJsonTemplate('{"text": {{text}}}', vars));
  assert.equal(out.text, '他说："你好"\n第二行');
});

check('请求头按行解析，忽略空行与注释', () => {
  assert.deepEqual(parseHeaders('Content-Type: application/json\n\n# 注释\nx-api-key: abc\n'), {
    'Content-Type': 'application/json', 'x-api-key': 'abc',
  });
});

// ---------- 结果取值 ----------
check('结果取值路径支持数组下标与纯数组节点', () => {
  assert.equal(pickPath({ choices: [{ message: { content: 'hi' } }] }, 'choices[0].message.content'), 'hi');
  assert.deepEqual(pickPath({ translations: [{ text: 'a' }, { text: 'b' }] }, 'translations'), [{ text: 'a' }, { text: 'b' }]);
  const whole = { a: { b: 1 } };
  assert.equal(pickPath(whole, ''), whole, '路径留空表示取整个响应');
  assert.equal(pickPath({ a: 1 }, 'a.b.c'), undefined, '越界应返回空而不是抛错');
});

// ---------- 结果归一化 ----------
check('归一化：JSON 数组 / 代码块 / 纯文本 / 对象数组', () => {
  assert.deepEqual(normalizeTexts('["甲","乙"]', 2), ['甲', '乙']);
  assert.deepEqual(normalizeTexts('```json\n["甲","乙"]\n```', 2), ['甲', '乙']);
  assert.deepEqual(normalizeTexts([{ text: '甲' }, { text: '乙' }], 2), ['甲', '乙']);
  assert.deepEqual(normalizeTexts('只有一段译文', 1), ['只有一段译文']);
  assert.deepEqual(normalizeTexts('第一行\n第二行', 2), ['第一行', '第二行']);
});

check('归一化：长度不匹配时补齐或截断，绝不返回错位数组', () => {
  assert.deepEqual(normalizeTexts('["甲"]', 3), ['甲', '', '']);
  assert.deepEqual(normalizeTexts('["甲","乙","丙"]', 2), ['甲', '乙']);
  assert.deepEqual(normalizeTexts(null, 2), ['', '']);
});

// ---------- 提示词 ----------
check('系统提示词带上目标语言、专家身份与术语库', () => {
  const p = makeProvider('openai', { expert: '医学', glossary: 'prompt=提示词\n\n无效行' });
  const sys = buildSystemPrompt(p, 'zh-CN');
  assert.ok(sys.includes('简体中文'));
  assert.ok(sys.includes('医学'));
  assert.ok(sys.includes('prompt=提示词'));
  assert.ok(!sys.includes('无效行'), '不含 = 的行不是术语，应被忽略');
});

check('提示词要求模型利用上下文，而不是逐段孤立翻译', () => {
  const sys = buildSystemPrompt(makeProvider('openai'), 'zh-CN');
  assert.ok(sys.includes('上下文'), '提示词里应要求利用上下文');
  assert.ok(/一致/.test(sys), '应要求术语/语气保持一致');
});

check('文档标题会进入提示词，并明确说明不要翻译它', () => {
  const sys = buildSystemPrompt(makeProvider('openai'), 'zh-CN', 'How RAG Actually Works');
  assert.ok(sys.includes('How RAG Actually Works'));
  assert.ok(sys.includes('不要翻译'));
});

check('没有标题时不出现多余的标题说明', () => {
  assert.ok(!buildSystemPrompt(makeProvider('openai'), 'zh-CN').includes('这篇文章的标题'));
});

check('档案没写提示词时用内置的默认提示词', () => {
  const p = makeProvider('openai');
  assert.equal(p.systemPrompt, '', '新建档案不应把提示词写死进去');
  const sys = buildSystemPrompt(p, 'zh-CN');
  assert.ok(sys.includes('专业翻译引擎'), sys.slice(0, 60));
});

check('提示词骨架可以由外部覆盖（用于跟随界面语言）', () => {
  const en = {
    system: 'Translate into {{target}}.',
    contextRule: ' RULE',
    expert: ' (expert:{0})',
    glossary: ' G:{0}',
    title: ' T:{0}',
    context: ' C:{0}',
  };
  const p = makeProvider('openai', { expert: 'law', glossary: 'a=b' });
  const sys = buildSystemPrompt(p, 'en', 'Some Doc', ['prev', 'next'], en);
  assert.ok(sys.includes('Translate into English'), sys.slice(0, 80));
  assert.ok(sys.includes('(expert:law)'));
  assert.ok(sys.includes('G:a=b'));
  assert.ok(sys.includes('T:Some Doc'));
  assert.ok(sys.includes('C:prev\n---\nnext'));
  assert.ok(sys.endsWith('RULE'));
  // 关键：英文骨架下不能再混进中文
  assert.ok(!/[\u4e00-\u9fff]/.test(sys), `英文提示词里混入了中文：${sys}`);
});

// ---------- 指纹 ----------
check('指纹随配置变化，相同配置稳定', () => {
  const a = makeProvider('openai', { id: 'x', model: 'm1' });
  const b = makeProvider('openai', { id: 'x', model: 'm2' });
  assert.equal(fingerprint(a), fingerprint({ ...a }));
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, glossary: 'a=b' }));
});

// ---------- 档案解析 ----------
check('engine 指向不存在的档案时回退到第一个', () => {
  const config = { engine: '不存在', providers: [{ id: 'a', type: 'google' }] };
  assert.equal(resolveProvider(config).id, 'a');
  assert.equal(resolveProvider({ providers: [] }).type, 'google', '完全没有档案时回退到 Google');
});

// ---------- 配置迁移 ----------
check('v1 配置迁移为档案数组并保留 Key / 模型 / 术语库', () => {
  const v1 = {
    engine: 'openai',
    targetLang: 'en',
    siteRules: { 'a.com': 'never' },
    deepl: { apiKey: 'deepl-key', pro: true },
    openai: {
      apiKey: 'sk-old', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
      systemPrompt: '自定义提示词', expert: '法律', glossary: 'a=b',
    },
  };
  const next = migrateConfig(v1);
  assert.equal(next.version, CONFIG_VERSION);
  assert.equal(next.openai, undefined);
  assert.equal(next.deepl, undefined);
  assert.equal(next.engine, 'openai');
  assert.equal(next.targetLang, 'en', '无关字段原样保留');
  assert.deepEqual(next.siteRules, { 'a.com': 'never' });

  const openai = next.providers.find((p) => p.id === 'openai');
  assert.equal(openai.url, 'https://api.deepseek.com/v1');
  assert.equal(openai.model, 'deepseek-chat');
  assert.equal(openai.apiKey, 'sk-old');
  assert.equal(openai.expert, '法律');
  assert.equal(openai.glossary, 'a=b');

  const deepl = next.providers.find((p) => p.id === 'deepl');
  assert.equal(deepl.apiKey, 'deepl-key');
  assert.equal(deepl.pro, true);
});

check('版本号对不上但已有档案时，保留档案（不丢 Key）', () => {
  const stored = {
    version: 3, engine: 'mine', targetLang: 'ja',
    providers: [{ id: 'mine', type: 'openai', name: '内部', apiKey: 'sk-keep', model: 'm1', url: 'https://x/v1' }],
    someFutureField: true,
  };
  const out = migrateConfig(stored);
  assert.equal(out.version, 2);
  assert.equal(out.providers.length, 1);
  assert.equal(out.providers[0].apiKey, 'sk-keep', '迁移把用户已存的 Key 丢掉了');
  assert.equal(out.engine, 'mine');
  assert.equal(out.someFutureField, true, '未知字段应原样保留');
});

check('迁移幂等：已是 v2 的配置原样返回', () => {
  const cfg = { version: CONFIG_VERSION, engine: 'google', providers: [{ id: 'google', type: 'google' }] };
  assert.equal(migrateConfig(cfg), cfg);
  assert.equal(migrateConfig(null), null);
});

check('默认译文样式为无修饰，外观与原文一致', () => {
  assert.equal(DEFAULTS.displayStyle, 'none');
  assert.ok(DISPLAY_STYLES.includes(DEFAULTS.displayStyle));
});

check('默认配置本身自洽（engine 能解析到档案）', () => {
  assert.ok(DEFAULTS.providers.length >= 1);
  assert.equal(resolveProvider(DEFAULTS).id, DEFAULTS.engine);
});

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);