# Downloads

两种模式：让 Chrome 把文件写入你控制的目录，或在 CDP 中拦截下载响应并自行保存。

## 把下载路由到你自己的目录

```js
// Cross-platform temp dir: /tmp on Linux, /var/folders/… on macOS, %TEMP% on Windows
const { tmpdir } = await import('node:os')
const downloadDir = `${tmpdir()}/cdp-downloads`
await Bun.write(`${downloadDir}/.keep`, '')  // ensure dir exists

await session.Browser.setDownloadBehavior({
  behavior: 'allow',
  downloadPath: downloadDir,
  eventsEnabled: true,   // emit Browser.downloadWillBegin / downloadProgress
})
```

此后任何下载——无论是链接触发（`<a download>`）、指向二进制内容的 `window.location`，还是返回 `Content-Disposition: attachment` 的表单 POST——都会保存到该目录。

## 监听下载真正开始

```js
const ev = await session.waitFor(
  'Browser.downloadWillBegin',
  (p) => p.suggestedFilename.endsWith('.pdf'),
  10_000
)
console.log(ev.guid, ev.suggestedFilename, ev.url)
```

## 监听下载完成

```js
const done = await session.waitFor(
  'Browser.downloadProgress',
  (p) => p.state === 'completed',
  60_000
)
console.log(done.receivedBytes, done.totalBytes)
```

`Browser.downloadProgress.state` 的取值为 `'inProgress' | 'completed' | 'canceled'` 之一。

## 普通 HTTP 下载可完全绕过浏览器

如果下载 URL 是普通 HTTP GET，且不依赖浏览器添加的认证或 cookie 状态，可在 Bun 代码片段中直接 `fetch`：

```js
const { tmpdir } = await import('node:os')
const res = await fetch('https://example.com/report.pdf')
await Bun.write(`${tmpdir()}/report.pdf`, await res.arrayBuffer())
```

这通常比驱动浏览器快 10 倍。但会**丢失基于 cookie 的认证**——对于需要登录的下载，要么：
1. 走浏览器路径（`Browser.setDownloadBehavior`），要么
2. 先把 cookie 复制出来（`Network.getCookies`），并在 `fetch` 中携带。

## 只有点击才能触发时

如果站点只提供一个 "Download" 按钮而没有明显的 URL：

```js
// Pre-arm Browser.setDownloadBehavior, then click
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
const ev = await session.waitFor('Browser.downloadWillBegin', undefined, 10_000)
```

## 陷阱

- **`Browser.setDownloadBehavior` 的作用域是整个浏览器**，不是单个页面。每个浏览器 session 只需设置一次。
- **`downloadPath` 必须已存在。** 否则 Chrome 会静默丢弃文件——务必先 `mkdir -p`。
- **文件会以建议文件名落盘**，而不是你指定的名字。如果需要特定名称，请在 `state === 'completed'` 之后重命名。
- **触发页面上的 `beforeunload`** 可能阻塞下载。有些站点在跳转到 PDF 端点前会弹出确认 dialog——先处理 dialog（见 `dialogs.md`）。
- **如果这个"下载"其实只是内联导航**（页内打开 PDF 查看器），就不会有 `downloadWillBegin`——此时应改用 `Page.printToPDF` 或直接 `fetch`。
