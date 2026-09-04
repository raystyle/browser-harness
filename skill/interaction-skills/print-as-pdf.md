# 打印为 PDF

用户说"打印成 PDF"时，可能指两件完全不同的事：

## 1. 把当前页面渲染成 PDF（通常你要的就是这个）

```js
const { data } = await session.Page.printToPDF({
  printBackground: true,
  paperWidth: 8.5,           // inches
  paperHeight: 11,
  marginTop: 0.4,
  marginBottom: 0.4,
  marginLeft: 0.4,
  marginRight: 0.4,
  preferCSSPageSize: true,   // respect @page in the site's CSS if set
})
// Cross-platform temp dir: /tmp on Linux, /var/folders/… on macOS, %TEMP% on Windows
const { tmpdir } = await import('node:os')
await Bun.write(`${tmpdir()}/page.pdf`, Buffer.from(data, 'base64'))
```

整个过程**无需**任何可见的打印对话框 —— Chrome 在进程内部直接渲染 PDF。页面无法察觉。

值得了解的选项：
- `landscape: true` —— 切换为横向
- `displayHeaderFooter: true` 加上 `headerTemplate` / `footerTemplate` —— 打印出来的 HTML（使用 mustache 风格的变量：`{{pageNumber}}`、`{{totalPages}}`、`{{title}}`、`{{url}}`）
- `scale: 0.8` —— 缩放以适配页面
- `pageRanges: '1-3,7'` —— 只输出部分页
- `transferMode: 'ReturnAsStream'` —— 对于非常大的 PDF，返回一个 stream 句柄而不是巨大的 base64 数据块

## 2. 网站有一个"打印"按钮，会弹出真实的打印对话框

有些网站调用 `window.print()`，并依赖用户在操作系统对话框中选择"另存为 PDF"。CDP **无法**与操作系统的打印对话框交互。

两种绕过方式：

### A. 在点击之前拦截 `window.print`

```js
await session.Runtime.evaluate({ expression: `
  window.print = () => {
    window.dispatchEvent(new Event('beforeprint'))
    window.__printed__ = true
  }
`})
// Click the site's Print button — the call is now a no-op
// Then generate the PDF yourself:
```
接着使用方案 1 的 `session.Page.printToPDF(...)`。

这种方式能被 `window.print.toString()` 检测到 —— 对大多数网站没问题，遇到 antibot 有风险。

### B. 使用底层 URL

"打印"按钮通常只是跳转到一个适合打印的 URL，例如 `/invoice/123?print=1`。用 DevTools 找到它，然后：

```js
await session.Page.navigate({ url: 'https://example.com/invoice/123?print=1' })
// ...wait for load...
await session.Page.printToPDF({ printBackground: true })
```

## 陷阱

- **`printBackground: false`（默认值）会跳过背景色和背景图。** 发票、收据以及任何设计感较强的页面在没有它的情况下会显得一片空白 —— 除非你刻意想要"简洁打印"的效果，否则请开启它。
- **`Page.printToPDF` 使用它自己的 print 媒体 CSS**（`@media print`）。如果页面在 `@media print` 下用 `display: none` 隐藏了某些元素，它们就不会出现在 PDF 中。可先用 `Emulation.setEmulatedMedia({ media: 'screen' })` 覆盖。
- **非常大的页面**（超长报表、数据表格）可能触及 Chrome 内部的 PDF 尺寸限制并静默失败。可以用 `pageRanges` 分段，或减小 `scale`。
- **字体可能被替换。** Chrome 渲染 PDF 时使用系统字体 —— 如果网站使用了某个在截图时刻尚未加载的 webfont，PDF 里就会是回退字体。
