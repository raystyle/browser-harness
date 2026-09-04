# 滚动

三个层级，按成功概率从高到低排列：

1. **在某个坐标点派发滚轮事件** —— `Input.dispatchMouseEvent { type: 'mouseWheel' }`。滚动 (x, y) 位置下方的元素，并消耗该次滚轮事件。
2. **对元素调用 `scrollIntoView`** —— 用 `Runtime.evaluate` 执行一段简短的 JS。适用于 DOM 中任何你能 `querySelector` 到的东西。
3. **直接设置容器的 `scrollTop`** —— 绕过动画和 scroll snap。

## 滚轮（基于坐标，最接近真实用户）

```js
// scroll down 300px at the center of the viewport
await session.Input.dispatchMouseEvent({
  type: 'mouseWheel',
  x: 600, y: 400,
  deltaX: 0, deltaY: 300,
})

// scroll up
await session.Input.dispatchMouseEvent({ type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: -300 })
```

- 把 (x, y) 选在你想滚动的元素上方。如果滚轮停在 sticky 页头或固定的侧边栏上，什么都不会发生。
- 虚拟化列表（`react-window`、TanStack Virtual）：滚动容器是**唯一**可靠的滚动方式；对子行调用 `scrollIntoView` 通常不会生效，因为该行还未挂载。

## scrollIntoView（基于 DOM）

```js
await session.Runtime.evaluate({ expression: `
  document.querySelector('[data-row-id="42"]')?.scrollIntoView({ block: 'center', behavior: 'instant' })
`})
```

- `behavior: 'instant'` 可以避免动画往返，也避免你的下一步操作落在过期的坐标上。
- selector 匹配不到时会静默失败 —— 务必用截图验证。

## scrollTop / scrollLeft（简单粗暴但可靠）

```js
await session.Runtime.evaluate({ expression: `
  const el = document.querySelector('.list-scroll-container')
  if (el) el.scrollTop = el.scrollHeight
`})
```

适用场景：
- 容器设置了自定义 `overflow: auto`，而滚轮事件没有到达它。
- 你需要跳转到绝对偏移量（顶部、底部、"第 N 行 × rowHeight"）。

## 是哪个容器在消耗滚轮事件？

存在多层嵌套滚动容器（页面里有 modal、卡片里有列表）的网站，会让"滚动页面"这一说法变得模糊。先找出真正的滚动容器：

```js
await session.Runtime.evaluate({
  returnByValue: true,
  expression: `
    (() => {
      const out = []
      document.querySelectorAll('*').forEach(el => {
        const s = getComputedStyle(el)
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight)
          out.push({ tag: el.tagName, cls: el.className, h: el.clientHeight, scroll: el.scrollHeight })
      })
      return out
    })()
  `,
})
```

## 陷阱

- CSS 中的 **`scroll-behavior: smooth`** 会让一切滚动都带动画 —— `Input.dispatchMouseEvent` 立即返回，但下一次坐标点击会在滚动结束前落下。要么给 `scrollIntoView` 设置 `behavior: 'instant'`，要么在滚轮之后 `await new Promise(r => setTimeout(r, 400))`。
- **打开 dropdown / modal 之后，重新读取元素矩形**再做坐标点击。布局位移会使缓存的坐标失效。
- **触控板上的滚轮会派发几十个小 delta 事件。** 如果网站的无限滚动 sentinel 需要惯性，单次 `deltaY: 300` 可能触发不了 —— 请在循环中连续发送多次较小的滚轮。
