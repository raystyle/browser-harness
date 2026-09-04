# INDEX：项目总索引

> 角色：全仓唯一索引：只做定位。规则权威源见 AGENTS.md。

## 一、编号体系

前缀：`P`（proven，已完成方案归档，4 位）；`S`（research，研究，3 位）；`R`（references，现役流程，3 位）；`G`（guide，规范禁令，3 位）；`M`（mistakes，M1xx 分类文件、M0xx 行级）。退役编号不复用。

## 二、目录结构与代码位置

| 类别 | 目录/文件 | 说明 |
| --- | --- | --- |
| 文档 | `docs/`（proven/diary/research/references/guide/mistakes） | 方案归档/日记/研究/流程/规范/错误 |
| 源码 | `src/session.ts` | CDP Session：到浏览器端点的持久 WebSocket，自动注入 sessionId |
| 源码 | `src/generated.ts` | 全部 CDP 方法的类型化封装（gen 产物，禁手改，14383 行） |
| 源码 | `src/harness.ts` | daemon 语义驻进程内：事件环形缓冲、马标记、陈旧 session 自愈、附着策略、看门狗 |
| 源码 | `src/host.ts` | Host 接口：语义层编程面对的传输无关抽象 |
| 源码 | `src/remote.ts` | remoteHost：一次性 CLI/插件/worker 进程的 Host 实现（POST /eval） |
| 源码 | `src/helpers.ts` | 语义层：Host 无关、snake_case、参数序对齐 Python 原版（domain-skills 代码栅栏原样可跑） |
| 源码 | `src/browser_helpers.ts` | 站点级助手：一 app 一 tab 记账、带墙检测的搜索、可升级浏览器的正文抽取 |
| 源码 | `src/repl.ts` | REPL：持有一个持久 Session 的 HTTP server |
| 源码 | `src/cli.ts` | `bh` CLI：自动拉起 REPL 并转发代码片段 |
| 源码 | `src/admin.ts` | 管理面：doctor、ensureDaemon、restartDaemon、chrome-mode |
| 源码 | `src/agentChrome.ts` | agent 专属 Chrome 生命周期：launch/stop/detect，继承老栈 profile |
| 源码 | `src/paths.ts` | BH_HOME 路径系统：config/runtime/tmp/workspace/profile 一棵树 |
| 源码 | `src/env.ts` | 环境变量解析（坏值静默回退，不炸 import） |
| 源码 | `src/locks.ts` | 单例锁：O_EXCL 建文件 + pid 活性 + 陈旧抢占 |
| 源码 | `src/skills.ts` | 技能分发三线防漂移：repo payload <-> npm 包 <-> 已部署副本 |
| 源码 | `src/plugins.ts` | 插件装载：workspace/apps/<name>.mjs 导出 main(args) |
| 源码 | `src/recorder.ts` | 录制：每 ACTION 一帧（非 screencast 流） |
| 源码 | `src/video.ts` | 视频管线：帧 -> 编辑梗概 -> 合成 mp4 |
| 源码 | `src/sqlite.ts` | x_tweets 存储（node:sqlite），DDL 承 Python 原版 |
| 源码 | `src/taskIsolation.ts` | 任务级浏览器隔离（--once/--batch）：task-<hex8> 实例 + 克隆登录 profile + 内核保留端口 |
| 源码 | `src/rmux.ts` | rmux CLI 驱动（x-monitor 自愈监督，非官方 SDK） |
| 源码 | `src/session.test.ts` | 单元测试（node:test） |
| 脚本 | `scripts/gen.ts` | 代码生成：protocol/*.json -> generated.ts |
| 数据 | `protocol/` | browser_protocol.json + js_protocol.json（上游协议快照） |
| 技能 | `skill/SKILL.md` | agent 技能入口（装到 ~/.claude/skills/browser/） |
| 技能 | `skill/interaction-skills/` | 18 篇纯 CDP 交互配方（一文件一机制） |
| 资产 | `assets/` | domain-skills 97 站知识库等分发资产 |

## 三、方案归档（docs/proven/）

| 编号 | 文件 | 主题 |
| --- | --- | --- |
| P0001 | `docs/proven/P0001-Node移植与平台补齐.md` | browser-harness-js 的 Node/TS 移植 + P1-P6 平台能力补齐全案 |

## 四、项目日记（docs/diary/）

| 日期 | 主题 |
| --- | --- |
| 2026-09-04 | 移植与六期补齐收官、文档体系建立 |

## 五、研究文档（docs/research/）

| 编号 | 文件 | 主题 |
| --- | --- | --- |

登记表：`docs/research/README.md`。暂无 S 文档：移植选型已在上游与 Python 主仓完成 [经验: 移植项目无活跃研究场景，research 按需生长]

## 六、references 现役流程（docs/references/）

| 编号 | 文件 | 用途 |
| --- | --- | --- |
| R001 | `docs/references/R001-构建测试与发布.md` | 构建/测试/代码生成/发布/技能分发/诊断 |
| R002 | `docs/references/R002-插件应用开发方法.md` | 站点应用架构：常驻 SDK/固定形合约/两步契约/会话生命周期（提炼自 nu_plugin_browse skills 生态） |

## 七、guide 规范（docs/guide/）

| 编号 | 文件 | 用途 |
| --- | --- | --- |
| G001 | `docs/guide/G001-文档标准细则.md` | 命名/写作/六态/门禁/路径写法 |
| G002 | `docs/guide/G002-插件应用开发标准.md` | 插件应用强制项/禁令/验收门禁/迁移分级（方法见 R002） |
| - | `docs/guide/template.md` | 方案文档写作骨架 |

## 八、错误速查（docs/mistakes/）

| 编号 | 分类文件 | 覆盖关键词 | 行级编号段 |
| --- | --- | --- | --- |
| M101 | `docs/mistakes/M101-移植与平台补齐踩坑.md` | WebSocket 空消息、node--test glob、DevToolsActivePort、Input 挂起、ffmpeg 缺失、浏览器发现 Edge 兜底、锁偷活锁、页面 SDK 四连环坑 | M001-M008 |

## 九、阶段与版本

- ROADMAP.md：阶段路线
- CHANGELOG.md：版本里程碑
