// 页面脚本之前执行，把 closed shadow root 改成 open。
// 内容脚本读不到 closed root，Reddit / YouTube 一类站点会因此整块漏译。
// 已经创建好的 closed root 改不了，所以必须在 document_start 注入。
// 只在顶层文档注入（manifest 里 all_frames: false）：内容脚本本来就只处理顶层文档，
// 支付页、第三方 iframe 里没必要动 Element.prototype。
const orig = Element.prototype.attachShadow;
Element.prototype.attachShadow = {
  attachShadow(init) {
    const next = init && typeof init === 'object' ? { ...init, mode: 'open' } : { mode: 'open' };
    return orig.call(this, next);
  },
}.attachShadow;   // 方法简写保留 name === 'attachShadow'，也没有 prototype 属性，更接近原生函数
