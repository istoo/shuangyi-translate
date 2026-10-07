// e2e 脚本经常复用同一个 Chrome 实例，而配置是全扩展共享的：站点规则按 host 存，所有脚本
// 又都跑在 127.0.0.1 上；providers / engine / subtitleTranslate 也会被上一个脚本整个换掉。
// 于是上一个脚本留下的「总是翻译」「从不翻译」或 subtitleTranslate:false，会让下一个脚本
// 无端变红。实测：dynamic-check 之后跑 walkthrough 会假红 10 条（页面一打开就自动翻译，
// 每次 togglePage 都变成反向操作），walkthrough 之后跑 subtitle-check 字幕链路整个不工作。
// 每个脚本都用 setTestConfig 起步，就不存在这个顺序依赖。
export function setTestConfig(cli, patch) {
  // siteRules 是整体替换语义，默认清空；调用方要自己写规则时在 patch 里覆盖即可
  const full = { siteRules: {}, ...patch };
  return cli.evalJs(`new Promise(res => chrome.runtime.sendMessage({
    type: 'setConfig',
    patch: ${JSON.stringify(full)},
  }, (r) => res(JSON.stringify({ ok: !!r?.ok }))))`);
}

// 脚本自己写进去的站点规则要在收尾时清掉，否则会污染下一个脚本
export function clearSiteRules(cli) {
  return cli.evalJs(`new Promise(res => chrome.runtime.sendMessage({
    type: 'setConfig',
    patch: { siteRules: {} },
  }, (r) => res(JSON.stringify({ ok: !!r?.ok }))))`);
}
