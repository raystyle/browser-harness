# 标签页

用 **CDP 做控制**（attach、激活已知 target、检查）。用 **UI 自动化获取可见顺序**。

## 纯 CDP

```js
// List page targets (filtered; chrome:// / devtools:// dropped)
const tabs = await listPageTargets()

// Create a new tab and route subsequent calls to it
const { targetId } = await session.Target.createTarget({ url: 'https://example.com' })
await session.use(targetId)

// Switch: route calls to another existing tab
await session.use(otherTargetId)

// Show this tab visibly in Chrome (different from `session.use` — which is CDP routing only)
await session.Target.activateTarget({ targetId })

// Close a tab
await session.Target.closeTarget({ targetId })

// What tab is session.use currently pointing at?
const { targetInfo } = await session.Target.getTargetInfo({ targetId })
```

**`session.use` 是 CDP 侧的路由；`Target.activateTarget` 是 Chrome 侧的聚焦。** 二者相互独立。如果用户希望 Chrome 画面可见地变化，也要调用 `activateTarget`。

## `Target.createTarget` 悄悄做错的两件事

1. **竞态：`createTarget` 中的 `{ url }` 可能在导航开始前就 resolve。** 此时如果轮询 `document.readyState`，会看到 about:blank 返回 `'complete'`，于是直接往下走。更稳妥的做法：
   ```js
   const { targetId } = await session.Target.createTarget({ url: 'about:blank' })
   await session.use(targetId)
   await session.Page.enable()
   await session.Page.navigate({ url: 'https://example.com' })
   // now wait for Page.loadEventFired via session.waitFor
   ```

2. **新标签页可能在当前活动标签页后面打开。** 如果用户需要看到它，加上 `Target.activateTarget`。

## 可见的标签条顺序（平台 UI）

CDP 的 `Target.getTargets` 返回的顺序是任意的 —— 不是从左到右。

### macOS

```applescript
tell application "Google Chrome"
  set out to {}
  set i to 1
  repeat with t in every tab of front window
    set end of out to {tab_index:i, tab_title:(title of t), tab_url:(URL of t)}
    set i to i + 1
  end repeat
  return out
end tell
```

```applescript
tell application "Google Chrome"
  set active tab index of front window to 2
  activate
end tell
```

### Linux

没有 AppleScript。使用 `xdotool`、`wmctrl` 或桌面环境脚本。分工方式相同 —— CDP 负责 attach / 按 id 激活，窗口管理器负责可见顺序。

## 陷阱

- `listPageTargets()` 已经过滤掉 `chrome://` 和 `devtools://`。如果直接调用 `Target.getTargets`，必须自己过滤，否则你会 attach 到一个 1 像素大的 omnibox 弹窗。
- 如果某个页面报告 `innerWidth=0 innerHeight=0`，你很可能 attach 到了非窗口表面（omnibox 弹窗、从未渲染过的后台标签页）。
