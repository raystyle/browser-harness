---
name: browser
description: 用 JavaScript 通过 DevTools Protocol 驱动 Chrome 的完整平台。两层 API——协议层（652 个 CDP 方法全类型直调）与语义层（goto_url/js/click_at_xy/wait_for_render 等 snake_case 助手，tab 纪律、等待判官、自愈）。经 bh CLI 运行 JS 片段，长驻 Node daemon 持有持久会话，session、活动 target、全局变量跨调用保持。含插件应用（web-fetch/google-search/cookies/x-monitor X 监控）、domain-skills 站点知识（97 站）、录制与视频导出、任务级浏览器隔离。当用户想自动化、抓取、测试或检查浏览器时使用。
---

# browser：bh 平台技能

**两层 API，一个守护进程**：

1. **协议层**："协议即 API"，CDP 全部 56 域 652 方法带类型直调（`session.Page.navigate(...)`），无 click()/goto() 封装遮蔽
2. **语义层**：Python 版 browser-harness-py 同名 snake_case 助手（`goto_url` / `js` / `click_at_xy` / `fill_input` / `wait_for_render` …），预注入为裸全局名，domain-skills 97 站知识库里的 779 个示例**即插即用**

`bh` CLI 首次使用自动拉起长驻 daemon（Node ≥22，零运行时依赖）。

## 何时不该用浏览器

纯 HTTP 能读的内容（公开页、API、文档）用 curl / fetch 工具即可，别动浏览器。需要交互（点击、输入、导航）、登录态、JS 渲染、反爬页面时才用本技能。直接抓取失败或返回壳页时再升级到浏览器。

## 使用

```bash
bh 'await goto_url("https://example.com"); return await js("document.title")'
bh <<'EOF'
const tabs = await list_tabs();
const t = tabs.find(t => t.url.includes("github.com"));
if (t) await switch_tab(t.targetId);       // 后台附着，不抢可见标签
EOF
```

输出规约：字符串裸输出 / 非空对象紧凑 JSON / `undefined`/空集合无输出；错误进 stderr + exit 1；**多语句片段必须显式 `return`**。跨调用状态挂 `globalThis`（session 与活动 target 由 daemon 保持）。

## tab 纪律（硬约束）

- 任务首次导航用 `new_tab(url)`，不是 `goto_url`（daemon 跨调用保持附着）
- **每任务/每站点一个工作 tab**：开新前先 `current_tab()`/`list_tabs()` 复用匹配的
- 不留同 URL 重复 tab；**不关不是自己开的 tab**
- `switch_tab()` 只做后台附着（马标记会移过去）；`activate_tab()` 只在用户点名或页面隐藏停渲染时调用
- 后台 tab 上 `scroll` 超时会自动激活重试一次（输入事件在从未激活的 tab 上会挂起，已机制化处理）

## 等待判官（优先级：element > render > load > network idle）

- `wait_for_element(selector, timeout, visible)`：0.3s 轮询 + checkVisibility 走祖先链
- `wait_for_render(timeout, stable_ms=400)`：MutationObserver + **setInterval 心跳**（静态页 rAF=0 会把稳定误判冻结）
- `wait_for_load(timeout)`：readyState 轮询；超时=未知，绝不写成失败
- `wait_for_network_idle(timeout, idle_ms)`：in-flight 集合按活动 session 过滤；长轮询/SSE 永不 idle；**idle ≠ 已渲染**

## 登录墙

停下问用户。例外：Chrome 已登录的 SSO 可自动用；密码/MFA/consent/账号歧义仍必停。检测用 `detect_page_blocks()`（Cloudflare/captcha/墙词），被墙 ≠ 无结果：stderr 告警 + 返回 []。

## CLI 命令

| 命令 | 用途 |
|---|---|
| `bh '<js>'` / stdin | 片段求值（自动拉起 daemon） |
| `bh --status/--start/--stop/--restart/--logs` | daemon 生命周期 |
| `bh --version` | 版本 |
| `bh doctor [--json] [--require-existing-daemon]` | 诊断（chrome/daemon/connections/rmux/ffmpeg）；exit 0 <=> chrome+daemon |
| `bh chrome start\|stop\|status` | agent 专属 Chrome（隔离 profile + 9223 + 抗节流 flags） |
| `bh chrome-mode on\|off\|status` | 有头/无头翻转（.env 为事实源） |
| `bh skill status\|sync` | 技能三线同步（CRLF 归一哈希防漂移）+ workspace 铺装（只增不删） |
| `bh record start\|stop\|enable\|disable\|status` | 每动作一帧录制 |
| `bh video init\|export\|review <dir>` | 帧序列 -> mp4（ffmpeg）/ HTML 幻灯片降级 |
| `bh sessions` | 对象模型 + 全实例清单 + 窗口分组 tab 表 + 附着策略 |
| `bh rmux` | rmux 监督面探测：安装/daemon 活性/会话与 pane 树（target/command/title/path） |
| `bh --new-tab '<js>'` | 显式新开 about:blank 附着执行 |
| `bh run <name> [args]` | 显式插件调用 |
| `bh <name> [args]` | 未知命令 = 插件路由 |
| `bh --once '<js>'` / `--batch <file>` | 任务级隔离（专属端口 + 克隆 profile + 用后拆除） |

错误规约：`bh: <给 agent 的下一步指令>` 进 stderr + exit 1；usage 错误 exit 2。

## 内置插件（`<workspace>/apps/`）

- `bh web-fetch <url> [--browser|--current]`：HTTP 优先，三条件升级浏览器（空/墙词/正文<20 词）
- `bh google-search <query> [--top N]`：两步契约搜索（第一步出指标落盘，`bh google-search pluck gs_search` 取数）；CAPTCHA 如实报不自动重试
- `bh bing-search <query>`：浏览器搜索 + 拦截检测 + 摘要
- `bh cookies export|import`：CDP 存取，默认拒绝全量导出（--domain/--all）
- `bh x-monitor [start]`：X 监控全家桶（agent Chrome + rmux 自愈监督 + worker 心跳收割 + SQLite 去重库）；`bh x-monitor stop|close` 按序拆栈（先杀 supervisor 防重拉，再杀 worker，再停专属 daemon）
- `bh x-search <kw>|--recent|--since 1h|--stats [--group-by day] [--csv]`：查本地库，不碰浏览器
- `bh x-harvest <query> --from --to [--step 1d]`：时间分片全量收割（X 搜索固定供给窗 ~10-20 条，全量靠 since:/until: 分片）

**插件契约**：`<workspace>/apps/<name>.mjs` 导出 `main(argv, ctx)` 返回退出码；ctx 注入 `{helpers, browserHelpers}`。`<workspace>/browser_helpers.mjs` 的命名导出按名覆盖内置（合并不替换）。开发标准见 repo 的 G002/R002 文档。

## domain-skills（97 站知识库）

`BH_DOMAIN_SKILLS=1` 时 `goto_url()` 返回值附 `domain_skills` 文件名列表（≤10），**去通读匹配目录的全部 .md 再动手**。目录名 = hostname 去-www 首段（子域独立）。默认关。

## 录制与视频

`bh record enable` 后动作类 helper（点击/输入/滚动/导航/tab 操作）每动作一帧 JPEG + events.jsonl（URL 凭据自动 `<redacted>`、输入文本脱敏、文本截断 500）。`video init` 生成帧清单 sha256 锁；`video export` 校验 edit-brief（privacy.reviewed_frames 必须覆盖全部用帧）后合成，有 ffmpeg 出 mp4（隐私矩形 drawbox 烧入），没有出 HTML 幻灯片。

## 环境变量（常用）

`BH_HOME`（默认 ~/.config/browser-harness；dev checkout 自动用 `<repo>/.bh-dev`）、`BH_NAME`（多实例端口派生 9877+hash%120）、`BH_CDP_URL`/`BH_CDP_WS`（钉死连接目标）、`BH_AGENT_CDP_PORT`（默认 9223）、`BH_CHROME_HEADLESS`、`BH_IDLE_TIMEOUT`（daemon 空闲自退，默认 1800s）、`BH_RECORD`、`BH_DOMAIN_SKILLS`、`BH_IPC_TIMEOUT`/`BH_NAVIGATE_TIMEOUT`/`BH_SCREENSHOT_TIMEOUT`（5s/30s/60s）、`X_*`（监控族：X_INTERVAL/X_IDLE_THRESHOLD/X_FOREGROUND…）。

## 协议层速查

`session` 全局量挂全部 CDP 域；`listPageTargets()` / `resolveWsUrl()` / `detectBrowsers()` / `CDP` 类型命名空间；`session.onEvent(fn)` / `session.waitFor(method, pred, timeout)` 事件原语。完整类型面在包内 `dist/generated.d.ts`。

## 架构一图流

```
bh CLI ──HTTP /eval──> daemon（repl.ts：Harness + Session 单 WS）
  │                      ├─ 协议层 globals：session / CDP / …
  │                      ├─ 语义层 globals：goto_url / js / …（+workspace 覆盖）
  │                      └─ 空闲看门狗 / 陈旧 session 自愈 / 事件环形缓冲
  ├─ 插件进程（remoteHost 经 __bh_meta 复用同一 daemon）
  ├─ agent Chrome（隔离 profile，继承老栈登录态）
  └─ rmux 监督链（x-supervisor → x-monitor worker → x_tweets.db）
```

## 陷阱速查（踩过的坑）

- 马标记是代理对+空格=**3 个 UTF-16 单元**，去标记 slice(3)
- `fill_input` 清空**不发 Ctrl+A**（char 事件会输入字面 a），内部已用 `commands:['SelectAll']`
- `new_tab` 先建 about:blank 再 goto（带 url 与 attach 竞速 -> readyState 假完成）
- 从未激活的 tab 收不了 Input 事件（会挂起），scroll/click 已内置激活重试
- Chrome 136+ 拒绝默认 profile 开调试端口；agent Chrome 用独立 user-data-dir
- 录制开关三层：BH_RECORD env > recording.json > 关
