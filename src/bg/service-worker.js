// 后台：承接内容脚本的翻译请求（绕过页面 CORS）、缓存、右键菜单、快捷键。

import { getConfig, setConfig, ensureMigrated } from '../shared/config.js';
import { resolveProvider, fingerprint } from '../shared/providers.js';
import { translateTexts } from './engines.js';
import { t } from '../shared/i18n.js';

// 译文缓存：key = 服务档案指纹|to|文本，控制上限避免无限增长
// 指纹涵盖模型、提示词、术语库等全部配置，改完设置旧译文自动失效
const cache = new Map();
const CACHE_MAX = 5000;

function cacheGet(key) {
  const v = cache.get(key);
  if (v !== undefined) {
    cache.delete(key);
    cache.set(key, v); // LRU 提升
  }
  return v;
}

function cacheSet(key, val) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, val);
}

async function handleTranslate({ texts, from, to, provider: draft, docTitle, context, noCache }) {
  const config = await getConfig();
  const target = to || config.targetLang;
  const provider = draft || resolveProvider(config);
  const prefix = `${provider.id}#${fingerprint(provider)}|${target}|`;
  const result = new Array(texts.length);
  const missIdx = [];
  const missTexts = [];

  texts.forEach((t, i) => {
    // 单段重译要求绕过缓存，否则只会拿到一份一模一样的旧译文
    const hit = noCache ? undefined : cacheGet(prefix + t);
    if (hit !== undefined) result[i] = hit;
    else {
      missIdx.push(i);
      missTexts.push(t);
    }
  });

  if (missTexts.length) {
    const translated = await translateTexts(missTexts, { from, to: target, config, provider, docTitle, context });
    missIdx.forEach((origIdx, k) => {
      const val = translated[k] ?? '';
      result[origIdx] = val;
      if (val) cacheSet(prefix + missTexts[k], val);
    });
  }
  return result;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'translate':
          sendResponse({ ok: true, data: await handleTranslate(msg) });
          break;
        case 'getConfig':
          sendResponse({ ok: true, data: await getConfig() });
          break;
        case 'setConfig':
          sendResponse({ ok: true, data: await setConfig(msg.patch) });
          break;
        case 'clearCache':
          cache.clear();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: t('bgUnknownMessage', msg?.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // 保持异步通道
});

// ---- 右键菜单 ----
const MENUS = [
  { id: 'translate-page', title: t('bgMenuTranslatePage'), contexts: ['page', 'frame'] },
  { id: 'translate-selection', title: t('bgMenuTranslateSelection'), contexts: ['selection'] },
  { id: 'toggle-site-always', title: t('bgMenuSiteAlways'), contexts: ['page'] },
  { id: 'toggle-site-never', title: t('bgMenuSiteNever'), contexts: ['page'] },
  { id: 'open-options', title: t('bgMenuOptions'), contexts: ['action', 'page'] },
];

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) chrome.contextMenus.create(m);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  buildMenus();
  ensureMigrated(); // v1 的单份 openai/deepl 配置迁移为档案数组
  // 首次安装时开一个引导页：否则用户不会知道还有悬停、划词、快捷键这些用法
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
  }
});
chrome.runtime.onStartup?.addListener(() => {
  buildMenus();
  ensureMigrated();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'open-options') return chrome.runtime.openOptionsPage();
  if (!tab?.id) return;

  if (info.menuItemId === 'toggle-site-always' || info.menuItemId === 'toggle-site-never') {
    const host = safeHost(tab.url);
    if (!host) return;
    const rule = info.menuItemId === 'toggle-site-always' ? 'always' : 'never';
    const cfg = await getConfig();
    const rules = { ...cfg.siteRules };
    if (rules[host] === rule) delete rules[host];
    else rules[host] = rule;
    await chrome.storage.local.set({ config: { ...cfg, siteRules: rules } });
    send(tab.id, { type: 'configChanged' });
    return;
  }

  send(tab.id, { type: info.menuItemId === 'translate-page' ? 'togglePage' : 'translateSelection' });
});

chrome.commands?.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === 'toggle-translate') send(tab.id, { type: 'togglePage' });
  if (command === 'toggle-compare') send(tab.id, { type: 'toggleMode' });
});

function send(tabId, msg) {
  chrome.tabs.sendMessage(tabId, msg).catch(() => { /* 内容脚本未注入的页面忽略 */ });
}

function safeHost(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
