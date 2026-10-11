// i18n 完整性：漏翻、key 拼错、两个语言不齐这些问题，只有静态检查才拦得住。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALES = ['zh_CN', 'en'];

const load = (locale) => JSON.parse(readFileSync(join(ROOT, `_locales/${locale}/messages.json`), 'utf8'));
const bundles = Object.fromEntries(LOCALES.map((l) => [l, load(l)]));
const primary = bundles.zh_CN;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(join(ROOT, 'src'));
const sourceText = sourceFiles
  .filter((f) => /\.(js|html)$/.test(f))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const manifestText = readFileSync(join(ROOT, 'manifest.json'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('✅', name);
  } catch (e) {
    fail += 1;
    console.log('❌', name, '\n   ', e.message);
  }
}

// ---------- 语言包之间必须完全对齐 ----------
check(`${LOCALES.length} 个语言包的 key 完全一致`, () => {
  const base = Object.keys(primary).sort();
  for (const locale of LOCALES.slice(1)) {
    const other = Object.keys(bundles[locale]).sort();
    const missing = base.filter((k) => !other.includes(k));
    const extra = other.filter((k) => !base.includes(k));
    assert.deepEqual([...missing, ...extra], [],
      `${locale} 与 zh_CN 不一致：缺少 ${missing.join(',') || '无'}｜多余 ${extra.join(',') || '无'}`);
  }
});

check('没有空文案', () => {
  const empty = [];
  for (const locale of LOCALES) {
    for (const [k, v] of Object.entries(bundles[locale])) {
      if (!String(v.message || '').trim()) empty.push(`${locale}/${k}`);
    }
  }
  assert.deepEqual(empty, []);
});

// ---------- 用到但没定义的 key ----------
check('HTML 里的 data-i18n* 都能在语言包里找到', () => {
  const bad = [];
  for (const file of sourceFiles.filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(file, 'utf8');
    const re = /data-i18n(?:-html|-placeholder|-title)?="([^"]+)"/g;
    for (const m of html.matchAll(re)) {
      if (!(m[1] in primary)) bad.push(`${relative(ROOT, file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

check('manifest 里的 __MSG_xxx__ 都能在语言包里找到', () => {
  const bad = [];
  for (const m of manifestText.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) {
    if (!(m[1] in primary)) bad.push(m[1]);
  }
  assert.deepEqual(bad, [], `未定义：${bad.join(', ')}`);
});

check('源码里直接调用的 t(\'key\') 都能在语言包里找到', () => {
  const bad = [];
  for (const file of sourceFiles.filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/\bt\(\s*'([A-Za-z][A-Za-z0-9]*)'/g)) {
      if (!(m[1] in primary)) bad.push(`${relative(ROOT, file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

// ---------- 定义了但没人用（说明还有硬编码没迁走） ----------
check('语言包里没有用不到的死文案', () => {
  const unused = Object.keys(primary).filter((k) => {
    if (manifestText.includes(k)) return false;
    return !sourceText.includes(k);
  });
  assert.deepEqual(unused, [], `这些 key 没有任何引用：${unused.join(', ')}`);
});

// ---------- manifest 的默认语言必须存在 ----------
check('manifest 的 default_locale 有对应的语言包', () => {
  const manifest = JSON.parse(manifestText);
  assert.ok(LOCALES.includes(manifest.default_locale),
    `default_locale=${manifest.default_locale} 但只有 ${LOCALES.join(', ')}`);
  assert.ok(manifest.name.startsWith('__MSG_'), 'manifest.name 应当走 i18n');
  assert.ok(manifest.description.startsWith('__MSG_'), 'manifest.description 应当走 i18n');
});

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}（zh_CN ${Object.keys(primary).length} 条文案）`);
if (fail) process.exit(1);