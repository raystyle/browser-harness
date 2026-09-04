# 视口

坐标点击依赖视口大小；布局依赖视口大小；大量不稳定的自动化问题都能追溯到悄悄变化了的视口。

## 读取当前视口

```js
const { result } = await session.Runtime.evaluate({
  returnByValue: true,
  expression: `
    JSON.stringify({
      w: innerWidth, h: innerHeight,
      sx: scrollX, sy: scrollY,
      pw: document.documentElement.scrollWidth,
      ph: document.documentElement.scrollHeight,
      dpr: devicePixelRatio,
    })
  `,
})
const vp = JSON.parse(result.value)
```

`innerWidth`/`innerHeight` 是以 **CSS 像素**表示的视口 —— 坐标点击使用的就是它。`devicePixelRatio` 是实际屏幕像素的倍率（即 `captureScreenshot` 输出尺寸的依据）。

## 强制指定尺寸（CSS 像素）

```js
await session.Emulation.setDeviceMetricsOverride({
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,   // 0 = use real DPR; set to 2 for retina-like
  mobile: false,
})
```

后续所有 `Input.dispatchMouseEvent` 坐标都位于这个 1280×800 空间内 —— 在 session 开始时先固定它，坐标才能保持稳定。

清除覆盖，恢复实际窗口尺寸：

```js
await session.Emulation.clearDeviceMetricsOverride()
```

## 移动端模拟

```js
await session.Emulation.setDeviceMetricsOverride({
  width: 390, height: 844,
  deviceScaleFactor: 3,
  mobile: true,
})
await session.Emulation.setTouchEmulationEnabled({ enabled: true })
await session.Network.setUserAgentOverride({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
```

移动端模式会触发响应式断点并启用触摸事件。带 `@media (hover: hover)` 的站点还会关闭其 hover 交互提示。

## `w=0 h=0` 是 target 问题，不是视口问题

如果 `Runtime.evaluate('innerWidth')` 返回 0，说明你 attach 到了非窗口表面（omnibox 弹窗、某个 DevTools target）。见 `connection.md` / `tabs.md` —— 使用 `listPageTargets()` 并用 `session.use(...)` 重新路由。

## 陷阱

- **视口一变，坐标点击立即失准。** 任何 resize 之后都要重新用 `getBoundingClientRect()` 读取矩形，不只是滚动之后。
- **`captureScreenshot` 返回的是设备像素，不是 CSS 像素。** 如果 `devicePixelRatio = 2`，你在截图中目测到元素位于 (400, 300)，那么应在 CSS 像素 (200, 150) 处点击。
- **`setDeviceMetricsOverride` 在 session 内跨导航持续生效** —— 如果用户还要继续使用浏览器，记得在结束时清除。
- **部分站点会防御 resize 风暴**（例如 `window.addEventListener('resize', debounce)`）。在 `setDeviceMetricsOverride` 之后，等待约 300ms 再读取矩形或点击。
- **在页面加载时使用 `matchMedia` 的响应式站点**，在 override 之后可能不会重新求值断点。应在 `Page.navigate` **之前**应用 `setDeviceMetricsOverride`，而不是之后。
