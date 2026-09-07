# Browser Harness（browser-harness-ts）

从 LLM 到 Chrome 的完整操控平台，两层 API 一条守护进程：

1. **协议层**："协议即 API"，CDP 全部 56 域 652 方法带类型直调，无封装遮蔽（源自 [browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js) 的忠实移植）
2. **语义层**：[browser-harness-py](https://github.com/raystyle/browser-harness-py)（Python 版）同名 snake_case 助手，tab 纪律、等待判官、登录墙策略、自愈；97 站 domain-skills 知识库即插即用

**零运行时依赖**（Node ≥22 内置 WebSocket/fetch/sqlite）；长驻 daemon 持久会话；**附着用户自己打开的浏览器、人机共存**（永不 spawn，只在专属 tab 工作，Chrome 144+ 官方 auto-connect 通道）；插件应用生态（web-fetch / 搜索 / cookie-io / page-detect 页面诊断 / x-core X 监控全家桶）；只读网页看板；每动作一帧录制 + 视频合成。

## 能力矩阵

| 能力 | 命令 |
|---|---|
| CDP 协议直调 + 语义助手 | `bh '<js>'` |
| 诊断 | `bh doctor [--json]`（含「浏览器可附着」检查与开启指引） |
| 技能与资产分发 | `bh skill status/sync`（三线哈希防漂移、只增不删） |
| 抓取/搜索 | `bh web-fetch`、`bh google-search`（两步契约：`--top N` 出指标，`pluck gs_search` 取数）、`bh bing-search` |
| Cookie 迁移 | `bh cookie-io export/import` |
| X 监控 | `bh x-core [start]`（附着你的浏览器 + rmux 自愈监督）/ `bh x-core stop`（按序拆栈：supervisor -> worker -> 专属 daemon）/ `bh x-core search` / `bh x-core harvest`；`bh rmux` 看监督面状态（会话/pane 树） |
| 录制/视频 | `bh record …` -> `bh video init/export` |
| 状态探测 | `bh sessions`：对象模型（instance/browser/session/tab）+ 全实例清单 + 窗口分组 tab 表 + 新任务附着策略（专属 tab 铁律 / app 复用 / `--new-tab` 显式新开 / 用户 tab 显式授权） |
| 网页看板 | `bh dashboard`：只读看板 http://127.0.0.1:9870（SSE 推送）：守护实例/附着面/rmux 监督/worker 心跳/页面健康判定/事件流尾 |
| 显式新 tab | `bh --new-tab '<js>'`（新开 about:blank 附着执行） |
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

## 安装部署

要求 Node ≥ 22（原生 WebSocket 客户端）。三种安装方式按场景选：

### 方式一：git clone + 本地封板安装（当前推荐）

```bash
git clone https://github.com/raystyle/browser-harness.git
cd browser-harness
npm install            # 安装 devDependencies（typescript/esbuild）
npm run build          # tsc 编译到 dist/
npm pack               # 打出 browser-harness-ts-<版本>.tgz（拷贝式包）
npm install -g ./browser-harness-ts-*.tgz   # 全局安装真拷贝（不是 link）
rm browser-harness-ts-*.tgz
bh --version           # 验证：应输出 package.json 里的版本号
```

> **注意**：`npm install -g .` 在部分平台会创建符号链接而非拷贝，导致 BH_HOME 落到源码目录（dev checkout 判定）；`npm pack` + 安装 tarball 才是干净的安装态。

### 方式二：npm 安装（待发布到 npm registry）

```bash
npm install -g browser-harness-ts
```

### 方式三：开发模式（源码直跑）

```bash
git clone https://github.com/raystyle/browser-harness.git
cd browser-harness
npm install && npm run build && npm link
# 开发模式 BH_HOME 自动用 <repo>/.bh-dev，不污染安装态的用户目录
```

Windows 上 npm 自动创建 `.cmd`/`.ps1`/sh 三种 shim，cmd、PowerShell、git-bash 均可直接用 `bh`。

### 安装后初始化（用户数据目录）

安装态的 BH_HOME 固定为 `~/.config/browser-harness`（可用 `BH_HOME` 环境变量覆盖）。首次使用自动创建：

```
~/.config/browser-harness/
  browser-workspace/    # 应用（apps/）+ 站点知识（domain-skills/）+ SDK
  data/                 # 运行时数据（x_tweets.db、日志、心跳）
  runtime/              # 实例注册表（bh-<name>.port）
  tmp/                  # 日志
```

手动铺装应用与站点知识（也可跳过，首次调用自动铺）：

```bash
bh skill sync           # 铺装 workspace（apps + domain-skills + sdk，只增不删）
bh doctor               # 体检：可附着浏览器 / daemon / 资产一致性
```

### 浏览器附着开启（一次性）

bh 永不启动浏览器，它附着你自己打开的 Chrome（144+）：

1. 打开你的 Chrome，地址栏访问 `chrome://inspect/#remote-debugging`
2. 启用「Allow remote debugging for this browser instance」
3. 首次连接时 Chrome 会弹「Allow remote debugging?」确认框，点 Allow
4. 验证：`bh doctor` 应显示「browser attachable」

### 用作 agent 技能

安装后一键同步技能到 Claude Code 与 Codex：

```bash
bh skill sync
```

（手动路径：把 `skill/` 目录复制进 `~/.claude/skills/browser/`，技能名 `browser`。）

或者把下面这段直接粘给你的 agent，它会装好 CLI 并执行第一个任务：

```
Run `npm install -g browser-harness-ts`，确认 `bh --status` 可用，然后用
browser 技能驱动我的浏览器：查看我打开的所有标签页，按主题分组，
并截取最有意思的一个的截图。
```
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
- Chrome 136+ 拒绝在默认 user-data-dir 上启用 `--remote-debugging-port`。附着通道是官方 auto-connect：在你的 Chrome（144+）打开 `chrome://inspect/#remote-debugging`，启用「Allow remote debugging for this browser instance」；daemon 靠 profile 目录的 DevToolsActivePort 文件发现并 WS 直连（每条新连接 Chrome 弹一次 Allow）。
- 浏览器发现：扫描各 Chromium 默认 profile 目录的 DevToolsActivePort（Chrome Stable/Dev/Beta/Canary、Chromium、Brave、Arc、Vivaldi、Opera），按最近启动排序；**Edge 不在发现范围**。用 `BH_CDP_URL`/`BH_CDP_WS` 可钉死连接目标。
- 与原 curl 版 CLI 的已知差异：CLI 的 `fetch` 默认有约 5 分钟请求超时；确实需要更长的片段应改用带限时上界的 `session.waitFor`。

## 参与贡献

欢迎 PR。最好的贡献方式：当你摸索出某个冷门机制的 CDP 配方（某个下拉框框架、某个 shadow-DOM 陷阱、某种网络等待模式）时，**在 skill/interaction-skills/ 下新增一个交互技能**。

- 配方保持**纯 CDP**（`session.Domain.method(...)`），不做二次封装。
- 先给最短可用调用，再补充绕法或陷阱说明。
- 小而聚焦优于大而全。一个文件只讲一个机制。
- 缺陷修复、代码生成改进、`session.ts` 打磨同样欢迎。

## 许可证

MIT
