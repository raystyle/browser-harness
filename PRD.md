# PRD：需求清单管理

> 角色：需求清单，四原语之首：需求驱动目标。GOAL 的每个目标应能回指本清单条目。
> 分工：PRD=要什么；GOAL=要达成什么；PLAN=怎么做；TODO=做到哪。

## 生命周期

```text
新需求 → 待澄清 → 已澄清 → 已采纳 → 已交付
拒绝路径:任一状态 → 已拒绝(记原因防复问)
```

## 需求清单

| 编号 | 需求 | 状态 | 澄清轮次 | 派生去向 |
| --- | --- | --- | --- | --- |
| D01 | Node/TypeScript 移植 browser-harness-js：协议层（56 域 652 方法带类型）+ `bh` CLI + 长驻 REPL，零运行时依赖（Node ≥22） | 已交付 | 第 0 轮 [推断: 2026-09-04 追溯登记] | P0001 |
| D02 | 平台能力补齐对齐 Python 主仓：daemon 语义、语义层助手、插件生态、agent Chrome、任务隔离、录制视频、技能分发（除 MCP 与文档治理外全部），P1-P6 六期验收 | 已交付 | 第 0 轮 [推断: 2026-09-04 追溯登记] | P0001 |
| D03 | 建立 project-evo 文档体系：三平台矩阵、全量骨架、历史回溯补记（P0001 + diary + M101） | 已交付 | 第 1 轮（2026-09-04 澄清：平台矩阵=三平台；骨架=全量；历史=补记） | 收尾条件=D04 五步闭环，已达成 |
| D04 | 用 bh 实搜「TypeScript 稳定操作浏览器的技术」并整理技术图谱：双引擎（google/bing）、墙如实记；作为 D03 收尾的首个五步闭环需求。前身为「搜索与抓取极限测试」，用户主动缩小范围（追问结论作废，极限测试待后续需求重启） | 已交付 | 第 2 轮（2026-09-04：维度与口径已答后缩为单次实搜；产物=报告归 diary，不需要脚本资产） | diary 2026-09-04；执行中发现并修复 M006（Edge 静默兜底） |
| D05 | 学习 nu_plugin_browse 的锁与浏览器互斥方法，重构 bh 的三个乱源：(a) 30s stealAfterMs 偷活锁致并发双 spawn；(b) isAgentChromeRunning 只 ping 端口无归属验证；(c) stop 强杀无端口表兜底。零依赖约束内实现（不引 fs4） | 已交付 | 第 0 轮（2026-09-04 用户指令「学习 D:\sourcecode\opensource\nu_plugin_browse 的锁和浏览器互斥的方法」；参考仓已通读 session.rs/launch.rs/browse_open.rs） | M007；验证：并发双 start LISTENING=1、daemon 22s 自愈重附着 |
| D06 | 学习 nu_plugin_browse skills 生态（browse/twitter/google/sdk 四仓）的应用开发方法，评估并形成 bh 自己的插件应用开发标准 | 已交付 | 第 0 轮（2026-09-04 用户指令三个参考路径 + 追加 google/twitter；评估结论：固定形合约/两步契约/会话生命周期/错误分类直接采纳，SDK 注入需补基建，单浏览器多 tab 与 domain-skills 保留） | R002（方法）+ G002（标准）+ 迁移分级表 |
| D07 | google-search 按 G002/R002 标准化升级，作为标准首个落地：ensure_app_sdk 基建 + __gs 常驻 SDK + esbuild 构建链 + 两步契约命令层 | 已交付 | 第 0 轮（2026-09-04 用户指令「google 先做」） | M008；G002 六项验收门禁全过 [实证: 指标 1478B/5 条、墙 challenged 如实报、tab 重建自愈] |
| D08 | 集成状态探测原语：`bh sessions`（对象模型从代码提炼：instance/browser/session/tab/placeholder/window/navigation + 全实例清单 + 窗口分组 tab 表 + 四入口附着策略）与 `bh --new-tab`（显式新开 tab 执行原语） | 已交付 | 第 0 轮（2026-09-04 用户指令；追问澄清「字典按代码实际对象模型定义，不拍脑袋」） | 实测：发现 2 个僵尸实例注册与 4 个残留 about:blank 并清理 [实证: 2026-09-04] |
| D09 | rmux 探测原语：`bh rmux`（安装/daemon 活性/会话与 pane 树，pane 带 target/window/command/title/path）；rmux.ts 原有 listSessions/listPanes 仅内部自用且粒度粗，无用户面暴露 | 已交付 | 第 0 轮（2026-09-04 用户指令「rmux 没有会话和 pane 之类的 list 原语」） | 实测：空态如实报 daemon:false；起测试会话验证满态全字段后清理 [实证: 2026-09-04] |
