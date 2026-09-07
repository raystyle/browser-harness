# TODO：当前目标任务进度清单

> 角色：当前目标的任务进度清单。目标完成后回填 docs/proven 对应方案，起新清单。
> 当前锚定 D11（附着用户浏览器 + 人机共存重构），清单按 PLAN 计划项展开。

## D11 任务清单

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| S001 外部事实核查 | 已完成 | Chrome 136 禁令属实；Chrome 144+ 官方 auto-connect 通道同构 D11；Edge 排除、Chrome 家族自适应发现 | PLAN #1 |
| S001 PoC：实机附着用户自开浏览器 | 已完成 | 生死门判定可行：发现 -> WS 直连 -> 列 tabs -> 后台建 tab 不抢焦点全链路实证；每连接弹一次 Allow（daemon 须单条长连） | PLAN #1 生死门 |
| 补测试网 | 已完成 | 45 用例 18 套件全绿（env/paths/session 路由与发现/helpers 键位与 tab 纪律/harness 环形缓冲与自愈）[实证: 2026-09-05 npm test] | PLAN #2 |
| discovery 模块设计与实现 | 已完成 | 候选表补 Chrome Dev/Beta（三平台）、排除 Edge；harness 默认路径改发现附着（每候选 30s 等 Allow）；空态如实报 + chrome://inspect 指引 [实证: 真机 doctor attachable + current_tab 附着成功] | PLAN #3 |
| 移除 spawn 家族 | 已完成 | 删 agentChrome.ts/taskIsolation.ts/locks.ts 与 bh chrome、chrome-mode、--once/--batch；dist 陈旧产物清理；src 零残留（仅注释性记录） [实证: grep 验证] | PLAN #4 |
| 专属 tab 铁律 + 显式授权落地 | 已完成 | attachFirstPage 统一策略：马标记 -> 空白孤儿 -> 后台新建（background:true），永不选用户真实页面；用户 tab 操作走显式 switch_tab/set_session；单测三连锁定 [实证: 48 用例含铁律三连] | PLAN #5 |
| x-monitor 改造 | 收割闭环已实证，事件触发版待复验 | 去spawn+预检完成；实跑修复 7 处（attachedTargetId 事件跟踪、ensureDaemon 双假就绪、失败轮 5s 重试、Chrome 155 DOM 序列化、弹窗机枪改指数退避、daemon 首连失败不退出）；收割实证 +38 入库 x_tweets.db；触发模型按用户裁定改为 5s pill 探测自动触发（5min 兜底、60s 最小间隔、阅读中不清扫）；窗口操纵代码整段删除（运行期零 setWindowBounds/activate，硬规则入 SKILL：只关自有 tab，绝不关用户 tab 与附着浏览器）；用户浏览器曾被 Chrome Dev 自身崩溃带走（事件日志 0xc0000409，与 bh 无关），重开浏览器后待复验触发版 | PLAN #5 |
| 验收冒烟 + 文档同步 | 进行中 | 附着/共存/授权/空态四景已实测；x-monitor 景差最后一轮（harvest 入库 db）；README/SKILL/R001/CHANGELOG 已同步 | PLAN #6 |

## 待办池（与 D11 无依赖）

| 任务项 | 进度 | 说明 | 出处 |
| --- | --- | --- | --- |
| npm 发布（0.1.0） | 未开始 | 建议 D11 定型后发布（架构转向先落定再对外定型 API 面）；走 R001 + CHANGELOG 封版 | ROADMAP |
| bing-search 按 G002 升级 | 未开始 | 复用 google 全套路；顺带修 title 偶发空（M004 同源）；D11 后经由附着通道跑 | G002 迁移分级 |
| mp4 视频管线验证 | 未开始 | 依赖装 ffmpeg；验证后回填 M005 与 ROADMAP | ROADMAP + M005 |
| 搜索与抓取极限测试 | 搁置 | D04 前身，用户缩小范围时明确待重启 | PRD D04 |
| x-search / x-harvest 标准化 | 观望 | 触发痛点再迁；D11 后 x 系应用形态随 x-monitor 改造联动，暂不单独动 | G002 迁移分级 |
| MCP 桥接 | 挂起 | 不在忠实移植范围；有真实需求走 PRD | ROADMAP |
