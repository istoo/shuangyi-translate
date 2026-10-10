// 翻译服务类型、请求模板预设，以及不依赖 chrome API 的纯函数。
// 引擎适配层与设置界面共用这里的定义；因为不碰 chrome，可以直接在 Node 里单测。

export const LANG_LABEL = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', zh: '简体中文', en: 'English', ja: '日本語',
  ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский',
  pt: 'Português', it: 'Italiano', ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', hi: 'हिन्दी',
};

export const DEFAULT_SYSTEM_PROMPT =
  '你是专业翻译引擎。将用户提供的文本翻译为{{target}}。只输出译文，不要解释，不要加引号。保留原文中的 HTML 标签与占位符不变。';

// 提示词的文案骨架。这里是内置的兜底版本（Node 单测直接用）；
// 扩展运行时会用当前界面语言的版本覆盖，见 bg/engines.js。
export const PROMPT_DEFAULTS = {
  system: DEFAULT_SYSTEM_PROMPT,
  contextRule: '\n输入是同一篇文章里连续的段落（JSON 字符串数组），请输出等长的 JSON 字符串数组，逐条对应翻译结果。'
    + '请主动利用上下文：保持全文术语、人称与语气一致，并据此消除歧义（代词指代、多义词、省略句）。不要输出任何其他内容。',
  expert: '\n你的身份是「{0}」领域的专家译者，请使用该领域的专业表达。',
  glossary: '\n必须遵守以下术语对照表（左侧原文一律译为右侧译文）：\n{0}',
  title: '\n这篇文章的标题是「{0}」，仅用于帮你判断领域与语境，不要翻译它。',
  context: '\n以下是待翻译内容前后的段落，仅供你理解语境，不要翻译它们：\n{0}',
};

const fmt = (tpl, value) => String(tpl).replace(/\{0\}/g, value);

// 各类型的请求模板。用户在高级设置里可以覆盖任意一项。
export const TEMPLATE_PRESETS = {
  openai: {
    method: 'POST',
    defaultUrl: 'https://api.openai.com/v1',
    urlTemplate: '{{url}}/chat/completions',
    headersTemplate: 'Content-Type: application/json\nAuthorization: Bearer {{apiKey}}',
    bodyTemplate: `{
  "model": {{model}},
  "temperature": {{temperature}},
  "messages": [
    { "role": "system", "content": {{system}} },
    { "role": "user", "content": {{texts}} }
  ]
}`,
    responsePath: 'choices[0].message.content',
  },
  anthropic: {
    method: 'POST',
    defaultUrl: 'https://api.anthropic.com',
    urlTemplate: '{{url}}/v1/messages',
    // 浏览器直连 Anthropic 必须带上危险直连声明，否则会被 CORS 拦掉
    headersTemplate: 'Content-Type: application/json\nx-api-key: {{apiKey}}\nanthropic-version: 2023-06-01\nanthropic-dangerous-direct-browser-access: true',
    bodyTemplate: `{
  "model": {{model}},
  "max_tokens": 8192,
  "temperature": {{temperature}},
  "system": {{system}},
  "messages": [
    { "role": "user", "content": {{texts}} }
  ]
}`,
    responsePath: 'content[0].text',
  },
  gemini: {
    method: 'POST',
    defaultUrl: 'https://generativelanguage.googleapis.com',
    urlTemplate: '{{url}}/v1beta/models/{{model}}:generateContent?key={{apiKey}}',
    headersTemplate: 'Content-Type: application/json',
    bodyTemplate: `{
  "systemInstruction": { "parts": [ { "text": {{system}} } ] },
  "contents": [ { "parts": [ { "text": {{texts}} } ] } ],
  "generationConfig": { "temperature": {{temperature}} }
}`,
    responsePath: 'candidates[0].content.parts[0].text',
  },
  ollama: {
    method: 'POST',
    defaultUrl: 'http://localhost:11434',
    urlTemplate: '{{url}}/api/chat',
    headersTemplate: 'Content-Type: application/json',
    bodyTemplate: `{
  "model": {{model}},
  "stream": false,
  "options": { "temperature": {{temperature}} },
  "messages": [
    { "role": "system", "content": {{system}} },
    { "role": "user", "content": {{texts}} }
  ]
}`,
    responsePath: 'message.content',
  },
  custom: {
    method: 'POST',
    defaultUrl: '',
    urlTemplate: '{{url}}',
    headersTemplate: 'Content-Type: application/json',
    bodyTemplate: `{
  "text": {{texts}},
  "target": {{target}},
  "model": {{model}}
}`,
    responsePath: '',
  },
};

// 类型元数据。展示文本一律走文案 key（由 UI 层用 chrome.i18n 翻译），
// 这样本模块不依赖 chrome，可以在 Node 里直接单测。
export const PROVIDER_TYPES = {
  google: { kind: 'builtin', nameKey: 'typeGoogle' },
  deepl: { kind: 'builtin', nameKey: 'typeDeepl' },
  openai: {
    kind: 'llm', nameKey: 'typeOpenai', urlLabelKey: 'urlLabelBase', urlHintKey: 'urlHintBase',
  },
  anthropic: {
    kind: 'llm', nameKey: 'typeAnthropic', urlLabelKey: 'urlLabelEndpoint', urlHintKey: 'urlHintAnthropic',
  },
  gemini: {
    kind: 'llm', nameKey: 'typeGemini', urlLabelKey: 'urlLabelEndpoint', urlHintKey: 'urlHintGemini',
  },
  ollama: {
    kind: 'llm', nameKey: 'typeOllama', urlLabelKey: 'urlLabelEndpoint', urlHintKey: 'urlHintOllama',
  },
  custom: {
    kind: 'llm', nameKey: 'typeCustom', urlLabelKey: 'urlLabelUrl', urlHintKey: 'urlHintCustom',
  },
};

// 新建档案时的默认名字。用品牌名而不是翻译过的词，这样切界面语言时已存的档案不会显得错乱。
const FALLBACK_NAMES = {
  google: 'Google', deepl: 'DeepL', openai: 'OpenAI',
  anthropic: 'Anthropic', gemini: 'Gemini', ollama: 'Ollama', custom: 'Custom',
};

export function defaultProviderName(type) {
  return FALLBACK_NAMES[type] || type;
}

export function providerKind(type) {
  return PROVIDER_TYPES[type]?.kind || 'llm';
}

let idSeq = 0;

export function newProviderId() {
  idSeq += 1;
  return `p${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// 新建一个服务档案：默认 URL 与提示词都来自该类型的预设。
export function makeProvider(type, overrides = {}) {
  const preset = TEMPLATE_PRESETS[type] || {};
  const kind = providerKind(type);
  return {
    id: newProviderId(),
    type,
    name: overrides.name || defaultProviderName(type),
    url: preset.defaultUrl || '',
    apiKey: '',
    model: '',
    temperature: 0,
    pro: false,
    systemPrompt: '',
    expert: '',
    glossary: '',
    ...overrides,
  };
}

// 用户没填的模板字段用预设补齐，保证手改过的档案也能正常发请求。
export function fillProvider(provider) {
  const preset = TEMPLATE_PRESETS[provider?.type] || {};
  const out = { type: 'google', ...provider };
  // 从剪贴板粘来的密钥、地址、模型名常夹带空格与换行，拼进请求里就是错的东西：
  //   Authorization: Bearer {{apiKey}}  ← apiKey 前面多一个空格，就成了 "Bearer  sk-…"，
  //   服务端按无效密钥处理（DashScope / OpenAI 都会回 401 Incorrect API key provided）。
  //   地址两侧的空格会被 URL 编码成 %20，请求打到不存在的路径上。
  for (const key of ['url', 'apiKey', 'model']) {
    if (typeof out[key] === 'string') out[key] = out[key].trim();
  }
  for (const key of ['method', 'urlTemplate', 'headersTemplate', 'bodyTemplate', 'responsePath']) {
    if (!out[key]) out[key] = preset[key] || '';
  }
  if (!out.method) out.method = 'POST';
  if (!out.url) out.url = preset.defaultUrl || '';
  // 地址填到版本号为止就够了，用户多打一个结尾斜杠会拼出 .../v1//chat/completions。
  // 这种双斜杠 DashScope 之类网关不会自动纠正，直接 404。
  if (/\{\{\s*url\s*\}\}\s*\//.test(out.urlTemplate)) out.url = out.url.replace(/\/+$/, '');
  return out;
}

const FALLBACK_PROVIDER = { id: 'google', type: 'google', name: 'Google' };

export function resolveProvider(config) {
  const list = config?.providers || [];
  return list.find((p) => p.id === config?.engine) || list[0] || FALLBACK_PROVIDER;
}

// ---------- 模板渲染 ----------
// url / 请求头里的占位符按原文替换（保持 / : ? 等结构字符不变）。
export function renderRawTemplate(template, vars) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key) => String(vars[key] ?? ''));
}

// 请求体里的占位符一律替换为 JSON 值字面量：
//   "content": {{texts}}    → "content": "[\"a\",\"b\"]"
//   "content": "{{texts}}"  → 同上（带引号的写法也兼容）
// 两种写法都能产出合法 JSON，用户不必记规则。
export function renderJsonTemplate(template, vars) {
  if (!template) return '';
  const value = (key) => JSON.stringify(vars[key] === undefined ? null : vars[key]);
  return String(template)
    .replace(/"\{\{\s*([\w]+)\s*\}\}"/g, (_, key) => value(key))
    .replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, key) => value(key));
}

export function parseHeaders(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return headers;
}

export function buildRequestVars(provider, texts, { from, to, docTitle, context, strings } = {}) {
  return {
    url: provider.url || '',
    apiKey: provider.apiKey || '',
    model: provider.model || '',
    temperature: Number(provider.temperature) || 0,
    target: LANG_LABEL[to] || to || '',
    source: from && from !== 'auto' ? (LANG_LABEL[from] || from) : '',
    system: buildSystemPrompt(provider, to, docTitle, context, strings),
    texts: JSON.stringify(texts),
    textsJson: texts,
    text: texts.join('\n\n'),
    docTitle: docTitle || '',
  };
}

export function buildSystemPrompt(provider, to, docTitle, context, strings = PROMPT_DEFAULTS) {
  let sys = String(provider.systemPrompt || strings.system)
    .replace(/\{\{target\}\}/g, LANG_LABEL[to] || to || '');
  if (provider.expert) sys += fmt(strings.expert, provider.expert);
  const rules = String(provider.glossary || '')
    .split('\n').map((l) => l.trim()).filter((l) => l.includes('='));
  if (rules.length) sys += fmt(strings.glossary, rules.join('\n'));
  // 标题只用来建立主题认知，不参与翻译
  if (docTitle) sys += fmt(strings.title, docTitle);
  // 单段重译时把前后段落也带上：模型能看到指代对象和上下文语气，重译结果才有意义
  if (context?.length) sys += fmt(strings.context, context.join('\n---\n'));
  return sys + strings.contextRule;
}

// ---------- 响应取值 ----------
// 支持 'choices[0].message.content'、'a.b[1].c'、'translations' 这类写法；留空则取整个响应。
export function pickPath(obj, path) {
  if (!path) return obj;
  const keys = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter((k) => k !== '');
  let cur = obj;
  for (const key of keys) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[key];
  }
  return cur;
}

// 接口返回的数组元素常常是对象，这里按常见字段名兜底取值。
const TEXT_KEYS = ['text', 'translatedText', 'translated', 'translation', 'target', 'result', 'content', 'output', 'sentence'];

function pickText(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    for (const key of TEXT_KEYS) {
      if (typeof item[key] === 'string') return item[key];
    }
  }
  return '';
}

function padTo(list, expect) {
  const out = list.slice(0, expect);
  while (out.length < expect) out.push('');
  return out;
}

function stripFence(content) {
  return String(content ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

// 模型没按 JSON 输出时的兜底：单段直接当译文，多段按行切。
function parseModelArray(content, expect, depth = 0) {
  const stripped = stripFence(content);
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return padTo(parsed.map(pickText), expect);
    if (typeof parsed === 'string' && depth < 1) return parseModelArray(parsed, expect, depth + 1);
  } catch { /* 不是 JSON，落到下面的兜底 */ }
  if (expect === 1) return [stripped];
  return padTo(stripped.split('\n').map((l) => l.trim()).filter(Boolean), expect);
}

function textItemCount(content, depth = 0) {
  const stripped = stripFence(content);
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed.length;
    if (typeof parsed === 'string' && depth < 1) return textItemCount(parsed, depth + 1);
  } catch { /* 按行数算 */ }
  return stripped.split('\n').map((l) => l.trim()).filter(Boolean).length;
}

// 模型实际给出了几条译文（与 normalizeTexts 用同一套解析）。
// 调用方拿它和输入条数比：对不上就拆开重译，不能靠补空、截断凑数，那会让译文错位到别的段落上。
export function modelListLength(value) {
  if (Array.isArray(value)) return value.length;
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : (pickText(value) || JSON.stringify(value));
  return textItemCount(text);
}

// 把接口返回值归一化成与输入等长的译文字符串数组。
export function normalizeTexts(value, expect) {
  if (Array.isArray(value)) return padTo(value.map(pickText), expect);
  if (typeof value === 'string') return parseModelArray(value, expect);
  if (value === null || value === undefined) return new Array(expect).fill('');
  const single = pickText(value);
  if (single) return expect === 1 ? [single] : parseModelArray(single, expect);
  return parseModelArray(JSON.stringify(value), expect);
}

// 配置指纹：改了模型、提示词或术语库后，缓存 key 随之变化，旧译文自动失效。
export function fingerprint(value) {
  const text = JSON.stringify(value) || '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
