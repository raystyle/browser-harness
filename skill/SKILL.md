---
name: browser
description: 用 JavaScript 通过 DevTools Protocol 驱动 Chrome 的完整平台。两层 API——协议层（652 个 CDP 方法全类型直调）与语义层（goto_url/js/click_at_xy/wait_for_render 等 snake_case 助手，tab 纪律、等待判官、自愈）。经 bh CLI 运行 JS 片段，长驻 Node daemon 持有持久会话，session、活动 target、全局变量跨调用保持。附着用户自己打开的浏览器（永不 spawn，专属 tab 铁律与人机共存）。含插件应用（web-fetch/google-search/cookies/x-core X 监控）、domain-skills 站点知识（97 站）、录制与视频导出。当用户想自动化、抓取、测试或检查浏览器时使用。
---

# browser：bh 平台技能

**两层 API，一个守护进程**：

1. **协议层**："协议即 API"，CDP 全部 56 域 652 方法带类型直调（`session.Page.navigate(...)`），无 click()/goto() 封装遮蔽
2. **语义层**：Python 版 browser-harness-py 同名 snake_case 助手（`goto_url` / `js` / `click_at_xy` / `fill_input` / `wait_for_render` …），预注入为裸全局名，domain-skills 97 站知识库里的 779 个示例**即插即用**

`bh` CLI 首次使用自动拉起长驻 daemon（Node ≥22，零运行时依赖）。

## 原语与结构（四层栈）

> 唯一权威源在 `skill/primitives/`（一原语一文件）；本节只做索引。

| 层 | 载体 | 内容 |
| --- | --- | --- |
| 原语层 | `skill/primitives/` | 交互契约：附着（attach，含可用操作面语义）/ 搜索 / 抓取分析 / 检测 / 可观测 |
| 机制层 | `skill/interaction-skills/` | 纯 CDP 配方（一文件一机制）：连接/对话框/iframe/shadow-DOM/上传/滚动… |
| 站点层 | domain-skills（`BH_DOMAIN_SKILLS=1` 挂载） | 97 站知识库：原语在具体站点的实例化 |
| 应用层 | workspace apps | 长跑业务（x-monitor / google-search / detect / web-fetch…）：原语的编排成品 |

**关闭边界（硬规则）**：只关自己开的 tab；绝不关用户 tab、绝不关闭/重塑附着的浏览器（程序级守卫在 Session 调用层，绕不过）。**授权粒度**：Chrome 许可按连接计，daemon 单长连 = 一天个位数弹窗。


## 登录墙

停下问用户。例外：Chrome 已登录的 SSO 可自动用；密码/MFA/consent/账号歧义仍必停。检测用 `detect_page_blocks()`（Cloudflare/captcha/墙词），被墙 ≠ 无结果：stderr 告警 + 返回 []。

## CLI 命令

| 命令 | 用途 |
|---|---|
| `bh '<js>'` / stdin | 片段求值（自动拉起 daemon） |
| `bh --status/--start/--stop/--restart/--logs` | daemon 生命周期 |
| `bh --version` | 版本 |
| `bh doctor [--json] [--require-existing-daemon]` | 诊断（attachable/daemon/connections/rmux/ffmpeg）；exit 0 <=> 可附着浏览器+daemon |
| `bh skill status\|sync` | 技能三线同步（CRLF 归一哈希防漂移）+ workspace 铺装（只增不删） |
| `bh record start\|stop\|enable\|disable\|status` | 每动作一帧录制 |
| `bh video init\|export\|review <dir>` | 帧序列 -> mp4（ffmpeg）/ HTML 幻灯片降级 |
| `bh sessions` | 对象模型 + 全实例清单 + 窗口分组 tab 表 + 附着策略 |
| `bh dashboard [start\|stop\|status]` | 只读网页看板（127.0.0.1:9870，SSE 每 2 秒推送）：守护实例/附着面/rmux 会话树/worker 心跳与日志尾/页面六判/事件流尾（peek 不清空）；macOS 风格 |
| `bh rmux` | rmux 监督面探测：安装/daemon 活性/会话与 pane 树（target/command/title/path） |
| `bh --new-tab '<js>'` | 显式新开 about:blank 附着执行 |
| `bh run <name> [args]` | 显式插件调用 |
| `bh <name> [args]` | 未知命令 = 插件路由 |

错误规约：`bh: <给 agent 的下一步指令>` 进 stderr + exit 1；usage 错误 exit 2。

## 内置插件（`<workspace>/apps/`）

- `bh web-fetch <url> [--browser|--current]`：HTTP 优先，三条件升级浏览器（空/墙词/正文<20 词）
- `bh page-detect [url片段]`：页面诊断（附着既有 tab，不开新页）：challenge-stuck / network-stalled / blocked / login-wall / blank / ok 六判 + 事件流证据（失败请求、4xx/5xx、挑战平台、墙词）+ 处置建议；报告恒小（固定形合约）
- `bh google-search <query> [--top N]`：两步契约搜索（第一步出指标落盘，`bh google-search pluck gs_search` 取数）；CAPTCHA 如实报不自动重试
- `bh bing-search <query>`：浏览器搜索 + 拦截检测 + 摘要
- `bh cookie-io export|import`：CDP 存取，默认拒绝全量导出（--domain/--all）
- `bh x-core [start]`：X 监控全家桶（附着用户浏览器 + rmux 自愈监督 + worker 心跳收割 + SQLite 去重库；无可附着浏览器时如实报指引）；`bh x-core stop|close` 按序拆栈（先杀 supervisor 防重拉，再杀 worker，再停专属 daemon）；用户关浏览器即监控暂停，supervisor 只重拉 worker
- `bh x-core search <kw>|--recent|--since 1h|--stats [--group-by day] [--csv]`：查本地库，不碰浏览器
- `bh x-core harvest <query> --from --to [--step 1d]`：时间分片全量收割（X 搜索固定供给窗 ~10-20 条，全量靠 since:/until: 分片）

**插件契约**：`<workspace>/apps/<name>.mjs` 导出 `main(argv, ctx)` 返回退出码；ctx 注入 `{helpers, browserHelpers}`。`<workspace>/browser_helpers.mjs` 的命名导出按名覆盖内置（合并不替换）。开发标准见 repo 的 G002/R002 文档。

## domain-skills（97 站知识库）

`BH_DOMAIN_SKILLS=1` 时 `goto_url()` 返回值附 `domain_skills` 文件名列表（≤10），**去通读匹配目录的全部 .md 再动手**。目录名 = hostname 去-www 首段（子域独立）。默认关。

## 录制与视频

`bh record enable` 后动作类 helper（点击/输入/滚动/导航/tab 操作）每动作一帧 JPEG + events.jsonl（URL 凭据自动 `<redacted>`、输入文本脱敏、文本截断 500）。`video init` 生成帧清单 sha256 锁；`video export` 校验 edit-brief（privacy.reviewed_frames 必须覆盖全部用帧）后合成，有 ffmpeg 出 mp4（隐私矩形 drawbox 烧入），没有出 HTML 幻灯片。

## 环境变量（常用）

`BH_HOME`（默认 ~/.config/browser-harness；dev checkout 自动用 `<repo>/.bh-dev`）、`BH_NAME`（多实例端口派生 9877+hash%120）、`BH_CDP_URL`/`BH_CDP_WS`（钉死连接目标）、`BH_IDLE_TIMEOUT`（daemon 空闲自退，默认 1800s；退出只关自身连接，不动用户浏览器）、`BH_RECORD`、`BH_DOMAIN_SKILLS`、`BH_IPC_TIMEOUT`/`BH_NAVIGATE_TIMEOUT`/`BH_SCREENSHOT_TIMEOUT`（5s/30s/60s）、`X_*`（监控族：X_INTERVAL/X_IDLE_THRESHOLD/X_FOREGROUND…）。

## 协议层速查

`session` 全局量挂全部 CDP 域；`listPageTargets()` / `resolveWsUrl()` / `detectBrowsers()` / `CDP` 类型命名空间；`session.onEvent(fn)` / `session.waitFor(method, pred, timeout)` 事件原语。完整类型面在包内 `dist/generated.d.ts`。

## 架构一图流

```
bh CLI ──HTTP /eval──> daemon（repl.ts：Harness + Session 单 WS）
  │                      ├─ 协议层 globals：session / CDP / …
  │                      ├─ 语义层 globals：goto_url / js / …（+workspace 覆盖）
  │                      └─ 空闲看门狗 / 陈旧 session 自愈 / 事件环形缓冲
  ├─ 插件进程（remoteHost 经 __bh_meta 复用同一 daemon）
  ├─ 用户的浏览器（附着：DevToolsActivePort 发现 + WS 直连 + Allow 许可）
  └─ rmux 监督链（x-supervisor → x-monitor worker → x_tweets.db）
```

## 陷阱速查（踩过的坑）

- 马标记是代理对+空格=**3 个 UTF-16 单元**，去标记 slice(3)
- `fill_input` 清空**不发 Ctrl+A**（char 事件会输入字面 a），内部已用 `commands:['SelectAll']`
- `new_tab` 先建 about:blank 再 goto（带 url 与 attach 竞速 -> readyState 假完成）
- 从未激活的 tab 收不了 Input 事件（会挂起），scroll/click 已内置激活重试
- Chrome 136+ 拒绝默认 profile 开调试端口；附着走 chrome://inspect/#remote-debugging 官方通道（144+），发现靠 DevToolsActivePort 文件（HTTP /json 系端点不服务）
- 录制开关三层：BH_RECORD env > recording.json > 关
