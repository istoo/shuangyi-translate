// 打包前校验：manifest 引用的文件必须存在，所有脚本语法必须能通过解析。
// 这两类错误在浏览器里只会表现为「扩展加载失败」，很难排查。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

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

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const referenced = new Set([
  ...Object.values(manifest.icons || {}),
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ...(manifest.web_accessible_resources || []).flatMap((r) => (r.resources || []).filter((x) => !x.includes('*'))),
].filter(Boolean));

check(`manifest 引用的 ${referenced.size} 个文件都存在`, () => {
  const missing = [...referenced].filter((f) => !existsSync(join(ROOT, f)));
  assert.deepEqual(missing, [], `缺失文件：${missing.join(', ')}`);
});

check('扩展的 JS 都能通过语法解析', () => {
  const files = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 0);
  const broken = [];
  for (const file of files) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) broken.push(`${relative(ROOT, file)}: ${(r.stderr || '').split('\n')[0]}`);
  }
  assert.deepEqual(broken, [], broken.join('\n'));
});

check('HTML 里引用的本地资源都存在', () => {
  const pages = [manifest.action?.default_popup, manifest.options_page,
    'src/welcome/welcome.html', 'src/pdf/pdf.html'].filter(Boolean);
  const missing = [];
  for (const page of pages) {
    const html = readFileSync(join(ROOT, page), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
      const target = join(ROOT, page, '..', m[1]);
      if (!existsSync(target)) missing.push(`${page} → ${m[1]}`);
    }
  }
  assert.deepEqual(missing, [], missing.join(', '));
});

check('打包清单覆盖扩展运行需要的文件', () => {
  const packSrc = readFileSync(join(ROOT, 'scripts/pack.mjs'), 'utf8');
  const m = packSrc.match(/const INCLUDED = \[(.*?)\];/s);
  assert.ok(m, '在 scripts/pack.mjs 里找不到 INCLUDED 定义');
  const included = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);

  for (const need of ['manifest.json', 'icons', 'src']) {
    assert.ok(included.includes(need), `打包清单缺少 ${need}`);
  }
  // manifest 用了 __MSG__ 就必须带上语言包，否则商店里会直接显示成 __MSG_extName__
  if (manifest.default_locale) {
    assert.ok(included.includes('_locales'), 'manifest 走 i18n，但打包清单里没有 _locales');
    assert.ok(existsSync(join(ROOT, `_locales/${manifest.default_locale}/messages.json`)),
      `默认语言包 _locales/${manifest.default_locale}/messages.json 不存在`);
  }
});

check('脚本用 fileURLToPath 取路径，而不是 URL.pathname', () => {
  // URL.pathname 会把空格转义成 %20，代码放在含空格的目录里就会找不到文件。
  // 开发者机器上的路径五花八门，这种坑只会在别人 clone 之后才炸出来。
  const files = [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'test'))]
    .filter((f) => f.endsWith('.mjs'));
  const bad = files.filter((f) => /import\.meta\.url\)\.pathname/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map((f) => relative(ROOT, f)), [], '这些文件还在用 URL.pathname 取路径');
});

check('HTML 里的 id 与脚本用到的 id 对得上', () => {
  // 设置页与弹窗的脚本都是按 id 取元素的，改了 HTML 忘了改脚本会直接抛错
  const pairs = [
    ['src/options/options.html', 'src/options/options.js'],
    ['src/popup/popup.html', 'src/popup/popup.js'],
    ['src/welcome/welcome.html', 'src/welcome/welcome.js'],
    ['src/pdf/pdf.html', 'src/pdf/pdf.js'],
  ];
  const problems = [];
  for (const [htmlPath, jsPath] of pairs) {
    const html = readFileSync(join(ROOT, htmlPath), 'utf8');
    const js = readFileSync(join(ROOT, jsPath), 'utf8');
    const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of js.matchAll(/\$\('([^']+)'\)/g)) {
      if (!htmlIds.has(m[1])) problems.push(`${jsPath} 引用了 ${htmlPath} 中不存在的 #${m[1]}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

check('表单标签都关联到真实存在的控件', () => {
  // 两类问题：label[for] 指向不存在的 id；label 紧挨着下拉/输入框却没关联
  const problems = [];
  const pages = ['src/options/options.html', 'src/popup/popup.html', 'src/welcome/welcome.html', 'src/pdf/pdf.html'];
  for (const p of pages) {
    const html = readFileSync(join(ROOT, p), 'utf8');
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)) {
      if (!ids.has(m[1])) problems.push(`${p}: label for="${m[1]}" 找不到对应控件`);
    }
    // 内容里不能再出现 </label>：否则惰性匹配会跨过好几个 label，误报
    for (const m of html.matchAll(/<label(?![^>]*\bfor=)[^>]*>((?:(?!<\/label>)[\s\S])*?)<\/label>\s*<(select|input|textarea)\b/g)) {
      problems.push(`${p}: label「${m[1].replace(/<[^>]+>/g, '').trim().slice(0, 16)}」紧挨着 ${m[2]} 却没用 for 关联`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
