# TODO：当前目标任务进度清单

> 角色：当前目标的任务进度清单。目标完成后回填 docs/proven 对应方案，起新清单。
> 当前锚定 0.3.0 封版 + 文档账实对齐（2026-09-08，依据第三方封版评审）；D11/D22/D25 等已交付清单留作记录。

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
| npm 发布（0.1.0） | 不做 | 2026-09-07 用户裁定不做；本地 `npm pack` + 全局 tgz 安装验收即可，不走 registry 发布 | ROADMAP |
| bing-search 按 G002 升级 | 已完成 | D22：__bs + 两步契约 bs_search；实搜 5 条 title 非空 [实证: 2026-09-07] | G002 / PRD D22 |
| mp4 视频管线验证 | 已完成 | 2026-09-07：User PATH 探测 + ffmpeg 9 fps_mode；export mp4 与 contact sheet 冒烟通过 [实证: 1655B] | ROADMAP + M005 |
| 搜索与抓取极限测试 | 已完成 | D24：google 5 条 + bing 5 条 + web-fetch 一篇正文/一篇 DNS 失败如实记 [实证: 2026-09-07 diary] | PRD D24 |
| x-search / x-harvest 标准化 | 已完成 | D23：JSON `{_ok,_v,_ts}`；空库 count=0；harvest 打指标 | G002 / PRD D23 |
| MCP 桥接 | 不做 | 2026-09-07 用户裁定不做；不在忠实移植范围，不再挂起等待 | ROADMAP |
