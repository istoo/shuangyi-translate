import { LANGS, DEFAULTS } from '../shared/config.js';
import {
  PROVIDER_TYPES, TEMPLATE_PRESETS, makeProvider, fillProvider, providerKind, defaultProviderName,
} from '../shared/providers.js';
import { t, applyI18n } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);
let config = null;
let savedTimer = null;
let providerSaveTimer = null;

async function init() {
  applyI18n();

  const res = await chrome.runtime.sendMessage({ type: 'getConfig' });
  if (!res?.ok || !res.data) {
    flashSaved(t('popConfigError'));   // 后台没起来时报错，不要留下一个空白设置页
    return;
  }
  config = res.data;

  for (const [code, name] of LANGS) $('targetLang').appendChild(new Option(name, code));

  paint();
  bind();
  renderEngineOptions();
  renderProviderForm();
  renderSites();
  renderShortcuts();
}

function paint() {
  $('targetLang').value = config.targetLang;
  $('mode').value = config.mode;
  $('displayStyle').value = config.displayStyle;
  $('fontScale').value = config.fontScale;
  $('fontScaleVal').textContent = Number(config.fontScale).toFixed(2) + '×';

  for (const k of ['autoTranslate', 'showFloatBall', 'openClosedShadow', 'hoverTranslate', 'selectionTranslate', 'inputTranslate']) {
    $(k).checked = !!config[k];
  }
  $('hoverHotkey').value = config.hoverHotkey;

  $('subtitleTranslate').checked = !!config.subtitleTranslate;
  $('subtitleMode').value = config.subtitleMode;
  $('subtitleFontScale').value = config.subtitleFontScale;
  $('subtitleFontScaleVal').textContent = Number(config.subtitleFontScale).toFixed(2) + '×';
}

function bind() {
  on('targetLang', 'change', (v) => ({ targetLang: v }));
  on('mode', 'change', (v) => ({ mode: v }));
  on('displayStyle', 'change', (v) => ({ displayStyle: v }));
  $('fontScale').addEventListener('input', (e) => {
    $('fontScaleVal').textContent = Number(e.target.value).toFixed(2) + '×';
  });
  on('fontScale', 'change', (v) => ({ fontScale: Number(v) }));

  for (const k of ['autoTranslate', 'showFloatBall', 'openClosedShadow', 'hoverTranslate', 'selectionTranslate', 'inputTranslate']) {
    $(k).addEventListener('change', (e) => save({ [k]: e.target.checked }));
  }
  on('hoverHotkey', 'change', (v) => ({ hoverHotkey: v }));

  // ---- 视频字幕 ----
  $('subtitleTranslate').addEventListener('change', (e) => save({ subtitleTranslate: e.target.checked }));
  on('subtitleMode', 'change', (v) => ({ subtitleMode: v }));
  $('subtitleFontScale').addEventListener('input', (e) => {
    $('subtitleFontScaleVal').textContent = Number(e.target.value).toFixed(2) + '×';
  });
  on('subtitleFontScale', 'change', (v) => ({ subtitleFontScale: Number(v) }));

  // ---- 翻译服务档案 ----
  $('engineSel').addEventListener('change', async (e) => {
    const id = e.target.value;
    // 下拉没匹配到任何档案时（例如档案被删光）value 会是空串，不能写进配置
    if (!id) return;
    config.engine = id;
    await save({ engine: config.engine });
    renderProviderForm();
    clearTestOutput();
  });

  $('btnNew').onclick = async () => {
    const p = makeProvider('openai', { name: uniqueName(defaultProviderName('openai')) });
    config.providers = [...config.providers, p];
    config.engine = p.id;
    await save({ providers: config.providers, engine: p.id });
    renderEngineOptions();
    renderProviderForm();
    clearTestOutput();
    flashSaved(t('createdProvider', p.name));
  };

  $('btnDel').onclick = async () => {
    if (config.providers.length <= 1) return flashSaved(t('needOneProvider'));
    const p = currentProvider();
    if (!confirm(t('confirmDeleteProvider', p.name))) return;
    config.providers = config.providers.filter((x) => x.id !== p.id);
    if (config.engine === p.id) config.engine = config.providers[0].id;
    await save({ providers: config.providers, engine: config.engine });
    renderEngineOptions();
    renderProviderForm();
    clearTestOutput();
  };

  $('testBtn').onclick = runTest;
  $('openShortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  $('clearCache').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearCache' });
    flashSaved(t('cacheCleared'));
  };
  $('reset').onclick = async () => {
    if (!confirm(t('confirmReset'))) return;
    await chrome.storage.local.set({ config: structuredClone(DEFAULTS) });
    const res = await chrome.runtime.sendMessage({ type: 'getConfig' });
    config = res.data;
    paint();
    renderEngineOptions();
    renderProviderForm();
    renderSites();
    flashSaved(t('resetDone'));
  };
}

// ---------- 服务档案 ----------
function currentProvider() {
  return config.providers.find((p) => p.id === config.engine) || config.providers[0];
}

function renderEngineOptions() {
  const sel = $('engineSel');
  sel.innerHTML = '';
  for (const p of config.providers) sel.appendChild(new Option(p.name, p.id));
  // 当前 engine 指向已被删除的档案时回退到第一个，避免下拉处于未选中状态
  const known = config.providers.some((p) => p.id === config.engine);
  sel.value = known ? config.engine : (config.providers[0]?.id || '');
}

function renderProviderForm() {
  const p = currentProvider();
  const form = $('providerForm');
  form.innerHTML = '';
  if (!p) return;

  form.appendChild(textField(t('providerName'), p.name, (v) => updateProvider({ name: v }), t('providerNameHint')));

  const typeWrap = el('div', { class: 'field' });
  typeWrap.appendChild(el('label', { text: t('providerType') }));
  const typeSel = el('select');
  for (const [type, meta] of Object.entries(PROVIDER_TYPES)) {
    typeSel.appendChild(new Option(t(meta.nameKey), type));
  }
  typeSel.value = p.type;
  typeSel.addEventListener('change', () => changeProviderType(typeSel.value));
  typeWrap.appendChild(typeSel);
  form.appendChild(typeWrap);

  // 表单展示的是「预设补全后」的视图：未手改过的模板字段也要显示默认值，
  // 否则高级区一片空白，用户会以为功能坏了。编辑仍然只写回原始档案。
  const view = providerKind(p.type) === 'llm' ? fillProvider(p) : p;
  for (const key of fieldsForType(p.type)) form.appendChild(renderField(key, view));
  if (providerKind(p.type) === 'llm') form.appendChild(renderAdvanced(view));
}

function fieldsForType(type) {
  if (providerKind(type) === 'builtin') return type === 'deepl' ? ['apiKey', 'pro'] : [];
  return ['url', 'apiKey', 'model', 'temperature', 'systemPrompt', 'expert', 'glossary'];
}

// 换类型时保留通用字段，地址与模板重置为该类型的预设
function changeProviderType(type) {
  const p = currentProvider();
  const preset = TEMPLATE_PRESETS[type] || {};
  const wasDefaultName = p.name === defaultProviderName(p.type);
  Object.assign(p, {
    type,
    name: wasDefaultName ? defaultProviderName(type) : p.name,
    url: preset.defaultUrl || '',
    method: preset.method || 'POST',
    urlTemplate: '',
    headersTemplate: '',
    bodyTemplate: '',
    responsePath: '',
  });
  renderEngineOptions();
  renderProviderForm();
  scheduleProviderSave();
}

function updateProvider(patch) {
  const p = currentProvider();
  if (!p) return;
  const renamed = patch.name !== undefined && patch.name !== p.name;
  Object.assign(p, patch);
  // 改名时只改对应的那一项：重建整个下拉会在每敲一个字时都销毁重建选项，
  // 正在展开的下拉会被关掉，也会丢掉选中态
  if (renamed) {
    const opt = [...$('engineSel').options].find((o) => o.value === p.id);
    if (opt) opt.text = p.name;
    else renderEngineOptions();
  }
  scheduleProviderSave();
}

function scheduleProviderSave() {
  clearTimeout(providerSaveTimer);
  providerSaveTimer = setTimeout(() => save({ providers: config.providers }), 400);
}

function uniqueName(base) {
  const names = new Set(config.providers.map((p) => p.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

// ---------- 字段定义 ----------
// labelKey / hintKey 指向 _locales 里的文案；url 这一项按服务类型取不同的标签与提示。
const FIELD_DEFS = {
  url: {
    labelFrom: (meta) => meta.urlLabelKey,
    hintFrom: (meta) => meta.urlHintKey,
    placeholderKey: 'placeholderUrl',
  },
  apiKey: { kind: 'password', labelKey: 'fieldApiKey', placeholderKey: 'placeholderApiKey' },
  model: { labelKey: 'fieldModel', hintKey: 'fieldModelHint', placeholder: 'gpt-4o-mini' },
  temperature: { kind: 'number', labelKey: 'fieldTemperature', hintKey: 'fieldTemperatureHint' },
  pro: { kind: 'checkbox', labelKey: 'fieldPro' },
  systemPrompt: {
    kind: 'textarea', rows: 4, labelKey: 'fieldSystemPrompt', hintKey: 'fieldSystemPromptHint',
    placeholderKey: 'promptSystem',   // 空框时把内置提示词显示成 placeholder
  },
  expert: { labelKey: 'fieldExpert', placeholderKey: 'fieldExpertPlaceholder', hintKey: 'fieldExpertHint' },
  glossary: {
    kind: 'textarea', rows: 5, labelKey: 'fieldGlossary',
    placeholderKey: 'fieldGlossaryPlaceholder', hintKey: 'fieldGlossaryHint',
  },
};

const ADVANCED_DEFS = {
  method: { labelKey: 'advMethod', hintKey: 'advMethodHint' },
  urlTemplate: { labelKey: 'advUrlTemplate', hintKey: 'advUrlTemplateHint' },
  headersTemplate: { labelKey: 'advHeaders', rows: 5, hintKey: 'advHeadersHint' },
  bodyTemplate: { labelKey: 'advBody', rows: 10, hintKey: 'advBodyHint' },
  responsePath: { labelKey: 'advResponsePath', hintKey: 'advResponsePathHint' },
};

function renderAdvanced(p) {
  const details = el('details', { class: 'adv' });
  details.appendChild(el('summary', { text: t('advSummary') }));
  for (const [key, def] of Object.entries(ADVANCED_DEFS)) {
    details.appendChild(renderField(key, p, def));
  }
  details.appendChild(el('p', { class: 'hint', text: t('advVarsHint') }));
  return details;
}

function renderField(key, p, def = FIELD_DEFS[key] || {}) {
  const kind = def.kind || 'text';
  const meta = PROVIDER_TYPES[p.type] || {};
  const labelText = def.labelFrom ? t(def.labelFrom(meta)) : (def.labelKey ? t(def.labelKey) : key);

  if (kind === 'checkbox') {
    const lab = el('label', { class: 'check' });
    const input = el('input', { type: 'checkbox' });
    input.checked = !!p[key];
    input.addEventListener('change', () => updateProvider({ [key]: input.checked }));
    lab.append(input, el('span', { text: labelText }));
    return lab;
  }

  const wrap = el('div', { class: 'field' });
  const label = el('label', { text: labelText });

  const input = kind === 'textarea'
    ? el('textarea', { rows: String(def.rows || 5) })
    : el('input', { type: kind === 'number' ? 'number' : kind });
  // 标签要显式关联输入框：否则点标签不聚焦，读屏也读不出字段名
  input.id = `f_${p.id}_${key}`;
  label.setAttribute('for', input.id);
  wrap.appendChild(label);
  input.value = p[key] ?? '';
  if (def.placeholderKey) input.placeholder = t(def.placeholderKey);
  else if (def.placeholder) input.placeholder = def.placeholder;
  input.addEventListener('input', () => {
    updateProvider({ [key]: kind === 'number' ? Number(input.value) : input.value });
  });
  wrap.appendChild(input);

  const hintKey = def.hintFrom ? def.hintFrom(meta) : def.hintKey;
  if (hintKey) wrap.appendChild(el('p', { class: 'hint', text: t(hintKey) }));
  return wrap;
}

function textField(label, value, onInput, hint) {
  const wrap = el('div', { class: 'field' });
  const lab = el('label', { text: label });
  const input = el('input', { type: 'text' });
  input.id = 'f_provider_name';
  lab.setAttribute('for', input.id);
  wrap.appendChild(lab);
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el('p', { class: 'hint', text: hint }));
  return wrap;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) node.appendChild(c);
  return node;
}

// ---------- 快捷键 ----------
const COMMAND_LABEL_KEYS = {
  'toggle-translate': 'bgCmdToggleTranslate',
  'toggle-compare': 'bgCmdToggleCompare',
};

// Chrome 不允许扩展改写自己的快捷键，这里只把当前绑定显示出来并提供跳转入口。
async function renderShortcuts() {
  const list = $('shortcutList');
  list.innerHTML = '';
  let commands = [];
  try {
    commands = await chrome.commands.getAll();
  } catch { /* 某些环境拿不到，留空即可 */ }

  for (const cmd of commands) {
    const labelKey = COMMAND_LABEL_KEYS[cmd.name];
    if (!labelKey) continue;
    const row = el('div', { class: 'shortcut-item' });
    row.appendChild(el('span', { class: 'k', text: t(labelKey) }));
    const box = el('span', { class: 'keys' });
    const keys = String(cmd.shortcut || '').split('+').map((s) => s.trim()).filter(Boolean);
    if (keys.length) {
      for (const k of keys) box.appendChild(el('kbd', { text: k }));
    } else {
      box.appendChild(el('span', { class: 'unset', text: t('shortcutUnset') }));
    }
    row.appendChild(box);
    list.appendChild(row);
  }
}

// ---------- 保存与测试 ----------
function on(id, evt, toPatch, debounceMs = 0) {
  let timer = null;
  $(id).addEventListener(evt, (e) => {
    const run = () => save(toPatch(e.target.value));
    if (!debounceMs) return run();
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  });
}

async function save(patch) {
  const res = await chrome.runtime.sendMessage({ type: 'setConfig', patch });
  if (res?.ok) config = res.data;
  flashSaved(t('commonSaved'));
  // 通知所有已打开的标签页刷新配置（会按新配置重译）
  const tabs = await chrome.tabs.query({});
  for (const t2 of tabs) {
    if (t2.id) chrome.tabs.sendMessage(t2.id, { type: 'configChanged' }).catch(() => {});
  }
}

function flashSaved(text) {
  const node = $('saved');
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => node.classList.remove('show'), 1600);
}

function clearTestOutput() {
  const out = $('testOut');
  out.className = 'test-out';
  out.textContent = '';
}

async function runTest() {
  const out = $('testOut');
  out.className = 'test-out';
  out.textContent = t('testRunning');
  const sample = 'Immersive translation makes reading foreign articles effortless.';
  // 用当前编辑中的草稿测试，不必先等自动保存
  const res = await chrome.runtime.sendMessage({
    type: 'translate', texts: [sample], to: config.targetLang, provider: currentProvider(),
  });
  if (res?.ok) {
    out.className = 'test-out ok';
    out.textContent = t('testSource') + sample + '\n' + t('testResult') + res.data[0];
  } else {
    out.className = 'test-out fail';
    out.textContent = t('testFailed') + (res?.error || t('testUnknownError'));
  }
}

// ---------- 站点规则 ----------
function renderSites() {
  const list = $('siteList');
  list.innerHTML = '';
  const entries = Object.entries(config.siteRules || {});
  if (!entries.length) {
    list.innerHTML = `<div class="empty">${t('siteNone')}</div>`;
    return;
  }
  for (const [host, rule] of entries) {
    const row = document.createElement('div');
    row.className = 'site-item';
    const label = el('span', { class: 'h', text: host });
    const tag = el('span', { class: `tag ${rule}`, text: rule === 'always' ? t('siteAlways') : t('siteNever') });
    const del = el('button', { class: 'del', title: t('commonDelete'), text: '✕' });
    del.onclick = async () => {
      const rules = { ...config.siteRules };
      delete rules[host];
      // 走 setConfig 而不是直接写 storage：直接写会把整份旧配置盖回去（并发保存时丢改动），
      // 也不会通知已打开的标签页。siteRules 是整体替换语义，这里传整份规则表。
      await save({ siteRules: rules });
      renderSites();
      flashSaved(t('deleted'));
    };
    row.append(label, tag, del);
    list.appendChild(row);
  }
}

init();