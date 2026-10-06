# 打包脚本

生成两个产物，都放在 `dist/`：

- `shuangyi-translate-<version>.zip` —— 提交 Chrome Web Store 用
- `shuangyi-translate-<version>.crx` —— 本地 / 内网分发用（需要开发者模式或企业策略才能安装）

```bash
npm run pack
```

打包时只收录扩展运行需要的文件（manifest、src、icons），排除测试、开发依赖和素材目录。