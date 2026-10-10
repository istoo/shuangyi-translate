# 参与开发

欢迎提交 issue 与 pull request。动手前请先读这份文件，以及仓库根目录的 `AGENTS.md`（有更细的目录约定与编码风格）。

## 环境

```bash
npm install     # 只装测试依赖（jsdom、ws）
npm test        # 离线测试，不需要浏览器
```

改动涉及浏览器行为时，用 `npm run dev:sync` 把 `manifest.json`、`icons/`、`src/`、`_locales/` 同步到 `dev-ext/`，在 `chrome://extensions` 打开开发者模式后加载那个目录。改完源码要在扩展卡片上点刷新，页面也要重新加载。

## 提交前

1. `npm test` 必须全绿。
2. 新增测试文件要加进 `package.json` 的 `test` 脚本，否则 CI 不会跑它。
3. 改动面向用户的文案时，`_locales/zh_CN` 与 `_locales/en` 必须同时更新。测试会校验两个语言包 key 一致、没有空文案、没有用不到的文案。
4. 不要提交 `keys/`、`dist/`、`dev-ext/`，这三个目录是密钥或产物。

## 代码约定

项目没有构建步骤，浏览器直接加载 `src/` 下的 ES 模块。测试用 `node:assert/strict` 加一个本地 `check()` 函数，不引入测试框架。注释用中文。注入页面的 CSS 类名以 `irt-` 开头，并用 `:where()` 限制优先级外溢。更完整的约定见 `AGENTS.md`。

## 提交信息

用 Conventional Commits，主题用中文：

```
fix: 支持 shadow DOM…
feat: 更名双译、重做图标
chore: 改为 AGPL-3.0
```

## 授权

本项目以 GNU Affero 通用公共许可证第 3 版（AGPL-3.0）授权。提交 pull request 即表示你同意自己的贡献按同一许可证授权（入站即出站），并确认这份代码由你本人创作或你有权按此授权提交。

如果项目以后需要提供商业授权（双许可），会在这里说明并要求贡献者签署贡献者许可协议。目前没有这道手续。