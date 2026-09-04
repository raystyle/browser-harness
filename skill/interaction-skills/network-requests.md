# 网络请求

当 DOM 无法告诉你某个请求是否发生、发送了什么、返回了什么时，使用 `Network.*` 事件。需要拦截、修改或 mock 时，使用 `Fetch.*`。

## 监听请求

```js
await session.Network.enable({})

// React to every request
const off = session.onEvent((method, params) => {
  if (method === 'Network.requestWillBeSent') {
    console.log(params.request.method, params.request.url)
  }
  if (method === 'Network.responseReceived') {
    console.log(params.response.status, params.response.url)
  }
})

// ...do the action that should trigger the request...
off()
```

## 等待特定请求

`session.waitFor` 只返回第一个匹配事件的 params：

```js
await session.Network.enable({})
// (Trigger the action before awaiting, or trigger concurrently.)
const ev = await session.waitFor(
  'Network.responseReceived',
  (p) => p.response.url.includes('/api/submit') && p.response.status === 200,
  10_000
)
console.log(ev.response.status, ev.requestId)
```

## 读取响应体

`Network.getResponseBody` 需要 `requestId` —— 从对应事件中获取：

```js
const ev = await session.waitFor(
  'Network.responseReceived',
  (p) => p.response.url.endsWith('/me'),
  10_000
)
const { body, base64Encoded } = await session.Network.getResponseBody({ requestId: ev.requestId })
const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body
```

响应体并非总是可用 —— 如果响应是重定向、来自缓存，或 Chrome 已将其丢弃，`getResponseBody` 会抛出异常。请在 `Network.loadingFinished` 之后**立即**读取。

## 捕获请求体

`Network.requestWillBeSent` 会提供 `params.request.postData`（适用于较小的请求体）；较大的请求体请使用 `Network.getRequestPostData({ requestId })`。

## 拦截 / 修改 / mock（`Fetch` domain）

当需要修改请求的发送内容或返回结果时：

```js
await session.Fetch.enable({
  patterns: [{ urlPattern: '*/api/flag*', requestStage: 'Response' }],
})

session.onEvent(async (method, params) => {
  if (method === 'Fetch.requestPaused') {
    // Mock the response
    await session.Fetch.fulfillRequest({
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(JSON.stringify({ enabled: true })).toString('base64'),
    })
  }
})
```

针对单个请求的其他处理方式：
- `session.Fetch.continueRequest({ requestId })` —— 原样放行。
- `session.Fetch.continueRequest({ requestId, url, method, postData, headers })` —— 在传输过程中修改。
- `session.Fetch.failRequest({ requestId, errorReason: 'Failed' })` —— 模拟一次错误。

`Fetch.enable` 会为匹配的 URL 禁用 HTTP 缓存。用完之后请立即停用 `Fetch`。

## 低成本的 SPA "操作是否成功"信号

许多 SPA 在修改状态时不会带来可见的 DOM 变化。基于请求的等待是最干净的信号：

```js
await session.Network.enable({})
// click Save
await session.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
await session.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
await session.waitFor(
  'Network.responseReceived',
  (p) => p.response.url.includes('/save') && p.response.status === 200,
  10_000
)
```

## 陷阱

- **`Network.enable` 必须在请求发出之前调用。** 如果在点击之后才启用，就会错过事件。在 session 开始时启用一次，之后保持开启。
- **`Network.enable` 是按 target 生效的。** 在 `session.use(iframe.targetId)` 之后，需要在该 target 内重新调用 `Network.enable({})`。
- **请求 ID 只在单个 target 内唯一，不是全局唯一。** 不要把 iframe 的 `requestId` 传给主 frame 的 `getResponseBody` 调用。
- **`waitFor` 超时会 reject，而不是返回 `null`。** 如果不想在请求未发生时让整段脚本失败，请用 `try/catch` 包裹。
