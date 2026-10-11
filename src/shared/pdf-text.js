// PDF 文本重建：把 pdf.js 的 textContent.items 还原成段落。
//
// PDF 里的文本是一堆带坐标的碎片——一行可能被切成十几段，段落之间也没有语义标记。
// 直接拼接会得到满是硬换行的文本。这里按坐标先聚成行，再把行合并成段。
//
// 分段只依据几何信息（行距、缩进、字号），**不看标点**：段内换行以句号结尾在真实
// PDF 里非常常见，拿标点当判据会把每个句子都切成一段。
//
// 纯函数，不依赖 pdf.js 与 chrome，可以直接单测。

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
const SENTENCE_END = /[.!?。！？]["'”’»)\]]?$/;
const PAGE_NUMBER = /^\d{1,4}$/;

export function buildParagraphs(items, options = {}) {
  const {
    lineTolerance = 0.5,   // y 差在字高多少倍内算同一行
    paragraphGap = 0.6,    // 行距超过字高的多少倍算新段
    indentRatio = 1.2,     // 缩进超过字高的多少倍算新段
    headingRatio = 1.25,   // 字号超过正文多少倍算标题
    dropPageNumbers = true,
  } = options;

  const valid = (items || []).filter((it) =>
    it && typeof it.str === 'string' && it.str.trim().length && Array.isArray(it.transform));
  if (!valid.length) return [];

  // 1) 按 y 聚成行。pdf.js 的输出已经是阅读顺序，增量比较即可，不必两两比对。
  const lines = [];
  let cur = null;
  for (const it of valid) {
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.height) || Math.abs(it.transform[3]) || 10;
    if (!cur || Math.abs(cur.y - y) > h * lineTolerance) {
      cur = { y, h, parts: [] };
      lines.push(cur);
    }
    cur.parts.push({ x, str: it.str, w: Math.abs(it.width) || 0, h });
    cur.h = Math.max(cur.h, h);
  }

  // 2) 行内按 x 排序拼接
  const rows = lines
    .map((line) => {
      const parts = [...line.parts].sort((a, b) => a.x - b.x);
      return { text: joinParts(parts), h: line.h, indent: parts[0].x, y: line.y };
    })
    .filter((r) => r.text.trim());

  if (!rows.length) return [];

  // 不用 Math.min(...arr)：几万行的 PDF 会把参数列表撑爆，直接抛栈溢出
  let leftEdge = Infinity;
  for (const r of rows) if (r.indent < leftEdge) leftEdge = r.indent;
  if (!Number.isFinite(leftEdge)) leftEdge = 0;
  const bodyH = median(rows.map((r) => r.h));

  // 3) 行合并成段
  const out = [];
  let buf = null;
  let prevRow = null;

  for (const row of rows) {
    const text = row.text.trim();
    if (!text) continue;

    const indent = row.indent - leftEdge;
    const gap = prevRow ? Math.abs(prevRow.y - row.y) : 0;
    const isHeading = row.h > bodyH * headingRatio;

    const startsNew = !buf
      || isHeading
      || buf.isHeading                       // 标题自成一段，不把正文接在后面
      || gap > row.h * (1 + paragraphGap)    // 行距明显变大 —— PDF 分段最可靠的信号
      || indent > row.h * indentRatio;       // 首行缩进

    if (startsNew) {
      buf = { text, isHeading };
      out.push(buf);
    } else {
      buf.text += (needsSpace(buf.text, text) ? ' ' : '') + text;
    }
    prevRow = row;
  }

  // 页码只在页首/页尾丢。正文中间的独立数字（年份、编号、金额）是内容，
  // 光看「整段就是一个数字」会把 2024 这类段落整个丢掉。
  return out
    .map((p) => ({ text: p.text.replace(/\s+/g, ' ').trim(), isHeading: !!p.isHeading }))
    .filter((p, i, list) => {
      if (!p.text) return false;
      const edge = i === 0 || i === list.length - 1;
      return !(dropPageNumbers && edge && !p.isHeading && PAGE_NUMBER.test(p.text));
    });
}

function joinParts(parts) {
  let out = '';
  let prevEnd = null;
  for (const p of parts) {
    if (prevEnd !== null) {
      const gap = p.x - prevEnd;
      if (gap > p.h * 0.25 && needsSpace(out, p.str)) out += ' ';
    }
    out += p.str;
    prevEnd = p.x + p.w;
  }
  return out;
}

// 中日韩文字之间不加空格；西文之间按需补空格
function needsSpace(a, b) {
  if (!a || !b) return false;
  const last = a.slice(-1);
  const first = b[0];
  if (/\s/.test(last) || /\s/.test(first)) return false;
  if (CJK.test(last) || CJK.test(first)) return false;
  return true;
}

function median(list) {
  if (!list.length) return 10;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}