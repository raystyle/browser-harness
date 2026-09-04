# Changelog

本文件记录可交付变更。粒度纪律：只留版本级里程碑（定位变更/发布/阶段完成/核心能力整体落地）。

## [Unreleased]

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
