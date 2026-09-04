# Shadow DOM

在你要自动化的网站上，closed shadow root 很少见。大多数 web component 使用 open shadow root —— 你可以用 JS 遍历，或使用 CDP 的 `pierceShadow` 标志。

## 首选方案：坐标点击

合成器级别的点击不关心 shadow root。只要能在截图里看到它，`Input.dispatchMouseEvent` 就能点它。这样完全绕开了穿透 shadow DOM —— 对按钮、链接和表单触发器优先使用这一招。

## CDP 路径：`pierceShadow`

`DOM.querySelector` / `DOM.querySelectorAll` 接受 `pierceShadow: true` —— 一次调用即可跨越所有 open shadow 边界：

```js
await session.DOM.enable()
const { root } = await session.DOM.getDocument({})
const { nodeId } = await session.DOM.querySelector({
  nodeId: root.nodeId,
  selector: 'my-button >>> .inner-label',
  // Chrome has also historically accepted `pierceShadow: true`; on recent
  // Chrome the `>>>` combinator in the selector pierces shadow roots directly.
})
```

## JS 路径：通过 `shadowRoot` 递归遍历

更具可移植性，任何 Chrome 版本都可用：

```js
await session.Runtime.evaluate({
  returnByValue: true,
  expression: `
    (() => {
      function* walk(root) {
        const stack = [root]
        while (stack.length) {
          const node = stack.pop()
          if (!node) continue
          yield node
          if (node.shadowRoot) stack.push(...node.shadowRoot.children)
          stack.push(...(node.children || []))
        }
      }
      for (const el of walk(document.body)) {
        if (el.matches?.('.target-class')) {
          const r = el.getBoundingClientRect()
          return { x: r.x + r.width/2, y: r.y + r.height/2 }
        }
      }
      return null
    })()
  `,
})
```

把返回的 `{x, y}` 用于 `Input.dispatchMouseEvent`。

## 在 shadow DOM 内的 input 中设置值

找到 input 才是难点 —— 设置值与普通 input 无异：

```js
await session.Runtime.evaluate({ expression: `
  (() => {
    const host = document.querySelector('my-form')
    const input = host.shadowRoot.querySelector('input[name=email]')
    input.focus()
    input.value = 'hi@example.com'
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  })()
`})
```

事件上的 `composed: true` 让它能跨越 shadow 边界 —— 许多 web component 监听的是宿主元素，而不是内部 input。

## 陷阱

- **Closed shadow root**（`{ mode: 'closed' }`）无法从 JS 遍历。改用坐标点击 + `Input.insertText`。closed root 很少见 —— 通常只有密码管理器和部分 Google 组件。
- **`slot` 内容位于 light DOM 中**，不在 shadow root 里。如果你的元素有 `<slot>…</slot>`，要找的子元素是 `host.children`，而非 `host.shadowRoot.children`。
- **`::part()` / `::slotted()` CSS** 只影响样式，没有对应的 DOM 查询等价物 —— 你仍需遍历 `shadowRoot`。
- 只要拿到 `nodeId`，通过 `DOM.getBoxModel` 对元素截图同样适用于 shadow DOM 元素。
