# 上传

绝不要在 `<input type="file">` 上模拟点击 —— 它会打开 OS 文件选择器，而 CDP 无法关闭该选择器。改为直接通过 CDP 设置文件。

## 标准做法

```js
await session.DOM.enable()
const { root } = await session.DOM.getDocument({ depth: -1 })
const { nodeId } = await session.DOM.querySelector({
  nodeId: root.nodeId,
  selector: 'input[type="file"]',
})
if (!nodeId) throw new Error('no file input found')

await session.DOM.setFileInputFiles({
  nodeId,
  files: ['/absolute/path/to/file.png'],
})
```

- 路径必须是**绝对路径**。
- 多个文件：传入数组 —— 仅在该 input 具有 `multiple` 属性时有效。
- 会在 input 上触发 `change` 事件，与真实选择文件时完全一样。

## 隐藏的 / 屏幕外的 file input

网站常会隐藏 `<input type="file">`（display:none、visibility:hidden、定位到屏幕外），并暴露一个样式化的按钮来调用 `input.click()`。`DOM.setFileInputFiles` **不受可见性影响** —— 直接找到该 input，不要点击按钮：

```js
// Works even for display:none / opacity:0 inputs
const { nodeIds } = await session.DOM.querySelectorAll({
  nodeId: root.nodeId,
  selector: 'input[type="file"]',
})
```

如果 `querySelector` 返回 `nodeId: 0`，说明该 input 位于 shadow root 或 iframe 内 —— 见 `shadow-dom.md` / `iframes.md`。

## 拖放上传区

React/Vue 的 dropzone（`react-dropzone` 等）往往只响应 `drop` 事件，没有 `<input>`。两条路径：

1. **找到隐藏的 input** —— 大多数 dropzone 出于无障碍考虑仍会保留一个。先用 `document.querySelectorAll('input[type=file]')` 检查。
2. **合成一个携带 File 的 DOM drop 事件**：
   ```js
   await session.Runtime.evaluate({ awaitPromise: true, expression: `
     (async () => {
       const resp = await fetch('https://example.com/file.png')
       const blob = await resp.blob()
       const file = new File([blob], 'file.png', { type: 'image/png' })
       const dt = new DataTransfer()
       dt.items.add(file)
       const target = document.querySelector('.dropzone')
       for (const type of ['dragenter','dragover','drop']) {
         target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
       }
     })()
   `})
   ```
   这种方式会被反爬机制检测到 —— 若存在隐藏 input，优先用路径 1。

## 验证上传已触发

监听 input 上的 `change` 事件，或通过 `Network.requestWillBeSent` 观察网络中的上传 POST。仅凭截图往往看不出文件已附加 —— 用网络追踪。
