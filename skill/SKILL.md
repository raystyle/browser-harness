---
name: browser
description: 用 JavaScript 通过 DevTools Protocol 驱动 Chrome 的完整平台。两层 API——协议层（652 个 CDP 方法全类型直调）与语义层（goto_url/js/click_at_xy/wait_for_render 等 snake_case 助手，tab 纪律、等待判官、自愈）。经 bh CLI 运行 JS 片段，长驻 Node daemon 持有持久会话，session、活动 target、全局变量跨调用保持。附着用户自己打开的浏览器（永不 spawn，专属 tab 铁律与人机共存）。含插件应用（web-fetch/google-search/medium-search/bing-search/cookie-io/page-detect/x-intel X 监控）、domain-skills 站点知识（94 站）、录制与视频导出。当用户想自动化、抓取、测试或检查浏览器时使用。
---

# browser：bh 平台技能

> 本文是**总览 + 意图路由**：按意图找到入口，再按渐进层级下钻细节。
> 细节唯一权威源：原语在 `primitives/`，机制在 `interaction-skills/`，站点在 domain-skills，应用在 workspace apps。

**两层 API，一个守护进程**：协议层 652 方法带类型直调（`session.Page.navigate(...)`，无封装遮蔽）+ 语义层 snake_case 助手（`goto_url` / `js` / `click_at_xy` / `wait_for_render`，预注入裸全局名）。`bh` CLI 首次使用自动拉起长驻 daemon（Node ≥22，零运行时依赖），附着**用户自己打开的浏览器**（永不 spawn，专属 tab 铁律，人机共存）。初始化：使用前判系统环境（Node 版本闸），daemon（重）生时幂等带起看板、rmux 守护、page-detect watch、supervisor-core（fire-and-forget，不动既有附着）。page-detect 使用独立实例，首次会多弹一次 Chrome Allow。

## 意图路由（想做什么 -> 用什么）

| 意图 | 入口 | 细节下钻 |
| --- | --- | --- |
| 打开/操作某网站 | `bh '<js>'` + `goto_url` / `new_tab` / `switch_tab` | `primitives/attach.md`；该站的 domain-skill（见站点索引） |
| 看现在能操作哪些网页 | `bh sessions`；看板 `bh dashboard` | `primitives/observability.md` |
| 搜东西 | `bh google-search <q> --top N` / `bh bing-search <q> --top N`（两步契约） | `primitives/search.md` |
| 抓取并分析某页内容 | `bh web-fetch <url>`（HTTP 优先三条件升级浏览器） | `primitives/fetch-analyze.md` |
| 页面打不开/登不上/空白 | `bh page-detect [url片段]`（七判 + 证据 + 建议） | `primitives/detect.md` |
| 迁移登录态 | `bh cookie-io export\|import` | 应用层 |
| 监控 X / 查收割库 | `bh x-intel start\|stop` / `x-intel search\|harvest` | 应用层 |
| 冷门交互（下拉/shadow-DOM/拖拽…） | 直接写 CDP，先查配方 | `interaction-skills/<机制>.md` |
| 诊断环境 | `bh doctor [--json]` | `primitives/observability.md` |
| 录制与视频 | `bh record …` / `bh video init/export` | 本文「录制与视频」节 |

**硬边界（程序级强制）**：只关自己开的 tab；绝不关用户 tab、绝不关闭/重塑附着的浏览器。守卫在 Session 调用层，`session.domains.Browser.close()` 也被拦。看板 `http://127.0.0.1:9870` 不是工作 tab：default 与应用禁止 attachFirstPage / goto_url / switch_tab / new_tab 附着它；请在 Chrome 里自己打开看板。

## 渐进层级（按需下钻，不必通读）

| 层 | 何时读 | 载体 |
| --- | --- | --- |
| L0 命令速查 | 每次用 | 本文下方 CLI 表 |
| L1 原语契约 | 用到该原语时 | `primitives/attach.md` `search.md` `fetch-analyze.md` `detect.md` `observability.md` |
| L2 CDP 机制 | 写协议调用遇到冷门交互时 | `interaction-skills/`（一文件一机制，17 篇） |
| L3 站点知识 | 目标站在索引中时 | `BH_DOMAIN_SKILLS=1` 后 `goto_url()` 返回清单 -> **通读该站全部 .md 再动手** |
| L4 长跑应用 | 用 x-intel / 搜索 / 抓取 / 诊断 / cookie 迁移时 | 本文「应用」节 + workspace/apps/ |

## CLI 命令（L0 速查）

| 命令 | 用途 |
|---|---|
| `bh '<js>'` / stdin | 片段求值（自动拉起 daemon） |
| `bh --status/--start/--stop/--restart/--logs` | daemon 生命周期 |
| `bh doctor [--json]` | 诊断：可附着浏览器 / daemon / 资产一致性 |
| `bh sessions` | 实例清单 + 窗口分组 tab 表 + 附着策略 |
| `bh dashboard [start\|stop\|status]` | 只读看板 127.0.0.1:9870（SSE 推送；墙类弹 Chrome 系统通知 D16/D18；独立应用卡片区 D17：描述/运行流水/日志行/库存 + 折叠拖拽；部署信息栏默认隐藏；页面版本握手自动重载） |
| `bh rmux` | rmux 监督面：会话/pane 树 |
| `bh --new-tab '<js>'` | 显式新开 about:blank 附着执行 |
| `bh run <name>` / `bh <name>` | 显式/路由调用应用 |
| `bh skill status\|sync` | 技能三线同步 + workspace 铺装 |
| `bh record …` / `bh video …` | 录制与视频导出 |

错误规约：`bh: <给 agent 的下一步指令>` 进 stderr + exit 1；usage 错误 exit 2。

## 应用（L4：workspace/apps/）

- `bh web-fetch <url>`：HTTP 优先，空/墙词/正文<20 词三条件升级浏览器
- `bh google-search <q> [--top N]`：两步契约（指标落盘，`pluck gs_search` 取数）；CAPTCHA 如实报
- `bh medium-search <q> [--top N] | grab <url> [--out F] | pluck [ms_search|ms_article] | ready`：medium 站内搜索与文章抓取（两步契约 cache `ms_search`/`ms_article`；正文走 DOM 提取，因 CF 对页内 `?format=json` 连续请求挂起；遇墙 CAPTCHA|WALL 如实报 exit 2）
- `bh bing-search <q> [--top N] [--page N]`：两步契约（指标落盘，`pluck bs_search` 取数）；CAPTCHA 如实报不重试；`--limit` 等同 `--top`
- `bh page-detect [url片段]`：页面诊断七判 + 事件证据 + 建议
- `bh page-detect watch [--interval S] | unwatch | status`：通用页面守护（D18）：常驻只读探测附着浏览器全部 http(s) 页面，墙类边沿（含白屏持久化、资源被 CF 阻断）自动告警，通知经看板已授权源弹出；状态落 data/page-watch.json
- `bh cookie-io export|import`：CDP 存取，默认拒绝全量导出（--domain/--all）
- `bh x-intel [start|stop]`：X 监控（附着浏览器 + rmux 自愈监督 + SQLite 去重库；关浏览器即暂停，只重拉 worker）
- `bh x-intel search <kw>|--recent|--since|--stats`：查本地库，不碰浏览器；JSON `{_ok,_v,_ts,count,items}`（`--csv` 仍出 CSV）
- `bh x-intel harvest <q> --from --to`：时间分片全量收割；完成打指标 `{_ok,inserted,slices,db}`

**插件契约**：`apps/<name>.mjs` 导出 `main(argv, ctx)` 返回退出码；ctx 注入 `{helpers, browserHelpers}`；`browser_helpers.mjs` 命名导出按名覆盖内置。开发标准见 repo 的 G002/R002。

## workspace 索引（`~/.config/browser-harness`）

```
browser-workspace/          应用与资产运行面
  apps/                     七应用 + x-intel/ 组件目录
  browser_helpers.mjs       站点级助手（可覆盖）
  domain-skills/            94 站知识库（只增不删）
  sdk/                      页面常驻 SDK
data/                       运行时数据：x_tweets.db / 日志 / 心跳 / 录制
runtime/                    实例注册表 bh-<name>.port
```

## domain-skills 站点索引（94 站）

aa, agentlist, alaska, amazon, archive-org, articulate-rise, arxiv, arxiv-bulk, atlas, bigbang-hr, bilibili, booking-com, BOSS-zhipin, capterra, centilebrain, claude-ai, coingecko, coinmarketcap, coursera, craigslist, crossref, ctrip, dev-to, duckduckgo, ebay, etsy, eventbrite, expedia, facebook, flipkart, framer, fred, g2, genius, github, glassdoor, gmail, goodreads, gutenberg, hackernews, howlongtobeat, hubspot, imdb, itch-io, job-boards, letterboxd, linkedin, loom, ly-com, macrotrends, manus, medium, metacritic, musicbrainz, nasa, news-aggregation, openalex, open-library, openstreetmap, package-registries, perplexity, polymarket, producthunt, pubmed, qbo, quora, rawg, reddit, rest-countries, sec-edgar, shopify-admin, soundcloud, spotify, stackoverflow, steam, substack, tasksquad-ai, thetechgeeks, tiktok, tradingview, trello, trustpilot, vercel, walmart, wayback-machine, weather, wehotel, wellfound, weread, world-bank, x, xiaohongshu, youtube, zillow

目录名 = hostname 去 www 首段；未列出 = 无既存知识，走 interaction-skills 通用配方。

## 登录墙

停下问用户。例外：Chrome 已登录的 SSO 可自动用；密码/MFA/consent/账号歧义必停。检测用 `detect_page_blocks()`；被墙 ≠ 无结果：stderr 告警 + 返回 []。

## 语义层速查

`goto_url` `js` `click_at_xy` `fill_input` `press_key` `type_text` `scroll` `upload_file` `dispatch_key` / `list_tabs` `current_tab` `switch_tab` `new_tab` `close_tab` `ensure_real_tab` `iframe_target` / `wait_for_element` `wait_for_render` `wait_for_load` `wait_for_network_idle` / `capture_screenshot` `http_get` `run_app`。等待判官优先级：element > render > load > network idle。

## 协议层速查

`session` 全局量挂全部 CDP 域；`listPageTargets()` / `resolveWsUrl()` / `detectBrowsers()` / `session.onEvent(fn)` / `session.waitFor(method, pred, timeout)`。完整类型面在包内 `dist/generated.d.ts`。

## 环境变量（常用）

`BH_HOME`（默认 ~/.config/browser-harness）、`BH_NAME`（多实例端口派生）、`BH_CDP_URL`/`BH_CDP_WS`（钉死连接目标）、`BH_ATTACH_URL_MATCH`（应用钉面）、`BH_IDLE_TIMEOUT`（daemon 空闲自退，只关自身连接）、`BH_DOMAIN_SKILLS`、`BH_IPC/NAVIGATE/SCREENSHOT_TIMEOUT`、`X_*`（x-intel 族）。

## 架构一图流

```
bh CLI ──HTTP /eval──> daemon（Harness + Session 单 WS）
  │                      ├─ 协议层 globals：session / CDP
  │                      ├─ 语义层 globals：goto_url / js（+workspace 覆盖）
  │                      └─ 看门狗 / 陈旧 session 自愈 / 事件环形缓冲（peek 可窥视）
  ├─ 应用进程（remoteHost 经 __bh_meta 复用同一 daemon）
  ├─ 用户的浏览器（附着：DevToolsActivePort 发现 + WS 直连 + Allow）
  └─ rmux 监督链（x-supervisor -> x-intel worker -> x_tweets.db）
```

## 陷阱速查

- **多语句片段必须显式 `return`**：repl 只对单表达式自动补 `return (...)`；多行/带分号片段的返回值不写 `return` 就是 undefined，CLI 静默空输出（不是错误）
- **模板字面量内嵌 `'\n'` 与反引号会被外层先解释**：`\n` 变真换行（页内收到未闭合字符串 -> SyntaxError），``` 会终结模板；一律写 `\\n` 与 `\\\``，或用单引号拼接
- `js()` 对页内异常**静默返 undefined**（不检查 exceptionDetails）；调试时用裸 `cdp('Runtime.evaluate', ...)` 看原始响应
- 马标记 = 代理对 + 空格共 **3 个 UTF-16 单元**，去标记 slice(3)
- `fill_input` 清空**不发 Ctrl+A**（char 事件会输入字面 a），内部已用 `commands:['SelectAll']`
- `new_tab` 先建 about:blank 再 goto（带 url 与 attach 竞速 -> readyState 假完成）
- 从未激活的 tab 收不了 Input 事件（会挂起），scroll/click 已内置激活重试
- Chrome 136+ 拒绝默认 profile 开调试端口：附着走 chrome://inspect/#remote-debugging（144+），发现靠 DevToolsActivePort 文件（HTTP /json 端点不服务）
- 录制开关三层：BH_RECORD env > recording.json > 关
