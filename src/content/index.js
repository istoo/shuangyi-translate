/* 双译 —— 内容脚本
 * 职责：把页面切成"段落单元"，按需翻译，把译文以双语对照方式注入原文之后。
 * 内容脚本非 module，全部逻辑收在一个 IIFE 内。
 * 注：类名与属性上的 `irt-` 前缀是早期版本的遗留标识，与页面上的用户数据
 * 存在兼容关系，不做重命名。
 */
(() => {
  if (window.__shuangyiTranslate) return;
  window.__shuangyiTranslate = true;

  // ---------- 常量 ----------
  const MARK = 'irt-translation';           // 译文节点标记类
  const UNIT_ATTR = 'data-irt-unit';        // 已识别的翻译单元
  const STATE_ATTR = 'data-irt-state';      // pending | done | error
  const SHADOW_STYLE_ATTR = 'data-irt-shadow-style';

  // manifest 注入的 styles.css 只作用于主文档，进不了 shadow root。
  // 译文、悬停操作条和重试入口一旦插进 web component 内部，就会退回浏览器默认样式：
  // Reddit 上的 ⧉ ✎ ↻ 按钮会常驻显示并挡住按钮文字。这里给 shadow root 补最小样式。
  const SHADOW_CSS = `
.irt-translation { display: block; margin: .2em 0 0; color: inherit; font: inherit; font-size: calc(1em * var(--irt-font-scale, 1)); line-height: inherit; letter-spacing: inherit; text-align: inherit; unicode-bidi: isolate; }
.irt-translation.irt-inline { display: inline; margin: 0 0 0 .35em; }
.irt-style-dashed { border-bottom: 1px dashed rgba(125,125,125,.55); padding-bottom: .15em; }
.irt-style-underline { text-decoration: underline; text-decoration-color: rgba(56,132,255,.5); text-underline-offset: 3px; }
.irt-style-highlight { background: rgba(255,213,79,.22); border-radius: 3px; padding: .05em .25em; }
.irt-style-blockquote { border-left: 3px solid rgba(56,132,255,.55); padding-left: .65em; }
[data-irt-hide-origin] > *:not(.irt-translation), [data-irt-hide-origin]::before { display: none !important; }
[data-irt-hide-text] { display: none !important; }
[data-irt-hide-origin]::marker { font-size: var(--irt-origin-fs, 1rem); }
[data-irt-hide-origin] > .irt-translation { font-size: calc(var(--irt-origin-fs, 1rem) * var(--irt-font-scale, 1)) !important; line-height: var(--irt-origin-lh, normal) !important; display: inline !important; margin: 0 !important; }
.irt-flex-host { flex-wrap: wrap !important; }
.irt-flex-host > .irt-translation:not(.irt-inline) { flex: 1 0 100% !important; grid-column: 1 / -1 !important; }
.irt-unclamp { -webkit-line-clamp: unset !important; line-clamp: unset !important; max-height: none !important; }
.irt-pending { opacity: .82; }
[data-irt-state='error'] { outline: 1px dotted rgba(220,70,70,.45); outline-offset: 2px; }
.irt-translation.irt-retry { display: inline-flex !important; align-items: center; gap: 4px; margin: .2em 0 .3em !important; padding: 2px 9px; font: 500 max(11px,.74em)/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; color: #d9433c !important; background: rgba(217,67,60,.09) !important; border: 1px solid rgba(217,67,60,.32) !important; border-radius: 6px; cursor: pointer; user-select: none; }
.irt-translation.irt-retry::before { content: '\\21bb'; font-size: 1.1em; line-height: 1; }
.irt-trans-actions { position: absolute; display: inline-flex; gap: 3px; margin-left: .45em; vertical-align: middle; opacity: 0; transition: opacity .15s; user-select: none; }
.irt-translation:hover > .irt-trans-actions, .irt-translation:focus-within > .irt-trans-actions { opacity: 1; }
.irt-trans-actions .irt-act { all: unset; cursor: pointer; font: 12px/1 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; padding: 3px 6px; border-radius: 5px; color: #7d8794; background: rgba(128,128,128,.15); }
.irt-trans-actions .irt-act:hover { background: rgba(56,132,255,.18); color: #3884ff; }
.irt-trans-actions .irt-act:focus-visible { outline: 2px solid rgba(56,132,255,.5); outline-offset: 1px; }
.irt-translation.irt-trans-editing { outline: 2px solid rgba(56,132,255,.45); outline-offset: 3px; border-radius: 3px; cursor: text; }
.irt-translation.irt-trans-busy { opacity: .45; }
`;

  // 这些标签内的文本不翻译
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IFRAME', 'CANVAS', 'SVG', 'MATH', 'VIDEO', 'AUDIO',
    'OBJECT', 'EMBED', 'MAP', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'ANNOTATION',
    'SEMANTICS', 'MROW', 'MI', 'MN', 'MO', 'RUBY', 'RT', 'RP']);

  // 公式、角标、编辑链接一类的噪声：内容不该进译文，否则会把 LaTeX 源码
  // 和 "[1]:293" 这样的引用标记混进句子里。
  const SKIP_SELECTOR = [
    '.mwe-math-element', '.mwe-math-fallback-image-inline', '.mwe-math-mathml-a11y',
    '.katex', '.MathJax', '.math', 'mjx-container',
    '.reference', '.reference-text', 'sup.reference', '.mw-editsection', '.mw-cite-backlink',
    '.noprint', '[aria-hidden="true"]',
    // 无障碍专用文本：给屏幕阅读器的另一份文案，视觉上被压成 1px 隐藏，
    // isVisible() 判不出来（尺寸不为 0），但翻译它没有任何意义，还可能干扰读屏。
    '.sr-only', '.visually-hidden', '.screen-reader-text', '.screen-reader-content',
    'faceplate-screen-reader-content',
    // Reddit 的相对时间、计数组件：原样保留，翻成「3小时前」只会撑乱元数据行
    'faceplate-timeago', 'faceplate-number',
  ].join(',');

  function isSkippedNode(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    try { return el.matches(SKIP_SELECTOR); } catch { return false; }
  }

  // 天然块级标签：直接视为单元边界，不必查 CSS
  const BLOCK_TAGS = new Set(['P', 'LI', 'DD', 'DT', 'TD', 'TH', 'TR', 'BLOCKQUOTE', 'FIGCAPTION',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER',
    'MAIN', 'NAV', 'SUMMARY', 'DETAILS', 'CAPTION', 'LEGEND', 'FIELDSET', 'ADDRESS', 'FIGURE',
    'DL', 'OL', 'UL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'FORM', 'HR', 'P']);

  // 交互性内联元素：文本相互独立，各自成单元（否则整条导航会被拼成一句话翻译）
  const INLINE_UNIT_TAGS = new Set(['A', 'BUTTON', 'LABEL', 'SUMMARY']);

  // 内联标签：翻译时用占位符保留
  const INLINE_TAGS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SPAN', 'MARK', 'SMALL',
    'SUB', 'SUP', 'ABBR', 'CITE', 'Q', 'TIME', 'BDI', 'BDO', 'DFN', 'IMG', 'BR', 'WBR', 'FONT', 'LABEL']);

  // ---------- 状态 ----------
  let config = null;
  let pageTranslated = false;
  let observer = null;      // IntersectionObserver：懒翻译
  const HIDDEN_TEXT_ATTR = 'data-irt-hide-text';   // 仅译文模式下包住原文文本节点的 span
  let mutationObs = null;   // MutationObserver：动态内容
  const queue = [];         // 待翻译单元
  let flushTimer = null;
  let rescanTimer = null;   // 定期兜底扫描的定时器，全局只保留一个
  let inflight = 0;
  // 还原会让在途的请求作废：给每个入队项盖上会话号，响应回来时对不上就丢弃。
  // 不能用 pageTranslated 判断——悬停翻译是在「整页未翻译」状态下工作的。
  let session = 0;
  let stats = { done: 0, error: 0 };
  // 用户自己改过的译文（key 是原文 html）。重译时会让位给新译文。
  // 跨「还原 → 再翻译」保留：手改是用户自己花的功夫，关掉翻译再打开不该丢。
  // 单段重译是另一回事，那条路会显式删掉这一项（见 retranslateUnit）。
  const userEdits = new Map();
  const USER_EDITS_MAX = 300;        // 长页面翻多了不至于无限涨

  function rememberUserEdit(src, text) {
    userEdits.delete(src);           // 重新插入，淘汰时先丢最早改的那条
    userEdits.set(src, text);
    while (userEdits.size > USER_EDITS_MAX) userEdits.delete(userEdits.keys().next().value);
  }

  // ---------- i18n ----------
  // 内容脚本不是 module，不能 import，这里内联一份与 shared/i18n.js 等价的实现。
  const t = (key, ...subs) => {
    let text = key;
    try { text = chrome.i18n.getMessage(key) || key; } catch { /* 非扩展环境 */ }
    return subs.length
      ? text.replace(/\{(\d+)\}/g, (m, i) => (subs[Number(i)] === undefined ? m : String(subs[Number(i)])))
      : text;
  };

  // ---------- 工具 ----------
  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
        resolve(res || { ok: false, error: t('csNoResponse') });
      });
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  });

  const isVisible = (el) => {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    // 无障碍专用文本的经典写法是把内容压成 1×1 再裁剪掉。这类元素尺寸不为 0，
    // 光看 display/visibility 判不出来，但它的文字用户根本看不到——
    // 翻译它只会在页面上凭空多出一行（Reddit 顶栏实测会挤出一串导航标签）。
    if (rect.width <= 2 && rect.height <= 2) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  };

  // 判断文本是否值得翻译：需含目标语言以外的字母，且不是纯数字/符号
  const targetIsCJK = () => /^(zh|ja|ko)/.test(config.targetLang);

  function shouldTranslateText(text) {
    const t = text.trim();
    if (t.length < 3) return false;
    // 需要有一个真正的词，而不是散落的字母：滤掉 "2h"、"1.2K"、"v3" 这类元数据
    const hasWord = /[a-zA-ZÀ-ɏЀ-ӿͰ-Ͽ]{2,}|[぀-ヿ一-鿿가-힯؀-ۿ฀-๿]/.test(t);
    if (!hasWord) return false;
    // 目标是中文时，已经是中文的段落跳过
    if (targetIsCJK() && /^(zh)/.test(config.targetLang)) {
      const cjk = (t.match(/[一-鿿]/g) || []).length;
      const latin = (t.match(/[a-zA-Z]/g) || []).length;
      if (cjk > 0 && cjk >= latin) return false;
    }
    return true;
  }

  // 用户名、版块名、域名、产品名这类「标识」不是句子，翻了反而错：
  // UnusualCompany1191 → 不寻常的公司1191、r/ClaudeAI → r/克劳德AI。
  function looksLikeIdentifier(text) {
    const s = text.trim();
    if (/^(?:u|r)\/[\w-]+$/i.test(s)) return true;                       // u/name、r/sub
    if (/^\d+\s*(?:s|m|h|d|w|mo|y|yr|min|hr)s?\.?\s+ago$/i.test(s)) return true;  // 3h ago
    if (/\s/.test(s)) return false;
    if (/^[\w-]+(?:\.[\w-]+)+$/.test(s)) return true;                    // example.com
    if (/^[A-Z]{2,5}$/.test(s)) return true;                               // MOD、NEW、BETA 徽标
    // 单个词里夹数字、下划线或大小写驼峰：OddBig010、Good_Potential359、ClaudeAI-mod-bot
    return /^[\w-]+$/.test(s) && (/\d/.test(s) || /_/.test(s) || /[a-z][A-Z]/.test(s));
  }

  // 正文语义标签：哪怕很短（"Hey guys,"）也按段落另起一行
  const PROSE_TAGS = new Set(['P', 'LI', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION', 'TD', 'TH',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'CAPTION', 'SUMMARY']);

  // 导航项、按钮、标签、元数据这类短 UI 文案：译文跟在原文后面同一行，
  // 不另起块、不挂操作条。否则每个两三个词的标签都多出一行，整页布局被撑散。
  function isShortLabel(el, text) {
    if (PROSE_TAGS.has(el.tagName)) return false;
    const s = text.replace(/<\/?b\d+>/g, '').replace(/\s+/g, ' ').trim();
    return s.length <= 32 && s.split(' ').length <= 4 && !/[.!?。！？]$/.test(s);
  }

  // 页面框架（导航、顶栏、页脚、按钮、菜单）：整页翻译时跳过整棵子树。
  // 沉浸式翻译也是这么做的 —— 这些文字用户早就认识，翻了只会把每个导航项、
  // 按钮撑高一截，页面立刻变乱。需要时仍可悬停单段翻译。
  // 菜单、工具栏任何模式都跳过。按钮两种模式都翻：筛选栏标题经常就是 button。
  // 短按钮走行内译文，不另起一块，避免把一排按钮撑高。
  // 导航、顶栏、页脚只在双语模式下跳过。
  const CONTROL_ROLES = new Set(['menu', 'menubar', 'toolbar', 'tablist', 'search']);
  const FRAME_ROLES = new Set(['navigation', 'banner', 'contentinfo']);

  const replaceMode = () => config?.mode === 'translation';

  // 页面级导航、顶栏、页脚，以及选项卡条。容器本身不翻译，但要继续往里走：
  // OpenRouter 的筛选栏就是一个 <nav>，整棵跳过的话左侧一个字都不会变。
  function isFrameContainer(el) {
    const role = el.getAttribute('role');
    if (role === 'tablist') return true;
    if (replaceMode()) return false;
    if (el.tagName === 'NAV' || FRAME_ROLES.has(role)) return true;
    if (el.tagName === 'HEADER' || el.tagName === 'FOOTER') {
      return !el.parentElement?.closest('article, main, [role="main"], section');
    }
    return false;
  }

  function inPageFrame(el) {
    const frame = el.closest?.('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]');
    if (!frame || frame === el) return false;
    if ((frame.tagName === 'HEADER' || frame.tagName === 'FOOTER')
      && frame.parentElement?.closest('article, main, [role="main"], section')) return false;
    return true;
  }

  function isPageChrome(el) {
    const role = el.getAttribute('role');
    // 选项卡条要往下走，不能在这里把整组拦掉。菜单和工具栏仍然整棵跳过。
    if (role && role !== 'tablist' && CONTROL_ROLES.has(role)) return true;
    if (isFrameContainer(el)) return true;
    if (replaceMode()) return false;
    // 导航、顶栏里的链接和按钮仍跳过（Sign up、Models 这类，翻了会把顶栏撑得换行）。
    // 标题里的按钮是折叠筛选栏的分组标题，要翻；复选框行不是链接也不是按钮，照常翻。
    const control = el.tagName === 'A' || role === 'link' || el.tagName === 'BUTTON' || role === 'button';
    if (control && inPageFrame(el) && !el.closest('h1, h2, h3, h4, h5, h6')) return true;
    return false;
  }

  // 不值得整页翻译的零碎标签：非正文标签、不超过 3 个词、不成句。
  // "Public"、"User flair"、"Weekly visitors" 这类，翻了只添乱。
  function isTinyLabel(el, text) {
    // 表单 label 是用户要填的东西，再短也翻；仅译文模式就地替换，短标签也翻。
    // 按钮及其内部文字也翻：左侧筛选栏的标题就包在 button 里。
    if (replaceMode() || PROSE_TAGS.has(el.tagName) || el.tagName === 'LABEL') return false;
    const btn = el.closest?.('button, [role="button"]');
    if (btn) {
      // 按钮自己、或按钮里唯一的一段文字（筛选栏标题）才翻。
      // 整张卡片做成 role=button 时，里面的“42 comments”这类零碎文字不能跟着翻。
      const flat = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (btn === el || flat(btn) === flat(el)) return false;
    }
    // 筛选栏里挨着复选框的短词（Text、Image）也要翻，不能当零碎标签丢掉。
    if (el.querySelector?.('[role="checkbox"], input[type="checkbox"]')) return false;
    const s = text.replace(/\s+/g, ' ').trim();
    return s.split(' ').length <= 3 && !/[.!?。！？]$/.test(s);
  }

  // ---------- 段落单元识别 ----------
  // 一个"单元"是：包含文本、且其块级子元素都不含文本的最内层块元素。
  // 文档树里所有「根」：document 本身 + 所有 open shadow root。
  // Reddit、YouTube 这类 web component 站点把正文放在 shadow root 里，
  // 只走 light DOM 会漏掉绝大部分内容（实测覆盖率只有 15%）。
  function collectRoots(start = document) {
    const roots = [start];
    const seen = new Set();
    const walk = (node) => {
      for (const el of node.querySelectorAll('*')) {
        const sr = el.shadowRoot;   // closed shadow root 拿不到，只能跳过
        if (sr && !seen.has(sr)) {
          seen.add(sr);
          roots.push(sr);
          walk(sr);
        }
      }
    };
    walk(start);
    return roots;
  }

  function collectUnits(root, nearOnly = false) {
    const units = [];
    // 动态插入的子树可能落在菜单、工具栏里（下拉菜单一展开就是）：从祖先判断，不能只看根自己
    if (root.closest?.('[role="menu"], [role="menubar"], [role="toolbar"], [role="search"]')) return units;
    const walk = (el, depth) => {
      if (depth > 60) return;
      if (el.nodeType !== 1) return;
      const tag = el.tagName;
      if (isSkippedNode(el)) return;
      if (el.classList?.contains(MARK)) return;
      if (el.isContentEditable) return;
      if (el.closest('[data-irt-ignore]')) return;
      if (isPageChrome(el)) {
        if (isFrameContainer(el)) {
          for (const child of el.children) walk(child, depth + 1);
          if (el.shadowRoot) for (const child of el.shadowRoot.children || []) walk(child, depth + 1);
        }
        return;
      }
      // 滚动和定时兜底只复查视口附近。整棵文档每几百毫秒走一遍，大站点会卡。
      if (nearOnly && !isContents(el)) {
        const rect = el.getBoundingClientRect?.();
        if (rect && rect.top > window.innerHeight + 800) return;
      }

      // display:contents 的元素自己不成盒：既不能当单元（没有盒子承载译文），
      // 也不能因为 rect 是 0×0 就整棵跳过 —— 它的内容其实显示在父级的布局里。
      // 只能"穿过"它，继续看它的子节点（含 shadow root）。
      if (isContents(el)) {
        for (const child of el.children) walk(child, depth + 1);
        if (el.shadowRoot) for (const child of el.shadowRoot.children || []) walk(child, depth + 1);
        return;
      }
      if (!isVisible(el)) return;

      const blockChildren = [];
      let ownText = '';
      const { text, blocks } = splitChildren(el);
      ownText += text;
      blockChildren.push(...blocks);

      // 自身的裸文本（含内联子孙）有实质内容 → 本元素是一个单元。
      // 但仍要递归块级子元素：父元素有一行说明文字、下面跟着一个列表，
      // 两者都要翻译，早早 return 会让整棵子树被吞掉。
      if (shouldTranslateText(ownText) && ownText.trim().length >= 2 && !looksLikeIdentifier(ownText)
        && !isTinyLabel(el, ownText)) {
        units.push(el);
      }
      for (const child of blockChildren) walk(child, depth + 1);

      // 宿主元素的 shadow root 里可能藏着真正的内容，继续往下走
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children || []) walk(child, depth + 1);
      }
    };
    walk(root, 0);
    return units;
  }

  // 把一个元素的子节点分成「属于本单元的文字」和「该单独成单元的块级子元素」。
  // display:contents 的子节点实际参与本元素的排布，要先摊平再判断，否则整块 UI
  // （Reddit 的右侧栏、整个帖子）会被 visibleTextOf 一路收进来，塌成一个巨型单元。
  function splitChildren(el) {
    let text = '';
    const blocks = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          text += child.nodeValue;
        } else if (child.nodeType === 1) {
          if (isSkippedNode(child)) continue;
          // 按钮/菜单等控件的文字不能并进父元素的句子里（否则父元素会把它带去翻译）
          if (isPageChrome(child)) {
            // 导航本身要留下，好让里面的筛选按钮继续往下走。
            if (isFrameContainer(child)) blocks.push(child);
            continue;
          }
          if (isContents(child)) {
            visit(child);
            // contents 元素也可能是 shadow host（自定义元素常常两样都占）
            if (child.shadowRoot) blocks.push(child);
            continue;
          }
          if (isBlockish(child)) {
            blocks.push(child);
          } else if (!isVisible(child) && !child.shadowRoot && child.tagName !== 'BR') {
            // 没有盒子的子元素（未分配 slot 的提示文案、收起的菜单）：用户看不到，
            // 不能算进本单元。Reddit 头像按钮里藏着一段 "Open profile menu"，
            // 被收进来后会在按钮里塞进一大块译文。
            continue;
          } else if (hasBlockDescendant(child)) {
            // 内联排布、内部却装着块级内容（自定义元素很常见，比如 display:inline
            // 的整块导航）：这是容器不是一行文字，交出去单独成单元。
            blocks.push(child);
          } else {
            text += visibleTextOf(child);
            // 内联元素也可能带 shadow root（自定义元素默认就是 inline 排布）。
            // 只把它当内联文本会吹掉它内部的所有内容，这里补一次递归。
            if (child.shadowRoot) blocks.push(child);
          }
        }
      }
    };
    visit(el);
    return { text, blocks };
  }

  // 内联排布的元素里是否装着块级内容（穿过 contents 元素继续看）。
  // 深度封顶避免在深树上反复遍历，真实页面里两三层就能判出来。
  function hasBlockDescendant(el, depth = 6) {
    if (depth <= 0) return false;
    for (const child of el.children) {
      if (isSkippedNode(child)) continue;
      if (isBlockish(child)) return true;
      if (hasBlockDescendant(child, depth - 1)) return true;
    }
    return false;
  }

  function isContents(el) {
    return displayOf(el) === 'contents';
  }

  function ensureShadowStyle(el) {
    const root = el.getRootNode?.();
    if (!root || root === document || !root.host || root.querySelector?.(`style[${SHADOW_STYLE_ATTR}]`)) return;
    const style = document.createElement('style');
    style.setAttribute(SHADOW_STYLE_ATTR, '');
    style.setAttribute('data-irt-ignore', '');
    style.textContent = SHADOW_CSS;
    root.appendChild(style);
  }

  // 元素是否以块级方式排布（决定是否拆成独立单元）。
  // 先看标签语义再看 CSS：computed style 在部分环境下拿不到可靠值，
  // 只靠它会让整篇文章塌成一个单元。
  function isBlockish(el) {
    const tag = el.tagName;
    if (BLOCK_TAGS.has(tag)) {
      // 块级标签被 CSS 显式改成内联时才回退成内联
      const d = displayOf(el);
      return !(d === 'inline' || d === 'inline-block' || d === 'contents');
    }
    // 链接、按钮和 label 只有独占一行时才拆成单元；句子中间的链接、按钮必须留在段落里，
    // 否则句子会被切成两截，译文语序也跟着错。
    if (INLINE_UNIT_TAGS.has(tag) || el.getAttribute('role') === 'button') return isStandaloneInline(el);
    if (INLINE_TAGS.has(tag)) {
      // 其余默认内联的标签，只有被 CSS 改成块级排布时才拆
      const d = displayOf(el);
      return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table';
    }
    const d = displayOf(el);
    return !!d && d !== 'inline' && d !== 'inline-block' && d !== 'contents';
  }

  // 该内联元素是否独占一条内容：父元素除它之外没有别的实质文本。
  function isStandaloneInline(el) {
    const d = displayOf(el);
    if (d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table') return true;
    const parent = el.parentElement;
    if (!parent) return false;
    const own = (el.textContent || '').trim();
    if (!own) return false;
    // 只统计与它同处一行的内联兄弟：块级兄弟本就是各自独立的单元，
    // 同为链接/按钮的兄弟（一排导航项）也彼此独立。
    let siblingText = '';
    for (const n of parent.childNodes) {
      if (n === el) continue;
      if (n.nodeType === 3) { siblingText += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      if (isSkippedNode(n) || n.classList?.contains(MARK)) continue;
      if (INLINE_UNIT_TAGS.has(n.tagName)) continue;
      if (BLOCK_TAGS.has(n.tagName)) continue;
      // CSS 改成块级排布的兄弟自己占一行，不算同行文字
      const nd = displayOf(n);
      if (nd === 'block' || nd === 'flex' || nd === 'grid' || nd === 'list-item' || nd === 'table') continue;
      siblingText += n.textContent || '';
    }
    return siblingText.trim().length === 0;
  }

  function displayOf(el) {
    try { return getComputedStyle(el).display || ''; } catch { return ''; }
  }

  // ---------- 内联标签占位 ----------
  // 把单元内的内联元素替换为 <bN>…</bN>，翻译后按序还原，保住链接与强调。
  function serializeUnit(el) {
    const parts = [];
    const holders = [];
    // 公式/角标这类占位节点的下标：还原时保留原内容，不写入译文文本
    holders.verbatim = new Set();
    let idx = 0;
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          parts.push(escapeHtml(child.nodeValue));
        } else if (child.nodeType === 1) {
          if (child.classList?.contains(MARK)) continue;
          // 仅译文模式下原文被包进隐藏 span：它承载的就是本单元的原文，
          // 要算进指纹和待译文本，否则每次重扫都以为内容变了，会反复重译。
          if (child.hasAttribute(HIDDEN_TEXT_ATTR)) {
            parts.push(escapeHtml(child.textContent || ''));
            continue;
          }
          // 块级子元素是独立单元，不并入本单元的文本
          if (isBlockish(child)) continue;
          // 看不见的子元素既不送翻译，也不克隆进译文（克隆出来反而会显示）。
          // 例外：仅译文模式下这些子元素是被我们自己的样式藏起来的，不能因此把它们算作「内容变了」——
          // 否则每次重扫指纹都对不上，整页会不停重译、译文节点反复重建（带链接的段落实测必现）。
          const hiddenByUs = el.hasAttribute('data-irt-hide-origin');
          if (!hiddenByUs && child.tagName !== 'BR' && child.tagName !== 'IMG' && !isVisible(child)) continue;
          const i = idx++;
          holders.push(child);
          const inner = visibleTextOf(child);
          // 公式/角标、控件作为空占位原样带过去：位置保留，内容不送翻译
          if (isSkippedNode(child) || isPageChrome(child)) {
            holders.verbatim.add(i);
            parts.push(`<b${i}></b${i}>`);
            continue;
          }
          if (child.tagName === 'IMG' || child.tagName === 'BR' || !inner.trim()) {
            parts.push(`<b${i}></b${i}>`);
          } else {
            parts.push(`<b${i}>${escapeHtml(inner)}</b${i}>`);
          }
        }
      }
    };
    walk(el);
    return { html: parts.join('').replace(/\s+/g, ' ').trim(), holders };
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 把译文中的 <bN> 占位还原为克隆的原内联元素
  function deserialize(translated, holders) {
    const frag = document.createDocumentFragment();
    const re = /<b(\d+)>([\s\S]*?)<\/b\1>|<b(\d+)\s*\/?>/g;
    let last = 0;
    let m;
    while ((m = re.exec(translated)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(unescapeHtml(translated.slice(last, m.index))));
      const i = Number(m[1] ?? m[3]);
      const src = holders[i];
      if (src) {
        const clone = src.cloneNode(true);
        cleanClone(clone);
        const inner = m[2];
        if (holders.verbatim?.has(i)) {
          // 原样保留：公式、引用角标等
        } else if (inner !== undefined && clone.nodeType === 1 && clone.tagName !== 'IMG' && clone.tagName !== 'BR') {
          clone.textContent = unescapeHtml(inner);
        }
        frag.appendChild(clone);
      } else if (m[2]) {
        frag.appendChild(document.createTextNode(unescapeHtml(m[2])));
      }
      last = re.lastIndex;
    }
    if (last < translated.length) frag.appendChild(document.createTextNode(unescapeHtml(translated.slice(last))));
    return frag;
  }

  // 克隆内联元素时清掉可能重复触发的属性
  function cleanClone(node) {
    if (node.nodeType !== 1) return;
    node.removeAttribute?.('id');
    node.removeAttribute?.(UNIT_ATTR);
    node.querySelectorAll?.('[id]').forEach((n) => n.removeAttribute('id'));
  }

  function unescapeHtml(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  // ---------- 译文渲染 ----------
  function renderTranslation(el, translated, holders) {
    // 用户就地改过的译文优先，避免一次重译把他的手改冲掉
    const edited = userEdits.get(el.__irtSourceHtml);
    if (edited !== undefined) translated = edited;
    if (!translated || !translated.trim()) return markState(el, 'done');
    // 模型原样返回原文（品牌名、型号、代码这类实际不需要翻的）：再插一遍只会多出一条虚线下划线，
    // 仅译文模式还会把原文换成一个一模一样的副本。原文照旧显示就行。
    if (sameAsSource(el, translated)) return markState(el, 'done');
    removeTranslationOf(el);

    const inlineUnit = getComputedStyle(el).display.startsWith('inline')
      || isShortLabel(el, el.__irtSourceHtml || translated);
    // 先记下原字号：译文和列表序号（::marker）都要用它，避免忽大忽小
    if (!el.hasAttribute('data-irt-hide-origin')) {
      const cs = getComputedStyle(el);
      el.__irtFontSize = cs.fontSize;
      el.__irtLineHeight = cs.lineHeight;
      // 记在原元素上：仅译文模式下列表序号（::marker）也要用回原字号
      el.style.setProperty('--irt-origin-fs', cs.fontSize);
    }
    const node = document.createElement(inlineUnit ? 'span' : 'div');
    node.className = `${MARK} irt-style-${config.displayStyle}`;
    node.setAttribute('data-irt-ignore', '');
    node.dir = 'auto';
    if (config.fontScale !== 1) node.style.fontSize = `${config.fontScale}em`;
    if (el.__irtFontSize) node.style.setProperty('--irt-origin-fs', el.__irtFontSize);
    if (el.__irtLineHeight && el.__irtLineHeight !== 'normal') node.style.setProperty('--irt-origin-lh', el.__irtLineHeight);
    node.appendChild(deserialize(translated, holders));

    if (config.mode === 'translation') hideOrigin(el);

    // 行内元素的译文跟在后面并加分隔；块级元素另起一行
    if (inlineUnit) node.classList.add('irt-inline');
    else node.appendChild(buildActions(el));
    // 单元自己是 flex/grid 时，块级译文会变成并排的一列被挤窄（Reddit 规则标题实测高了 100px+）。
    // 让它换行独占一整行。
    if (!inlineUnit && /flex|grid/.test(getComputedStyle(el).display)) el.classList.add('irt-flex-host');
    ensureShadowStyle(el);
    el.appendChild(node);
    releaseLineClamp(el);
    markState(el, 'done');
  }

  // 卡片摘要常用 line-clamp 只显示两行。原文已经占满两行时，译文排在第三行会被整段裁掉（OpenRouter 模型列表实测）。
  // 往上看几层，把截断解除，还原时再恢复。
  // 例外：容器旁边有页面自己的“展开 / Show more”控件时，不能拆它的折叠。页面会量内容是否溢出，
  // 一旦没有溢出就把按钮删掉（模型详情页实测，Shift 悬停翻译后“Show more”整个消失）。
  // 这种情况替用户点一下展开，让页面自己露出完整内容。
  function releaseLineClamp(el) {
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i += 1) {
      const clamp = getComputedStyle(node).webkitLineClamp;
      if (clamp && clamp !== 'none' && clamp !== '0') {
        const more = findExpandControl(node);
        if (!more) node.classList.add('irt-unclamp');
        else if (more.getAttribute('aria-expanded') === 'false') more.click();
      }
      node = node.parentElement;
    }
  }

  function findExpandControl(node) {
    const scope = node.parentElement?.parentElement || node.parentElement;
    if (!scope || scope === document.body || scope === document.documentElement) return null;
    return [...scope.querySelectorAll('button[aria-expanded]')]
      .find((b) => /\b(show|read|view)\s+more\b|展开|更多/i.test(b.textContent || '')) || null;
  }

  // 仅译文模式藏原文：把裸露的文本节点包进一个隐藏 span。
  // 不能用 font-size: 0 压原文 —— 页面里 em / ch / ex 这些相对单位会跟着塌掉：
  // atomicagent.io 的标题是 max-width: 14ch，字号一压成 0，宽度就成了 0，译文被挤成一字一行。
  function hideOrigin(el) {
    el.setAttribute('data-irt-hide-origin', '');
    for (const node of [...el.childNodes]) {
      if (node.nodeType !== 3 || !node.nodeValue) continue;
      const span = document.createElement('span');
      span.setAttribute(HIDDEN_TEXT_ATTR, '');
      span.setAttribute('data-irt-ignore', '');
      node.replaceWith(span);
      span.appendChild(node);
    }
  }

  // 还原：把包起来的文本节点放回去，并合并回原来的文本节点
  function showOrigin(el) {
    el.removeAttribute('data-irt-hide-origin');
    const wraps = el.querySelectorAll(`:scope > [${HIDDEN_TEXT_ATTR}]`);
    if (!wraps.length) return;
    for (const span of wraps) span.replaceWith(...span.childNodes);
    el.normalize();
  }

  // 译文没了就把截断还给页面；同一个容器里还有别的译文时保留，免得它们被裁掉
  function restoreLineClamp(el) {
    let node = el;
    for (let i = 0; i < 4 && node && node !== document.body; i += 1) {
      if (node.classList.contains('irt-unclamp') && !node.querySelector(`.${MARK}`)) node.classList.remove('irt-unclamp');
      node = node.parentElement;
    }
  }

  // 译文与原文（去掉 <bN> 占位、还原转义、忽略大小写与空白）完全相同
  function sameAsSource(el, translated) {
    const norm = (s) => unescapeHtml(String(s || '').replace(/<\/?b\d+>/g, '')).replace(/\s+/g, ' ').trim().toLowerCase();
    const src = norm(el.__irtSourceHtml);
    return src !== '' && src === norm(translated);
  }

  // ---------- 译文的悬停操作条 ----------
  function buildActions(el) {
    const wrap = document.createElement('span');
    wrap.className = 'irt-trans-actions';
    wrap.setAttribute('data-irt-ignore', '');
    wrap.setAttribute('contenteditable', 'false');
    for (const [act, glyph, titleKey] of [
      ['copy', '⧉', 'csCopyOne'],
      ['edit', '✎', 'csEdit'],
      ['retranslate', '↻', 'csRetranslate'],
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `irt-act irt-act-${act}`;
      btn.textContent = glyph;
      btn.title = t(titleKey);
      btn.setAttribute('data-irt-ignore', '');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        runAction(act, el);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function runAction(act, el) {
    if (act === 'copy') return copyOne(el);
    if (act === 'edit') return startEdit(el);
    if (act === 'retranslate') return retranslate(el);
  }

  // 取译文文本时要把操作条排除掉，否则导出/复制会带上 ⧉✎↻ 这些符号
  function translatedTextOf(el) {
    const trans = el.querySelector(`:scope > .${MARK}:not(.irt-retry)`);
    if (!trans) return '';
    const clone = trans.cloneNode(true);
    clone.querySelectorAll('.irt-trans-actions').forEach((n) => n.remove());
    return clone.textContent.trim();
  }

  async function copyOne(el) {
    const text = translatedTextOf(el);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast(t('csCopied'), 'info');
    } catch {
      toast(t('csCopyFailed'), 'error');
    }
  }

  // 相邻段落作为重译的上下文，让模型看得到指代对象和语气
  function neighborTexts(el) {
    const all = [...document.querySelectorAll(`[${UNIT_ATTR}]`)];
    const i = all.indexOf(el);
    if (i < 0) return [];
    return [all[i - 1], all[i + 1]]
      .filter(Boolean)
      .map((n) => originalTextOf(n).slice(0, 200))
      .filter(Boolean);
  }

  // 重译必须绕过缓存，否则拿回来的还是同一份旧译文
  async function retranslate(el) {
    const src = el.__irtSourceHtml;
    const mySession = session;
    if (!src) return;
    const trans = el.querySelector(`:scope > .${MARK}:not(.irt-retry)`);
    if (!trans) return;
    userEdits.delete(src);
    trans.classList.add('irt-trans-busy');
    try {
      const res = await send({
        type: 'translate', texts: [src], to: config.targetLang,
        docTitle: document.title, context: neighborTexts(el), noCache: true,
      });
      if (!res.ok) throw new Error(res.error);
      if (mySession !== session || !el.isConnected) return;   // 重译期间被还原了，别再写回页面
      removeTranslationOf(el);
      renderTranslation(el, res.data[0], el.__irtHolders || []);
    } catch (e) {
      trans.classList.remove('irt-trans-busy');
      toast(t('csFailed', e.message || e), 'error');
    }
  }

  // 就地编辑译文：双击进编辑，Esc 放弃，Enter 或失焦保存
  function startEdit(el) {
    const trans = el.querySelector(`:scope > .${MARK}:not(.irt-retry)`);
    if (!trans || trans.getAttribute('contenteditable') === 'true') return;
    // 编辑期间把操作条移出 DOM：否则用户全选删除会连按钮一起干掉
    const actions = trans.querySelector('.irt-trans-actions');
    actions?.remove();
    const snapshot = trans.innerHTML;
    trans.setAttribute('contenteditable', 'true');
    trans.classList.add('irt-trans-editing');
    trans.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    };
    const onBlur = () => finish(true);

    function finish(save) {
      trans.removeEventListener('keydown', onKey);
      trans.removeEventListener('blur', onBlur);
      trans.removeAttribute('contenteditable');
      trans.classList.remove('irt-trans-editing');

      const edited = translatedTextOf(el);
      if (!save || !edited) {
        trans.innerHTML = snapshot;        // 放弃修改：连内联标签一起恢复
      } else {
        rememberUserEdit(el.__irtSourceHtml || '', edited);
        trans.textContent = edited;
      }
      if (actions) trans.appendChild(actions);   // 无论保存与否都把操作条放回去
    }

    trans.addEventListener('keydown', onKey);
    trans.addEventListener('blur', onBlur);
  }

  function markState(el, state) {
    const prev = el.getAttribute(STATE_ATTR);
    el.setAttribute(STATE_ATTR, state);
    if (prev === state) return;        // 避免同一元素重复计数
    if (state === 'done') stats.done++;
    if (state === 'error') stats.error++;
  }

  // 失败的段落给一个可点击的恢复入口，而不是让它永远红着
  function renderRetry(el) {
    removeTranslationOf(el);
    const btn = document.createElement('span');
    btn.className = `${MARK} irt-retry`;
    btn.setAttribute('data-irt-ignore', '');
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.textContent = t('csRetryFailed');
    const activate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      retryUnit(el);
    };
    btn.addEventListener('click', activate);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
    ensureShadowStyle(el);
    el.appendChild(btn);
  }

  function retryUnit(el) {
    if (el.getAttribute(STATE_ATTR) === 'error') stats.error = Math.max(0, stats.error - 1);
    removeTranslationOf(el);
    el.removeAttribute(STATE_ATTR);
    el.removeAttribute(UNIT_ATTR);   // 清掉标记，才能重新走一遍 enqueue 的判定
    el.classList.remove('irt-pending');
    delete el.__irtHolders;
    enqueue(el);
    updateBall();
  }

  function removeTranslationOf(el) {
    el.querySelectorAll(`:scope > .${MARK}`).forEach((n) => n.remove());
  }

  // ---------- 队列与批量翻译 ----------
  function enqueue(el) {
    if (el.hasAttribute(UNIT_ATTR)) return;
    el.setAttribute(UNIT_ATTR, '1');
    const { html, holders } = serializeUnit(el);
    // 噪音过滤统一放在这里。整页扫描那条路已经在 collectUnits 里筛过一遍，
    // 但悬停翻译、以及「节点被复用、内容变了」后的重新入队不经过 collectUnits，
    // 以前这两条路会把品牌名、型号也送去翻译（实测 TurboQuant → 涡轮定量）。
    const plain = html.replace(/<\/?b\d+>/g, '');
    if (!shouldTranslateText(plain) || looksLikeIdentifier(plain) || isTinyLabel(el, plain) || isPageChrome(el)) {
      el.setAttribute(STATE_ATTR, 'skip');
      return;
    }
    el.__irtHolders = holders;
    el.__irtSourceHtml = html;   // 单段重译要用它重新发请求
    el.setAttribute(STATE_ATTR, 'pending');
    el.classList.add('irt-pending');
    queue.push({ el, html, session });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    // 已经够一批就马上发。不满一批时只留一帧，把同一次扫描里后入队的段落并进去。
    // 以前固定 120ms，而且每批结束后再等 120ms，首屏白白多出好几拍。
    const delay = queue.length >= BATCH_SIZE ? 0 : 16;
    flushTimer = setTimeout(flush, delay);
  }

  const MAX_PARALLEL = 4;
  const BATCH_SIZE = 12;

  function flush() {
    flushTimer = null;
    if (!queue.length) return updateBall();
    // 空着的并发位一次补满。旧写法每轮只取一批，下一批要等这一批的请求回来才发，
    // MAX_PARALLEL 名存实亡，整页翻译实际是串行的。
    while (queue.length && inflight < MAX_PARALLEL) {
      // 失败后拆出来的单段带 batchCap=1，不能再并回 12 段一批。
      const cap = queue[0].batchCap || BATCH_SIZE;
      const batch = queue.splice(0, cap);
      inflight++;
      runBatch(batch);
    }
    updateBall();
  }

  async function runBatch(batch) {
    try {
      // 带上标题，让模型知道这篇文章的主题（仅用于判断语境，不会翻译它）
      const res = await send({
        type: 'translate', texts: batch.map((b) => b.html),
        to: config.targetLang, docTitle: document.title,
      });
      if (!res.ok) throw Object.assign(new Error(res.error), { kind: res.kind });
      batch.forEach((item, i) => {
        item.el.classList.remove('irt-pending');
        // 请求在飞的时候用户可能已经点了还原：不能再把译文写回页面，
        // 否则会留下一块没被标记、下次还原也清不掉的译文（实测真会留下）。
        if (item.session !== session || !item.el.isConnected) return;
        renderTranslation(item.el, res.data[i], item.el.__irtHolders || []);
      });
    } catch (e) {
      const reason = e.message || String(e);
      batch.forEach((item) => item.el.classList.remove('irt-pending'));
      toast(t('csFailed', reason), 'error');
      // 后台把失败分了类（见 engines.js 的 failure）：
      //   fatal 配置错误，重试没有意义，直接报错
      //   limited / slow 限流、超时、连不上，整批稍后只重试一次，拆开只会多打一轮请求
      //   无分类 拆成单段，隔离出有问题的那一段，也避免失败后仍合成一批
      const kind = e.kind;
      const alive = batch.filter((item) => item.session === session && item.el.isConnected);
      if (kind === 'fatal') {
        alive.forEach((item) => { markState(item.el, 'error'); renderRetry(item.el); });
      } else if (alive.length > 1 && !kind) {
        for (const item of alive) item.batchCap = 1;
        queue.unshift(...alive);
      } else {
        const retry = [];
        for (const item of alive) {
          if (item.retried) { markState(item.el, 'error'); renderRetry(item.el); }
          else retry.push(item);
        }
        if (retry.length) {
          for (const item of retry) item.retried = true;
          setTimeout(() => {
            if (!pageTranslated) return;
            for (const item of retry) if (item.el.isConnected) queue.push(item);
            scheduleFlush();
          }, kind ? 1500 : 400);
        }
      }
    } finally {
      inflight--;
      updateBall();
      if (queue.length) scheduleFlush();
    }
  }

  // ---------- 懒加载：只翻译进入视口附近的段落 ----------
  function ensureObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          enqueue(entry.target);
        }
      }
    }, { rootMargin: '600px 0px' });
    return observer;
  }

  // 「原文」的指纹：用来识别「节点被虚拟列表复用、内容已经换掉」的情况。
  // X / Reddit 会回收 DOM 节点再填新内容，元素上的 data-irt-unit 还留着，
  // 只看标记就会一直跳过它，新内容永远不翻译（实测 Reddit 会漏 20 多条）。
  //
  // 注意必须用 serializeUnit（它跳过 .irt-translation），不能用 textContent：
  // textContent 含译文，用户手改译文会被误判成「内容变了」而触发重译、
  // 把手改冲掉（这个坑被 translate-actions 测试抓到过）。
  function sourceFingerprintOf(el) {
    return serializeUnit(el).html;
  }

  function resetUnit(el) {
    removeTranslationOf(el);
    restoreLineClamp(el);
    // 计数要跟着退回：节点被虚拟列表复用、内容变了要重来时，
    // 不退回的话 stats.error 永远留着，悬浮球会一直显示失败徽标。
    const prev = el.getAttribute(STATE_ATTR);
    if (prev === 'error') stats.error = Math.max(0, stats.error - 1);
    if (prev === 'done') stats.done = Math.max(0, stats.done - 1);
    el.removeAttribute(STATE_ATTR);
    // 必须连 UNIT_ATTR 一起去掉：enqueue 开头就是
    // `if (el.hasAttribute(UNIT_ATTR)) return`，留着它重置后根本不会重新入队。
    el.removeAttribute(UNIT_ATTR);
    showOrigin(el);
    el.classList.remove('irt-pending', 'irt-flex-host');
    el.style.removeProperty('--irt-origin-fs');
    if (el.getAttribute('style') === '') el.removeAttribute('style');
    delete el.__irtHolders;
    delete el.__irtSourceHtml;
  }

  function scanAndObserve(root = document.body, nearOnly = false) {
    if (!root || root.nodeType !== 1) return 0;
    const units = collectUnits(root, nearOnly);
    const io = ensureObserver();
    for (const u of units) {
      if (u.hasAttribute(UNIT_ATTR)) {
        // 已处理过：只在内容确实变了的时候重来（复用节点的情况）
        if (u.__irtSourceHtml !== undefined && u.__irtSourceHtml !== sourceFingerprintOf(u)) {
          resetUnit(u);
          enqueue(u);
        }
        continue;
      }
      if (u.hasAttribute(STATE_ATTR)) continue;
      // 已经在视口里、或者用户已经滚过去的内容：直接翻，不等 IntersectionObserver。
      // X 这类虚拟列表在快速滚动时，有些段落只是「闪过」视口 —— 一旦滚过去，
      // 观察器就再也不会触发，那几段就永远不翻了（实测确实会零星漏几条）。
      // 视口下方很远的内容仍然交给观察器懒加载，避免一上来就翻完整页。
      const rect = u.getBoundingClientRect();
      if (rect.top < window.innerHeight + 800) enqueue(u);
      else io.observe(u);
    }
    return units.length;
  }

  // 动态加载的内容（无限滚动、SPA 路由）
  function ensureMutationObserver() {
    if (mutationObs) return;

    // 注意这里是「节流」不是「防抖」。
    // X / Twitter 这类 SPA 的 DOM 变动是持续不断的，用防抖的话每次变动都会把定时器重置，
    // 结果扫描永远不会执行（无限滚动加载出来的内容就一直不被翻译）。
    const pendingRoots = new Set();
    let timer = null;

    const flush = () => {
      timer = null;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      for (const r of roots) if (r.isConnected) scanAndObserve(r);
      if (pendingRoots.size) schedule();
    };
    const schedule = () => {
      if (timer) return;             // 已经在排队就不再重置
      timer = setTimeout(flush, 350);
    };

    const nearViewport = (el) => {
      const rect = el.getBoundingClientRect?.();
      if (!rect) return false;
      return rect.bottom > -100 && rect.top < window.innerHeight + 400;
    };
    // 变动回调里不量布局：页面一刷新就是几百个节点，逐个 getBoundingClientRect 会反复强制排版。
    // 先收起来，下一帧去重（祖先已在集合里的不再单独扫）后再一次性处理。
    const added = new Set();
    let rafId = null;
    const processAdded = () => {
      rafId = null;
      if (!pageTranslated) { added.clear(); return; }
      const nodes = [...added];
      added.clear();
      const set = new Set(nodes);
      const covered = (n) => {
        for (let p = n.parentElement; p; p = p.parentElement) if (set.has(p)) return true;
        return false;
      };
      for (const n of nodes) {
        if (!n.isConnected || covered(n)) continue;
        // 已经在视口里的马上翻，虚拟列表的节点撑不过 350ms 的节流；远处的留给节流扫描
        if (nearViewport(n)) scanAndObserve(n);
        else pendingRoots.add(n);
      }
      if (pendingRoots.size) schedule();
    };
    mutationObs = new MutationObserver((mutations) => {
      if (!pageTranslated) return;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList?.contains(MARK) || n.closest?.('[data-irt-ignore]')) continue;
          // 后台标签页不出帧，rAF 不会触发，走原来的节流扫描
          if (document.visibilityState === 'hidden') pendingRoots.add(n);
          else added.add(n);
        }
      }
      if (pendingRoots.size) schedule();
      if (added.size && rafId === null) rafId = requestAnimationFrame(processAdded);
    });
    mutationObs.observe(document.body, { childList: true, subtree: true });
  }

  // 新出现的 shadow root 不会被上面那个 observer 看到，滚动/定时扫描时顺手补上
  let observedRoots = new WeakSet();   // 需要整体重置，WeakSet 本身不能 clear
  function observeNewRoots() {
    if (!mutationObs) return;
    for (const root of collectRoots(document)) {
      if (root === document || observedRoots.has(root)) continue;
      observedRoots.add(root);
      try { mutationObs.observe(root, { childList: true, subtree: true }); } catch { /* 忽略 */ }
    }
  }

  // 滚动时补一次扫描：虚拟列表复用节点、或变动被观察器漏掉时，滚动是个可靠的兜底信号
  function setupScrollRescan() {
    let timer = null;
    window.addEventListener('scroll', () => {
      if (!pageTranslated || timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!pageTranslated) return;
        observeNewRoots();
        scanAndObserve(document.body, true);
      }, 600);
    }, { passive: true, capture: true });
  }

  // 定期兜底：X 这类虚拟列表可能在滚动停稳之后才把内容真正放进 DOM，
  // 单靠 MutationObserver 和滚动事件都可能错过（实测会有零星几段一直不被处理）。
  function setupPeriodicRescan() {
    if (rescanTimer) return;   // translatePage 会被反复调用，定时器只能建一个
    rescanTimer = setInterval(() => {
      if (!pageTranslated) return;
      if (document.visibilityState === 'hidden') return;   // 标签页在后台时不白跑
      observeNewRoots();
      scanAndObserve(document.body, true);
    }, 3000);
  }

  // ---------- 整页翻译 / 还原 ----------
  async function translatePage() {
    await loadConfig();
    pageTranslated = true;
    stats = { done: 0, error: 0 };
    document.documentElement.setAttribute('data-irt-on', config.mode);
    const n = scanAndObserve(document.body);
    ensureMutationObserver();
    setupScrollRescan();
    setupPeriodicRescan();
    updateBall();
    if (n === 0) toast(t('csNoParagraphs'), 'info');
  }

  function restorePage() {
    pageTranslated = false;
    session += 1;          // 在途的批次全部作废
    queue.length = 0;
    stats = { done: 0, error: 0 };
    // 不清 userEdits：还原只是把译文从页面上撤掉，用户手改过的内容要留着，
    // 再打开翻译时 renderTranslation 会重新用它（否则改一次样式再翻译就白改了）。
    observer?.disconnect();
    observer = null;
    mutationObs?.disconnect();
    mutationObs = null;
    observedRoots = new WeakSet();   // 还原后再翻译时，shadow root 要重新登记
    document.documentElement.removeAttribute('data-irt-on');
    // 译文可能插在 shadow root 里，document.querySelectorAll 够不到，要逐根清理
    for (const root of collectRoots(document)) {
      root.querySelectorAll(`.${MARK}`).forEach((n) => n.remove());
      root.querySelectorAll('.irt-unclamp').forEach((n) => n.classList.remove('irt-unclamp'));
      root.querySelectorAll(`style[${SHADOW_STYLE_ATTR}]`).forEach((n) => n.remove());
      root.querySelectorAll(`[${UNIT_ATTR}]`).forEach((n) => {
        n.removeAttribute(UNIT_ATTR);
        n.removeAttribute(STATE_ATTR);
        showOrigin(n);
        n.classList.remove('irt-pending', 'irt-flex-host');
        n.style.removeProperty('--irt-origin-fs');
        if (n.getAttribute('style') === '') n.removeAttribute('style');
        delete n.__irtHolders;
        delete n.__irtSourceHtml;
      });
    }
    updateBall();
  }

  // 必须 await：translatePage 是 async，pageTranslated 要等它内部的 await 之后才置位，
  // 不等就会把「切换前」的状态回给调用方（弹窗按钮会显示成没生效）。
  async function togglePage() {
    if (pageTranslated) restorePage();
    else await translatePage();
  }

  async function toggleMode() {
    config.mode = config.mode === 'bilingual' ? 'translation' : 'bilingual';
    await send({ type: 'setConfig', patch: { mode: config.mode } });
    if (pageTranslated) {
      document.documentElement.setAttribute('data-irt-on', config.mode);
      for (const root of collectRoots(document)) {
        root.querySelectorAll(`[${UNIT_ATTR}][${STATE_ATTR}="done"]`).forEach((el) => {
          if (config.mode === 'translation') hideOrigin(el);
          else showOrigin(el);
        });
      }
    }
    toast(t(config.mode === 'bilingual' ? 'csModeBilingual' : 'csModeTranslation'), 'info');
  }

  // ---------- 悬停翻译单段 ----------
  let hoverKeyDown = false;
  let lastHovered = null;

  function setupHover() {
    document.addEventListener('keydown', (e) => {
      if (config?.hoverTranslate && config.hoverHotkey !== 'none' && e.key === config.hoverHotkey) {
        hoverKeyDown = true;
        if (lastHovered) tryHoverTranslate(lastHovered);
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === config?.hoverHotkey) hoverKeyDown = false;
    }, true);
    window.addEventListener('blur', () => { hoverKeyDown = false; });
    // 切走再回来时 keyup 可能收不到，按键状态会一直留着，之后随便划过哪里都触发翻译
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') hoverKeyDown = false;
    });

    document.addEventListener('mouseover', (e) => {
      if (!config?.hoverTranslate) return;
      const el = findUnitFrom(e.target);
      lastHovered = el;
      if (!el) return;
      if (config.hoverHotkey === 'none' || hoverKeyDown) tryHoverTranslate(el);
    }, true);
  }

  function tryHoverTranslate(el) {
    if (!el || el.hasAttribute(UNIT_ATTR)) return;
    enqueue(el);
  }

  // 从任意节点向上找到最合适的"段落单元"
  function findUnitFrom(node) {
    let el = node?.nodeType === 3 ? node.parentElement : node;
    if (!el || el.nodeType !== 1) return null;
    if (el.closest(`.${MARK}`) || el.closest('[data-irt-ignore]')) return null;
    if (el.isContentEditable) return null;
    let cur = el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      if (isSkippedNode(cur)) return null;
      const txt = directTextOf(cur);
      if (shouldTranslateText(txt) && txt.trim().length >= 2) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // 取元素可见的文本，碰到要跳过的标签（script/style/code 等）就不往下走。
  // 不能用 textContent：它会把后代里的 <script> 源码一并吃进来，
  // 结果 JS 代码被当作正文送去翻译、又插回页面（Reddit 那种 web component 里
  // 常见 <span> 包着 <script> 的结构，实测会整页冒出代码）。
  function visibleTextOf(el) {
    let out = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1 && !isSkippedNode(child) && isVisible(child)) out += visibleTextOf(child);
    }
    return out;
  }

  function directTextOf(el) {
    let s = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) s += child.nodeValue;
      else if (child.nodeType === 1 && !isSkippedNode(child) && !isBlockish(child)) s += visibleTextOf(child);
    }
    return s;
  }

  // ---------- 划词翻译 ----------
  let bubble = null;

  function setupSelection() {
    document.addEventListener('mouseup', (e) => {
      if (!config?.selectionTranslate) return;
      if (bubble && bubble.contains(e.target)) return;
      setTimeout(() => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 1 || text.length > 3000) return hideBubble();
        if (!shouldTranslateText(text)) return hideBubble();
        const range = sel.getRangeAt(0);
        showBubble(range.getBoundingClientRect(), text);
      }, 10);
    }, true);

    document.addEventListener('mousedown', (e) => {
      if (bubble && !bubble.contains(e.target)) hideBubble();
    }, true);
    document.addEventListener('scroll', hideBubble, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideBubble(); }, true);
  }

  function showBubble(rect, text) {
    hideBubble();
    bubble = document.createElement('div');
    bubble.className = 'irt-bubble';
    bubble.setAttribute('data-irt-ignore', '');
    bubble.innerHTML = `
      <div class="irt-bubble-head">
        <span class="irt-bubble-title">${t('csBubbleTitle')}</span>
        <button class="irt-bubble-copy" title="${t('csCopy')}">${t('csCopy')}</button>
        <button class="irt-bubble-close" title="${t('csClose')}">✕</button>
      </div>
      <div class="irt-bubble-body"><span class="irt-spinner"></span>${t('csTranslating')}…</div>`;
    document.body.appendChild(bubble);
    positionBubble(rect);

    bubble.querySelector('.irt-bubble-close').onclick = hideBubble;

    // 回调参数不能叫 t：那会把上面的 i18n t() 函数遮住，复制提示就变成「t is not a function」
    translateSelectionText(text).then((translated) => {
      if (!bubble) return;
      const body = bubble.querySelector('.irt-bubble-body');
      body.textContent = translated;
      bubble.querySelector('.irt-bubble-copy').onclick = () => {
        navigator.clipboard?.writeText(translated);
        toast(t('csCopied'), 'info');
      };
      positionBubble(rect);
    }).catch((e) => {
      if (bubble) bubble.querySelector('.irt-bubble-body').textContent = t('csFailed', e.message || e);
    });
  }

  function positionBubble(rect) {
    if (!bubble) return;
    const bw = bubble.offsetWidth || 320;
    const bh = bubble.offsetHeight || 80;
    let left = rect.left + window.scrollX;
    let top = rect.bottom + window.scrollY + 8;
    left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - bw - 8));
    // 下方放不下时翻到选区上方
    if (rect.bottom + bh + 16 > window.innerHeight) top = rect.top + window.scrollY - bh - 8;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${Math.max(8, top)}px`;
  }

  function hideBubble() {
    bubble?.remove();
    bubble = null;
  }

  async function translateSelectionText(text) {
    await loadConfig();
    const res = await send({ type: 'translate', texts: [text], to: config.targetLang });
    if (!res.ok) throw new Error(res.error);
    return res.data[0] || t('csNoResult');
  }

  // ---------- 输入框翻译：连按 3 次空格 ----------
  function setupInputTranslate() {
    let spaceCount = 0;
    let lastSpaceAt = 0;
    let lastTarget = null;

    document.addEventListener('keydown', async (e) => {
      if (!config?.inputTranslate) return;
      const el = e.target;
      if (!isEditable(el)) return;
      if (e.key !== ' ' && e.code !== 'Space') { spaceCount = 0; return; }

      const now = Date.now();
      if (el !== lastTarget || now - lastSpaceAt > 600) spaceCount = 0;
      lastTarget = el;
      lastSpaceAt = now;
      spaceCount++;

      if (spaceCount < 3) return;
      spaceCount = 0;
      e.preventDefault();
      e.stopPropagation();

      const raw = readEditable(el);
      const text = raw.replace(/\s+$/, '');
      if (!text.trim()) return;

      // 占位文案用来判断「等待期间用户有没有继续改内容」：改过就不要再覆盖他的输入
      const placeholder = `${text} …${t('csTranslating')}`;
      writeEditable(el, placeholder);
      try {
        await loadConfig();
        const res = await send({ type: 'translate', texts: [text], to: config.targetLang });
        if (!res.ok) throw new Error(res.error);
        if (readEditable(el) !== placeholder) return;
        writeEditable(el, res.data[0] || text);
      } catch (err) {
        if (readEditable(el) === placeholder) writeEditable(el, text);
        toast(t('csInputFailed', err.message || err), 'error');
      }
    }, true);
  }

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return ['text', 'search', 'url', 'email', ''].includes((el.type || '').toLowerCase());
    return false;
  }

  function readEditable(el) {
    return el.isContentEditable ? el.innerText : el.value;
  }

  function writeEditable(el, value) {
    if (el.isContentEditable) {
      el.innerText = value;
      // 光标移到末尾
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      // 用原生 setter 触发 React 等框架的受控更新
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter ? setter.call(el, value) : (el.value = value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- 悬浮球 ----------
  let ball = null;

  function setupBall() {
    if (!config?.showFloatBall || ball) return;
    if (window.top !== window.self) return; // 只在顶层文档显示
    ball = document.createElement('div');
    ball.className = 'irt-ball';
    ball.setAttribute('data-irt-ignore', '');
    ball.title = t('csBallTitle');
    // 键盘与读屏可达：只有鼠标能用的话，纯键盘用户没法在页面上开关翻译
    ball.setAttribute('role', 'button');
    ball.setAttribute('tabindex', '0');
    ball.setAttribute('aria-label', t('csBallTitle'));
    ball.innerHTML = `<span class="irt-ball-text">${t('csBallText')}</span><span class="irt-ball-badge"></span>`;
    document.documentElement.appendChild(ball);

    let dragged = false;
    let startY = 0;
    let originTop = 0;

    ball.addEventListener('mousedown', (e) => {
      dragged = false;
      startY = e.clientY;
      originTop = ball.getBoundingClientRect().top;
      const move = (ev) => {
        if (Math.abs(ev.clientY - startY) > 4) dragged = true;
        const top = Math.max(8, Math.min(window.innerHeight - 52, originTop + ev.clientY - startY));
        ball.style.top = `${top}px`;
        ball.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    }, true);

    ball.addEventListener('click', (e) => {
      e.stopPropagation();
      if (dragged) return;
      togglePage();
    }, true);
    ball.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      togglePage();
    }, true);
  }

  function updateBall() {
    if (!ball) return;
    const working = queue.length + inflight;
    ball.classList.toggle('irt-ball-on', pageTranslated);
    ball.classList.toggle('irt-ball-busy', working > 0);
    const failed = working === 0 && stats.error > 0;
    ball.classList.toggle('irt-ball-error', failed);
    ball.title = failed
      ? t('csBallFailedTitle', stats.error)
      : t('csBallTitle');
    const badge = ball.querySelector('.irt-ball-badge');
    // 忙碌时显示剩余段落数，全部完成后若有失败则提示
    let text = '';
    if (working > 0) text = working > 99 ? '99+' : String(working);
    else if (stats.error > 0) text = '!';
    badge.textContent = text;
    badge.style.display = text ? 'block' : 'none';
  }

  // ---------- 轻提示 ----------
  let toastEl = null;
  let toastTimer = null;

  function toast(msg, kind = 'info') {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'irt-toast';
      toastEl.setAttribute('data-irt-ignore', '');
      // 读屏要能听到：失败提示、已复制这类反馈不能只在视觉上存在
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.documentElement.appendChild(toastEl);
    }
    // 同一条消息还在展示时不重放动画：连续多批失败时不会闪个不停
    if (toastEl.textContent === msg && toastEl.classList.contains('irt-toast-show')) return;
    toastEl.textContent = msg;
    toastEl.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    toastEl.className = `irt-toast irt-toast-${kind} irt-toast-show`;
    clearTimeout(toastTimer);
    // 错误信息更长，给它更多阅读时间
    toastTimer = setTimeout(() => toastEl?.classList.remove('irt-toast-show'), kind === 'error' ? 6000 : 3000);
  }

  // ---------- 导出双语对照 ----------
  // 只取"叶子单元"：嵌套段落里外层往往只是容器，一并导出会重复。
  function originalTextOf(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(`.${MARK}`).forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  function buildMarkdown() {
    const units = [...document.querySelectorAll(`[${UNIT_ATTR}][${STATE_ATTR}="done"]`)]
      .filter((el) => !el.querySelector(`[${UNIT_ATTR}]`));
    const out = [`# ${document.title || location.hostname}`, '', `> ${t('exportSource', location.href)}`, ''];
    let count = 0;
    for (const el of units) {
      const translated = translatedTextOf(el);
      if (!translated) continue;
      const original = originalTextOf(el);
      if (!original) continue;
      // 原页面里的标题在导出后保持标题层级，方便贴进笔记
      const heading = /^H[1-6]$/.test(el.tagName) ? '#'.repeat(Math.min(6, Number(el.tagName[1]) + 1)) : '';
      out.push(heading ? `${heading} ${original}` : original, '', translated, '');
      count += 1;
    }
    return { markdown: `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`, count };
  }

  function exportPage() {
    const { markdown, count } = buildMarkdown();
    if (!count) return { ok: false, error: t('exportEmpty') };
    const name = (document.title || location.hostname || 'translation')
      .replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    try {
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.md`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    return { ok: true, count };
  }

  // ---------- 配置与启动 ----------
  async function loadConfig() {
    const res = await send({ type: 'getConfig' });
    if (res.ok) config = res.data;
    return config;
  }

  function siteRule() {
    return config?.siteRules?.[location.hostname] || null;
  }

  async function init() {
    await loadConfig();
    if (!config) return;

    setupHover();
    setupSelection();
    setupInputTranslate();
    setupBall();
    applyStyleVars();

    const rule = siteRule();
    if (rule === 'never') return;
    if (rule === 'always' || (config.autoTranslate && !isTargetLangPage())) {
      translatePage();
    }
  }

  // 页面本身已是目标语言时不自动翻译
  function isTargetLangPage() {
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    if (!htmlLang) return false;
    const target = config.targetLang.toLowerCase();
    if (htmlLang === target) return true;
    return config.skipLangs.some((l) => htmlLang.startsWith(l.toLowerCase().split('-')[0]) && target.startsWith(l.toLowerCase().split('-')[0]));
  }

  function applyStyleVars() {
    document.documentElement.style.setProperty('--irt-font-scale', String(config.fontScale));
  }

  // 影响译文内容的设置：目标语言、当前服务档案（档案里带着模型与提示词、术语库）。
  // 其余设置（译文样式、字号、悬浮球、快捷键……）只影响显示，重译纯属浪费。
  function translationInputsChanged(before, after) {
    if (!before || !after) return true;
    if (before.targetLang !== after.targetLang) return true;
    const pick = (c) => JSON.stringify([c.engine, c.providers]);
    return pick(before) !== pick(after);
  }

  // 不重译，只把新设置套到已经翻好的段落上：译文样式类与原文显隐。
  function restyleUnits() {
    document.documentElement.setAttribute('data-irt-on', config.mode);
    const nextStyle = `irt-style-${config.displayStyle}`;
    const hide = config.mode === 'translation';
    for (const root of collectRoots(document)) {
      for (const node of root.querySelectorAll(`[${UNIT_ATTR}] > .${MARK}`)) {
        if (node.classList.contains('irt-retry')) continue;   // 重试入口没有译文样式
        const old = [...node.classList].find((c) => c.startsWith('irt-style-'));
        if (old === nextStyle) continue;
        if (old) node.classList.replace(old, nextStyle);
        else node.classList.add(nextStyle);
      }
      for (const el of root.querySelectorAll(`[${UNIT_ATTR}][${STATE_ATTR}="done"]`)) {
        if (hide) hideOrigin(el);
        else showOrigin(el);
      }
    }
  }

  // ---------- 消息入口 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case 'togglePage':
          await loadConfig();
          await togglePage();
          sendResponse({ ok: true, translated: pageTranslated });
          break;
        case 'translatePage':
          await translatePage();
          sendResponse({ ok: true });
          break;
        case 'restorePage':
          restorePage();
          sendResponse({ ok: true });
          break;
        case 'toggleMode':
          await loadConfig();
          await toggleMode();
          sendResponse({ ok: true, mode: config.mode });
          break;
        case 'translateSelection': {
          const sel = window.getSelection();
          const text = sel?.toString().trim();
          if (text) showBubble(sel.getRangeAt(0).getBoundingClientRect(), text);
          sendResponse({ ok: true });
          break;
        }
        case 'exportPage':
          sendResponse(exportPage());
          break;
        case 'getState':
          await loadConfig();
          sendResponse({ ok: true, translated: pageTranslated, host: location.hostname, rule: siteRule(), stats });
          break;
        case 'configChanged': {
          const prev = config;          // loadConfig 会换成新对象，先留住上一份做对比
          await loadConfig();
          applyStyleVars();
          if (siteRule() === 'never') {
            // 站点被设成「从不翻译」：已经在译文状态就退回原文。
            // 以前这里无条件重翻一次，于是规则设成 never 之后页面依然是译文。
            if (pageTranslated) restorePage();
          } else if (pageTranslated) {
            // 只有影响译文的设置变了才重译。改样式（虚线/字号）就地更新 ——
            // 重译会走 restorePage()，顺手把用户手改过的译文一起清掉。
            if (translationInputsChanged(prev, config)) { restorePage(); translatePage(); }
            else restyleUnits();
          }
          // 刚把这个站点设成「总是翻译」时也应该立刻翻，而不是等下次刷新
          else if (siteRule() === 'always' || (config.autoTranslate && !isTargetLangPage())) {
            translatePage();
          }
          if (config.showFloatBall) setupBall();
          else { ball?.remove(); ball = null; }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false });
      }
    })();
    return true;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
