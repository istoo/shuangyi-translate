// 首次安装的引导页：把用户送去配置模型，或者关掉。
import { applyI18n } from '../shared/i18n.js';

applyI18n();

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('closeTab').addEventListener('click', () => {
  window.close();
});
