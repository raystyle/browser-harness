# Browser Harness（browser-harness-ts）

从 LLM 到 Chrome 的完整操控平台，两层 API 一条守护进程：

1. **协议层**："协议即 API"，CDP 全部 56 域 652 方法带类型直调，无封装遮蔽（源自 [browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js) 的忠实移植）
2. **语义层**：[browser-harness-py](https://github.com/raystyle/browser-harness-py)（Python 版）同名 snake_case 助手，tab 纪律、等待判官、登录墙策略、自愈；97 站 domain-skills 知识库即插即用

**零运行时依赖**（Node ≥22 内置 WebSocket/fetch/sqlite）；长驻 daemon 持久会话；agent 专属 Chrome 隔离（继承老栈登录态）；插件应用生态（web-fetch / 搜索 / cookies / X 监控全家桶）；每动作一帧录制 + 视频合成；任务级浏览器隔离。

## 能力矩阵

| 能力 | 命令 |
|---|---|
| CDP 协议直调 + 语义助手 | `bh '<js>'` |
| 诊断 | `bh doctor [--json]` |
| 专属 Chrome 管理 | `bh chrome start/stop/status`、`bh chrome-mode on/off` |
| 技能与资产分发 | `bh skill status/sync`（三线哈希防漂移、只增不删） |
| 抓取/搜索 | `bh web-fetch`、`bh google-search`（两步契约：`--top N` 出指标，`pluck gs_search` 取数）、`bh bing-search` |
| Cookie 迁移 | `bh cookies export/import` |
| X 监控 | `bh x-monitor`（rmux 自愈监督）-> `bh x-search` / `bh x-harvest`；`bh rmux` 看监督面状态（会话/pane 树） |
| 录制/视频 | `bh record …` -> `bh video init/export` |
| 状态探测 | `bh sessions`：对象模型（instance/browser/session/tab）+ 全实例清单 + 窗口分组 tab 表 + 新任务附着策略（attach / app 复用 / `--new-tab` 显式新开 / `--once` 隔离栈） |
| 任务隔离 | `bh --once '<js>'`、`bh --batch <file>`、`bh --new-tab '<js>'`（显式新开 tab 执行） |
| 多实例 | `BH_NAME=<name> bh …`（端口自动派生） |

详细用法见技能文档（`skill/SKILL.md`，装到 `~/.claude/skills/browser/`）。


```
  ● agent：想点击一个按钮
  │
  ● 没有 click() 助手，没有 upload_file()，没有 goto()
  │
  ● agent 自己写 CDP 调用          await session.Input.dispatchMouseEvent({...})
  │                                await session.DOM.setFileInputFiles({...})
  ✓ 完成 —— 652 个方法全是同一个模式
```

**协议即 API。** Chrome 能做的，你就能调用。

## 安装

要求 Node ≥ 22（原生 WebSocket 客户端）。然后：

```bash
npm install -g browser-harness-ts      # 发布后
# 或从源码：
npm install && npm run build && npm link
```

这会把 `bh` CLI 装到 PATH（npm 在 Windows 上自动创建 `.cmd`/`.ps1`/sh 三种 shim，cmd、PowerShell、git-bash 均可直接使用）。

要用作 agent 技能，把 `skill/` 目录复制进你所用 agent 的技能目录（Claude Code：`~/.claude/skills/browser/`，技能名 `browser`）。

或者把下面这段直接粘给你的 agent，它会装好 CLI 并执行第一个任务：

```
Run `npm install -g browser-harness-ts`，确认 `bh --status` 可用，然后用
browser 技能驱动我的浏览器：查看我打开的所有标签页，按主题分组，
并截取最有意思的一个的截图。
```

如果 Chrome 弹出远程调试确认框，勾选即可，agent 就是通过它接入的。

冷门机制（光看 CDP 方法列表想不到的那些）见 interaction-skills/ 配方文档。

## 文件

- `skill/SKILL.md`：日常使用，如何连接、选标签页、调方法、跨调用保持状态
- `src/cli.ts`：`bh` CLI，自动拉起常驻 server 并转发代码片段
- `src/repl.ts`：Node HTTP server，持有一个持久 `Session`
- `src/session.ts`：`Session` 类，传输层、连接、target 路由、事件
- `scripts/gen.ts`：代码生成，读取 `protocol/browser_protocol.json` + `protocol/js_protocol.json` -> 生成带类型的封装
- `src/generated.ts`：每个 CDP 方法对应 `session.<Domain>.<method>(params)`（生成物；运行 `npm run gen` 再生成）

完整模块清单见 `INDEX.md` 第二节。

没有 helpers 文件。没有 `click()`、没有 `goto()`、没有 `upload_file()`，只有协议本身，带类型。

## 为什么不预置封装？

每个 helper 都是对 CDP 既有能力的遮蔽。`click(x, y)` 藏掉了 `Input.dispatchMouseEvent`，它有 14 个 LLM 可能用到的参数（button、clickCount、modifiers、pointerType、force、tangentialPressure……）。一个只暴露其中三个的 harness，等于悄悄限制了 agent 能做的事。

- **类型即文档**。敲 `session.Page.navigate(` 触发的自动补全就是精确的参数列表，与 CDP 官方参考的 JSDoc 一致。
- **没有版本漂移**。SDK 从上游协议 JSON 重新生成；换上新 JSON，新 Chrome 方法立刻可用。
- **没有"helper 覆盖不了我的场景"的绕路**。CDP 能做的，agent 就能直接调，类型安全、当天可用。

你唯一能找到的几个"helper"，都是 CDP 自身缺失的东西：

- `listPageTargets()`：从 `Target.getTargets` 里过滤掉 `chrome://` / `devtools://` 内部页
- `resolveWsUrl({wsUrl|port|profileDir})`：读取 `DevToolsActivePort`（兼容 Chrome 144+）
- `session.use(targetId)` / `session.waitFor(method, pred, timeout)`：真正需要的两个路由原语

## Windows 说明

- server 以分离进程方式拉起（`windowsHide`），不随启动它的终端退出；`bh --stop` 负责关停。
- 默认日志：`%TEMP%\bh.log`（用 `CDP_REPL_LOG` 覆盖）。
- Chrome 136+ 拒绝在默认 user-data-dir 上启用 `--remote-debugging-port`，自动化用途的实例要单独指定 `--user-data-dir`。
- 浏览器发现：Windows 扫描注册表（StartMenuInternet + App Paths），按 CDP 适用性排序（Chrome Dev > Beta/Canary > Chrome > Chromium > Brave > Edge）；装在非标准位置也能找到。用 `BH_CHROME_PATH` 钉死指定二进制。
- 与原 curl 版 CLI 的已知差异：CLI 的 `fetch` 默认有约 5 分钟请求超时；确实需要更长的片段应改用带限时上界的 `session.waitFor`。

## 参与贡献

欢迎 PR。最好的贡献方式：当你摸索出某个冷门机制的 CDP 配方（某个下拉框框架、某个 shadow-DOM 陷阱、某种网络等待模式）时，**在 skill/interaction-skills/ 下新增一个交互技能**。

- 配方保持**纯 CDP**（`session.Domain.method(...)`），不做二次封装。
- 先给最短可用调用，再补充绕法或陷阱说明。
- 小而聚焦优于大而全。一个文件只讲一个机制。
- 缺陷修复、代码生成改进、`session.ts` 打磨同样欢迎。

## 许可证

MIT
