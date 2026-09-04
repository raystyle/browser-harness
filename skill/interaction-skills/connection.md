# 连接与标签页可见性

## 直接调用 `session.connect()`

无需任何参数。它会扫描各操作系统特定的 profile 目录，找到所有正在运行的 Chromium 系浏览器（Chrome、Chromium、Edge、Brave、Arc、Vivaldi、Opera、Comet、Canary），选取最近启动且 WebSocket 接受连接的那一个并附加。失效端口和返回 403 拒绝权限的候选每个在 100ms 内即被跳过，因此整个循环很快。

```js
await session.connect()
```

用 `detectBrowsers()` 查看有哪些可用浏览器（例如让用户选择）：

```js
const browsers = await detectBrowsers()
// [{ name: 'Google Chrome', profileDir, port, wsPath, wsUrl, mtimeMs }, ...]
```

### 显式指定（覆盖自动检测）

仅当自动检测选错了浏览器，或你已明确知道目标时才使用。

| 形式 | 适用场景 |
|---|---|
| `{ profileDir }` | 定位某个正在运行的特定浏览器。直接读取其 `DevToolsActivePort`。与操作系统无关。 |
| `{ wsUrl }` | 你已经拿到了 `ws://…/devtools/browser/<uuid>`。 |

```js
await session.connect({ profileDir: '/Users/<you>/Library/Application Support/Google/Chrome' })
await session.connect({ wsUrl: 'ws://127.0.0.1:9222/devtools/browser/<uuid>' })
```

### 超时与 Allow 弹窗

每个候选的 WebSocket 打开超时默认为 **5 秒**。运行中的浏览器会在约 100ms 内要么建立连接要么关闭连接，所以 5 秒总是足够——除非用户需要在 Chrome 的远程调试弹窗上点击 **Allow**。这种情况请传入 `timeoutMs: 30000` 给用户留出时间：

```js
await session.connect({ profileDir, timeoutMs: 30_000 })
```

如果 `session.connect()` 报告 `No detected browser accepted a connection`，说明所有带 `DevToolsActivePort` 的浏览器要么返回 403，要么未建立连接就关闭了——最可能的原因是用户还没点击 Allow。请让用户点击后重试。

## omnibox popup 问题

Chrome 刚启动时，CDP 中 `type: "page"` 的 target 可能只有 `chrome://inspect` 和 `chrome://omnibox-popup.top-chrome/`（一个 1px 的不可视视口）。如果附加到 omnibox popup，后续所有操作都会发生在一个用户看不见的标签页上。

`listPageTargets()` 已过滤掉 `chrome://` 和 `devtools://` 的 URL。如果直接调用 `Target.getTargets`，需要手动过滤：

```js
const { targetInfos } = await session.Target.getTargets({})
const realTabs = targetInfos.filter(t =>
  t.type === 'page' &&
  !t.url.startsWith('chrome://') &&
  !t.url.startsWith('devtools://')
)
```

如果还没有真实页面，就创建一个，而不是附加到空目标上：

```js
const tabs = await listPageTargets()
let targetId = tabs[0]?.targetId
if (!targetId) {
  ({ targetId } = await session.Target.createTarget({ url: 'about:blank' }))
}
await session.use(targetId)
```

## 启动流程

1. `await session.connect()` — 自动检测正在运行的浏览器。
2. `const tabs = await listPageTargets()` — 查看存在哪些真实页面。
3. `await session.use(tabs[0].targetId)` — 把 Page/DOM/Runtime/Network 调用路由到该 target。
4. `await session.Target.activateTarget({ targetId: tabs[0].targetId })` — 把该标签页置前显示。
5. 启用所需的 domain：`await session.Page.enable()`、`await session.Network.enable({})` 等。

## CDP target 顺序 ≠ 可见标签栏顺序

当用户说"我能看到的第一个标签页"时，不要相信 `Target.getTargets` 的顺序。应使用：

- 截图（`session.Page.captureScreenshot()`）进行视觉识别。
- 页面标题 / URL 启发式判断。
- 或平台 UI 自动化（macOS：AppleScript；Linux：`xdotool`/`wmctrl`）。

`Target.activateTarget` 只能切换到你已知的 targetId——它无法解析"最左边的标签页"。

## 把 Chrome 置前

```bash
# macOS — prefer AppleScript over `open -a` (reuses current profile, avoids the profile picker)
osascript -e 'tell application "Google Chrome" to activate'

# Linux (X11) — use wmctrl or xdotool
wmctrl -a 'Google Chrome'
xdotool search --name 'Google Chrome' windowactivate

# Windows (PowerShell)
powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate('Google Chrome')"
```
