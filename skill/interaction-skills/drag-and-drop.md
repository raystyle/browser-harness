# Drag and Drop

"拖放"背后其实分三类，每一类需要不同的 CDP 调用。

## 第 1 类：HTML5 DnD（`dragstart` / `drop` 事件）

React DnD、pragmatic-drag-and-drop、原生 `<div draggable>`——它们都监听 DOM `DragEvent`。CDP 的 `Input.dispatchMouseEvent`（mousePressed/moved/released）**不会**触发这些事件，因为浏览器是从原生 OS 拖拽合成 `DragEvent` 的，而 CDP 无法触发原生拖拽。应改用 `Input.dispatchDragEvent`：

```js
// Chrome needs to be told we're about to handle drags via CDP
await session.Input.setInterceptDrags({ enabled: true })

// Press at the source
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: srcX, y: srcY, button: 'left', clickCount: 1 })

// Wait for CDP to deliver the initial drag intent (via Input.dragIntercepted)
const di = await session.waitFor('Input.dragIntercepted', undefined, 2_000)

// Simulate the move + drop via dispatchDragEvent
await session.Input.dispatchDragEvent({ type: 'dragEnter', x: dstX, y: dstY, data: di.data })
await session.Input.dispatchDragEvent({ type: 'dragOver',  x: dstX, y: dstY, data: di.data })
await session.Input.dispatchDragEvent({ type: 'drop',      x: dstX, y: dstY, data: di.data })

await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: dstX, y: dstY, button: 'left', clickCount: 1 })
await session.Input.setInterceptDrags({ enabled: false })
```

这覆盖了 React/Vue 应用中的大多数真实拖放场景（Trello 卡片、Notion 块、Linear 工单、Figma 图层）。

## 第 2 类：基于指针的拖拽（canvas、SVG、自定义处理器）

游戏、地图平移、Figma/Excalidraw 画布、范围滑块——它们监听 `mousedown` / `mousemove` / `mouseup`（或 pointer 事件），并自行计算坐标。对这类场景，一段普通的鼠标事件序列就足够：

```js
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 })
// Intermediate moves matter — many sites track velocity / only trigger on movement delta
for (let i = 1; i <= 10; i++) {
  const x = x1 + (x2 - x1) * (i / 10)
  const y = y1 + (y2 - y1) * (i / 10)
  await session.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' })
}
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 })
```

务必添加中间的 `mouseMoved` 事件——追踪速度的站点不会响应单次跳变。

## 第 3 类："把文件拖到这个区域"＝上传

大多数接受文件的放置区域底下都藏着一个 `<input type="file">`。直接用 `DOM.setFileInputFiles`——见 `uploads.md`。既然有 input，就别去碰 DnD 路径。

## 陷阱

- **HTML5 DnD 不要只用 `Input.dispatchMouseEvent`**——不会触发 `dragstart`。站点只会看到一个落空的点击。请用 `setInterceptDrags` + `dispatchDragEvent`。
- **不要在没有 `setInterceptDrags({ enabled: true })` 的情况下调用 `Input.dispatchDragEvent`**——否则 Chrome 会把拖拽路由到原生 OS。
- **吸附 / 动画**：drop 之后约 300ms 再重新截图。有些库会把卡片动画到目标位置，后续动作过快会落在错误的坐标上。
- **Pointer Events 与 Mouse Events**：如果 `mousedown` 不起作用，试着用 `dispatchMouseEvent` 并带上 `pointerType: 'mouse'`，同时也用 `dispatchPointerEvent` 发送同样的序列（一些新的 SPA 只监听 pointer 事件）。
