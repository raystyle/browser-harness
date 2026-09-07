# Changelog

本文件记录可交付变更。粒度纪律：只留版本级里程碑（定位变更/发布/阶段完成/核心能力整体落地）。

## [Unreleased]

-（空，0.2.0 已封板）

## [0.2.0] - 2026-09-07

- 新增只读网页看板 `bh dashboard`（D12，127.0.0.1:9870）：macOS 风格单页，SSE 每 2 秒推送：守护实例健康、附着面（各实例活动 tab 与全部可操作 tab，马标记归属）、rmux 会话/pane 树、x-monitor worker 心跳与日志尾、页面健康判定、事件流尾；事件用新增的 `__bh_meta peek` 原语非破坏窥视（绝不 drain，不干扰 x-monitor 触发器）
- 新增检测应用 `bh detect [url片段]`：附着既有 tab 的页面诊断（challenge-stuck / network-stalled / blocked / login-wall / blank / asset-throttled / ok 七判），事件流证据（失败请求、4xx/5xx、Cloudflare 挑战平台、墙词）+ 处置建议，固定形合约报告恒小；首跑实测揪出 Medium 登录失败真因（graphql 429 限流 + 挑战 + 第三方脚本超时叠加）
- **架构转向（D11）：附着用户浏览器 + 人机共存**。bh 永不 spawn 浏览器：daemon 经 DevToolsActivePort 发现并 WS 直连用户自己打开的 Chrome（144+，chrome://inspect/#remote-debugging 官方 auto-connect 通道；每条新连接弹一次 Allow）；专属 tab 铁律（马标记 -> 空白孤儿 -> 后台新建 background:true 不抢焦点，永不自动选中用户正在看的页面；操作用户 tab 须显式 switch_tab/set_session 授权）；空态如实报错并给开启指引；发现范围覆盖 Chrome Stable/Dev/Beta/Canary 并排除 Edge；idle 退出与 daemon 关停只关自身连接。移除 spawn 家族：agentChrome.ts、taskIsolation.ts（--once/--batch）、locks.ts、`bh chrome start/stop/status`、`bh chrome-mode`；x-monitor 改为附着用户浏览器（无可附着时如实报指引，用户关浏览器即监控暂停）。测试网先行：48 用例锁存活语义（键位真值、tab 纪律、自愈链、发现排序、Edge 排除、专属 tab 铁律）
- 新增状态探测原语 `bh sessions`：浏览器对象模型（instance/browser/session/tab/placeholder/window/navigation，按代码实际结构定义）+ 全实例清单（含僵尸注册如实报）+ 窗口分组 tab 表 + 新任务附着策略（attach / app 复用 / explicit / isolated）；新增 `bh --new-tab '<js>'` 显式新开 tab 执行原语
- google-search 标准化升级（G002 首个落地）：新增 `ensure_app_sdk` 基建（Page.addScriptToEvaluateOnNewDocument 源指纹注册 + 自动重注入）；`__gs` 页面常驻 SDK（固定形合约 `_ok/_v/_ts`，版本 1.1.0）；esbuild 构建链（devDependency，零 runtime 依赖不变）；两步契约（`bh google-search <q> --top N` 出指标落盘，`bh google-search pluck gs_search` 取数，指标恒 <1KB）；CAPTCHA/墙如实报告不自动重试（M008）
- 锁与浏览器互斥重构（学习 nu_plugin_browse）：锁文件支持 meta 与 `stealAfterMs: Infinity`（只认 pid 死亡，消灭偷活锁双 spawn）；agent Chrome 启动在锁内写归属记录（bh-agent.json），运行判定从「端口活着」升级为「端口活 + 归属一致 + UA 家族匹配」；stop 补端口表强杀兜底（netstat/lsof -> kill -9）（M007）
- 修复 Windows 浏览器发现：chromeBinary 改注册表扫描（StartMenuInternet + App Paths）+ CDP 偏好排序，替代硬编码路径与失效的 `--version` 探测；`bh chrome stop` 改命令行 marker 定位（可停掉任意 Chromium 系浏览器）；`bh chrome start` 输出明示所选浏览器（M006）

## [0.1.0] - 2026-09-04

- 协议层：CDP 56 域 652 方法带类型直调，生成物与上游 browser-harness-js 字节级保真（仅头两行注释差异）
- 语义层：Python 同名 snake_case 助手（Host 无关），domain-skills 97 站资产原样可用
- daemon：事件环形缓冲、马标记、陈旧 session 自愈、看门狗；`bh` CLI 自动拉起与转发
- agent Chrome：继承老栈 profile 登录态；`bh chrome start/stop/status`、`bh chrome-mode`
- 插件生态：web-fetch / google-search / bing-search / cookies / x-monitor（rmux 自愈监督 + sqlite 存储）
- 录制与视频：每动作一帧；导出 HTML 幻灯片（mp4 合成待 ffmpeg）
- 任务隔离：`bh --once` / `bh --batch`（独立实例 + 克隆登录 profile + 内核保留端口）
- 技能分发：三线哈希防漂移、只增不删（`bh skill status/sync`）
- 工程化：零运行时依赖（Node >=22）、project-evo 文档体系、CI 三系统矩阵
