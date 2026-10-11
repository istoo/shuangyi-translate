// 视频字幕端到端验证：本地起一个带 WebVTT 字幕的 HTML5 视频页，跑完整链路
// （捕获轨道 → 翻译 → 双语叠加层），确认字幕层的位置与内容都对。
//
// 用法：先启动带调试端口的 Chrome，再 node test/e2e/subtitle-check.mjs <port>
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from './cdp.mjs';
import { setTestConfig } from './state.mjs';

const PORT = process.argv[2] || '9352';
const EXT = fileURLToPath(new URL('../../', import.meta.url));

const VTT = `WEBVTT

1
00:00:00.200 --> 00:00:02.600
Hello and welcome to this subtitle test.

2
00:00:02.600 --> 00:00:05.200
The translation should appear right below this line.

3
00:00:05.200 --> 00:00:08.000
This is the third caption used for testing.
`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Subtitle Test</title>
<style>body{margin:0;background:#0c0d10;display:flex;align-items:center;justify-content:center;height:100vh}
video{width:min(880px,92vw);border-radius:10px;background:#000}</style></head><body>
<video id="v" controls muted autoplay playsinline>
  <track kind="subtitles" src="/subs.vtt" srclang="en" label="English" default>
</video></body></html>`;

// 一个可公开访问的短测试视频（MDN 的 CC0 素材）
const SAMPLE_VIDEO = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';

const server = createServer((req, res) => {
  // 扮演 OpenAI 兼容翻译接口：字幕链路必须走本地假接口，不能依赖上一个脚本留下的配置
  // （否则指向的可能是已经关掉的端口，字幕永远翻译不出来）
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (ch) => { raw += ch; });
    req.on('end', () => {
      const texts = JSON.parse(JSON.parse(raw).messages[1].content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(texts.map((x) => `【译】${x}`)) } }] }));
    });
    return;
  }
  if (req.url.startsWith('/subs.vtt')) {
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
    return res.end(VTT);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${server.address().port}`;

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const listing = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await connect(ver.webSocketDebuggerUrl);
const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
// 已经加载过时 loadUnpacked 可能不回 id，就从 service worker target 里认领一个
let extId = loaded.result?.id;
if (!extId) {
  const sw = (await listing()).find((t) => (t.url || '').startsWith('chrome-extension://'));
  extId = sw ? new URL(sw.url).hostname : null;
}
check('扩展加载成功', !!extId, extId || JSON.stringify(loaded.error));
await sleep(2500);

// 自带翻译服务与字幕开关：跑在别的脚本后面时，也能保证状态是自己要的那份
await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/options/options.html` });
await sleep(1800);
const optTarget = (await listing()).find((t) => t.url.includes('options.html'));
const opt = await connect(optTarget.webSocketDebuggerUrl);
await opt.send('Runtime.enable');
await sleep(500);
await setTestConfig(opt, {
  engine: 'e2e',
  providers: [{ id: 'e2e', type: 'openai', name: 'E2E 假接口', url: SITE, apiKey: 'k', model: 'm' }],
  autoTranslate: false, showFloatBall: false, subtitleTranslate: true, targetLang: 'zh-CN',
});

await browser.send('Target.createTarget', { url: SITE });
await sleep(2500);
const target = (await listing()).find((t) => t.url.startsWith(SITE));
const c = await connect(target.webSocketDebuggerUrl);
await c.send('Runtime.enable');

await c.evalJs(`(() => {
  const v = document.getElementById('v');
  v.src = ${JSON.stringify(SAMPLE_VIDEO)};
  v.muted = true;
  v.play().catch(() => {});
  return 1;
})()`);
await sleep(3000);

const early = JSON.parse((await c.evalJs(`(() => {
  const v = document.getElementById('v');
  return JSON.stringify({ mode: v.textTracks[0]?.mode, cues: v.textTracks[0]?.cues?.length ?? null });
})()`)).value || '{}');
check('原生字幕轨被切成 hidden（改由扩展渲染）', early.mode === 'hidden', early.mode || '');
check('字幕 cue 已加载', (early.cues || 0) > 0, `${early.cues} 条`);

const sample = async () => JSON.parse((await c.evalJs(`(() => {
  const v = document.getElementById('v');
  const layer = document.querySelector('.irt-sub-layer');
  return JSON.stringify({
    time: Math.round(v.currentTime * 10) / 10,
    shown: layer?.classList.contains('irt-sub-show') ?? false,
    orig: layer?.querySelector('.irt-sub-orig')?.textContent || '',
    trans: layer?.querySelector('.irt-sub-trans')?.textContent || '',
    layerBox: layer ? [Math.round(layer.getBoundingClientRect().width), Math.round(layer.getBoundingClientRect().height)] : null,
    videoBox: [Math.round(v.getBoundingClientRect().width), Math.round(v.getBoundingClientRect().height)],
  });
})()`)).value || '{}');

// 等译文回来（首次翻译请求可能较慢）。字幕是按播放进度预取的，采样时停在哪条 cue 上不
// 确定 —— 只等「有译文」会撞上第 1 条，后面「原文正确」的断言就会无端变红，所以要等到
// 第 2 条 cue 显示且已翻译。
let state = {};
for (let i = 0; i < 20; i += 1) {
  state = await sample();
  if (state.trans && /translation should appear/.test(state.orig || '')) break;
  await sleep(1000);
}
// 兜底：视频可能已经播完（叠加层随之隐藏），直接定位到第 2 条 cue 再采样一次
if (!/translation should appear/.test(state.orig || '')) {
  await c.evalJs(`(() => { const v = document.getElementById('v'); v.currentTime = 3; v.pause(); return 1; })()`);
  await sleep(2000);
  state = await sample();
}

check('字幕叠加层显示出来了', state.shown === true);
check('原文正确', /translation should appear/.test(state.orig || ''), (state.orig || '').slice(0, 60));
check('译文渲染出来了', !!state.trans && /[\u4e00-\u9fff]/.test(state.trans), (state.trans || '').slice(0, 60));
check('叠加层与视频区域对齐',
  state.layerBox && state.videoBox && state.layerBox[0] === state.videoBox[0] && state.layerBox[1] === state.videoBox[1],
  `层 ${JSON.stringify(state.layerBox)} vs 视频 ${JSON.stringify(state.videoBox)}`);

const shot = await c.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/subtitle-e2e.png', Buffer.from(shot.result.data, 'base64'));
console.log('   截图: /tmp/subtitle-e2e.png');

c.close();
opt.close();
browser.close();
server.close();
console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
