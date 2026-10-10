# 上架清单

这份文件写给维护者，说明怎么把扩展提交到 Chrome Web Store 与 Microsoft Edge Addons，以及每次发版要做什么。

## 一、前置准备（一次性）

1. **注册开发者账号**
   - Chrome Web Store：<https://chrome.google.com/webstore/devconsole> ，一次性 5 美元注册费。
   - Microsoft Partner Center：<https://partner.microsoft.com/dashboard/microsoftedge/> ，注册免费。
2. **隐私政策需要一个可公开访问的网址**。已用 GitHub Pages 托管：<https://istoo.github.io/shuangyi-translate/privacy.html> 。如果换域名或换托管，记得同步改这里、`store/privacy-policy.md` 和 issue 模板里的链接。
3. **打包产物**：`npm run pack` 会生成 `dist/shuangyi-translate-<版本>.zip`。商店上传的就是这个 zip。
4. **素材**：`store/description.md`（商店文案）、`store/permissions.md`（权限说明）、`store/review-qa.md`（审核问答）、`store/screenshots/`（截图 1280×800，商店要求 1 到 5 张）。

## 二、提交到 Chrome Web Store

1. 开发者后台 → 「新增项目」→ 上传 `dist/*.zip`。
2. 「商店信息」按 `store/description.md` 填写名称、简短说明、详细说明、类别、语言。截图用 `store/screenshots/`。
3. 「隐私权」页：
   - 填写隐私政策网址（上面的 Pages 地址）。
   - 数据使用声明里勾选「网站内容」，因为扩展会把页面文本发送到用户自行配置的接口。隐瞒这一项会被下架。
   - 说明用途时写清楚：文本只发往用户自己填写的接口，扩展本身没有后端。
4. 「权限理由」按 `store/permissions.md` 填写。
5. 提交审核。Chrome 侧通常几天。

## 三、提交到 Microsoft Edge Addons

Edge 与 Chrome 共用同一个 MV3 包（manifest 无需改动）：

1. Partner Center → 「新建扩展」→ 上传同一个 zip。
2. 商店信息与截图复用 `store/description.md` 与 `store/screenshots/`。
3. 提交审核。

## 四、每次发版的固定流程

```bash
# 1. 改版本号（两处必须一致）
#    manifest.json 的 version，package.json 的 version
# 2. 记录改动
#    在 CHANGELOG.md 顶部新增一节
# 3. 跑测试
npm test
# 4. 打包
npm run pack
# 5. 提交代码并打 tag
git add -A && git commit -m "chore: 发布 1.10.x"
git tag -a v1.10.x -m "v1.10.x" && git push origin main && git push origin v1.10.x
# 6. 发 GitHub Release，附上 zip 与 crx
gh release create v1.10.x --title v1.10.x --notes-file <(sed -n '/## 1.10.x/,/^## /p' CHANGELOG.md) dist/shuangyi-translate-1.10.x.zip
# 7. 到两个开发者后台上传新 zip 并提交审核
```

## 五、商店文案的注意事项

1. **不要提到其他扩展的名字**，包括做对比或批评，Chrome 商店会因此驳回。
2. **不要承诺不支持的能力**。当前不支持扫描件 OCR、不做 PDF 原版式还原、不代理图片翻译。
3. 描述里可以写明「开源、无后端、文本只发往你配置的接口」，这几条既如实，也减少审核对数据流向的追问。
4. 上架后把商店链接补进 `README.md` 的徽章和 `docs/index.html`。