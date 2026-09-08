# Browser Harness（browser-harness-ts）

从 LLM 到 Chrome 的完整操控平台，两层 API 一条守护进程：

1. **协议层**："协议即 API"，CDP 全部 56 域 652 方法带类型直调，无封装遮蔽（源自 [browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js) 的忠实移植）
2. **语义层**：[browser-harness-py](https://github.com/raystyle/browser-harness-py)（Python 版）同名 snake_case 助手，tab 纪律、等待判官、登录墙策略、自愈；94 站 domain-skills 知识库即插即用

**运行时依赖白名单制**（仅 commander 与 zod 两项，其余全用 Node ≥22 内置 WebSocket/fetch/sqlite）；长驻 daemon 持久会话；**附着用户自己打开的浏览器、人机共存**（永不 spawn，只在专属 tab 工作，Chrome 144+ 官方 auto-connect 通道）；插件应用生态（web-fetch / 搜索 / cookie-io / page-detect 页面诊断 / super-ocr 验证码图识别 / x-intel X 监控全家桶）；只读网页看板；每动作一帧录制 + 视频合成。

## 能力矩阵

| 能力 | 命令 |
|---|---|
| CDP 协议直调 + 语义助手 | `bh '<js>'` |
| 诊断 | `bh doctor [--json]`（含「浏览器可附着」检查与开启指引） |
| 技能与资产分发 | `bh skill status/sync`（三线哈希防漂移、只增不删） |
| 抓取/搜索 | `bh web-fetch`、`bh google-search`（两步契约：`--top N` 出指标，`pluck gs_search` 取数）、`bh medium-search`（站内搜索 + `grab <url>` 文章转 markdown，两步契约 `ms_search`/`ms_article`）、`bh bing-search`（两步契约：`--top N` 出指标，`pluck bs_search` 取数） |
| Cookie 迁移 | `bh cookie-io export/import` |
| X 监控 | `bh x-intel [start]`（附着你的浏览器，worker 在 rmux `x-monitor`，start 自动带起 supervisor-core 守护）/ `bh x-intel stop`（先写 stopped 再杀 worker 与专属 daemon）/ `bh x-intel search` / `bh x-intel harvest` |
| 录制/视频 | `bh record …` -> `bh video init/export` |
| 状态探测 | `bh sessions`：对象模型（instance/browser/session/tab）+ 全实例清单 + 窗口分组 tab 表 + 新任务附着策略（专属 tab 铁律 / app 复用 / `--new-tab` 显式新开 / 用户 tab 显式授权） |
| 网页看板 | `bh dashboard`：只读看板 http://127.0.0.1:9870（SSE 每秒推送）：守护实例/附着面/rmux 监督/worker 心跳/页面健康判定/常驻应用卡片区（描述/运行流水/日志行/库存，折叠拖拽）；墙类判定（含 Google 验证/Cloudflare 挑战/白屏持久化/资源阻断）经已授权源弹 Chrome 系统通知（requireInteraction 驻留）；部署信息栏默认隐藏；页面版本握手自动重载。看板不是工作 tab，default 与应用禁止附着 |
| 页面守护 | `bh page-detect watch [--interval S]`：常驻只读探测全部页面，墙类边沿、白屏持久化（连续 2 轮）自动告警；`--interval` 持久化，守护重拉沿用（`unwatch` 停、`status` 查）；单次诊断 `bh page-detect [url片段]` 七判保留 |
| 验证码图 OCR | `bh super-ocr [url片段]`：扫描当前页定位验证码图片并识别（不填写）；`locate` 只定位；`setup` 安装 ppu-paddle-ocr 到 `<BH_HOME>/ocr`；交互式拼图/滑块报 CAPTCHA\|WALL |
| 初始化 | 首次使用判系统环境自动带起：默认浏览器守护 + rmux 守护 + 看板 + page-detect watch + supervisor-core（幂等；Node ≥22 版本闸）。page-detect 使用独立实例，首次会多弹一次 Chrome Allow |
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

## 内置应用

一次性应用经 default 守护进程执行；常驻应用住 rmux 会话、由 supervisor-core 统一守护，状态在 `bh dashboard` 的「应用」卡片区可见。墙与人机验证一律如实报告，不硬闯。

| 应用 | 命令 | 说明 |
|---|---|---|
| web-fetch | `bh web-fetch <url> [--markdown\|--text] [--browser]`，或 `--current` 抓当前页 | 抓取网页正文，必要时自动升级为真实浏览器渲染 |
| google-search | `bh google-search <query> [--top N]`，再 `pluck [cache]` 取数 | 谷歌搜索：两步契约（指标先落盘、取数恒小）；CAPTCHA/墙如实报不重试 |
| bing-search | `bh bing-search <query> [--top N] [--page N]`，再 `pluck [cache]` | 必应搜索：同两步契约，常驻 `__bs` SDK + 就绪判官 |
| medium-search | `bh medium-search <query> [--top N]`；`grab <url> [--out file]` | Medium 站内搜索 + 文章正文转 Markdown（两步契约 `ms_search`/`ms_article`） |
| cookie-io | `bh cookie-io export\|import`（默认按域名，`--domain`/`--all` 控制） | 迁移浏览器 Cookie 登录态；默认拒绝全量导出 |
| page-detect | `bh page-detect [url片段]`；`watch [--interval S]` / `unwatch` / `status` | 单次诊断七判；watch 常驻只读探测全部 http(s) 页面，墙类边沿告警、白屏连续 2 轮才告警；`--interval` 持久化，守护与 companions 重拉沿用 |
| super-ocr | `bh super-ocr [url片段] [--top N] [--save]`；`locate` / `setup` / `ready` | 扫描页面定位验证码图并用 PaddleOCR 识别（不自动填写）；交互式拼图/滑块报 CAPTCHA\|WALL；引擎按需装到 `<BH_HOME>/ocr` |
| x-intel | `bh x-intel start` / `stop` / `search <kw>` / `harvest` | X 时间线持续监控，自动收割新帖到本地 SQLite（`data/x_tweets.db`）；worker 住 rmux `x-monitor`，`start` 自动带起 supervisor-core；专属 `BH_NAME=x-intel` daemon，不占 default |
| supervisor-core | 常驻，随 default 守护进程自动拉起（无需手动） | 统一守护常驻应用：会话消失、心跳超时、无心跳挂死自动重启；`data/<name>.status.json` 的 `stopped` 状态被尊重；按需应用（x-intel）未启动不拉起 |

## 安装部署

要求 Node ≥ 22（原生 WebSocket 客户端）。三种安装方式按场景选：

### 方式一：git clone + 本地封版安装（当前推荐）

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

### 方式二：GitHub Release 下载 tgz 安装（免 clone 源码）

从 [Releases](https://github.com/raystyle/browser-harness/releases) 下载 `browser-harness-ts-<版本>.tgz` 附件后：

```bash
npm install -g ./browser-harness-ts-0.4.0.tgz
bh --version   # -> 0.4.0
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
bh skill sync --yes      # 铺装 workspace（apps + domain-skills + sdk，只增不删；默认 dry-run，--yes 执行）
bh doctor               # 体检：可附着浏览器 / daemon / 资产一致性
```

### 配置（环境变量）

全部有默认值，零配置可用；按需覆盖：

| 变量 | 作用 | 默认 |
|---|---|---|
| `BH_HOME` | 用户数据根目录（workspace/data/runtime/tmp 都在它下面） | `~/.config/browser-harness` |
| `BH_NAME` | 实例名，多实例端口自动派生 | `default` |
| `BH_DASHBOARD_PORT` | 只读看板端口 | `9870` |
| `BH_CDP_URL` / `BH_CDP_WS` | 钉死连接目标（`/json/version` HTTP 或 WS 直连） | 自动发现可附着浏览器 |
| `BH_ATTACH_URL_MATCH` | 应用 daemon 钉住既有页面（不新建 tab） | 未设 |
| `BH_IDLE_TIMEOUT` | daemon 空闲自退秒数（只关自身连接，不动浏览器） | `1800` |
| `BH_EVAL_TIMEOUT` | CLI 单次求值秒数；超时后求值可能仍在 daemon 上，期间新 eval 被拒（429） | `300` |
| `BH_IPC_TIMEOUT` / `BH_NAVIGATE_TIMEOUT` / `BH_SCREENSHOT_TIMEOUT` | CDP 调用 / 导航 / 截图的秒级预算 | `5` / `30` / `60` |
| `BH_DOMAIN_SKILLS` | 站点知识目录覆盖 | workspace 内 `domain-skills/` |
| `X_RMUX_SESSION` 等 `X_*` | x-intel 族调优 | `x-monitor` 等 |
| `CDP_REPL_PORT` / `CDP_REPL_LOG` | 旧名兼容：daemon 端口 / 日志路径 | 派生 / `%TEMP%\bh.log` |

### 浏览器附着开启（一次性）

bh 永不启动浏览器，它附着你自己打开的 Chrome（144+）：

1. 打开你的 Chrome，地址栏访问 `chrome://inspect/#remote-debugging`
2. 启用「Allow remote debugging for this browser instance」
3. 首次连接时 Chrome 会弹「Allow remote debugging?」确认框，点 Allow
4. 验证：`bh doctor` 应显示「browser attachable」

### 用作 agent 技能

安装后一键同步技能到 Claude Code 与 Codex：

```bash
bh skill sync --yes
```

（手动路径：把 `skill/` 目录复制进 `~/.claude/skills/browser/`，技能名 `browser`。）

或者把下面这段直接粘给你的 agent，它会装好 CLI 并执行第一个任务：

```
Run: 从 https://github.com/raystyle/browser-harness/releases 下载 browser-harness-ts-0.4.0.tgz，`npm install -g ./browser-harness-ts-0.4.0.tgz`，确认 `bh --status` 可用，然后用
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
- `src/helpers.ts`：语义层 snake_case 助手（与 Python 主仓同名同参）
- `src/dashboard.ts`：只读网页看板（127.0.0.1:9870）
- `scripts/gen.ts`：代码生成，读取 `protocol/browser_protocol.json` + `protocol/js_protocol.json` -> 生成带类型的封装
- `src/generated.ts`：每个 CDP 方法对应 `session.<Domain>.<method>(params)`（生成物；运行 `npm run gen` 再生成）

完整模块清单见 `INDEX.md` 第二节。

协议层没有 `click()`、没有 `goto()`、没有 `upload_file()`，只有协议本身，带类型；语义层（`goto_url` / `js` / `click_at_xy` / `wait_for_render` 等）是 Python 主仓的忠实移植，两层并存。

## 为什么不预置封装？

（这一节说的是协议层。语义层助手是跨语言忠实移植、与 Python 版同名同参，不是新发明的封装。）

每个 helper 都是对 CDP 既有能力的遮蔽。`click(x, y)` 藏掉了 `Input.dispatchMouseEvent`，它有 14 个 LLM 可能用到的参数（button、clickCount、modifiers、pointerType、force、tangentialPressure……）。一个只暴露其中三个的 harness，等于悄悄限制了 agent 能做的事。

- **类型即文档**。敲 `session.Page.navigate(` 触发的自动补全就是精确的参数列表，与 CDP 官方参考的 JSDoc 一致。
- **没有版本漂移**。SDK 从上游协议 JSON 重新生成；换上新 JSON，新 Chrome 方法立刻可用。
- **没有"helper 覆盖不了我的场景"的绕路**。CDP 能做的，agent 就能直接调，类型安全、当天可用。

协议层里仅有的几个便利原语，都是 CDP 自身缺失的东西：

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
