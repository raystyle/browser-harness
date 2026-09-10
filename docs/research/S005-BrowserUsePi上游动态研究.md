# Browser Use Pi 上游动态研究

- 状态：已完成（研究）
- 日期：2026-09-10
- 关联：P0001（移植起源）；触发：2026-09-10 用户指令「Browser Use Pi？深度研究下」（情报源 x-intel 09-10 收割 gregpr07 帖）
- 信源：browser-use/browser-use-pi 仓库（README、package.json、git tree、docs/browser.md）、org 仓清单、X 帖 gregpr07/GitTrend0x/realfxw

## 一、是什么

`@browser_use/pi` 0.1.0（2026-09-09 发布，MIT，TS）：Browser Use 团队（gregpr07）让 Astra 把自家三个项目（Browser Use、Browser Harness、BrowserCode）的有效部分组合蒸馏出的微型 Web Agent SDK。官方口号「A tiny TypeScript web agent, hill climbed on real browser evals」（真实浏览器评测爬山优化）。定位句直指上游血统：「The programmability of Browser Harness, with sessions, saved logins, streaming and typed results. One SDK you can put in your app.」[实证: 仓库 README 2026-09-10 抓取]

## 二、架构与原语面

```
任务 → Pi Mono → 持久 V8 REPL（可杀 worker）→ raw CDP → Chrome
         ↑                                          │
         └──────── AX tree + screenshots ───────────┘
```

- **持久 V8 REPL 是心脏**：顶层变量/函数/await 跨 cell 存活，agent 写 JS、用 Node 库、helper 沉淀在 workspace（「Reusable helpers belong in the agent's workspace」，helper 不进框架）[实证: docs/browser.md]
- src 仅 24 模块（agent/browser/cdp/protocol/page/observer/policy/prompt/runtime/worker/recording/video/highlight/server/telemetry 等）[实证: git tree]
- 原语仅 11 个：`page.goto/info/snapshot/evaluate/waitFor/clickAt/screenshot/cdp` + `tabs.open/list/get/close` + `browser.send/waitFor`；`page.cdp(method, params)` 为任意 typed tab CDP 命令 [实证: docs/browser.md 原语表]
- **语义层被砍**：migration 节明言删除 find/click/fill/press/text/select/upload/frames/Target，替代路线是「AX 发现（backendNodeId）+ DOM.getBoxModel 质心坐标 + clickAt + evaluate + raw CDP」，prompt.ts 教配方 [实证: docs/browser.md Migration 与 AX 至 coordinates 至 click 示例]
- worker 哲学：生成的 JS 跑在可杀子进程（同步死循环可超时杀、process.exit 只杀 worker）；明说 worker 不是安全沙箱 [实证: docs/browser.md Why a worker]

## 三、与本仓对照 [推断: 依据双方公开文档]

| 维度 | browser-use-pi | browser-harness-ts（本仓） |
| --- | --- | --- |
| 运行时 | Node 至 22.19 / Bun 至 1.3.14 | Node 至 22（一致，Node 优先） |
| 协议面 | page.cdp 任意 typed 命令 | 652 方法全类型直调（更完整） |
| 语义层 | 砍掉，agent 涌现式自建 helper 落 workspace | Python 同名 snake_case 全家 + domain-skills 94 站预制 |
| 观测/动作 | AX tree + 坐标 clickAt（官方提示坐标可能中 overlay） | snapshot_interactives + click_ref（elementFromPoint 自证防 STALE_REF，D35） |
| 会话模型 | 持久 V8 REPL worker | daemon 持久会话 + 单飞锁 + 挂锁清算（D31） |
| 浏览器面 | Browser Use Cloud 优先 + 自有 Chrome | 附着用户浏览器（D11 人机共存铁律）+ 自起 headless 引擎（D37） |
| 分发 | npm SDK 内嵌进 app | npm 三平台 + bh CLI + 技能三线分发 |

## 四、生态位判断

1. **上游官方验证了本仓核心赌注**：Node/TS + CDP 直调 + 持久会话是正确方向；browser-harness-js 的可编程性被官方亲手蒸馏成 Node 优先形态（engines 把 node 写在 bun 前）[推断]
2. **分歧在 helper 哲学**：Pi 信「模型够强就让它自己写」（砍语义层、Astra 爬山出 prompt 配方）；本仓信「预制知识 + 类型面」（94 站 + 652 类型 + G002 应用生态）。两者是光谱两端：Pi 对旗舰模型 token 高效，本仓对可控/复用/弱模型友好 [推断]
3. **browser-harness-js 维护观察**：09-07 仍有 push（17466 星），但 org 近期活跃重心在 pi / browser-harness-tui（Codex fork 内嵌为内置浏览器 agent）/ workflow-use / sdk（Cloud）；移植仓需持续观察 harness 是否转维护模式 [实证: org push 时间 + 推断]
4. **可吸收项**：`page.waitFor(fn, arg, timeoutMs)` 观察式等待签名；`finish_from_js({expression})` 交付既有变量不让模型重写（省 token 好设计）；`highlightActions` 演示层（橙角括号动画，aria-hidden 不污染 AX 树）；遥测默认开可关的取舍 [实证: docs/browser.md]

## 五、对本仓的行动建议

- 观察项：browser-use-pi 的 eval/ 评测集形态（真实浏览器 hill-climb 基准），本仓 G002 门禁可借鉴其「评测驱动 helper 取舍」的思路 [假设: 待评估其 eval 仓库内容]
- 不跟随项：砍语义层（与忠实移植原则和 94 站资产冲突；且本仓交互对象含弱模型场景）
- 跟踪节奏建议：browser-use org 周报式 diff（gh api commits?since=，同上游同步核查惯例，见 TODO 待办池）
