/* 栖译 —— 视频字幕翻译
 *
 * 两条路径拿字幕：
 *  1) 标准 textTrack（WebVTT）：任何用原生字幕轨的视频站。把轨切成 hidden 让浏览器
 *     正常加载 cues，但不显示原生字幕，改由我们自己渲染双语，这样原文与译文能一起排版。
 *  2) 站点适配器：字幕由站点自绘在 DOM 里的（YouTube、B站等），监听字幕节点文本变化。
 *
 * 翻译是"按播放进度预取"而不是一次翻完整部视频：只翻译当前时间点前后的一小段，
 * 边播边补。这样既不会在打开视频时打爆接口，也天然适配拖动进度条。
 */
(() => {
  if (window.__qiyiSubtitles) return;
  window.__qiyiSubtitles = true;

  const t = (key, ...subs) => {
    let text = key;
    try { text = chrome.i18n.getMessage(key) || key; } catch { /* 非扩展环境 */ }
    return subs.length
      ? text.replace(/\{(\d+)\}/g, (m, i) => (subs[Number(i)] === undefined ? m : String(subs[Number(i)])))
      : text;
  };

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: t('csNoResponse') });
      });
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  });

  let config = null;

  // ---------- 站点适配器 ----------
  // 这些站点的字幕不在 textTrack 里，而是自己画在 DOM 上，只能按选择器监听。
  const SITE_ADAPTERS = [
    {
      id: 'youtube',
      match: () => /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname),
      container: '.ytp-caption-window-container',
      segment: '.ytp-caption-segment',
    },
  ];

  function activeAdapter() {
    return SITE_ADAPTERS.find((a) => {
      try { return a.match(); } catch { return false; }
    }) || null;
  }

  const PREFETCH_AHEAD = 90;   // 预取当前时间之后多少秒的字幕
  const PREFETCH_BEHIND = 15;  // 往前留一点，便于回拖
  const BATCH = 20;            // 单次批量翻译的条数
  const TICK_MS = 2500;        // 预取轮询间隔

  const controllers = new Set();

  // ---------- 单个视频的控制器 ----------
  function createController(video) {
    const state = {
      video,
      layer: null,
      track: null,
      adapter: null,
      observer: null,
      cache: new Map(),       // 原文 -> 译文
      inflight: new Set(),
      current: '',
      lastShown: null,
      disposed: false,
    };
    return state;
  }

  function attach(video) {
    const state = createController(video);
    controllers.add(state);

    const adapter = activeAdapter();
    if (adapter) {
      state.adapter = adapter;
      bindDomAdapter(state, adapter);
    }
    bindTextTracks(state);

    video.addEventListener('emptied', () => {
      state.cache.clear();
      state.current = '';
      hideLayer(state);
    });

    return state;
  }

  // ---------- 路径 1：标准 textTrack ----------
  function bindTextTracks(state) {
    const { video } = state;

    const onCueChange = () => {
      if (state.adapter) return;   // 站点自绘字幕优先，避免两路打架
      const cue = state.track?.activeCues?.[0];
      showCue(state, cue ? cue.text : '');
    };

    const scan = () => {
      for (const track of video.textTracks) {
        if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
        if (state.track === track) continue;
        state.track = track;
        state.track.addEventListener('cuechange', onCueChange);
        // hidden：浏览器照常加载 cues，但不画原生字幕
        try { track.mode = 'hidden'; } catch { /* 某些实现只读 */ }
      }
    };

    scan();
    try {
      video.textTracks.addEventListener('addtrack', scan);
      // 轨道列表变化后重新扫一遍，覆盖 mode 被站点改回去的情况
      video.textTracks.addEventListener('change', scan);
    } catch { /* ignore */ }
  }

  // ---------- 路径 2：站点自绘字幕 ----------
  function bindDomAdapter(state, adapter) {
    let lastText = '';
    const read = () => {
      const container = document.querySelector(adapter.container);
      // 容器不存在 = 用户关掉了字幕，要视为空文本把叠加层收起来
      const seg = container?.querySelector(adapter.segment);
      const text = (seg?.textContent || '').trim();
      if (text === lastText) return;
      lastText = text;
      showCue(state, text);
    };

    // 字幕节点是动态创建/销毁的，只能观察整页
    state.observer = new MutationObserver(read);
    state.observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
    read();
  }

  // ---------- 显示 ----------
  function ensureLayer(state) {
    if (state.layer && state.layer.isConnected) return state.layer;
    const { video } = state;
    const layer = document.createElement('div');
    layer.className = 'irt-sub-layer';
    layer.setAttribute('data-irt-ignore', '');
    layer.style.setProperty('--irt-sub-scale', String(config?.subtitleFontScale || 1));
    const orig = document.createElement('div');
    orig.className = 'irt-sub-orig';
    const trans = document.createElement('div');
    trans.className = 'irt-sub-trans';
    layer.append(orig, trans);
    // 挂在 video 的父节点里：全屏时只有全屏元素内部的节点才可见
    (video.parentElement || document.body).appendChild(layer);
    state.layer = layer;
    syncLayerBox(state);
    return layer;
  }

  function syncLayerBox(state) {
    if (!state.layer || !state.video.isConnected) return;
    const r = state.video.getBoundingClientRect();
    const s = state.layer.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    // 视频太小时不显示字幕层，避免挡住画面
    state.layer.classList.toggle('irt-sub-hidden', r.width < 240 || r.height < 120);
  }

  function showCue(state, rawText) {
    const text = (rawText || '').trim();
    if (text === state.current) return;
    state.current = text;

    if (!text) return hideLayer(state);

    const layer = ensureLayer(state);
    layer.classList.add('irt-sub-show');
    layer.classList.remove('irt-sub-translation-only');
    if (config?.subtitleMode === 'translation') layer.classList.add('irt-sub-translation-only');
    layer.querySelector('.irt-sub-orig').textContent = text;

    const translated = state.cache.get(text);
    renderTrans(state, translated === undefined ? null : translated);
    syncLayerBox(state);

    if (translated === undefined) translateOne(state, text);
  }

  function renderTrans(state, translated) {
    const node = state.layer?.querySelector('.irt-sub-trans');
    if (!node) return;
    if (translated === null) {
      node.textContent = t('csTranslating');
      node.classList.add('irt-sub-pending');
    } else {
      node.textContent = translated || '';
      node.classList.remove('irt-sub-pending');
    }
  }

  function hideLayer(state) {
    state.layer?.classList.remove('irt-sub-show');
  }

  // ---------- 翻译 ----------
  async function translateOne(state, text) {
    if (state.cache.has(text) || state.inflight.has(text)) return;
    state.inflight.add(text);
    try {
      const res = await send({ type: 'translate', texts: [text], to: config.targetLang });
      state.inflight.delete(text);
      if (!res.ok) return;
      const out = res.data[0] || '';
      state.cache.set(text, out);
      // 还停在这一句就立刻刷新译文
      if (state.current === text) renderTrans(state, out);
    } catch {
      state.inflight.delete(text);
    }
  }

  // 按播放进度预取，避免一次性翻译整部视频
  async function prefetch(state) {
    if (state.disposed || !config?.subtitleTranslate) return;
    const track = state.track;
    if (!track?.cues?.length) return;

    const now = state.video.currentTime;
    const pending = [];
    for (const cue of track.cues) {
      if (cue.end < now - PREFETCH_BEHIND) continue;
      if (cue.start > now + PREFETCH_AHEAD) break;   // cues 按时间升序
      const text = (cue.text || '').trim();
      if (text && !state.cache.has(text) && !state.inflight.has(text)) pending.push(text);
    }
    if (!pending.length) return;

    const batch = pending.slice(0, BATCH);
    batch.forEach((x) => state.inflight.add(x));
    const res = await send({ type: 'translate', texts: batch, to: config.targetLang });
    batch.forEach((x) => state.inflight.delete(x));
    if (!res.ok) return;
    batch.forEach((src, i) => state.cache.set(src, res.data[i] || ''));

    const cur = state.cache.get(state.current);
    if (cur !== undefined && state.layer) renderTrans(state, cur);
  }

  // ---------- 位置同步 ----------
  function syncAll() {
    for (const state of controllers) syncLayerBox(state);
  }

  function isWatched(state) {
    if (state.disposed || !state.video.isConnected) return false;
    const r = state.video.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function tick() {
    for (const state of controllers) {
      if (!state.video.isConnected) { dispose(state); continue; }
      if (!config?.subtitleTranslate) { hideLayer(state); continue; }
      if (!isWatched(state)) continue;
      if (state.layer) syncLayerBox(state);
      prefetch(state);
    }
  }

  function dispose(state) {
    state.disposed = true;
    state.observer?.disconnect();
    state.layer?.remove();
    controllers.delete(state);
  }

  // ---------- 启动 ----------
  function scanVideos() {
    if (!config?.subtitleTranslate) return;
    for (const video of document.querySelectorAll('video')) {
      if ([...controllers].some((s) => s.video === video)) continue;
      attach(video);
    }
  }

  function setupPositionSync() {
    const rerun = () => requestAnimationFrame(syncAll);
    window.addEventListener('scroll', rerun, { passive: true, capture: true });
    window.addEventListener('resize', rerun, { passive: true });
    document.addEventListener('fullscreenchange', () => {
      // 全屏切换后节点可能被搬走，重新挂一次
      for (const state of controllers) {
        state.layer?.remove();
        state.layer = null;
        if (state.current) showCue(state, state.current);
      }
      rerun();
    });
    // 视频自身尺寸变化（例如 YouTube 切剧场模式）
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(rerun);
      document.querySelectorAll('video').forEach((v) => ro.observe(v));
    }
  }

  async function loadConfig() {
    const res = await send({ type: 'getConfig' });
    if (res.ok) config = res.data;
    return config;
  }

  async function init() {
    await loadConfig();
    if (!config) return;

    scanVideos();
    setupPositionSync();

    // 视频是动态插入的（SPA 路由、无限滚动）
    const mo = new MutationObserver(() => scanVideos());
    mo.observe(document.documentElement, { childList: true, subtree: true });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'configChanged') return;
      loadConfig().then(() => {
        if (!config.subtitleTranslate) {
          for (const state of [...controllers]) dispose(state);
          return;
        }
        scanVideos();
      });
    });

    setInterval(tick, TICK_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();