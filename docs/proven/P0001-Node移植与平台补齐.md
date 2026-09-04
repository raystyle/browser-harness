# Node 移植与平台补齐

- 状态：已完成（封存）
- 日期：2026-09-04（单日立项、实施、验收；本文为当日回溯归档）
- 关联：PRD D01/D02；踩坑明细见 M101

## 背景与问题

上游 [browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js) 跑在 Bun 运行时上；agent 生态是 Node 原生环境，装 Bun 只为这一个工具不值。同时 Python 主仓 [browser-harness-py](https://github.com/raystyle/browser-harness-py) 已沉淀成熟平台能力（daemon 语义、语义助手、插件生态、agent Chrome、任务隔离、录制视频、技能分发），上游 JS 版只覆盖了其中一小块。

## 目标与非目标

目标：

1. 忠实移植协议层：CDP 56 域 652 方法带类型直调，`bh` CLI + 长驻 REPL，零运行时依赖（Node >=22）
2. 平台能力补齐到 Python 主仓水位（除 MCP 与文档治理子系统外全部）

非目标：

- 不做 MCP 桥接；不移植 Python 仓文档治理
- 不加新功能、不改原版行为（含已知的 `connect({port})` 文档-代码差距，保留原样）

## 方案

- **架构映射**：砍掉 Python 的 IPC 层，daemon 语义（事件环形缓冲、马标记、陈旧 session 自愈、附着策略、看门狗）住进 `src/harness.ts`；传输与会话由 `src/session.ts` 承担
- **Host 抽象**：语义层（`helpers.ts`）编程面对 `host.ts` 接口，双实现：inProcessHost（daemon 内）与 remoteHost（`remote.ts`，一次性 CLI/插件/worker 进程经 `__bh_meta` over POST /eval）
- **语义层兼容**：`helpers.ts` 用 Python 同名 snake_case 与参数序，domain-skills 97 站的代码栅栏原样可跑
- **代码生成**：`scripts/gen.ts` 读 `protocol/*.json` 生成 `generated.ts`，可随上游协议 JSON 换版再生
- **agent Chrome**：adoptLegacyProfile 从 `~/.config/browser-harness/agent-chrome-profile` 继承登录态（滤缓存后 159MB 实际数据）
- **陷阱机制化**：Input 挂起重试（withInputRetry）、DevToolsActivePort 缺失兜底（/json/version）、帧号同步预留防并发共用

## 备选方案

- 直接用上游 Bun 产物：否决，运行时不通用，与零依赖目标冲突
- 包一层 Python 主仓（子进程管理）：否决，跨语言进程管理复杂度高于移植，且丢失类型面

## 实施步骤

1. 协议层移植（session/repl/cli/generated + gen 脚本）
2. daemon 语义进 harness.ts
3. 语义层 helpers + browser_helpers（Host 无关化）
4. 插件生态（web-fetch / 搜索 / cookies / x-monitor 全家桶，x-harvest 时间分片收割 + sqlite 存储）
5. agent Chrome（继承老栈 profile）+ chrome-mode
6. 任务隔离、录制视频、技能分发三线防漂移

（P1-P6 六期划分的具体期界未逐期回填 [记忆: 会话验收记录有六期结论，期界明细如需可回溯补]）

## 风险与回滚

- 风险：undici WebSocket 与 Bun WebSocket 行为差异；Chrome Dev 通道行为漂移（DevToolsActivePort）；Windows 分离进程生命周期
- 回滚：纯新增仓，无需回滚；上游参考克隆可随时重建对照

## 实施过程与经验

- 六期验收全部通过 [实证: 2026-09-04 会话验收记录]
- 生成物与上游字节级保真，diff 仅头两行注释 [实证: 2026-09-04 对账]
- 五个坑当场机制化，明细见 M101（M001-M005）；其中 M005（无 ffmpeg）留了 HTML 幻灯片降级路径
- 最有价值的一条架构经验：**语义层 Host 无关化**让 CLI/插件/worker 全部复用同一套 helpers，不产生第二套语义实现

## 验收标准

- 652 方法全部带类型可直调：达成 [实证: 2026-09-04 生成物对账 + 冒烟]
- 零运行时依赖、Node >=22 原生跑通：达成 [实证: 2026-09-04 本机 Node 24.20]
- daemon 语义与 Python 主仓对齐（除 MCP/文档治理）：达成 [实证: 2026-09-04 六期验收]
- domain-skills 97 站资产原样可用：达成 [实证: 2026-09-04 技能分发三线同步]
