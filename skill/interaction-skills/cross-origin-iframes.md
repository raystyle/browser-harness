# 跨域 iframe（OOPIF）

跨域 iframe（stripe.com 结账页、recaptcha、Salesforce Lightning、Azure blades）以 **out-of-process iframe（OOPIF）** 形式运行，拥有独立的 CDP target。无法从父页面通过 `contentDocument` 访问它们。

## 首选方案：坐标点击

合成器层面的输入事件会透明地穿透 OOPIF。如果目标是截图中可见的某个按钮，优先尝试这种方式——更简单、无法被检测，也不需要附加到任何 target：

```js
// Click a "Pay" button inside a Stripe iframe by page coordinates
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
```

基于坐标的键盘输入同样可行：先点击，再调用 `Input.insertText` / `Input.dispatchKeyEvent`。

## 需要访问 OOPIF 内部 DOM 时

找到该 iframe 的 target，把 Runtime/DOM 调用路由过去：

```js
const { targetInfos } = await session.Target.getTargets({})
const iframe = targetInfos.find(t => t.type === 'iframe' && t.url.includes('stripe.com'))

// Route subsequent calls to the iframe target
await session.use(iframe.targetId)

await session.Runtime.enable()
const { result } = await session.Runtime.evaluate({
  expression: 'document.querySelector("[name=cardnumber]").value',
  returnByValue: true,
})

// Switch back to the parent page when done
await session.use(parentTargetId)
```

`session.use(iframe.targetId)` 在尚未附加时会自动附加，并把 Page/DOM/Runtime/Network 路由到该 target。无论是否调用 `use`，`Target.*` 和 `Browser.*` 始终作用于 browser 端点。

## 如何区分各个 target？

`Target.getTargets` 会平铺返回页面中的**所有** OOPIF。如果多个 iframe 同源（例如多个 Stripe Elements），仅靠 URL 无法区分：

- 按 URL 路径过滤（Stripe 中的 `cardNumber`、`cardExpiry`、`cvc`）。
- 从父页面按 DOM 顺序枚举：找出所有 `<iframe>` 元素，把它们的 `src` 映射到 target URL。
- 通过 `Target.getTargetInfo({ targetId })` 查看 title。

## 监听来自 OOPIF 的事件

调用 `session.use(iframe.targetId)` 后，该 target 的事件仍通过同一个 `session.onEvent` / `session.waitFor` 接收：

```js
await session.use(iframe.targetId)
await session.Network.enable({})
const ev = await session.waitFor(
  'Network.responseReceived',
  (p) => p.response.url.includes('/confirm_payment'),
  10_000
)
```

## 常见陷阱

- **OOPIF 在交互前不一定存在。** Stripe 的卡号 iframe 会在你聚焦外层输入框后才懒加载挂载。先截图并用坐标点击外层输入框，再重新查询 `Target.getTargets`。
- **父页面导航后 OOPIF target 会消失。** 导航前缓存的 `iframe.targetId` 已失效。
- **即使已附加，CSP / sandbox 也可能阻止 `Runtime.evaluate` 产生副作用。** 只读调用通常正常；写操作可能静默失效。
- **不要 `use(iframe.targetId)` 之后忘了切回。** 下一次 `Page.navigate` 会作用于 iframe 而不是主 frame。务必配合 `session.use(parentTargetId)` 一起使用。
