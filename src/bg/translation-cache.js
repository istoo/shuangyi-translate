// 译文缓存。内存里做 LRU，同时写到 chrome.storage.local。
// Service Worker 休眠后内存会丢，同一页再打开不能因此整页重翻。

const CACHE_MAX = 2000;
const STORAGE_KEY = 'translationCache';
const MAX_JSON = 4_000_000;

const cache = new Map();
let loadPromise = null;
let savePromise = Promise.resolve();

function cacheGet(key) {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  scheduleSave();
}

// 一批译文会连着写入十几条，防抖后合成一次落盘；否则每条都把整份缓存序列化重写一遍。
const SAVE_DELAY_MS = 1000;
let dirty = false;
let saveTimer = null;

async function flushIfDirty() {
  if (!dirty) return;
  dirty = false;
  await saveNow();
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    savePromise = savePromise.then(flushIfDirty);
  }, SAVE_DELAY_MS);
}

async function saveNow() {
  let entries = [...cache.entries()];
  // 按字节占比一次砍到位，再兜底微调：整份 JSON 有几十万字符，反复 stringify 会明显拖慢 Service Worker
  const bytes = JSON.stringify(entries).length;
  if (entries.length > 1 && bytes > MAX_JSON) {
    entries = entries.slice(-Math.max(1, Math.floor(entries.length * (MAX_JSON / bytes))));
    while (entries.length > 1 && JSON.stringify(entries).length > MAX_JSON) entries = entries.slice(1);
  }
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: entries });
  } catch {
    // 配额满了就只留内存。下次成功写入时再覆盖。
  }
}

function ready() {
  if (!loadPromise) {
    loadPromise = chrome.storage.local.get(STORAGE_KEY).then((bag) => {
      const entries = bag?.[STORAGE_KEY];
      if (!Array.isArray(entries)) return;
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[1] !== 'string') continue;
        if (!cache.has(pair[0])) cache.set(pair[0], pair[1]);
      }
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }).catch(() => {});
  }
  return loadPromise;
}

async function clearTranslationCache() {
  await ready();
  cache.clear();
  loadPromise = Promise.resolve();
  clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  savePromise = Promise.resolve();
  try {
    await chrome.storage.local.remove(STORAGE_KEY);
  } catch {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: [] }); } catch { /* 忽略 */ }
  }
}

// 测试用：把内存丢掉，再从本地存储装回来，模拟 Service Worker 重启。
async function reloadFromDisk() {
  await cacheIdle();
  cache.clear();
  loadPromise = null;
  await ready();
}

// 立刻把还没落盘的写完并等它结束。
function cacheIdle() {
  clearTimeout(saveTimer);
  saveTimer = null;
  savePromise = savePromise.then(flushIfDirty);
  return savePromise;
}

export {
  cacheGet, cacheSet, ready, clearTranslationCache, reloadFromDisk, cacheIdle,
};
