// 打包扩展：产出 zip（提交商店用）和 crx（本地/内网分发用）。
// 只收录扩展运行必需的文件，测试、开发依赖和素材一律不进包。
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const base = `qiyi-translate-${version}`;
const dist = join(ROOT, 'dist');
const stage = join(dist, base);
const zipPath = join(dist, `${base}.zip`);
// 私钥不能放 dist（它是产物目录，随时会被清掉），单独存在项目根的 keys/ 下
const keysDir = join(ROOT, 'keys');
const keyPath = join(keysDir, 'qiyi-translate.pem');

// _locales 必须在包里：manifest 的 name/description 走 __MSG__，缺了语言包商店里会显示成 __MSG_extName__
const INCLUDED = ['manifest.json', 'icons', 'src', '_locales', 'README.md'];

// ---------- 校验 ----------
const missing = INCLUDED.filter((f) => !existsSync(join(ROOT, f)));
if (missing.length) {
  console.error('缺少文件:', missing.join(', '));
  process.exit(1);
}
if (manifest.web_accessible_resources) {
  console.warn('提示: manifest 里声明了 web_accessible_resources，提交商店前确认确实需要。');
}

// ---------- 准备暂存目录 ----------
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(keysDir, { recursive: true });
for (const f of INCLUDED) {
  cpSync(join(ROOT, f), join(stage, f), { recursive: true });
}
// 去掉 macOS 的元数据文件
spawnSync('find', [stage, '-name', '.DS_Store', '-delete']);

// 包内不应出现任何开发文件
const strays = readdirSync(stage).filter((f) => /^(node_modules|test|store|dist)$/.test(f));
if (strays.length) {
  console.error('暂存目录里混入了开发文件:', strays.join(', '));
  process.exit(1);
}

// ---------- zip ----------
rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: stage });

const kb = (p) => (statSync(p).size / 1024).toFixed(0);
console.log(`✅ zip  ${zipPath}  ${kb(zipPath)} KB`);

// ---------- crx（可选：Chrome 的打包功能在部分版本已被移除） ----------
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const crxPath = `${stage}.crx`;
if (existsSync(CHROME)) {
  const args = [`--pack-extension=${stage}`];
  if (existsSync(keyPath)) args.push(`--pack-extension-key=${keyPath}`);
  const r = spawnSync(CHROME, args, { encoding: 'utf8', timeout: 60000 });
  if (existsSync(crxPath)) {
    // 首次打包时 Chrome 会把私钥生成在 <dir>.pem，挪到固定位置以便后续复用同一签名
    const generatedKey = `${stage}.pem`;
    if (!existsSync(keyPath) && existsSync(generatedKey)) {
      cpSync(generatedKey, keyPath);
      rmSync(generatedKey);
    }
    console.log(`✅ crx  ${crxPath}  ${kb(crxPath)} KB`);
    console.log(`   签名私钥: ${keyPath}`);
    console.log('   请备份这个文件并保密：后续版本必须用同一把私钥签名，否则商店会当成另一个扩展。');
  } else {
    console.log('⚠️  未能生成 crx：当前 Chrome 已移除命令行打包功能。');
    console.log('   可改用 zip 提交商店，或用 chrome://extensions 的「打包扩展程序」按钮。');
    if (r.stderr) console.log('   Chrome 输出:', String(r.stderr).trim().slice(0, 200));
  }
}

console.log(`\n包内容:`);
execFileSync('unzip', ['-l', zipPath], { stdio: 'inherit' });