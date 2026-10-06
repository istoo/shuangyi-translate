// 生成扩展图标。用 Chrome 渲染精确尺寸的 PNG，避免手工做图带来的边缘发虚。
//
// 字形选「双」而不是「译」：16px 是浏览器工具栏的显示尺寸，汉字笔画一多就粘连成
// 一团白斑（实测「译」「对」都不行）。「双」四笔、结构对称，16px 下仍然清楚，
// 而且正好呼应「双语对照」这个产品定位。小尺寸再额外加粗、放大字面。
//
// 用法：先启动带调试端口的 Chrome，再 node test/e2e/gen-icons.mjs <port>
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, sleep } from './cdp.mjs';

const PORT = process.argv[2] || '9342';
const OUT = new URL('../../icons/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const SIZES = [16, 32, 48, 128];

function iconHtml(size) {
  // 按尺寸微调：小图标需要更粗的笔画、更大的字面，否则会糊成一团
  const radius = Math.round(size * 0.235);
  const fontSize = Math.round(size * (size <= 32 ? 0.76 : 0.68));
  const weight = size <= 32 ? 800 : 700;
  const lift = -(size * 0.008).toFixed(2);
  const glow = size >= 48 ? `0 ${Math.round(size * 0.03)}px ${Math.round(size * 0.085)}px rgba(19,64,170,.38)` : 'none';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
    .icon{position:relative;width:${size}px;height:${size}px;border-radius:${radius}px;
      background:linear-gradient(148deg,#5fa2ff 0%,#3374ff 52%,#1d4fd8 100%);
      box-shadow:${glow};display:flex;align-items:center;justify-content:center;overflow:hidden}
    /* 顶部高光，让方块有材质感而不是死板的纯色 */
    .icon::after{content:'';position:absolute;inset:0 0 auto 0;height:46%;
      background:linear-gradient(180deg,rgba(255,255,255,.26),rgba(255,255,255,0));pointer-events:none}
    .glyph{position:relative;color:#fff;letter-spacing:0;
      font:${weight} ${fontSize}px/1 -apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
      transform:translateY(${lift}px);text-shadow:0 1px 1px rgba(18,56,140,.22)}
  </style></head><body><div class="icon"><span class="glyph">双</span></div></body></html>`;
}

const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);

for (const size of SIZES) {
  const created = await browser.send('Target.createTarget', {
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(iconHtml(size)),
  });
  const targetId = created.result.targetId;
  await sleep(900);

  const target = (await listing()).find((t) => t.id === targetId && t.type === 'page');
  const c = await connect(target.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: size, height: size, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(700);

  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(shot.result.data, 'base64');
  writeFileSync(`${OUT}icon${size}.png`, buf);
  console.log(`  icon${size}.png  ${size}×${size}  ${(buf.length / 1024).toFixed(1)} KB`);
  c.close();
  await browser.send('Target.closeTarget', { targetId });
}

browser.close();
console.log('\n图标输出目录:', OUT);
process.exit(0);