// 翻译引擎适配层。统一入口：
//   translateTexts(texts, { from, to, config, provider }) -> string[]（与输入等长）
// Google / DeepL 协议特殊，各留一份专用实现；其余（OpenAI 兼容、Anthropic、
// Gemini、Ollama、任意自定义 HTTP 接口）共用同一套模板驱动实现，
// 差别只体现在预设的 URL / 请求头 / 请求体 / 结果取值路径上。
// 文本可能含内联 HTML 标签（<b0>…</b0> 形式的占位标签）。

import {
  resolveProvider, fillProvider, buildRequestVars, renderRawTemplate, renderJsonTemplate,
  parseHeaders, pickPath, normalizeTexts,
} from '../shared/providers.js';
import { t } from '../shared/i18n.js';
import { PROMPT_DEFAULTS } from '../shared/providers.js';

// 提示词按界面语言取。惰性求值：Node 单测里 chrome 是在 import 之后才挂上的。
let promptStrings = null;
function prompts() {
  if (!promptStrings) {
    promptStrings = {
      system: t('promptSystem'),
      contextRule: t('promptContextRule'),
      expert: t('promptExpert'),
      glossary: t('promptGlossary'),
      title: t('promptTitle'),
      context: t('promptContext'),
    };
    // 某个 key 缺失时退回内置文案，避免提示词里出现裸 key
    for (const k of Object.keys(PROMPT_DEFAULTS)) {
      if (!promptStrings[k] || promptStrings[k] === `prompt${k[0].toUpperCase()}${k.slice(1)}`) {
        promptStrings[k] = PROMPT_DEFAULTS[k];
      }
    }
  }
  return promptStrings;
}

const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/t';

// ---------- 带重试的请求 ----------
// 网络抖动、限流和临时故障值得重试；配置类错误（401/403/404/400）重试没有意义，直接交给调用方报错。
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, init) {
  let networkError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt) {
      // 指数退避 + 抖动：多个标签页同时被限流时不要齐步重试
      await sleep(600 * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6));
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      networkError = e;                 // 断网 / DNS / CORS 预检失败 → 重试
      continue;
    }
    if (res.ok) return res;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) return res;
    // 429 且服务端给了 Retry-After 就听它的（上限 15 秒，避免卡着用户）
    const after = Number(res.headers.get('Retry-After'));
    if (Number.isFinite(after) && after > 0 && after <= 15) await sleep(after * 1000);
  }
  throw networkError;
}

export async function translateTexts(texts, { from, to, config, provider, docTitle, context } = {}) {
  const p = fillProvider(provider || resolveProvider(config));
  if (p.type === 'google') return googleTranslate(texts, { from, to });
  if (p.type === 'deepl') return deeplTranslate(texts, { from, to, provider: p });
  return templatedTranslate(texts, { from, to, provider: p, docTitle, context });
}

// ---------- Google 免费接口 ----------
async function googleTranslate(texts, { from, to }) {
  // 该端点单次请求有长度上限，按字符数分批
  const batches = chunkByLength(texts, 1800, 40);
  const out = [];
  for (const batch of batches) {
    const qs = batch.map((t) => 'q=' + encodeURIComponent(t)).join('&');
    const url = `${GOOGLE_ENDPOINT}?client=gtx&sl=${from || 'auto'}&tl=${to}&format=html&${qs}`;
    const res = await fetchWithRetry(url, { method: 'GET' });
    if (!res.ok) throw new Error(t('errGoogleFailed', res.status));
    const data = await res.json();
    // 返回形态随请求段数变化：单段为 [["译文","en"]]，多段为 [["译文","en"], ...]
    // 且当 sl 显式指定时可能退化为 ["译文", ...]
    out.push(...normalizeGoogle(data, batch.length));
  }
  return out;
}

function normalizeGoogle(data, expect) {
  const list = data;
  if (!Array.isArray(list)) return new Array(expect).fill('');
  // 每项可能是 ["译文", "srcLang"] 或直接字符串
  const mapped = list.map((item) => (Array.isArray(item) ? String(item[0] ?? '') : String(item ?? '')));
  if (expect === 1) return [mapped[0] ?? ''];
  const out = mapped.slice(0, expect);
  while (out.length < expect) out.push('');
  return out;
}

// ---------- DeepL ----------
async function deeplTranslate(texts, { from, to, provider }) {
  const { apiKey, pro } = provider;
  if (!apiKey) throw new Error(t('errDeeplNoKey'));
  const endpoint = pro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate';
  const body = new URLSearchParams();
  for (const t of texts) body.append('text', t);
  body.append('target_lang', toDeeplLang(to));
  if (from && from !== 'auto') body.append('source_lang', toDeeplLang(from));
  body.append('tag_handling', 'html');
  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `DeepL-Auth-Key ${apiKey}` },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(t('errDeeplFailed', res.status));
  const data = await res.json();
  return (data.translations || []).map((t) => t.text);
}

function toDeeplLang(lang) {
  const map = { 'zh-CN': 'ZH', 'zh-TW': 'ZH', zh: 'ZH', en: 'EN', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE', es: 'ES', ru: 'RU', pt: 'PT', it: 'IT' };
  return map[lang] || lang.split('-')[0].toUpperCase();
}

// ---------- 模板驱动（所有大模型类服务） ----------
async function templatedTranslate(texts, { from, to, provider, docTitle, context }) {
  const { urlTemplate, headersTemplate, method } = provider;
  if (!provider.url) throw new Error(t('errNoUrl', provider.name));
  if (!provider.apiKey && /\{\{\s*apiKey\s*\}\}/.test(urlTemplate + headersTemplate)) {
    throw new Error(t('errNoApiKey', provider.name));
  }

  const vars = buildRequestVars(provider, texts, { from, to, docTitle, context, strings: prompts() });
  const url = renderRawTemplate(urlTemplate, vars);
  const headers = parseHeaders(renderRawTemplate(headersTemplate, vars));
  const verb = (method || 'POST').toUpperCase();
  const body = verb === 'GET' ? undefined : renderJsonTemplate(provider.bodyTemplate, vars);

  let res;
  try {
    res = await fetchWithRetry(url, { method: verb, headers, body });
  } catch (e) {
    // 浏览器抛的是 "Failed to fetch" 这类英文，对用户没有意义，换成能照做的说法
    const reason = /failed to fetch|networkerror|load failed/i.test(e.message || '')
      ? t('errCannotConnect')
      : e.message;
    throw new Error(t('errRequestFailed', provider.name, reason, MAX_RETRIES));
  }

  const raw = await res.text();
  if (!res.ok) throw new Error(t('errHttp', provider.name, res.status, raw.slice(0, 200)));

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(t('errNotJson', provider.name, raw.slice(0, 200)));
  }
  // 部分服务即使 HTTP 200 也会在 body 里带 error
  if (data?.error) {
    const detail = data.error.message || JSON.stringify(data.error);
    throw new Error(t('errApiError', provider.name, String(detail).slice(0, 200)));
  }

  const result = normalizeTexts(pickPath(data, provider.responsePath), texts.length);
  // 一条都没取到，基本可以断定是取值路径不对。直接报错，比丢给用户一片空白强。
  if (texts.length && !result.some((t) => t)) {
    throw new Error(t('errNoTranslation', provider.name,
      provider.responsePath || t('errWholeResponse'), raw.slice(0, 200)));
  }
  return result;
}

// Google 单次请求有长度上限，按字符数与段数分批
function chunkByLength(texts, maxChars, maxCount) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const t of texts) {
    const tLen = t.length + 8;
    if (cur.length && (len + tLen > maxChars || cur.length >= maxCount)) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += tLen;
  }
  if (cur.length) batches.push(cur);
  return batches;
}