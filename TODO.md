# TODO：当前目标任务进度清单

> 角色：当前目标的任务进度清单。目标完成后回填 docs/proven 对应方案，起新清单。
> 当前锚点：x-intel 监控与搜索分道独立（D40，2026-09-10）；上一锚点文档账实全面对齐已完成（proven P0002-P0004 归档、四原语与 R001/ROADMAP 刷新），各历史清单留作记录。

## D40 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| 监控只附着（删自建 tab 分支） | 已完成 | worker.mjs：无 home tab 时不 new_tab，持续等待；`waitForTrigger` 缺 tab 超 `X_NO_HOME_REPORT_MS`（默认 15s）报等待态，主循环写 running 等待状态（文案区分「无 x.com tab」与「用户浏览其他页」） | PRD D40 |
| 探针/收割 eval 钉 targetId | 已完成 | 去掉 `switch_tab` 抢活动 tab；`js(expr, tid)` + `waitReadyPinned`；FIND/CLICK pill 与滚动全钉；刷新日志带触发来源（新帖指示器/定时兜底） | PRD D40 / D34 |
| harvest 自开专属 tab 自收 | 已完成 | `new_tab()` 无参建全新 target（绕开空白页复用，防劫持用户空 tab）-> `goto_url` 搜索页 -> 跨分片复用 -> `finally` 关闭；被用户接管（URL 已非 x.com/search）则保留 | PRD D40 |
| x-search 与文档同步 | 已完成 | search.mjs 头注写明三线分工；SKILL 应用节分道规则；G002 禁令与迁移分级；P0002 行为基线注记；README 一句话 | AGENTS 文档义务表 |
| 验收：npm test + 引擎隔离实验 | 已完成 | 82 测全绿；引擎（`bh headless`）三景：无 home tab 只等不建 tab、有 home tab 附着收割零建 tab、harvest 自开自收归还 | G002 / R001 |
| D41 看板双侧栏折叠 + 描述精炼 | 已完成 | dashboard.ts：`noright`/`nosource` 双类 + 底部控制栏两箭头按钮（左端管左栏、右端管右栏，箭头指向下一次点击的移动方向，状态存 localStorage）；x-intel/page-detect 描述收敛一句话 | 用户指令 2026-09-10 |
| 验收：看板 DOM 探针 | 已完成 | 引擎打开看板 1440x900：两按钮 y=876 贴底；右栏 490 与 0 互换、左栏 220 与 0 互换、箭头 ◂/▸ 翻转、localStorage 键写入 | G002 / R001 |
| 封版 0.6.7（版本三件套 + 提交推送 + 本地轮换） | 已完成 | 用户拍板「发布个小版本 提交 推送 本地更新轮换」：bump 0.6.7 + CHANGELOG 封段 + pack/install/sync + `bh upgrade --offline --yes` 七步滚动终验全守护 0.6.7 看板 200；tag/Release 随提交推送 | R001 封版八步 |

## 文档账实对齐任务清单（2026-09-10）

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| proven 补齐 P0002-P0004 | 已完成 | 附着模型转向与人机共存 / 看板与守护面运营化 / 插件应用生态深化；验收全部回指已有实证 [实证: 提交 ab0d07c] | GOAL 锚点 |
| GOAL/INDEX 刷新 | 已完成 | 锚点轮转、时间线与历史补 D12-D38；INDEX 归档节、engine.ts、82 用例、九应用口径 | 同上 |
| oma trace 过程证据交叉 | 已完成 | 1000 块按 agent/日期/文件聚合：无未记录源码文件，化石（x-core/x-worker）已清；grok 27% 参与度与 trace 09-07 起的边界记 diary | 用户指令 |
| PLAN/TODO/R001/ROADMAP 轮转 | 已完成 | 本清单 + PLAN 重写 + R001 封版第 0 步先问用户 + ROADMAP 补 0.4.x 至 0.6.x 里程碑 | AGENTS 四原语义务 |
| oma trace 使用问题反馈 | 已完成 | 五项经 herdr 委托 oma 仓 agent 当日全修并回执（随 oma 下版发布）；debug build 实测验收全过，timeline 1536 全量 review 收口 | 用户指令 2026-09-10 |

## 封版 0.3.0 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| 第三方封版评审 | 已完成 | codex reviewer（herdr 委托）：无代码级阻断；3 项元数据阻塞 + 3 项建议 [实证: 2026-09-08 3m30s 评审] | GOAL 锚点 |
| 版本号 0.3.0（package.json + lockfile） | 已完成 | 0.2.1 与 0.1.0 统一提至 0.3.0 | 评审阻塞项 1 |
| README 安装示例更新 | 已完成 | 0.2.1.tgz 与 bh --version 示例改 0.3.0 | 评审阻塞项 2 |
| CHANGELOG 封版 | 已完成 | Unreleased 定版为 [0.3.0] - 2026-09-08 | 评审阻塞项 3 |
| 站点口径 97 至 94 | 已完成 | README/AGENTS 对齐 SKILL 与实际目录 | 评审建议 |
| 文档滞后六处清理 | 已完成 | INDEX（16 篇/74 用例/primitives 登记）、PRD D13 已交付、GOAL 锚点轮转、ROADMAP 收口、TODO 头部 | 内部 review |
| tag v0.3.0 | 已完成 | npm test 全绿后打 tag | R001 发布 |

## D30 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| 漂移检测自动化 | 已完成 | daemonVersionDrift（health.version 缺字段视为 pre-0.4.0）；warnVersionDrift 启动提示一行，滚动过程子进程实测可见 | PRD D30 |
| upgrade 五步滚动 | 已完成 | upgradePlan 纯函数 4 单测；spawn 子进程复用 stop/start 语义；终验全对版 [实证: 2026-09-08 实机 0.4.0 至 0.4.1 五步全绿] | PRD D30 |
| 包源三态 | 已完成 | Release 默认（cmpVersion 不降级 + 离线降级）；--from 本地/URL（后台引导安装）；--offline | 用户裁定 |
| Commander 三连环修复 | 已完成 | KNOWN_COMMANDS 注册、action 闭包 opts、enablePositionalOptions、program.args 取操作数 [实证: doctor --json / skill sync --yes / upgrade --yes 全链] | 实机验收发现 |
| 文档与封版 | 已完成 | README 能力矩阵 + R001 第 5 步改 bh upgrade；tag v0.4.1 | PLAN |

## D29 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| Commander 迁移 | 已完成 | 结构化命令（sessions/rmux/dashboard/doctor/skill/record/video/run + 全局 flag）走 Commander 严格解析；裸片段与插件路由保持原直通路径；--name 预剥离保位次无关 [实证: tsc 零错误 + 冒烟] | PRD D29 |
| Zod 校验 | 已完成 | env.ts schema 化（大小写不敏感 tri-bool 回归修）；CLI 写操作选项 WriteOpts | PRD D29 |
| --dry-run/--yes | 已完成 | --restart 与 skill sync 默认只打印计划；无 --yes 一律 dry-run；退出码 usage=2 [实证: video usage=2 / skill bogus=2 / restart dry-run=0] | PRD D29 |
| G002 退出码表 | 已完成 | 第 7 条：0/1/2/3 四档 + 写操作默认 dry-run | 用户裁定 |
| 文档同步 | 已完成 | AGENTS/README/SKILL 白名单表述；R001/README sync --yes | PLAN |
| 封版 0.4.0 | 已完成 | pack + install -g + 冒烟（restart/sync dry-run、video usage=2、x-intel 插件路由、eval `return 1+1` 得 2、看板 200）+ tag [实证: 2026-09-08 安装态] | 用户裁定目标 |

## D28 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| TypeScript 7 升级 | 已完成 | 5.9.3 至 7.0.2（npm latest）；NodeNext 新式配置零错误直过 | PRD D28 |
| 严格开关清零 | 已完成 | exactOptionalPropertyTypes 12 处修复（admin/remote/dashboard/host/harness/rmux/skills）；noImplicitOverride/isolatedModules/incremental 同开 [实证: tsc --noEmit 0 错误 + npm test 74/74] | 用户推荐基线 |
| module 取舍 | 已完成 | 保留 NodeNext（纯 Node ESM 库），不采纳 preserve/bundler | 用户表格「Node 库用 nodenext」 |

## D27 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| worker 非 home 页等待 | 已完成 | homeTab 判定（x.com 根/home，12 边界用例过）+ waitForTrigger/round 双闸门；等待不写 degraded 不发错误事件 [实证: 2026-09-08 node --check + 边界单测] | PRD D27 |
| 封版 0.3.1 | 已完成 | pack + install -g + skill sync（+worker.mjs）+ 重启实机验证：详情页期间无错误刷屏，回 home 后 10:41:45 收割 13 贴库存 1234 [实证: 2026-09-08 安装态] | 用户裁定 |

## D13 任务清单（补记）

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| 四层原语栈 + skill/primitives 载体 | 已完成 | primitives 5 篇（attach/search/fetch-analyze/detect/observability）+ README；SKILL.md 按四层路由 | PRD D13 |
| workspace 数据迁出 | 已完成 | paths.ts D13 hygiene split：data 归 BH_HOME，仓库不再持运行时数据 | PRD D13 |
| 资产漂移同步+监控 | 已完成 | skills.ts 三线防漂移 + doctor 资产一致性核查 | PRD D13 |

## D11 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| S001 外部事实核查 | 已完成 | Chrome 136 禁令属实；Chrome 144+ 官方 auto-connect 通道同构 D11；Edge 排除、Chrome 家族自适应发现 | PLAN #1 |
| S001 PoC：实机附着用户自开浏览器 | 已完成 | 生死门判定可行：发现 -> WS 直连 -> 列 tabs -> 后台建 tab 不抢焦点全链路实证；每连接弹一次 Allow（daemon 须单条长连） | PLAN #1 生死门 |
| 补测试网 | 已完成 | 45 用例 18 套件全绿（env/paths/session 路由与发现/helpers 键位与 tab 纪律/harness 环形缓冲与自愈）[实证: 2026-09-05 npm test] | PLAN #2 |
| discovery 模块设计与实现 | 已完成 | 候选表补 Chrome Dev/Beta（三平台）、排除 Edge；harness 默认路径改发现附着（每候选 30s 等 Allow）；空态如实报 + chrome://inspect 指引 [实证: 真机 doctor attachable + current_tab 附着成功] | PLAN #3 |
| 移除 spawn 家族 | 已完成 | 删 agentChrome.ts/taskIsolation.ts/locks.ts 与 bh chrome、chrome-mode、--once/--batch；dist 陈旧产物清理；src 零残留（仅注释性记录） [实证: grep 验证] | PLAN #4 |
| 专属 tab 铁律 + 显式授权落地 | 已完成 | attachFirstPage 统一策略：马标记 -> 空白孤儿 -> 后台新建（background:true），永不选用户真实页面；用户 tab 操作走显式 switch_tab/set_session；单测三连锁定 [实证: 48 用例含铁律三连] | PLAN #5 |
| x-monitor 改造 | 已完成 | 去spawn+预检完成；触发模型 5s 探测（标题徽章/pill）自动收割，5min 兜底。触发版复验：x.com/home 标题 `(1)`，启动 14s 内刷新，页面 15 帖新入库 9，库存 1003 至 1012 [实证: 2026-09-07 21:51:48 启动 / 21:52:02 入库，非 300s 兜底] | PLAN #5 |
| 验收冒烟 + 文档同步 | 已完成 | 附着/共存/授权/空态四景已实测；触发版收割入库闭环 | PLAN #6 |

## D22 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| bing SDK `__bs` | 已完成 | ready/results/extract + 挑战检测 + ck/a 解码 | PLAN #1 |
| bing-search 命令层两步契约 | 已完成 | stash bs_search / pluck / ready；墙不重试 | PLAN #2 |
| 文档同步 | 已完成 | SKILL / README / search.md / G002 / CHANGELOG | PLAN #3 |
| 开发态实搜冒烟 | 已完成 | 指标 count=5 bytes=1290、pluck 五条 title 均非空 [实证: 2026-09-07 TypeScript browser] | PLAN #4 |

## D25 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| `__ocr` SDK 定位 | 已完成 | ready/locate/export；关键词+邻近标签+尺寸；交互式拼图单独报 | PLAN #1 |
| super-ocr 命令层 | 已完成 | 扫描、定位、OCR；setup 装引擎到 BH_HOME/ocr；不填写；ArrayBuffer 规避 M015 | PLAN #2 |
| 文档同步 | 已完成 | SKILL / README / G002 / CHANGELOG / INDEX / M015 M016 | PLAN #3 |
| 开发态冒烟 | 已完成 | locate canvas+验证码；OCR K8M2 conf=0.9997；reCAPTCHA iframe CAPTCHA\|WALL [实证: 2026-09-07] | PLAN #4 |
| 安装态验收 | 已完成 | pack + 全局 tgz（无 tsconfig）；`bh skill sync` 铺装；`bh super-ocr setup` 装到 `~/.config/browser-harness/ocr`；全局 `bh super-ocr` 识别 K8M2 [实证: 2026-09-07 npm-global] | R001 |

## 待办池（与 D11 无依赖）

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| 上游同步核查（js 仓 09-04 以来） | 已完成 2026-09-08 | video#757 免疫（ffmpeg 路线不走 Chrome 下载）；auth#755 部分免疫（cookie-io 补受控 JSON.parse）；update-flag 无关（py CLI）；raw-cdp#764 文档不冲突（TS 形态不同）。py 主仓停 09-04 基线无新 | 上游回流 |
| x-intel 探测 eval 显式短超时 | 备查 | 瞬时页面挂起致单飞锁 429 约 21 秒自愈（12:23 实测，自然结算路径；D31 僵尸清算与 watch 自愈待命未触发）。频率升高（分钟级一次）再立项：探测 eval 带 ?timeout=20 级显式超时把瞬失窗口压到秒级 | 2026-09-08 观察 |
| npm 发布（0.1.0） | 不做 | 2026-09-07 用户裁定不做；本地 `npm pack` + 全局 tgz 安装验收即可，不走 registry 发布 | ROADMAP |
| bing-search 按 G002 升级 | 已完成 | D22：__bs + 两步契约 bs_search；实搜 5 条 title 非空 [实证: 2026-09-07] | G002 / PRD D22 |
| mp4 视频管线验证 | 已完成 | 2026-09-07：User PATH 探测 + ffmpeg 9 fps_mode；export mp4 与 contact sheet 冒烟通过 [实证: 1655B] | ROADMAP + M005 |
| 搜索与抓取极限测试 | 已完成 | D24：google 5 条 + bing 5 条 + web-fetch 一篇正文/一篇 DNS 失败如实记 [实证: 2026-09-07 diary] | PRD D24 |
| x-search / x-harvest 标准化 | 已完成 | D23：JSON `{_ok,_v,_ts}`；空库 count=0；harvest 打指标 | G002 / PRD D23 |
| MCP 桥接 | 不做 | 2026-09-07 用户裁定不做；不在忠实移植范围，不再挂起等待 | ROADMAP |
