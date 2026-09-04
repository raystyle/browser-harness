# 截图

`session.Page.captureScreenshot` 是你默认的探索与验证工具。

## 核心调用

```js
// Viewport only (default) — fastest, matches what the user sees
const { data } = await session.Page.captureScreenshot({ format: 'png' })
// Cross-platform temp dir: /tmp on Linux, /var/folders/… on macOS, %TEMP% on Windows
const { tmpdir } = await import('node:os')
await Bun.write(`${tmpdir()}/shot.png`, Buffer.from(data, 'base64'))

// Full page — stitched beyond the viewport
await session.Page.captureScreenshot({ format: 'png', captureBeyondViewport: true })

// JPEG is ~5× smaller — good when you only need to eyeball
await session.Page.captureScreenshot({ format: 'jpeg', quality: 70 })

// A specific region (page coordinates)
await session.Page.captureScreenshot({
  format: 'png',
  clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
})
```

## 什么时候截图

- **探索阶段：** 导航之后、编写 selector 之前。一张截图回答"我要的东西可见吗、在哪里"的速度比遍历 DOM 更快。
- **验证阶段：** 每次有实际意义的操作之后。DOM 在状态这件事上可能撒谎，像素不会。
- **调试坐标点击：** 截图 → 读取 → 在 (x, y) 处 `Input.dispatchMouseEvent` → 再截图。

## 通过 `DOM.getBoxModel` 截取元素

只需要截取某个元素时：

```js
await session.DOM.enable()
const { root } = await session.DOM.getDocument({})
const { nodeId } = await session.DOM.querySelector({ nodeId: root.nodeId, selector: '.card' })
const { model } = await session.DOM.getBoxModel({ nodeId })
const [x, y] = model.border        // top-left
const width = model.width
const height = model.height
await session.Page.captureScreenshot({ clip: { x, y, width, height, scale: 1 } })
```

`model.border` 是 `[x1,y1, x2,y1, x2,y2, x1,y2]` —— 8 个数字，4 个角。取前两个作为起点即可。

## 陷阱

- `captureBeyondViewport: true` 会重新布局页面（触发 resize）。不要在用户驱动的流程中途使用 —— 请改用视口截图。
- 在高 DPI 屏幕上，`captureScreenshot` 返回的是设备像素的图像。如果你打算依据从图像中读出的数值做坐标点击，请记住 CSS 像素 / 设备像素之间的比例（见 viewport.md）。
- 使用固定（fixed/sticky）页头的页面在 `captureBeyondViewport` 下，拼接出来的图像中可能出现重复的页头。
