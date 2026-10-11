// PDF 文本重建的单测。这是「读得懂」与「满屏断行」之间的分界线，必须覆盖住。
import assert from 'node:assert/strict';
import { buildParagraphs } from '../src/shared/pdf-text.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('✅', name); }
  catch (e) { fail++; console.log('❌', name, '\n   ', e.message); }
}

// 造一个 pdf.js 风格的文本项
const item = (str, x, y, { h = 10, w = null } = {}) => ({
  str,
  width: w === null ? str.length * h * 0.5 : w,
  height: h,
  transform: [h, 0, 0, h, x, y],
});

const textOf = (paras) => paras.map((p) => p.text);

check('同一行的碎片拼成一行，并按左到右排序', () => {
  const paras = buildParagraphs([
    item('world', 120, 700),
    item('Hello', 50, 700),
  ]);
  assert.deepEqual(textOf(paras), ['Hello world']);
});

check('多行连续文本合并成一个段落', () => {
  const paras = buildParagraphs([
    item('Retrieval augmented generation is a technique', 50, 700),
    item('that lets a model answer using documents it', 50, 686),
    item('was never trained on.', 50, 672),
  ]);
  assert.equal(paras.length, 1, `实际 ${paras.length} 段`);
  assert.ok(paras[0].text.includes('never trained on.'));
  // 没有硬换行残留
  assert.ok(!paras[0].text.includes('\n'));
});

check('行距变大时切分成两段', () => {
  const paras = buildParagraphs([
    item('First paragraph line one', 50, 700),
    item('still first paragraph here', 50, 688),   // 段内行距 12（字高 10 的 1.2 倍）
    item('Second paragraph starts', 50, 660),      // 段间距 28，明显更大
    item('and continues on this line', 50, 648),
  ]);
  assert.equal(paras.length, 2, JSON.stringify(textOf(paras)));
  assert.ok(paras[1].text.startsWith('Second paragraph'));
  assert.ok(paras[0].text.includes('still first paragraph here'));
});

check('段内换行以句号结尾时不切段（拿标点当判据会把每句都切成一段）', () => {
  const paras = buildParagraphs([
    item('This sentence is finished.', 50, 700),
    item('The same paragraph keeps going on the next line.', 50, 688),
  ]);
  assert.equal(paras.length, 1, JSON.stringify(textOf(paras)));
  assert.ok(paras[0].text.startsWith('This sentence is finished. The same paragraph'));
});

check('首行缩进触发新段', () => {
  const paras = buildParagraphs([
    item('A line that runs to the left edge of the page', 50, 700),
    item('An indented line starts a new paragraph here', 90, 686),
  ]);
  assert.equal(paras.length, 2, JSON.stringify(textOf(paras)));
});

check('字号明显更大的行被识别为标题', () => {
  const paras = buildParagraphs([
    item('Working with Vector Embeddings', 50, 760, { h: 20 }),
    item('Body text starts here and keeps going for a while.', 50, 730),
    item('The paragraph continues on the next line as usual.', 50, 716),
  ]);
  assert.equal(paras[0].isHeading, true, JSON.stringify(paras));
  assert.equal(paras[0].text, 'Working with Vector Embeddings');
  assert.equal(paras[1].isHeading, false);
  assert.equal(paras[1].text.split(' ').length > 8, true);
});

check('标题不会被正文接在后面', () => {
  const paras = buildParagraphs([
    item('Section Two', 50, 760, { h: 18 }),
    item('The body immediately follows the heading.', 50, 730),
  ]);
  assert.equal(paras.length, 2, JSON.stringify(textOf(paras)));
  assert.notEqual(paras[1].text, paras[0].text);
  assert.ok(paras[1].text.startsWith('The body'));
});

check('中日韩文字之间不插空格', () => {
  const paras = buildParagraphs([
    item('向量嵌入是', 50, 700, { w: 50 }),
    item('一种稠密表示', 100, 700, { w: 60 }),
  ]);
  assert.equal(paras[0].text, '向量嵌入是一种稠密表示', paras[0].text);
});

check('西文碎片间距够大时补空格，贴在一起时不补', () => {
  const tight = buildParagraphs([item('Hel', 50, 700, { w: 15 }), item('lo', 65, 700, { w: 10 })]);
  assert.equal(tight[0].text, 'Hello', tight[0].text);
  const loose = buildParagraphs([item('Hello', 50, 700, { w: 25 }), item('world', 85, 700, { w: 25 })]);
  assert.equal(loose[0].text, 'Hello world', loose[0].text);
});

check('页码这类纯数字段落被丢弃', () => {
  const paras = buildParagraphs([
    item('Real content of the page.', 50, 700),
    item('12', 300, 40),
  ]);
  assert.deepEqual(textOf(paras), ['Real content of the page.']);
});

check('可以保留页码（dropPageNumbers: false）', () => {
  const paras = buildParagraphs([item('12', 300, 40)], { dropPageNumbers: false });
  assert.deepEqual(textOf(paras), ['12']);
});

check('页首的页码同样被丢弃', () => {
  const paras = buildParagraphs([
    item('7', 300, 780),
    item('Real content of the page.', 50, 700),
  ]);
  assert.deepEqual(textOf(paras), ['Real content of the page.']);
});

check('正文中间的独立数字（年份、编号）不能被当页码丢掉', () => {
  const paras = buildParagraphs([
    item('Table 1 lists the results.', 50, 700),
    item('2024', 50, 660),
    item('The trend continued afterwards.', 50, 620),
  ]);
  assert.deepEqual(textOf(paras), ['Table 1 lists the results.', '2024', 'The trend continued afterwards.']);
});

check('空输入与脏数据不会抛错', () => {
  assert.deepEqual(buildParagraphs([]), []);
  assert.deepEqual(buildParagraphs(null), []);
  assert.deepEqual(buildParagraphs([null, { str: '' }, { str: 'x' }]), []);
  assert.deepEqual(buildParagraphs([{ str: '   ', transform: [1, 0, 0, 1, 0, 0] }]), []);
});

check('多段落的长文本保持顺序与段落数', () => {
  const paras = buildParagraphs([
    item('Introduction to the topic.', 50, 760, { h: 16 }),
    item('The first paragraph explains the background of the work', 50, 730),
    item('and continues across two more lines of text right here.', 50, 718),  // 段内
    item('The second paragraph introduces a different idea entirely.', 50, 690), // 段间
    item('It also spans more than a single line of the page body.', 50, 678),   // 段内
  ]);
  assert.equal(paras.length, 3, JSON.stringify(textOf(paras)));
  assert.equal(paras[0].isHeading, true);
  assert.equal(paras[1].isHeading, false);
  assert.equal(paras[2].isHeading, false);
  assert.ok(paras[1].text.startsWith('The first paragraph'));
  assert.ok(paras[2].text.startsWith('The second paragraph'));
});

console.log(`\n=== 汇总 ===\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);