// 视频字幕：两条路径（标准 textTrack / 站点自绘 DOM）都要能拿到字幕并渲染双语。
// jsdom 没有 textTracks API，这里手工构造一个最小实现。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { makeI18n } from './helpers/i18n.mjs';

const cfg = {
  engine: 'google', targetLang: 'zh-CN', skipLangs: ['zh-CN'],
  displayStyle: 'dashed', mode: 'bilingual', fontScale: 1,
  subtitleTranslate: true, subtitleMode: 'bilingual', subtitleFontScale: 1,
  selectionTranslate: false, hoverTranslate: false, inputTranslate: false, showFloatBall: false,
};

const sentBatches = [];
const msgListeners = [];   // subtitles.js 注册的消息入口，用来模拟 configChanged
let translateImpl = (texts) => texts.map((x) => '【译】' + x);

function bootDom({ url = 'https://example.com/video', body = '' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><body>${body || '<video id="v" src="a.mp4"></video>'}</body></html>`,
    { pretendToBeVisual: true, runScripts: 'outside-only', url },
  );
  const { window } = dom;
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 960, height: 540, top: 60, left: 0, right: 960, bottom: 600, x: 0, y: 60 };
  };
  window.chrome = {
    i18n: makeI18n(),
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => { msgListeners.push(fn); } },
      sendMessage: (msg, cb) => {
        let res = { ok: true };
        if (msg.type === 'getConfig') res = { ok: true, data: JSON.parse(JSON.stringify(cfg)) };
        else if (msg.type === 'translate') {
          sentBatches.push(msg.texts);
          res = { ok: true, data: translateImpl(msg.texts) };
        }
        cb && cb(res);
        return Promise.resolve(res);
      },
    },
  };
  return { dom, window, doc: window.document };
}

function run(window) {
  window.eval(readFileSync('src/content/subtitles.js', 'utf8'));
}

// 手工造一个 textTrack，并挂到 video 上
function attachTrack(window, video, cues) {
  const listeners = {};
  const track = {
    kind: 'subtitles', label: 'English', language: 'en', mode: 'disabled',
    cues, activeCues: [],
    addEventListener(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeEventListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn); },
    listenerCount(ev) { return (listeners[ev] || []).length; },
    emit(ev) { (listeners[ev] || []).forEach((fn) => fn()); },
  };
  const list = [track];
  const tracksObj = {
    length: 1, 0: track,
    [Symbol.iterator]: function* () { yield* list; },
    addEventListener() {},
  };
  Object.defineProperty(video, 'textTracks', { value: tracksObj, configurable: true });
  return track;
}

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= 路径 1：标准 textTrack =================
console.log('=== 标准 textTrack ===');
{
  const { window, doc } = bootDom();
  const video = doc.getElementById('v');
  const track = attachTrack(window, video, [
    { start: 0, end: 4, text: 'Hello and welcome.' },
    { start: 4, end: 8, text: 'This is the second line.' },
  ]);
  run(window);
  await sleep(200);

  check('把轨道切成 hidden（不再显示原生字幕）', track.mode === 'hidden', track.mode);

  // 播放到第一句
  Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
  track.activeCues = [track.cues[0]];
  track.emit('cuechange');
  await sleep(150);

  const layer = doc.querySelector('.irt-sub-layer');
  check('字幕层被创建并显示', !!layer && layer.classList.contains('irt-sub-show'));
  check('显示原文', layer?.querySelector('.irt-sub-orig')?.textContent === 'Hello and welcome.',
    layer?.querySelector('.irt-sub-orig')?.textContent || '');
  check('译文渲染出来', layer?.querySelector('.irt-sub-trans')?.textContent === '【译】Hello and welcome.',
    layer?.querySelector('.irt-sub-trans')?.textContent || '');
  check('字幕层挂在 video 的父节点里（全屏时可见）', layer?.parentElement === video.parentElement);
  check('字幕层带 data-irt-ignore（不会被整页翻译当正文）', layer?.hasAttribute('data-irt-ignore'));

  // 切到第二句：应立刻复用缓存/重新翻译
  track.activeCues = [track.cues[1]];
  track.emit('cuechange');
  await sleep(150);
  check('切换到下一句时更新内容',
    layer?.querySelector('.irt-sub-orig')?.textContent === 'This is the second line.',
    layer?.querySelector('.irt-sub-orig')?.textContent || '');

  // 字幕消失
  track.activeCues = [];
  track.emit('cuechange');
  await sleep(80);
  check('没有活动字幕时隐藏字幕层', !layer?.classList.contains('irt-sub-show'));
}

// ================= 预取 =================
console.log('\n=== 按播放进度预取 ===');
{
  sentBatches.length = 0;
  const { window, doc } = bootDom();
  const video = doc.getElementById('v');
  const cues = Array.from({ length: 30 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: `Line number ${i}` }));
  attachTrack(window, video, cues);
  run(window);
  Object.defineProperty(video, 'currentTime', { value: 20, configurable: true });
  await sleep(3500);   // 等一次 tick（2.5s）

  const all = sentBatches.flat();
  check('按批次预取而不是逐条请求', sentBatches.length > 0 && sentBatches.every((b) => b.length > 1),
    `批次大小：${sentBatches.map((b) => b.length).join(',')}`);
  check('只翻译当前时间附近的字幕，不是整部', all.length > 0 && all.length < cues.length,
    `预取了 ${all.length} / ${cues.length} 条`);
  check('预取范围内包含当前时间点的字幕', all.some((x) => /Line number (3|4|5)\b/.test(x)), all.slice(0, 3).join(' | '));
}

// ================= 路径 2：YouTube 自绘字幕 =================
console.log('\n=== 站点适配器（YouTube 结构）===');
{
  sentBatches.length = 0;
  const { window, doc } = bootDom({
    url: 'https://www.youtube.com/watch?v=abc',
    body: '<div class="html5-video-player"><video id="v" src="a.mp4"></video>'
      + '<div class="ytp-caption-window-container"><span class="ytp-caption-segment">Initial caption</span></div></div>',
  });
  run(window);
  await sleep(250);

  const layer = doc.querySelector('.irt-sub-layer');
  check('从站点自绘字幕里读到文本', layer?.querySelector('.irt-sub-orig')?.textContent === 'Initial caption',
    layer?.querySelector('.irt-sub-orig')?.textContent || '');
  check('自绘字幕也被翻译', layer?.querySelector('.irt-sub-trans')?.textContent === '【译】Initial caption',
    layer?.querySelector('.irt-sub-trans')?.textContent || '');

  // 字幕滚动更新
  doc.querySelector('.ytp-caption-segment').textContent = 'Next caption line';
  await sleep(250);
  check('字幕变化后跟进更新', layer?.querySelector('.irt-sub-orig')?.textContent === 'Next caption line',
    layer?.querySelector('.irt-sub-orig')?.textContent || '');

  // 字幕窗口被移除（用户关了字幕）
  doc.querySelector('.ytp-caption-window-container').remove();
  await sleep(250);
  check('字幕消失后隐藏叠加层', !layer.classList.contains('irt-sub-show'));
}

// ================= 显示方式 =================
console.log('\n=== 显示方式与开关 ===');
{
  cfg.subtitleMode = 'translation';
  const { window, doc } = bootDom();
  const video = doc.getElementById('v');
  const track = attachTrack(window, video, [{ start: 0, end: 4, text: 'Only translation please' }]);
  run(window);
  await sleep(200);
  Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
  track.activeCues = [track.cues[0]];
  track.emit('cuechange');
  await sleep(150);
  const layer = doc.querySelector('.irt-sub-layer');
  check('仅译文模式给字幕层加上对应 class', layer?.classList.contains('irt-sub-translation-only'));
  cfg.subtitleMode = 'bilingual';
}

// ================= 视频太小不显示 =================
console.log('\n=== 边界 ===');
{
  const { window, doc } = bootDom();
  const video = doc.getElementById('v');
  video.getBoundingClientRect = () => ({ width: 120, height: 68, top: 0, left: 0, right: 120, bottom: 68, x: 0, y: 0 });
  const track = attachTrack(window, video, [{ start: 0, end: 4, text: 'Tiny player' }]);
  run(window);
  await sleep(200);
  Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
  track.activeCues = [track.cues[0]];
  track.emit('cuechange');
  await sleep(150);
  check('播放器过小时不覆盖画面', doc.querySelector('.irt-sub-layer')?.classList.contains('irt-sub-hidden'));
}

// ================= 翻译失败不炸 =================
console.log('\n=== 翻译失败 ===');
{
  translateImpl = () => { throw new Error('boom'); };
  const { window, doc } = bootDom();
  const video = doc.getElementById('v');
  const track = attachTrack(window, video, [{ start: 0, end: 4, text: 'Will fail' }]);
  run(window);
  await sleep(200);
  Object.defineProperty(video, 'currentTime', { value: 1, configurable: true });
  track.activeCues = [track.cues[0]];
  track.emit('cuechange');
  await sleep(200);
  check('翻译出错时页面不崩，仍显示原文',
    doc.querySelector('.irt-sub-orig')?.textContent === 'Will fail');
  translateImpl = (texts) => texts.map((x) => '【译】' + x);
}

console.log('\n=== 控制器销毁时要摘掉监听器 ===');
{
  msgListeners.length = 0;
  const { window, doc } = bootDom();
  const video = doc.getElementById('v');
  const cues = [{ start: 0, end: 5, text: 'Hello and welcome.' }];
  const track = attachTrack(window, video, cues);
  run(window);
  await sleep(200);
  check('控制器挂上了 cuechange 监听', track.listenerCount('cuechange') === 1, String(track.listenerCount('cuechange')));

  // 关掉字幕翻译：init 里的 configChanged 分支会销毁全部控制器
  cfg.subtitleTranslate = false;
  for (const fn of msgListeners) fn({ type: 'configChanged' });
  await sleep(200);

  check('销毁后 cuechange 监听被摘掉', track.listenerCount('cuechange') === 0, String(track.listenerCount('cuechange')));
  check('销毁后字幕层被移除', !doc.querySelector('.irt-sub-layer'));

  // 重新打开：新控制器要能重新挂上监听（还原时 WeakSet/观察器不能留残状态）
  cfg.subtitleTranslate = true;
  for (const fn of msgListeners) fn({ type: 'configChanged' });
  await sleep(250);
  check('重新开启后重新挂上监听', track.listenerCount('cuechange') === 1, String(track.listenerCount('cuechange')));
}

// 字幕缓存要封顶，否则看完一部两小时的片子会攒下几千条译文白占内存。
// 缓存藏在模块内部，这里退一步做源码级检查：有上限常量，且写入都走封顶的 remember()。
console.log('\n=== 字幕缓存封顶 ===');
{
  const src = readFileSync('src/content/subtitles.js', 'utf8');
  const withoutHelper = src.replace(/function remember\(state, src, out\) \{[\s\S]*?\n  \}/, '');
  check('有缓存上限常量', /const CACHE_MAX = \d+;/.test(src));
  check('译文都写进封顶的 remember()', /remember\(state, /.test(src)
    && !/state\.cache\.set\(/.test(withoutHelper));
}

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
