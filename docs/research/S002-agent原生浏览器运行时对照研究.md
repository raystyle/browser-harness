# S002：agent 原生浏览器运行时对照研究（gsd-browser）

> 缘起：2026-09-08 用户在 Medium 搜索「与本 项目同类的浏览器操作与 TypeScript CLI 开发经验」，命中 Agent Native 的《GSD-Browser: Playwright Is Not Good Enough for Agents》（登录态全文 2360 词经 web-fetch Defuddle 取回）。本文做逐点对照，回答「browser-harness 的架构立场在业界同类中的位置、有什么可吸收」。状态：已完成（2026-09-08）。

## 研究问题

| # | 问题 | 类型 |
| --- | --- | --- |
| Q1 | gsd-browser 对「agent 为什么用不好现有浏览器工具」的病理诊断是什么 | 外部事实 |
| Q2 | 其架构核心（daemon/CDP/IPC/命令面）与 browser-harness 的同构度 | 对照 |
| Q3 | 双方各自的独特维度是什么 | 对照 |
| Q4 | 有无值得吸收进 bh 的机制 | 结论 + 待立项 |

## 外部事实核查（2026-09-08，登录态全文）

- 病理诊断：浏览器是「敌对的、有状态的、时序敏感的运行时」，可见界面、可访问树、网络事件、DOM 变化、登录态各自独立漂移；端到端测试 / RPA / agent 执行是三种不同负载，agent 要在不确定性下推断状态、行动、重规划；「许多 agent 失败其实是接口失败：环境给了模型错误的原语」[实证: 文章原文]
- 架构核心：单一二进制 + **daemon 持久 CDP 连接 + 本地 IPC**，首命令自动拉起 daemon，之后「浏览器不再是重型挂件而是本地执行基座」；四大理由：低延迟紧观测环、持久进程态少重连 bug、IPC 边界比远程跳便宜、多步工作流像一次连续交互 [实证: 文章原文]
- 命令面：63 个命令（导航/截图/可访问树/表单分析/网络 mock/HAR 导出/视觉回归 diff/加密凭据库/测试生成/设备仿真/frame 管理），哲学是「暴露给模型的**最小、最确定、最可检视**的控制面」[实证: 文章原文]
- 元素引用机制：`snapshot --json` 返回 `{version: "v1", elements: [{ref: "@v1:e1", role, name}]}`；ref 绑定快照版本，DOM 变化后旧 ref 失效，防「模型记着旧页面状态的选择器盲用」[实证: 文章原文]
- 语义意图命令：`act accept-cookies` / `act login` 把高频动作提到语义层，「消灭一类脆弱的提示时推理」[实证: 文章原文]
- 仓库：github.com/gsd-build/gsd-browser（install.sh curl 安装）[实证: 文章所引]

## 对照分析

### 同构决策（双方独立收敛，互相印证）

| 维度 | gsd-browser | browser-harness |
| --- | --- | --- |
| 常驻 daemon + 持久 CDP + 本地 IPC | 核心卖点，四大理由成段论证 | repl.ts 0.1.0 起即是（`bh` 首用自动拉起 /eval） |
| agent-native 而非测试框架包装 | 核心论点 | 协议即 API 立场（README「agent 自己写 CDP」） |
| observe-act-reobserve 循环 | 明确宣示 | daemon 跨调用保 session/target/globalThis + 事件环形缓冲 |
| 墙与不确定性如实暴露 | （提及 ambiguity 恢复） | 更进一步：CAPTCHA\|WALL 七判 + 通知告警（G002 第 5 条） |

### 他们独有（候选吸收）

| 机制 | 价值 | bh 现状 |
| --- | --- | --- |
| 版本化元素引用（snapshot version + ref） | 防陈旧选择器盲用：agent 记住旧 DOM 状态的引用 | 无对应机制；click_at_xy 为坐标即时查询 |
| 语义意图命令（act login 等） | 高频动作免提示时推理 | 语义层是 Python 助手对齐；站点高频意图可由 domain-skills（94 站）承载 |

### 我们独有（他们未覆盖）

- **附着用户浏览器 + 人机共存**（D11）：agent 与人类共享同一浏览器，专属 tab 铁律、显式授权、Chrome 144+ 官方 auto-connect 通道；gsd-browser 仍是 agent 专属运行时形态
- **协议层全暴露**：652 CDP 方法带类型直调 vs 其 63 封装命令：「最小控制面」适合受控 agent，「协议即 API」适合探索型 agent，两种哲学并存互补
- 事件环证据流（page-detect 判定原料）、只读看板、super-ocr、x-intel、录制视频等应用生态

## 结论

- Q1/Q2 定案：gsd-browser 的病理诊断与 daemon 架构论证与 bh 0.1.0 以来的实践**独立同源**，bh 的架构立场获得业界旁证 [实证: 全文对照]
- Q3 定案：bh 独占「人机共存」维度；gsd-browser 独占「最小控制面封装」哲学：二者定位互补而非竞争
- Q4 结论：值得吸收两项：**版本化元素引用**（建议 D35：helpers 增 `snapshot_interactives()` 返回版本化 ref 表，interaction-skills 落配方；与 click/fill 联动做 ref 失效防护），以及**语义意图层**（远期，domain-skills 承载） [推断: 机制价值判断，落地效果待立项验证]
- 附带旁证：《Why the New Generation of CLIs Is Built with JavaScript》论证 TS+ESM 成熟度使 CLI DX 超越 bash/Python/Go，与 D28/D29（TS7 全严格 + Commander/Zod）路线一致 [实证: 文章开头论点段]

## 信源

- GSD-Browser: Playwright Is Not Good Enough for Agents — Agent Native, medium.com/@agentnativedev/gsd-browser-playwright-is-not-good-enough-for-agents-e759eed565e7（登录态全文 2360 词，2026-09-08 取）
- Why the New Generation of CLIs Is Built with JavaScript — medium.com/@asierr/why-the-new-generation-of-clis-is-built-with-javascript-（付费墙截断，论点段完整）
