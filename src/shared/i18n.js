// 扩展页面的 i18n 工具。文案放在 _locales/<lang>/messages.json。
//
// 取不到 key 时直接返回 key 本身（而不是空串），这样漏翻会以可见的 key 暴露出来，
// i18n 完整性测试也靠这个行为来发现问题。

export function t(key, ...subs) {
  let text = key;
  try {
    text = chrome.i18n.getMessage(key) || key;
  } catch { /* 非扩展环境（Node 单测）里退回 key 本身 */ }
  if (!subs.length) return text;
  return text.replace(/\{(\d+)\}/g, (m, i) => (subs[Number(i)] === undefined ? m : String(subs[Number(i)])));
}

// 把 data-i18n / data-i18n-html / data-i18n-placeholder / data-i18n-title 应用到 DOM
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

// 界面语言是否是中文（用于少数需要按语言分支的地方）
export function isChineseUI() {
  return /^zh/i.test(chrome.i18n.getUILanguage?.() || '');
}