# AGENTS.md

本文件是协作规则的**最高约束**，四段职责依次为：**项目定位**、**工作规则**、**意图路由**、**资源索引**。只留规则骨架与指向，细则唯一权威在对应 G/R 文档（摘要层铁律：双份并行必漂移）。

## 一、项目定位

1. **本质**：从 LLM 到 Chrome 的完整操控平台。[browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js)（Bun 运行时）的 Node/TypeScript 忠实移植，平台能力对齐 Python 主仓 [browser-harness-py](https://github.com/raystyle/browser-harness-py)。两层 API 一条守护进程：协议层（CDP 56 域 652 方法带类型直调，无封装遮蔽）+ 语义层（Python 同名 snake_case 助手，domain-skills 94 站资产原样可用）。成功标准：`npm test` 全绿、`npm pack` 三平台安装态实跑功能完整、全部方法带类型。
2. **边界**：做：协议直调、语义助手、daemon 持久会话、agent 专属 Chrome（继承老栈登录态）、插件应用、录制与视频、任务级浏览器隔离、技能分发。不做：MCP 桥接、Python 仓的文档治理子系统、上游没有的新功能（忠实移植原则：不加新功能、保留原版行为；架构级偏离须用户明示裁定并记 PRD，先例 D11）。质量承诺：**运行时依赖白名单制**（现役仅 `commander` 与 `zod`，新增须走 PRD 采纳）、npm 三平台分发、全方法带类型。
3. **管理对象**：协议面（`protocol/*.json` 唯一源，`src/generated.ts` 为 gen 产物禁手改）；守护面（`BH_HOME` 默认 `~/.config/browser-harness`：workspace 应用资产 + data 运行时数据 + runtime 实例注册表）；技能资产（`skill/` 与 `assets/` 为源，`bh skill sync` 三线防漂移铺装）；本地开发面 `.bh-dev`。
4. **交互对象**：agent（`bh` CLI + `browser` 技能，装到 `~/.claude/skills/browser/`）；Node 程序（npm 库入口 `dist/session.js`）；人（`bh doctor` 诊断面与只读看板 9870）。
5. **方案索引**：构建测试与发布 R001；插件应用开发 R002；移植架构与六期方案 P0001，架构转向 P0002，守护面运营化 P0003，应用生态 P0004。

## 二、工作规则

### 工作节奏

1. **每轮对话**：先核对四原语（`PRD.md`、`GOAL.md`、`PLAN.md`、`TODO.md`）；实质推进当场更新。禁止不核对就干活、偏离当前目标、推进了不更新。
2. **对话分两式**：立项拷问走你问我答（整轮齐问、附推荐答案）；咨询答疑走我问你答（先读文档再答、答必六态）。新需求先入 PRD 走追问链，禁止静默假设。
3. **一次只推进一个目标**；踩坑当场按当前最大号接编 MNNN 落 `docs/mistakes/`，同根因同型坑合并进已有条目，深挖落 research。禁止只留在对话里反复试错。
4. **发现问题时**：走五步闭环（G003）：定位（先搜 INDEX）、归类（错修文档、缺补规则、知识落研究、出错记 mistakes、实证进 references）、修正（改在源头，下游同步）、验证（`npm test` 全绿 + evo scan 无禁字）、提交（一事一提交，diary 记钩子）。禁止跳过定位直接改、只修表象不回写体系、修完不跑验证。
5. **交付变更时**：改代码同步对应文档（README / SKILL / guide），改文档同步 INDEX。禁止只改代码不落文档、改了文档不更新索引。
6. **经验沉淀（G004 强规则）**：成功 plan 归 `docs/proven/`；实证做法与正确工作流进 `docs/references/` 并挂意图路由或 INDEX；同型坑二犯以上升格 references 并配机器可执行约束（hook / 测试门禁 / CI）。禁止 `[经验]` 断言只留研究不落 references、错误只记现象不记根因、`[推断]`/`[假设]` 跳级、一条知识两个权威落位。
7. **提交与发布**：`feat:` / `fix:` / `docs:` / `chore:` / `test:` 前缀加中文描述；一事一提交；未经指示不做 commit / push / reset 等变更操作；封版三件套（bump 版本、CHANGELOG 封段、本地滚动）先问用户拍板（R001 封版第 0 步）。

### 写作编码

8. **执行命令**：Windows 用 PowerShell 7（`pwsh`）；Linux/macOS/WSL 用该平台常规 shell；文档与源码 UTF-8；路径分隔符一律 `node:path` API 拼接，禁止手拼 `\` 或 `/`。
9. **写 TypeScript**：ESM；运行时依赖白名单制（现役 commander 与 zod），白名单外新增必须走 PRD 采纳，devDependencies 从宽；`src/generated.ts` 是 `scripts/gen.ts` 产物禁手改，协议升级后 `npm run gen` 再生成。
10. **写文档**：遵守 G001（树形、标题干净、文件名即标题、禁字机检；vendor 资产豁免区见 D14 条款）。禁止标题带括号、口号或破折号。
11. **写研究与方案**：事实性断言必标六态之一（G001）：`[实证]`、`[推断]`、`[经验]`、`[记忆]`、`[假设]`、`[直觉]`。禁止把「没验证」写成「已验证」、断言不标六态、猜测冒充结论。
12. **写测试**：`node:test`（`npm test` = build + `typecheck:apps` + `node --test "dist/*.test.js"`）；apps 层 .mjs 受 checkJs 纳管。Windows git-bash 下 glob 必须带引号（M002）。禁止重言式断言、只测 happy path。
13. **写 CDP 配方**：新的使用配方落 `skill/interaction-skills/`，纯 CDP 调用格式、一文件一机制。
14. **两套家禁止混用**（M014）：开发走 `<repo>/.bh-dev`（`node dist/cli.js` / `npm link`）；安装验收走 `npm pack` + `npm install -g ./browser-harness-ts-*.tgz`，只用 PATH 上的 `bh`。禁止从仓库起 dashboard 看安装态应用、把 `npm install -g .` 或 `npm link` 当安装验收。流程见 R001「开发 vs 安装验收」。

### 文档义务表

> 动作到必须对齐的文档；漏一件即流程缺口。

| 动作 | 时机 | 义务 |
| --- | --- | --- |
| 新需求提出 | 提出时 | PRD 登记新行 |
| 追问链澄清 | 澄清完成 | PRD 状态流转 + 澄清轮次与裁定 |
| 目标立项 | 开工前 | GOAL 起点与锚点、PLAN 方案、TODO 清单 |
| 选型与调研 | 研究完成 | S 文档（六态）+ INDEX 研究节 |
| 写改源码 | 改动完成 | README / SKILL 同步；行为基线变化同步 guide；版本级成果进 CHANGELOG |
| 写测试 | 新层或新面 | 测试纪律同步 guide；INDEX 测试行 |
| 协议 JSON 升级 | gen 后 | generated.ts 重生成 + 冒烟；R001 同步 |
| 出 PoC | 原型完成 | `poc/README.md` 登记 + S 文档回填 |
| 踩坑 | 当场 | mistakes 接编一行；INDEX 错误节同步 |
| 方案达成 | 验收全绿 | proven 回填、GOAL 历史行、INDEX 归档节、TODO 残表清退留指针 |
| 每次提交 | 提交后 | diary 当天记钩子 |
| 发布 | tag 推送后 | CHANGELOG 封版、ROADMAP 阶段状态 |
| 文档结构变更 | 改名移目录后 | INDEX 同步；断链回归必跑 |

## 三、意图路由

> 需求意图与命令映射的摘要层；行为细则唯一权威在 R/G 文档。
> 能力口径：协议层 652 方法直调 + 语义层 snake_case 助手 + 长驻 daemon；仓库 `D:\browser-harness-ts`；上游 js 仓 browser-use/browser-harness-js、py 主仓 raystyle/browser-harness-py（忠实移植基线）。
> 命令真机对照基准为安装态（PATH 上的 `bh`）；禁止把开发中能力当已交付宣称。

- 构建/测试/发布/技能分发/诊断 -> `docs/references/R001-构建测试与发布.md`
- 安装验收 vs 开发（BH_HOME、看板不刷新、pack 还是 link） -> R001「开发 vs 安装验收」+ `docs/mistakes/M103-开发与安装验收踩坑.md`（M014）
- 开发/升级插件应用（站点搜索、抓取、监控类） -> `docs/references/R002-插件应用开发方法.md`（方法）+ `docs/guide/G002-插件应用开发标准.md`（强制项与验收门禁）
- 协议升级（新 Chrome 方法、protocol JSON 换版） -> R001「代码生成」节
- 发现问题怎么修（定位/归类/修正/验证/提交） -> `docs/guide/G003-五步工作流闭环.md`
- 经验往哪沉淀 / 踩坑何时升格 -> `docs/guide/G004-经验沉淀分级.md`
- daemon 异常 / WebSocket 连接失败 / 端口冲突 -> R001「诊断」节 + `docs/mistakes/M101-移植与平台补齐踩坑.md`
- 想了解移植架构与六期方案 -> `docs/proven/P0001`；架构转向与人机共存 P0002；看板与守护面 P0003；应用生态 P0004
- 文档写法/落位/六态 -> `docs/guide/G001-文档标准细则.md`

## 四、资源索引

> 定位看 `INDEX.md`（唯一索引：编号表、目录结构、代码文件位置）。本节是配合 INDEX 的搜索与分析方法。

**速记**：`P` 归档 / `S` 研究 / `R` 参考 / `G` 规范 / `M` 错误（M1xx 分类、M0xx 行级）；根四原语 `PRD` / `GOAL` / `PLAN` / `TODO`。

**搜索方法（文档）**：

```powershell
rg -n "关键词" INDEX.md                        # 1 先搜总索引
rg --files docs | rg 关键词                     # 2 按文件名搜
rg -n "关键词" docs\research docs\references docs\proven   # 3 全文搜研究参考
rg -n "关键词" docs\mistakes\                   # 4 搜错误处理

# mq（markdown 结构查询；section 必须带 -A）
mq -F grep '.h2' docs\proven\*.md               # 按节标题跨文件定位
mq -A 'section::section(., "验收标准")' 文档     # 抽整节内容
```

**搜索方法（代码）**：

```powershell
ast-grep outline -l ts --json src\              # 模块符号表
ast-grep run -p 'export function name($$$) $$$' -l ts   # 按名定位定义
```

坑速查：mq 无 `.s` 选择器（用 section 模块）；ast-grep 的 fn 模式必须带 body 通配 `$$$`、可见性写进模式。

**分析路径**：改产品行为先读 references 再回 research；规范禁令查 guide；踩坑查 mistakes；选型查 research 与上游两仓；定位代码先 INDEX 再 ast-grep；抽节用 mq section。
