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
| D10 | x-monitor 关闭原语：`bh x-monitor stop|close`（按序拆栈：supervisor 先杀防 15s 重拉 -> worker -> BH_NAME=x-monitor 专属 daemon POST /quit）；`start` 子命令显式化，裸调保持启动兼容 | 已交付 | 第 0 轮（2026-09-04 用户指令「bh x-monitor 没有关闭方法」+ 补充「start/stop 或 close」） | 实测：空态幂等；手造双会话按序停止、停后 rmux daemon:false [实证: 2026-09-04] |
| D11 | 重构程序为「附着用户浏览器 + 人机共存」形态：只附着用户自己打开的浏览器操作，专属 tab 铁律不影响人类浏览，彻底移除 spawn 家族 | 已采纳 | 3 轮（2026-09-05：动机=共存不扰人；定性=架构转向，忠实移植原则在本需求让位；spawn 家族彻底移除，agentChrome 整文件删重写、taskIsolation 删（D02 子能力被取代）、x-monitor 随改；铁律=专属 tab+显式授权；通道=用户自开为主，可行性研究是生死门，证伪则告警退出无兜底；空态=如实报+引导；门禁=先补测试网） | 研究先行（S 文档+PoC 待立项） |
| D12 | 127.0.0.1 网页看板：bh 守护（daemon 实例健康）、附着面（各实例附加/操作着哪些网页）、rmux 守护（后台任务会话/pane 树）一屏可视 | 已采纳（已交付待验收） | 第 1 轮（2026-09-07：独立全局看板 9870；SSE 推送；数据面全量（实例+附着面/rmux+worker 心跳/页面判定/事件尾）+ macOS 风格；只读铁律） | src/dashboard.ts + cli dashboard 命令 |
| D13 | 项目原语与结构重组：四层原语栈（原语/机制/站点/应用）、skill/primitives/ 载体、workspace 数据迁出、资产漂移同步+监控 | 已采纳 | 第 1 轮（2026-09-07：四项全按推荐裁定） | 进行中 |
| D14 | G001 补 vendor 资产禁字豁免条款：assets/domain-skills、skill/interaction-skills、protocol/*.json 为上游原样移植件，禁字命中豁免不改写（忠实移植优先），自有文档仍全量适用 | 已交付 | 第 1 轮（2026-09-07 evo scan 检出 3730 条告警，正式文档零命中、全落上游移植资产与 .bh-dev 运行时区；用户裁定走 G001 豁免而非批量改字） | G001 |
