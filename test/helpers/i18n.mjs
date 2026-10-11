// 测试用的 i18n 辅助：从 _locales 读真实消息，
// 这样测试断言可以继续使用中文文案，同时也能发现漏翻（漏翻会返回 key 本身）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadMessages(locale = 'zh_CN') {
  return JSON.parse(readFileSync(`${ROOT}_locales/${locale}/messages.json`, 'utf8'));
}

export function makeI18n(locale = 'zh_CN') {
  const msgs = loadMessages(locale);
  return {
    getMessage(key) {
      return msgs[key]?.message ?? '';
    },
    getUILanguage: () => (locale === 'zh_CN' ? 'zh-CN' : 'en-US'),
  };
}
