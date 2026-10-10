// PDF 翻译阅读页。
//
// 只做「文本层提取 + 双语对照阅读」：解析出段落、按视口懒翻译、可导出 Markdown。
// 不做版式还原，也不做扫描件 OCR —— 那些是另一个量级的工作。
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { buildParagraphs } from '../shared/pdf-text.js';
import { t, applyI18n } from '../shared/i18n.js';

// worker 必须指向扩展内的文件：商店禁止加载远程代码
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('src/vendor/pdfjs/pdf.worker.min.mjs');

applyI18n();

const $ = (id) => document.getElementById(id);
const state = { title: '', paragraphs: [], nodes: [], translated: 0 };
let config = null;
let observer = null;
// 换文件时自增：在途的旧批次回来后据此丢弃结果，否则会把上一份 PDF 的译文写进新文档
let gen = 0;

// ---------- 与后台通信 ----------
const send = (msg) => new Promise((resolve) => {
  chrome.runtime.sendMessage(msg, (res) => {
    if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
    resolve(res || { ok: false, error: t('csNoResponse') });
  });
});

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text || '';
  el.hidden = !text;
  el.classList.toggle('error', isError);
}

function setSummary() {
  const total = state.paragraphs.length;
  $('summary').textContent = total ? t('pdfSummary', total, state.translated) : '';
}

// ---------- 解析 ----------
async function loadPdf(file) {
  setStatus(t('pdfParsing'));
  $('content').hidden = true;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const paragraphs = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      setStatus(t('pdfParsingPage', n, pdf.numPages));
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      paragraphs.push(...buildParagraphs(content.items));
    }
    if (!paragraphs.length) {
      setStatus(t('pdfNoText'), true);
      return;
    }
    state.title = file.name.replace(/\.pdf$/i, '');
    state.paragraphs = paragraphs.map((p) => ({ ...p, translation: '', status: 'idle' }));
    state.translated = 0;
    gen += 1;          // 之前排队的段落全部作废
    queue.length = 0;
    render();
    setStatus('');
  } catch (e) {
    setStatus(t('pdfParseFailed', e.message || String(e)), true);
  }
}

function render() {
  const box = $('content');
  box.innerHTML = '';
  state.nodes = [];

  const title = document.createElement('h1');
  title.className = 'doc-title';
  title.textContent = state.title;
  box.appendChild(title);

  state.paragraphs.forEach((para, i) => {
    const wrap = document.createElement('div');
    wrap.className = `para${para.isHeading ? ' heading' : ''}`;
    const orig = document.createElement(para.isHeading ? 'h2' : 'p');
    orig.className = 'orig';
    orig.textContent = para.text;
    const trans = document.createElement('p');
    trans.className = 'trans';
    wrap.append(orig, trans);
    box.appendChild(wrap);
    state.nodes.push({ wrap, trans });
  });

  box.hidden = false;
  $('drop').hidden = true;          // 文档加载后收起拖放区，把版面让给正文
  $('openAnother').hidden = false;
  $('translateAll').hidden = false;
  $('exportBtn').hidden = false;
  setSummary();
  observeParagraphs();
}

// ---------- 翻译 ----------
const queue = [];
let inflight = 0;
let flushTimer = null;
const BATCH = 12;
const MAX_PARALLEL = 4;

function observeParagraphs() {
  observer?.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      enqueue(Number(entry.target.dataset.index));
    }
  }, { rootMargin: '800px 0px' });
  state.nodes.forEach(({ wrap }, i) => {
    wrap.dataset.index = String(i);
    observer.observe(wrap);
  });
}

function enqueue(i, cap = BATCH) {
  const para = state.paragraphs[i];
  if (!para || para.status !== 'idle') return;
  para.status = 'queued';
  para.cap = cap;
  queue.push(i);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  const delay = queue.length >= BATCH ? 0 : 16;
  flushTimer = setTimeout(flush, delay);
}

function flush() {
  flushTimer = null;
  if (!queue.length) return;
  // 同网页：空位一次补满，避免整份 PDF 串行一页页等。
  while (queue.length && inflight < MAX_PARALLEL) {
    const cap = state.paragraphs[queue[0]]?.cap || BATCH;
    const batch = [];
    while (queue.length && batch.length < cap) batch.push(queue.shift());
    inflight += 1;
    runBatch(batch);
  }
}

async function runBatch(batch) {
  const myGen = gen;
  batch.forEach((i) => {
    state.paragraphs[i].status = 'pending';
    state.nodes[i].trans.textContent = t('pdfTranslating');
    state.nodes[i].trans.classList.add('pending');
  });

  try {
    const res = await send({
      type: 'translate',
      texts: batch.map((i) => state.paragraphs[i].text),
      to: config.targetLang,
      docTitle: state.title,   // 让模型先建立主题认知
    });
    if (!res.ok) throw Object.assign(new Error(res.error), { kind: res.kind });
    if (myGen !== gen) return;
    batch.forEach((i, k) => {
      const out = res.data[k] || '';
      state.paragraphs[i].translation = out;
      state.paragraphs[i].status = 'done';
      const node = state.nodes[i].trans;
      node.textContent = out;
      node.classList.remove('pending');
      if (out) state.translated += 1;
    });
  } catch (e) {
    if (myGen !== gen) return;
    const reason = e.message || String(e);
    // fatal 是配置错误，重试没用。limited / slow（限流、超时）整批等一会儿只重试一次。
    // 其余失败拆成单段，隔离出有问题的那一段；单段再失败就报错。
    const kind = e.kind;
    const again = kind !== 'fatal'
      && (kind ? batch.some((i) => !state.paragraphs[i].retried) : batch.length > 1);
    if (again) {
      batch.forEach((i) => {
        if (kind) state.paragraphs[i].retried = true;
        state.paragraphs[i].status = 'idle';
        state.nodes[i].trans.classList.remove('pending');
      });
      setTimeout(() => batch.forEach((i) => enqueue(i, kind ? BATCH : 1)), kind ? 1500 : 0);
    } else {
      batch.forEach((i) => {
        state.paragraphs[i].status = 'error';
        const node = state.nodes[i].trans;
        node.textContent = t('csFailed', reason);
        node.classList.remove('pending');
        node.classList.add('error');
      });
    }
  } finally {
    inflight -= 1;
    setSummary();
    if (queue.length) scheduleFlush();
  }
}

function translateAll() {
  state.paragraphs.forEach((_, i) => enqueue(i));
}

// ---------- 导出 ----------
function exportMarkdown() {
  const lines = [`# ${state.title}`, ''];
  state.paragraphs.forEach((para) => {
    lines.push(para.isHeading ? `## ${para.text}` : para.text, '');
    if (para.translation) lines.push(para.translation, '');
  });
  const blob = new Blob([`${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`],
    { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'document'}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- 事件 ----------
$('pickFile').onclick = () => $('fileInput').click();
$('openAnother').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  const file = e.target.files?.[0];
  if (file) loadPdf(file);
};
$('translateAll').onclick = translateAll;
$('exportBtn').onclick = exportMarkdown;

$('drop').addEventListener('dragover', (e) => {
  e.preventDefault();
  $('drop').classList.add('over');
});
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  $('drop').classList.remove('over');
  const file = [...(e.dataTransfer?.files || [])].find((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (file) loadPdf(file);
  else setStatus(t('pdfParseFailed', 'not a pdf'), true);
});

(async () => {
  const res = await send({ type: 'getConfig' });
  if (res.ok) config = res.data;
  if (!config) setStatus(t('pdfParseFailed', 'config'), true);
})();