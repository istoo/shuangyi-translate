import { LANGS } from '../shared/config.js';
import { fillProvider } from '../shared/providers.js';
import { t, applyI18n } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);
let config = null;
let tab = null;
let translated = false;
let pageOk = false;   // 内容脚本是否在这个页面里（拿不到时不能把占位文案当域名写进站点规则）

const sendBg = (msg) => chrome.runtime.sendMessage(msg);
const sendTab = (msg) => chrome.tabs.sendMessage(tab.id, msg).catch(() => null);

function showErr(text) {
  const el = $('err');
  el.textContent = text;
  el.classList.toggle('show', !!text);
}

async function init() {
  applyI18n();

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await sendBg({ type: 'getConfig' });
  if (!res?.ok) return showErr(t('popConfigError'));
  config = res.data;

  for (const [code, name] of LANGS) {
    $('targetLang').appendChild(new Option(name, code));
  }
  for (const p of config.providers) {
    $('engine').appendChild(new Option(p.name, p.id));
  }
  $('targetLang').value = config.targetLang;
  $('engine').value = config.engine;
  $('displayStyle').value = config.displayStyle;
  paintSeg('modeSeg', 'mode', config.mode);

  const state = await sendTab({ type: 'getState' });
  pageOk = !!state?.ok;
  if (state?.ok) {
    translated = state.translated;
    $('host').textContent = state.host;
    paintSeg('siteSeg', 'rule', state.rule || '');
  } else {
    $('host').textContent = t('popUnsupported');
    $('toggle').disabled = true;
  }
  paintToggle();
  bind();
}

function paintToggle() {
  $('toggle').textContent = translated ? t('popRestorePage') : t('popTranslatePage');
  $('toggle').classList.toggle('on', translated);
}

function paintSeg(segId, attr, value) {
  for (const b of $(segId).querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset[attr] === value);
  }
}

// 模板里引用了 {{apiKey}} 却没填，基本可以断定是配置没做完
function needsApiKey(provider) {
  // 只填了空白等于没填：粘贴时带进来的空格不能当成「已配置」
  if (!provider || String(provider.apiKey || '').trim()) return false;
  const filled = fillProvider(provider);
  return /\{\{\s*apiKey\s*\}\}/.test((filled.urlTemplate || '') + (filled.headersTemplate || ''));
}

function bind() {
  $('toggle').onclick = async () => {
    const r = await sendTab({ type: 'togglePage' });
    if (r?.ok) { translated = r.translated; paintToggle(); }
  };

  $('targetLang').onchange = async (e) => {
    await save({ targetLang: e.target.value });
  };

  $('engine').onchange = async (e) => {
    const id = e.target.value;
    await save({ engine: id });
    showErr(needsApiKey(config.providers.find((p) => p.id === id)) ? t('popNeedKey') : '');
  };

  $('displayStyle').onchange = async (e) => {
    await save({ displayStyle: e.target.value });
  };

  $('modeSeg').onclick = async (e) => {
    const mode = e.target.dataset?.mode;
    if (!mode) return;
    paintSeg('modeSeg', 'mode', mode);
    await save({ mode });
  };

  $('siteSeg').onclick = async (e) => {
    const rule = e.target.dataset?.rule;
    if (rule === undefined) return;
    if (!pageOk) return showErr(t('popUnsupported'));
    const host = $('host').textContent;
    if (!host) return;
    paintSeg('siteSeg', 'rule', rule);
    const rules = { ...config.siteRules };
    if (rule) rules[host] = rule;
    else delete rules[host];
    await save({ siteRules: rules });   // siteRules 是整体替换语义，传整份规则表
  };

  $('exportBtn').onclick = async () => {
    const r = await sendTab({ type: 'exportPage' });
    if (r?.ok) showErr('');
    else showErr(r?.error || t('exportEmpty'));
  };

  $('openPdf').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/pdf/pdf.html') });
    window.close();
  };

  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('openOptions2').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
}

async function save(patch) {
  const r = await sendBg({ type: 'setConfig', patch });
  if (r?.ok) config = r.data;
  await sendTab({ type: 'configChanged' });
  const state = await sendTab({ type: 'getState' });
  if (state?.ok) { translated = state.translated; paintToggle(); }
}

init();
