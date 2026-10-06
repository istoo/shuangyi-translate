// 生成扩展图标。
//
// 用 SVG 渲染而不是 CSS 布局：CSS 的百分比尺寸在 16px 下会把内部元素压到 1px 以下直接消失
// （试过，小尺寸全成了纯色块）。SVG 的 viewBox 坐标与输出尺寸无关，任何尺寸都保持比例。
//
// 图形选择：圆角对话气泡 + 两条横线，代表「跨语言的内容」。实测 16px 下气泡轮廓和两条线
// 都能辨认；相比之下汉字（双/译/文）在 16px 下必然糊成一团，字母组合也挤不开。
//
// 用法：先启动带调试端口的 Chrome，再 node test/e2e/gen-icons.mjs <port>
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect, sleep } from './cdp.mjs';

const PORT = process.argv[2] || '9361';
const OUT = new URL('../../icons/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const SIZES = [16, 32, 48, 128];

// 图形本体。viewBox 固定 100×100，坐标不用随尺寸调整。
function iconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5fa2ff"/>
      <stop offset="52%" stop-color="#3374ff"/>
      <stop offset="100%" stop-color="#1d4fd8"/>
    </linearGradient>
    <linearGradient id="hi" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".28"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#bg)"/>
  <rect width="100" height="46" rx="22" fill="url(#hi)"/>
  <rect x="14" y="20" width="72" height="56" rx="18" fill="#ffffff"/>
  <rect x="28" y="34" width="38" height="14" rx="7" fill="#3374ff"/>
  <rect x="28" y="54" width="24" height="14" rx="7" fill="#3374ff"/>
</svg>`;
}

const html = (size) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
  svg{display:block}
</style></head><body>${iconSvg(size)}</body></html>`;

const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);

for (const size of SIZES) {
  const created = await browser.send('Target.createTarget', {
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html(size)),
  });
  const targetId = created.result.targetId;
  await sleep(900);

  const target = (await listing()).find((t) => t.id === targetId);
  const c = await connect(target.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: size, height: size, deviceScaleFactor: 1, mobile: false,
  });
  await c.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await sleep(600);

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