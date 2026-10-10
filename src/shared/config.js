// 默认配置与存储读写。所有模块共用同一份 schema。
// 翻译服务以「档案数组」形式存储：providers[] 里每一项是一套完整的服务配置，
// engine 指向当前启用的档案 id，因此可以保存 N 套模型配置随时切换。

import {
  TEMPLATE_PRESETS, DEFAULT_SYSTEM_PROMPT, makeProvider,
} from './providers.js';

export const CONFIG_VERSION = 2;

export const DISPLAY_STYLES = ['underline', 'dashed', 'highlight', 'blockquote', 'none'];

function defaultProviders() {
  return [
    { id: 'google', type: 'google', name: 'Google' },
    makeProvider('openai', { id: 'openai', name: 'OpenAI', model: 'gpt-4o-mini' }),
  ];
}

export const DEFAULTS = {
  version: CONFIG_VERSION,
  engine: 'google',
  providers: defaultProviders(),
  targetLang: 'zh-CN',
  // 这些语言的页面不翻译（视为已是母语）
  skipLangs: ['zh-CN', 'zh-TW', 'zh'],
  // 默认不加修饰：译文继承原文字体，看起来就是页面自己的文字（与沉浸式翻译一致）
  displayStyle: 'none',
  // 'bilingual' 双语对照 | 'translation' 仅译文
  mode: 'bilingual',
  autoTranslate: false,          // 打开页面自动翻译
  hoverTranslate: true,          // 悬停 + 快捷键 翻译单段
  hoverHotkey: 'Shift',          // Shift | Control | Alt | none(纯悬停)
  selectionTranslate: true,      // 划词翻译气泡
  inputTranslate: true,          // 输入框三连空格翻译
  showFloatBall: true,           // 页面右下角悬浮球
  openClosedShadow: false,       // 翻译 closed shadow DOM：要在页面脚本前改写 attachShadow，默认关闭
  fontScale: 1,                  // 译文字号缩放
  // 视频字幕：默认开启，但只在视频本身有字幕时才会生效，不会主动去开字幕
  subtitleTranslate: true,
  subtitleMode: 'bilingual',     // 'bilingual' 原文+译文 | 'translation' 仅译文
  subtitleFontScale: 1,
  // 站点级规则：{ [hostname]: 'always' | 'never' }
  siteRules: {},
};

// v1 把配置写死在 config.openai / config.deepl 两个字段里，v2 起改为档案数组。
// 迁移是幂等的：已经是 v2 就原样返回（返回同一引用，调用方可据此判断是否需要写回）。
export function migrateConfig(stored) {
  if (!stored || typeof stored !== 'object') return null;
  if (stored.version === CONFIG_VERSION) return stored;

  const next = { ...stored, version: CONFIG_VERSION };
  // 已经是档案数组就别重建：从更新版本回退安装时（version 对不上但数据是新的），
  // 重建默认档案会把用户已存的 Key、模型、术语库全丢掉。
  const providers = Array.isArray(stored.providers) && stored.providers.length
    ? stored.providers.map((p) => ({ ...p }))
    : defaultProviders();

  const oldOpenai = stored.openai || {};
  if (oldOpenai.apiKey || oldOpenai.model) {
    Object.assign(providers.find((p) => p.id === 'openai'), {
      apiKey: oldOpenai.apiKey || '',
      url: oldOpenai.baseUrl || TEMPLATE_PRESETS.openai.defaultUrl,
      model: oldOpenai.model || 'gpt-4o-mini',
      systemPrompt: oldOpenai.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      expert: oldOpenai.expert || '',
      glossary: oldOpenai.glossary || '',
    });
  }

  if (stored.deepl?.apiKey) {
    providers.push(makeProvider('deepl', {
      id: 'deepl', name: 'DeepL', apiKey: stored.deepl.apiKey, pro: !!stored.deepl.pro,
    }));
  }

  next.providers = providers;
  delete next.deepl;
  delete next.openai;
  if (!providers.some((p) => p.id === next.engine)) next.engine = providers[0].id;
  return next;
}

export async function getConfig() {
  const stored = await chrome.storage.local.get('config');
  return deepMerge(structuredClone(DEFAULTS), migrateConfig(stored.config) || {});
}

// setConfig 是「读-改-写」。设置页和弹窗可能同时发消息（改模型名是防抖保存，勾选项是立即保存），
// 不串行化的话两边读到同一份旧配置，后写的会把先写的整片覆盖掉。
let writeChain = Promise.resolve();

export async function setConfig(patch) {
  const run = writeChain.then(async () => {
    const cur = await getConfig();
    const next = deepMerge(cur, patch);
    await chrome.storage.local.set({ config: next });
    return next;
  });
  writeChain = run.then(() => {}, () => {});   // 一次失败不能卡住后续写入
  return run;
}

export async function ensureMigrated() {
  const stored = await chrome.storage.local.get('config');
  const migrated = migrateConfig(stored.config);
  if (migrated && migrated !== stored.config) {
    await chrome.storage.local.set({ config: migrated });
    return true;
  }
  return false;
}

// 这几个字段是「映射表」语义（整份数据一起换掉），不能深合并。
// 尤其是 siteRules：
//   patch: { siteRules: {} }  本意是「清空所有站点规则」，
//   但深合并会把它当成「没有要改的键」而什么都不做，规则永远清不掉。
const REPLACE_KEYS = new Set(['siteRules', 'providers', 'skipLangs']);

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (REPLACE_KEYS.has(k)) {
      if (v !== undefined) base[k] = v;
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}

export const LANGS = [
  ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
  ['ru', 'Русский'], ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'],
  ['th', 'ไทย'], ['vi', 'Tiếng Việt'], ['hi', 'हिन्दी'],
];

export const LANG_NAME = Object.fromEntries(LANGS);