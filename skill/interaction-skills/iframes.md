# Iframes (same-origin)

同源 iframe 只是父 DOM 的一部分——可以通过 `contentDocument` 走进去。跨域的情况（OOPIF）见 `cross-origin-iframes.md`。

## 通过 `contentDocument` 读取 / 写入

```js
await session.Runtime.evaluate({
  returnByValue: true,
  expression: `
    (() => {
      const doc = document.querySelector('iframe#inner').contentDocument
      return doc.querySelector('h1').textContent
    })()
  `,
})
```

- 如果该 frame 实际上是跨域的，会抛出 `DOMException: Blocked a frame with origin …`。这就是该切换到 OOPIF 路由的信号。
- 需要向 iframe 内部传数据时，可以在父页面用 `contentWindow.postMessage`。

## 坐标点击可穿透 iframe

合成器层面的输入路径（`Input.dispatchMouseEvent`）不关心 frame 边界。只要能在截图里看到某个按钮，就能点击它的页面坐标，无论它嵌套了多少层 iframe：

```js
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
```

这通常是**阻力最小**的方式。只有当需要读取 DOM，或对难以按坐标定位的元素分发 DOM 事件时，才退回到 `contentDocument` / OOPIF attach。

## Frame 局部坐标与页面坐标

iframe 内的 `getBoundingClientRect()` 返回的是 **iframe 局部**坐标。要按坐标点击，需要页面坐标：

```js
await session.Runtime.evaluate({
  returnByValue: true,
  expression: `
    (() => {
      const iframe = document.querySelector('iframe#inner')
      const inner = iframe.contentDocument.querySelector('.target')
      const iRect = iframe.getBoundingClientRect()
      const tRect = inner.getBoundingClientRect()
      return { x: iRect.x + tRect.x + tRect.width/2, y: iRect.y + tRect.y + tRect.height/2 }
    })()
  `,
})
```

## 嵌套 iframe

逐层递归 `contentDocument`：

```js
let doc = document
for (const sel of ['iframe#outer', 'iframe#middle', 'iframe#inner']) {
  doc = doc.querySelector(sel).contentDocument
  if (!doc) throw new Error('cross-origin boundary')
}
return doc.querySelector('h1').textContent
```

## 陷阱

- 原本同源的 frame 在其内部发生导航后可能变成跨域（例如 OAuth 重定向）。用 `contentDocument` 的真值重新检查。
- iframe 刚插入时 `iframe.contentDocument === null`——先等 iframe 的 `load` 事件再读取。
- 即使 origin 一致，CSP `frame-ancestors` / `sandbox="allow-same-origin"` 也可能阻止 `contentDocument` 访问。
