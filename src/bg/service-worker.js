// 后台：承接内容脚本的翻译请求（绕过页面 CORS）、缓存、右键菜单、快捷键。

import { getConfig, setConfig, ensureMigrated } from '../shared/config.js';
import { resolveProvider, fingerprint } from '../shared/providers.js';
import { translateTexts } from './engines.js';
import { cacheGet, cacheSet, ready, clearTranslationCache } from './translation-cache.js';
import { t } from '../shared/i18n.js';

// 译文缓存的 key = 服务档案指纹|to|文本。指纹涵盖模型、提示词、术语库，改完设置旧译文自动失效。
// 缓存本体在 translation-cache.js：内存 LRU，并落到 chrome.storage.local，Service Worker 重启后还在。

async function handleTranslate({ texts, from, to, provider: draft, docTitle, context, noCache }) {
  await ready();
  const config = await getConfig();
  const target = to || config.targetLang;
  const provider = draft || resolveProvider(config);
  // 系统提示词里会带上页面标题（帮模型建立主题认知），所以同一句话在不同页面上的
  // 译文本来就可能不一样。标题必须进缓存 key，否则上一篇文章的译文会被搬到这一篇上。
  const prefix = `${provider.id}#${fingerprint(provider)}|${target}|${fingerprint(docTitle || '')}|`;
  const result = new Array(texts.length);
  const missIdx = [];
  const missTexts = [];

  // 参数名不要叫 t：上面的 i18n t() 是同一个作用域里的函数，命名撞上很容易埋雷
  texts.forEach((text, i) => {
    // 单段重译要求绕过缓存，否则只会拿到一份一模一样的旧译文
    const hit = noCache ? undefined : cacheGet(prefix + text);
    if (hit !== undefined) result[i] = hit;
    else {
      missIdx.push(i);
      missTexts.push(text);
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
          await clearTranslationCache();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: t('bgUnknownMessage', msg?.type) });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e), kind: e?.kind });
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

// ---- closed shadow root 支持 ----
// 要在页面脚本之前改写 attachShadow，对所有页面都有副作用，所以默认关闭，
// 用户在设置里打开后才动态注册这条 MAIN world 脚本。新注册的脚本只对之后加载的页面生效。
const SHADOW_SCRIPT_ID = 'irt-open-shadow';

async function syncShadowScript() {
  if (!chrome.scripting?.registerContentScripts) return;
  try {
    const want = !!(await getConfig()).openClosedShadow;
    const have = (await chrome.scripting.getRegisteredContentScripts({ ids: [SHADOW_SCRIPT_ID] })).length > 0;
    if (want && !have) {
      await chrome.scripting.registerContentScripts([{
        id: SHADOW_SCRIPT_ID,
        matches: ['<all_urls>'],
        js: ['src/content/force-open-shadow.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: false,
        persistAcrossSessions: true,
      }]);
    } else if (!want && have) {
      await chrome.scripting.unregisterContentScripts({ ids: [SHADOW_SCRIPT_ID] });
    }
  } catch { /* 注册失败只是少了 closed shadow 支持，不影响翻译 */ }
}

chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.config) syncShadowScript();
});

chrome.runtime.onInstalled.addListener((details) => {
  syncShadowScript();
  buildMenus();
  ensureMigrated(); // v1 的单份 openai/deepl 配置迁移为档案数组
  // 首次安装时开一个引导页：否则用户不会知道还有悬停、划词、快捷键这些用法
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome/welcome.html') });
  }
});
chrome.runtime.onStartup?.addListener(() => {
  syncShadowScript();
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
