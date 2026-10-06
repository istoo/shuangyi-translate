# Chrome Web Store 上架清单

## 一、前置条件

| 事项 | 说明 |
|---|---|
| Google 账号 | 任意账号即可 |
| 开发者注册费 | **5 美元，一次性**，不年费。在 [开发者控制台](https://chrome.google.com/webstore/devconsole) 首次提交时支付 |
| 隐私政策网址 | 必填，且必须是可公开访问的网址（见 `privacy-policy.md` 末尾说明） |
| 审核时长 | 首次通常 1–3 个工作日，之后更新一般几小时到 1 天 |

## 二、提交材料

| 材料 | 位置 | 状态 |
|---|---|---|
| 扩展包（zip） | `npm run pack` → `dist/shuangyi-translate-<版本>.zip` | ✅ 打包脚本已就绪 |
| 商店名称 | `description.md` | ✅ |
| 简短说明 | `description.md` | ✅ |
| 详细说明 | `description.md` | ✅ |
| 截图（1280×800） | `store/screenshots/01`、`02`、`03` | ✅ 已用真实翻译效果生成 |
| 促销图（440×280） | `store/screenshots/04` | ✅ |
| 图标 128×128 | `icons/icon128.png` | ✅ 已在包内 |
| 单一用途 / 权限理由 | `permissions.md` | ✅ 可直接粘贴 |
| 数据使用声明 | `permissions.md` 末尾的表格 | ⚠️ 需手动勾选 |
| 隐私政策 | `privacy-policy.md` | ⚠️ 需托管成公开网址，并填上联系邮箱 |
| 审核问答预案 | `review-qa.md` | ✅ 被追问或被拒时照抄 |

截图可以随时重新生成（扩展有改动时）：

```bash
# 启动带调试端口的 Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9341 --user-data-dir=/tmp/irt-shot about:blank &
# 加载扩展
node test/e2e/verify.mjs 9341
# 生成截图（用真实 Google 翻译效果，不是模拟数据）
node test/e2e/screenshot.mjs 9341
```

## 隐私政策怎么托管

Chrome Web Store 要求隐私政策是一个**可公开访问的网址**，不能填本地路径。

| 方案 | 成本 | 适合 |
|---|---|---|
| **Notion / 语雀公开页面** | 免费，几分钟 | 最快，不需要任何技术操作 |
| **GitHub Gist** | 免费 | 需要一个 GitHub 账号，内容是纯文本 |
| **自己的域名 / 静态托管** | 域名年费 | 商业化之后的正经做法 |

把 `privacy-policy.md` 的内容整段粘过去、填上联系邮箱即可，**不需要为了隐私政策公开任何代码**。

## 三、提交流程

1. 打包：`npm run pack`
2. 打开 [Chrome Web Store 开发者控制台](https://chrome.google.com/webstore/devconsole)，支付 5 美元注册费（首次）
3. 「新增项目」→ 上传 `dist/shuangyi-translate-<版本>.zip`
4. 按 `description.md` 填写商品信息，上传 3 张图
5. 按 `permissions.md` 填写单一用途、权限理由、数据使用声明
6. 填写隐私政策网址
7. 提交审核

## 四、发布更新

1. 改 `manifest.json` 里的 `version`（例如 `1.1.0` → `1.1.1`）
2. `npm run pack`
3. 在开发者控制台用新的 zip 提交更新

**签名私钥 `keys/shuangyi-translate.pem` 必须保管好**：同一个扩展的后续版本要用同一把私钥签名，否则商店会认为是另一个扩展。这个文件不要在版本库里（`.gitignore` 已排除 `keys/`），并请另外备份 —— 丢了就只能换新私钥，而商店会把新私钥签出来的包当成另一个扩展。

## 五、注意事项

- **描述里不要提其他扩展的名字**，包括做对比或批评，商店会驳回。
- **数据使用声明必须勾选「网站内容」**。本扩展会把待翻译文本发送到用户配置的第三方接口，隐瞒这一点会导致下架。
- 名称避免使用可能与现有商标冲突的词（这也是本项目从原名改名为「双译」的原因）。
- 如果后续要改名，需要同步修改的位置：`manifest.json` 的 `name`/`action.default_title`、`src/options/options.html`、`src/popup/popup.html`、以及本目录下的文案。

## 六、如果不想上架

`dist/shuangyi-translate-<版本>.crx` 可以用于本地安装，但 Chrome 稳定版会拦截非商店来源的 crx，仍需开发者模式或企业策略。详见项目根目录 `README.md` 的说明。