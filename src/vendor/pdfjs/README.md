# pdf.js（第三方）

来自 npm 包 `pdfjs-dist`，版本见下方的 VERSION。

- `pdf.min.mjs` / `pdf.worker.min.mjs` —— 未经修改的官方构建产物
- 许可证：Apache-2.0，见 `LICENSE`

## 为什么要打包进来

Chrome Web Store 禁止扩展加载远程代码，PDF 解析库必须随包分发。

## 升级方式

```bash
cd /tmp && rm -rf pdfjs && mkdir pdfjs && cd pdfjs
npm pack pdfjs-dist && tar xzf pdfjs-dist-*.tgz
cp package/build/pdf.min.mjs package/build/pdf.worker.min.mjs /path/to/src/vendor/pdfjs/
cp package/LICENSE /path/to/src/vendor/pdfjs/LICENSE
```

注意：`cmaps/` 与 `standard_fonts/` 没有打包（合计数 MB）。绝大多数字体能在没有它们的情况下正常提取文本；如果遇到某些 PDF 出现乱码，再考虑补上。
VERSION: 6.4.299
