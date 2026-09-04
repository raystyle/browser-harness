# Dialogs

`alert`、`confirm`、`prompt`、`beforeunload` 会冻结 JS 线程。按时机不同有两种处理方式。

## 响应式：通过 CDP 处理（推荐）

即使 JS 已冻结也能工作。可处理全部四种 dialog 类型。

```js
await session.Page.enable()

// Dismiss / accept
await session.Page.handleJavaScriptDialog({ accept: true })               // "OK"
await session.Page.handleJavaScriptDialog({ accept: false })              // "Cancel"
await session.Page.handleJavaScriptDialog({ accept: true, promptText: 'hi' })  // for prompt()

// Wait for a dialog to open (and read its text)
const ev = await session.waitFor('Page.javascriptDialogOpening', undefined, 10_000)
console.log(ev.type, ev.message)  // "alert"|"confirm"|"prompt"|"beforeunload"
```

不会被反爬检测到——页面中不运行任何 JS。

**在流程执行期间订阅所有 dialog：**

```js
await session.Page.enable()
const off = session.onEvent(async (method, params) => {
  if (method === 'Page.javascriptDialogOpening') {
    await session.Page.handleJavaScriptDialog({ accept: true })
  }
})
// ...do actions that may trigger dialogs...
off()
```

## 主动式：用 JS 打桩

让 dialog 从一开始就无法出现。适合预期会有大量 `alert()` / `confirm()` 调用的场景。

```js
await session.Runtime.evaluate({ expression: `
  window.__dialogs__ = [];
  window.alert = m => window.__dialogs__.push(String(m));
  window.confirm = m => { window.__dialogs__.push(String(m)); return true; };
  window.prompt = (m, d) => { window.__dialogs__.push(String(m)); return d || ''; };
` })
// ...actions...
const { result } = await session.Runtime.evaluate({
  expression: 'window.__dialogs__ || []',
  returnByValue: true,
})
```

代价：
- 桩函数在页面导航后会丢失——每次导航后都要重新注入。
- `confirm()` 总是返回 `true`。
- 会被反爬检测到（`window.alert.toString()` 会暴露非原生代码）。
- **无法**处理 `beforeunload`。

## beforeunload 的专门处理

在离开含有未保存更改的页面（表单、编辑器）时触发。在用户点击 Leave 或 Stay 之前，页面会一直冻结。

```js
// Option A: dismiss after navigating (CDP, safe, undetectable)
await session.Page.navigate({ url: 'https://new-url.com' })
try {
  await session.Page.handleJavaScriptDialog({ accept: true })  // "Leave"
} catch { /* no dialog — normal */ }

// Option B: prevent before navigating (JS, detectable)
await session.Runtime.evaluate({ expression: 'window.onbeforeunload = null' })
await session.Page.navigate({ url: 'https://new-url.com' })
```
