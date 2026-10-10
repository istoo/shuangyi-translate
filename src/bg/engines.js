// 翻译引擎适配层。统一入口：
//   translateTexts(texts, { from, to, config, provider }) -> string[]（与输入等长）
// Google / DeepL 协议特殊，各留一份专用实现；其余（OpenAI 兼容、Anthropic、
// Gemini、Ollama、任意自定义 HTTP 接口）共用同一套模板驱动实现，
// 差别只体现在预设的 URL / 请求头 / 请求体 / 结果取值路径上。
// 文本可能含内联 HTML 标签（<b0>…</b0> 形式的占位标签）。

import {
  resolveProvider, fillProvider, buildRequestVars, renderRawTemplate, renderJsonTemplate,
  parseHeaders, pickPath, normalizeTexts, modelListLength,
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

// 带分类的错误，内容脚本据此决定怎么处理这一批：
//   fatal   配置类错误（密钥、地址、模型名、取值路径），重试和拆批都没用，直接报错
//   limited 被限流，整批稍后重试
//   slow    超时、连不上：整批只重试一次，不拆成单段再各打一轮
//   无分类  其余失败（如 5xx），拆成单段隔离出有问题的那一段
function failure(message, kind) {
  const err = new Error(message);
  if (kind) err.kind = kind;
  err.rendered = true;      // 文案已经是给用户看的，上层不必再改写
  return err;
}

function httpKind(status) {
  if (status === 429) return 'limited';
  if (status >= 400 && status < 500 && status !== 408 && status !== 425) return 'fatal';
  return undefined;
}

// 失败响应体常常是一整坨 JSON（DashScope 的 401 有 200 多字符），直接甩给用户没法看。
// 能解析出 error.message 之类的可读字段就取它，否则原样截断。
function httpDetail(raw) {
  const text = String(raw || '').trim();
  try {
    const data = JSON.parse(text);
    const message = data?.error?.message || data?.error?.msg || data?.message
      || (typeof data?.error === 'string' ? data.error : '');
    if (message.trim()) return message.trim().slice(0, 200);
  } catch { /* 不是 JSON，按原文截断 */ }
  return text.slice(0, 200);
}

// 401/403 几乎都是密钥问题，404 几乎都是地址问题。把结论直接写出来，
// 省得用户对着一坨 JSON 猜是哪一项没填对。
function httpHint(status) {
  if (status === 401 || status === 403) return t('errHintAuth');
  if (status === 404) return t('errHintNotFound');
  return '';
}
// 一批译文再慢也该在这个时间内回来。挂住的请求会占着并发位，整页停在那里。
const REQUEST_TIMEOUT_MS = 45000;

async function fetchWithRetry(url, init) {
  let networkError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt) {
      // 指数退避 + 抖动：多个标签页同时被限流时不要齐步重试
      await sleep(600 * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if (e?.name === 'AbortError') throw failure(t('errTimeout'), 'slow');
      networkError = e;                 // 断网 / DNS / CORS 预检失败 → 重试
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    if (!RETRYABLE_STATUS.has(res.status) || attempt === MAX_RETRIES) return res;
    // 429 且服务端给了 Retry-After 就听它的（上限 15 秒，避免卡着用户）
    const after = Number(res.headers.get('Retry-After'));
    if (Number.isFinite(after) && after > 0 && after <= 15) await sleep(after * 1000);
  }
  networkError.kind = 'slow';
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
    if (!res.ok) throw failure(t('errGoogleFailed', res.status), httpKind(res.status));
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
  if (!apiKey) throw failure(t('errDeeplNoKey'), 'fatal');
  // DeepL 单次请求最多 50 段、请求体上限 128 KiB。不分批的话，长文会整批被拒（413/400）。
  // provider.url 非空时优先用它，方便走区域端点或自建代理。
  const endpoint = provider.url
    || (pro ? 'https://api.deepl.com/v2/translate' : 'https://api-free.deepl.com/v2/translate');
  const out = [];
  for (const batch of chunkByLength(texts, 100000, 40)) {
    const body = new URLSearchParams();
    for (const t of batch) body.append('text', t);
    body.append('target_lang', toDeeplLang(to));
    if (from && from !== 'auto') body.append('source_lang', toDeeplLang(from));
    body.append('tag_handling', 'html');
    const res = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `DeepL-Auth-Key ${apiKey}` },
      body: body.toString(),
    });
    if (!res.ok) throw failure(t('errDeeplFailed', res.status), httpKind(res.status));
    const data = await res.json();
    out.push(...(data.translations || []).map((t) => t.text));
  }
  // 服务端少返回时补齐，避免后面的段落接到前面的译文上
  return normalizeTexts(out, texts.length);
}

function toDeeplLang(lang) {
  const map = { 'zh-CN': 'ZH', 'zh-TW': 'ZH', zh: 'ZH', en: 'EN', ja: 'JA', ko: 'KO', fr: 'FR', de: 'DE', es: 'ES', ru: 'RU', pt: 'PT', it: 'IT' };
  return map[lang] || lang.split('-')[0].toUpperCase();
}

// Azure 等网关会拒绝 temperature: 0，并写明只接受默认值。去掉该字段再发一次，
// 让模型用它自己的默认值；支持 0 的模型第一次就会成功，不会走到这里。
function temperatureUnsupported(status, raw) {
  return status === 400 && /temperature/i.test(raw)
    && /does not support|unsupported|only the default/i.test(raw);
}

function omitTemperature(body) {
  if (!body) return null;
  try {
    const data = JSON.parse(body);
    let removed = false;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(node, 'temperature')) {
        delete node.temperature;
        removed = true;
      }
      for (const value of Object.values(node)) walk(value);
    };
    walk(data);
    return removed ? JSON.stringify(data) : null;
  } catch {
    return null;
  }
}

// ---------- 模板驱动（所有大模型类服务） ----------
async function templatedTranslate(texts, { from, to, provider, docTitle, context }) {
  const { urlTemplate, headersTemplate, method } = provider;
  if (!provider.url) throw failure(t('errNoUrl', provider.name), 'fatal');
  if (!provider.apiKey && /\{\{\s*apiKey\s*\}\}/.test(urlTemplate + headersTemplate)) {
    throw failure(t('errNoApiKey', provider.name), 'fatal');
  }

  const vars = buildRequestVars(provider, texts, { from, to, docTitle, context, strings: prompts() });
  const url = renderRawTemplate(urlTemplate, vars);
  const headers = parseHeaders(renderRawTemplate(headersTemplate, vars));
  const verb = (method || 'POST').toUpperCase();
  let body = verb === 'GET' ? undefined : renderJsonTemplate(provider.bodyTemplate, vars);

  let res;
  let raw = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      res = await fetchWithRetry(url, { method: verb, headers, body });
    } catch (e) {
      if (e?.rendered) throw e;
      // 浏览器抛的是 "Failed to fetch" 这类英文，对用户没有意义，换成能照做的说法
      const reason = /failed to fetch|networkerror|load failed/i.test(e.message || '')
        ? t('errCannotConnect')
        : e.message;
      throw failure(t('errRequestFailed', provider.name, reason, MAX_RETRIES), 'slow');
    }
    raw = await res.text();
    if (res.ok || attempt === 1 || !temperatureUnsupported(res.status, raw)) break;
    const next = omitTemperature(body);
    if (!next) break;
    body = next;
  }
  if (!res.ok) {
    const hint = httpHint(res.status);
    throw failure(t('errHttp', provider.name, res.status, httpDetail(raw)) + (hint ? `\n${hint}` : ''),
      httpKind(res.status));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw failure(t('errNotJson', provider.name, raw.slice(0, 200)), 'fatal');
  }
  // 部分服务即使 HTTP 200 也会在 body 里带 error
  if (data?.error) {
    const detail = data.error.message || JSON.stringify(data.error);
    throw failure(t('errApiError', provider.name, String(detail).slice(0, 200)), 'fatal');
  }

  // 条数对不上就拆开重译。直接补空会把后面的译文错位接到前面的段落上。
  const got = modelListLength(pickPath(data, provider.responsePath));
  // got === 0：模型什么都没返回，多半是服务本身出了问题，二分下去只会把请求放大成一整棵树
  if (got !== null && got > 0 && got !== texts.length && texts.length > 1) {
    const mid = Math.ceil(texts.length / 2);
    const ctx = { from, to, provider, docTitle, context };
    const [left, right] = await Promise.all([
      templatedTranslate(texts.slice(0, mid), ctx),
      templatedTranslate(texts.slice(mid), ctx),
    ]);
    return left.concat(right);
  }

  const result = normalizeTexts(pickPath(data, provider.responsePath), texts.length);
  // 一条都没取到，基本可以断定是取值路径不对。直接报错，比丢给用户一片空白强。
  if (texts.length && !result.some((t) => t)) {
    throw failure(t('errNoTranslation', provider.name,
      provider.responsePath || t('errWholeResponse'), raw.slice(0, 200)), 'fatal');
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
