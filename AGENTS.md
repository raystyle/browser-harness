# browser-harness-ts：开发协作规则

> 唯一权威源。`CLAUDE.md` 仅一行 `@AGENTS.md` 桥接，不重复维护。

## 一、项目定位

1. **本质**：从 LLM 到 Chrome 的完整操控平台。[browser-use/browser-harness-js](https://github.com/browser-use/browser-harness-js)（Bun 运行时）的 Node/TypeScript 忠实移植，平台能力对齐 Python 主仓 [browser-harness](https://github.com/raystyle/browser-harness)。两层 API 一条守护进程：协议层（CDP 56 域 652 方法带类型直调，无封装遮蔽）+ 语义层（Python 同名 snake_case 助手，domain-skills 97 站资产原样可用）。
2. **边界**：做：协议直调、语义助手、daemon 持久会话、agent 专属 Chrome（继承老栈登录态）、插件应用、录制与视频、任务级浏览器隔离、技能分发。不做：MCP 桥接、Python 仓的文档治理子系统、上游没有的新功能（忠实移植原则：不加新功能、保留原版行为）。质量承诺：零运行时依赖（Node ≥22 内置 WebSocket/fetch/sqlite）、npm 三平台分发、全方法带类型。
3. **交互对象**：agent（`bh` CLI + `browser` 技能，装到 `~/.claude/skills/browser/`）；Node 程序（npm 库入口 `dist/session.js`）；人（`bh doctor` 诊断面）。

## 二、工作规则

### 对话

- 每轮先核对四原语（PRD/GOAL/PLAN/TODO）；新需求先入 PRD 走追问链，禁止静默假设
- 对话分两式：立项拷问走你问我答（整轮齐问、附推荐答案）；咨询答疑走我问你答（先读文档再答、答必六态）
- 一次只推进一个目标；踩坑当场落 docs/mistakes

### 操作

- Windows 用 PowerShell 7(`pwsh`)；Linux/macOS/WSL 用该平台常规 shell
- 未经指示不做 commit/push/reset 等变更操作；提交一事一提交（feat:/fix:/docs:/chore:/test: 前缀）
- 文档与源码 UTF-8；路径分隔符一律 `node:path` API 拼接，禁止手拼 `\` 或 `/`

### 编码

- TypeScript ESM；**零运行时依赖**：新增 runtime 依赖必须走 PRD 采纳，devDependencies 从宽
- `src/generated.ts` 是 `scripts/gen.ts` 从 `protocol/*.json` 生成的产物，**禁止手改**；协议升级后 `npm run gen` 再生成
- 测试用 `node:test`（`npm test` = build + `node --test "dist/*.test.js"`）；Windows git-bash 下 glob 必须带引号（见 M002）
- 新的 CDP 使用配方落 `skill/interaction-skills/`，纯 CDP 调用格式、一文件一机制
- 行为基线变化同步 README 与 `skill/SKILL.md`

### 文档

| 动作 | 时机 | 义务 |
| --- | --- | --- |
| 新需求提出 | 提出时 | PRD 登记新行 |
| 目标立项 | 开工前 | GOAL 起点/锚点、PLAN 方案、TODO 清单 |
| 选型与调研 | 研究完成 | S 文档（六态）+ INDEX 研究节 |
| 写改源码 | 改动完成 | README / SKILL 同步；版本级成果进 CHANGELOG |
| 协议 JSON 升级 | gen 后 | generated.ts 重生成 + 冒烟；R001 同步 |
| 出 PoC | 原型完成 | `poc/README.md` 登记 + S 文档回填 |
| 踩坑 | 当场 | mistakes 接编一行；INDEX 错误节同步 |
| 方案达成 | 验收全绿 | proven 回填、GOAL 历史行、INDEX 归档节 |
| 每次提交 | 提交后 | diary 当天记钩子 |
| 发布 | tag 后 | CHANGELOG 封版、ROADMAP 阶段状态 |

## 三、意图路由

> 摘要层：一行摘要定去向，行为细则唯一权威在 R 文档。

- 构建/测试/发布/技能分发/诊断 -> `docs/references/R001-构建测试与发布.md`
- 开发/升级插件应用（站点搜索、抓取、监控类） -> `docs/references/R002-插件应用开发方法.md`（方法）+ `docs/guide/G002-插件应用开发标准.md`（强制项与验收门禁）
- 协议升级（新 Chrome 方法、protocol JSON 换版） -> R001「代码生成」节
- daemon 异常 / WebSocket 连接失败 / 端口冲突 -> R001「诊断」节 + `docs/mistakes/M101-移植与平台补齐踩坑.md`
- 想了解移植架构与六期方案 -> `docs/proven/P0001-Node移植与平台补齐.md`
- 文档写法/落位/六态 -> `docs/guide/G001-文档标准细则.md`

## 四、资源索引

```powershell
rg -n "关键词" INDEX.md          # 1 先搜总索引
rg --files docs | rg 关键词       # 2 按文件名搜
rg -n "关键词" docs/references docs/proven   # 3 全文搜流程与方案
rg -n "关键词" docs/mistakes/    # 4 搜踩坑
```

分析路径：改产品行为先读 references 再回 research；规范禁令查 guide；踩坑查 mistakes。
