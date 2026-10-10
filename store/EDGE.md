# Edge Addons 上架清单

Chrome 与 Edge 共用同一个 MV3 包，上传的就是 `npm run pack` 产出的 zip。这份文件写给他本人操作时照着填。

## 一、前置（一次性，只能你本人做）

1. 注册 Partner Center（免费）：<https://partner.microsoft.com/dashboard/microsoftedge/>
   用 Microsoft 账号登录，填写 Publisher 名称。这个名字会出现在商店页面上，建议用品牌名而不是个人姓名。
2. 准备一个支持邮箱：商店必填，审核结果和用户反馈会发到这里。仓库里没有你的邮箱，提交时直接填在表单里。

## 二、要上传的文件

| 用途 | 文件 |
|---|---|
| 扩展包 | `dist/shuangyi-translate-1.10.1.zip`（zip，Edge 不接受 crx） |
| 商店图标 | `store/edge-store-logo-300.png`（300×300 PNG，用扩展图标的同一份 SVG 渲染） |
| 截图 | `store/screenshots/01-bilingual-reading.png`、`02-model-profiles.png`、`03-shortcuts.png`（均 1280×800，商店要求至少 1 张） |
| 小促销图（可选） | `store/screenshots/04-promo.png`（440×280，对应 Small promotional tile） |

## 三、字段怎么填

| 字段 | 填什么 |
|---|---|
| 名称 | 双译 — 双语对照网页翻译 |
| 简短描述 | 见下方代码块（71 字符，上限 132） |
| 详细描述 | `store/description.md` 里「详细说明」整段 |
| 类别 | 生产力（Productivity） |
| 支持的语言 | 中文（简体）、English |
| 隐私政策网址 | <https://istoo.github.io/shuangyi-translate/privacy.html> |
| 支持邮箱 | 你的邮箱（必填） |
| 支持网站（可选） | <https://github.com/istoo/shuangyi-translate> |
| 可见性 | 公开 |
| 是否需要付费许可 | 否 |

```
双语对照网页翻译：整页、悬停、划词、输入框翻译。模型自己选——OpenAI 兼容、Claude、Gemini、Ollama，或任意自定义接口。
```

## 四、隐私与权限

1. **数据收集声明必须如实勾选「网站内容」**，因为扩展会把页面里待翻译的文本发送到用户自己配置的接口。隐瞒这一项会被下架。
2. 权限说明直接复制 `store/permissions.md`，里面已经写明 `<all_urls>`、`storage`、`contextMenus` 与 `scripting` 各自的用途。
3. `store/review-qa.md` 里有审核可能追问的问题与回答，可以照着写。

## 五、已知风险与应对

1. `manifest.json` 里的 `minimum_chrome_version: 108` 是 Chrome 专有字段。Edge 一般会忽略，如果审核因此报错，我可以打一个 Edge 专用包（去掉该字段）再上传。
2. `<all_urls>` 属于宽泛权限，审核会看用途说明。`store/permissions.md` 里写的是「翻译工具需要读取你正在浏览的页面」，直接粘贴即可。
3. 描述里不要出现其他扩展的名字，包括做对比或批评，这是两家商店共同的红线。
4. 隐私政策页在 GitHub Pages 上，国内访问偶尔慢。如果审核反馈打不开，先自己确认能打开；必要时我换托管。
5. 不要承诺做不到的事：没有扫描件 OCR，不做 PDF 原版式还原，不代理图片翻译。

## 六、提交之后

1. 审核通常几个工作日，状态在 Partner Center 的扩展列表里。
2. 通过后把商店链接补进 `README.md` 的徽章与 `docs/index.html`。
3. 每次发版：改版本号、`npm test`、`npm run pack`，再到 Partner Center 上传新 zip。固定流程见 `store/SUBMIT.md`。