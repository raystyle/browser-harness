# Dropdowns

正确的做法取决于站点实际渲染的是哪种下拉框。

## 原生 `<select>`

不要点击选项——直接设置 value 并触发 `change`。对原生 select 使用键盘/鼠标会打开一个 CDP 无法关闭的 OS 菜单。

```js
await session.Runtime.evaluate({ expression: `
  (() => {
    const s = document.querySelector('select#country')
    s.value = 'DE'
    s.dispatchEvent(new Event('change', { bubbles: true }))
  })()
`})
```

验证：`await session.Runtime.evaluate({ expression: 'document.querySelector("select#country").value', returnByValue: true })`。

## 自定义浮层（触发器下的 div 菜单）

1. 用 `Input.dispatchMouseEvent` 点击触发器。
2. **重新测量**——选项出现较晚，有时挂在 `<body>` 下的 portal 里。
3. 按可见文本点击选项。

```js
// Click the trigger
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x: triggerX, y: triggerY, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x: triggerX, y: triggerY, button: 'left', clickCount: 1 })

// Wait one frame, then find the option by text and coordinate-click it
const { result } = await session.Runtime.evaluate({
  returnByValue: true,
  expression: `
    (() => {
      const t = [...document.querySelectorAll('[role="option"], li, .menu-item')]
        .find(el => el.textContent.trim() === 'Germany')
      if (!t) return null
      const r = t.getBoundingClientRect()
      return { x: r.x + r.width/2, y: r.y + r.height/2 }
    })()
  `,
})
if (result.value) {
  const { x, y } = result.value
  await session.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}
```

## 可搜索的 combobox（React / Downshift / Radix / MUI Autocomplete）

大多数 combobox 靠**键盘**提交，而不是点击：

1. 点击 input，使其获得焦点并展开。
2. 用 `Input.insertText` 输入搜索字符串。
3. 等待选项渲染。
4. 用 `Input.dispatchKeyEvent` 发送 ArrowDown → Enter 提交。

```js
await session.Input.dispatchKeyEvent({ type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
await session.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
await session.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter',     code: 'Enter',     windowsVirtualKeyCode: 13, text: '\r' })
await session.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'Enter',     code: 'Enter',     windowsVirtualKeyCode: 13 })
```

有些库（尤其是 Radix）需要按 `Escape` 才能不提交而关闭。点击外部可能残留旧的输入。

## 虚拟化菜单

长选项列表（`react-window`、TanStack Virtual）只渲染可见的那一部分。如果目标选项不在 DOM 中，用 `mouseWheel` 在菜单容器的坐标上滚动（见 `scrolling.md`），直到它挂载，**然后**再按坐标点击。

## 陷阱

- 打开后务必**重新测量**——菜单出现时触发器的屏幕位置可能移动（会把内容推下去的下拉框）。
- Portal：选项 DOM 可能不是触发器的后代。用 `document.querySelectorAll` 搜索，而不是 `trigger.querySelectorAll`。
- MUI Autocomplete：`blur` 提交的是文本值，而非选中的选项。始终用 Enter。
- 选项上有 CSS `pointer-events: none` 时，点击会穿透——查找内层的 `<span>` 或上一层的选项容器。
