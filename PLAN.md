# PLAN：当前目标实施计划

> 角色：当前目标方案文档：基于 research（为什么）与 references（怎么做）的执行计划；每条挂依据来源，不存历史目标。

## 当前目标

x-intel 监控与搜索分道独立（GOAL 锚点回指 PRD D40）

## 计划项

| # | 计划 | 依据 |
| --- | --- | --- |
| 1 | worker「只附着」改造：删掉无 x.com tab 时自建 home tab 的分支，改为持续等待（`waitForTrigger` 无 home tab 超一档即报等待态，主循环写 running 等待状态） | PRD D40；D27 共存闸门 |
| 2 | 探针与收割的 eval 全钉 targetId：`js(expr, tid)` + 钉住的 readyState 等待，监控不再 switch_tab 抢 daemon 活动 tab | PRD D40；D34 抢锁标准 |
| 3 | harvest「自己新开 tab 去搜」：`new_tab()` 无参必建新 target（避开空白页复用分支，防劫持用户空 tab）-> goto_url 搜索页 -> 跨分片复用 -> finally 关自己的 tab（被用户接管则保留） | PRD D40；专属 tab 铁律 |
| 4 | 文档同步：SKILL 应用节分道规则、G002 禁令与迁移分级、P0002 行为基线注记、README 一句话、四原语与 diary | AGENTS 文档义务表 |
| 5 | 看板双侧栏折叠（D41）：左右列各自可收起/展开，入口收敛为**两条 1px 分界线上的隐藏式箭头按钮**（默认 opacity 0，悬停/键盘聚焦才浮现；收起侧留 20px 槽位半透明可见，箭头指向下一次点击后的移动方向），状态存 localStorage；应用卡片描述精炼成一句话 | 用户指令 2026-09-10（第 2 轮修正底栏方案）；D12/D17 看板既有形态 |
| 6 | 验收：npm test 全绿 + 引擎隔离实验三景（无 home tab 只等不建 tab / 有 home tab 附着收割零建 tab / harvest 自开自收归还）+ 看板 DOM 探针（按钮圆心压在分界线上、hover 0 变 1 移开回 0、四轮点击两侧栏宽度互换与箭头翻转） | G002 验收门禁；R001 开发 vs 安装验收 |

## 完成的定义

- [x] worker 只附着：无 home tab 时只等待不建 tab，探针/收割 eval 全钉 targetId [实证: 引擎隔离实验，30s 内 log「等待打开 x.com 主页 tab（只附着，不自建）」且 tab 数恒 1]
- [x] harvest 专属 tab：自开、跨分片复用、收工关闭 [实证: 引擎隔离实验，运行中 tabs=2（原 tab + 自开搜索 tab），退出后 tabs=1，stderr「搜索 tab 已关闭」]
- [x] `npm test` 全绿（82 用例 + typecheck:apps）[实证: 2026-09-10]
- [x] SKILL/G002/P0002/README/四原语/diary 同步 [实证: 本次提交]
- [x] 看板：两列皆可折叠，按钮为分界线上的隐藏式箭头（hover 才浮现）、箭头随状态翻转、状态持久化 [实证: 引擎 DOM 探针 1440x900：按钮圆心恒等于分界线中心（10/221、950/1430），hover 0 变 1、移开回 0，左栏 220 与 0、右栏 490 与 0 四轮点击互换]
- [x] 封版 0.6.7（版本三件套 + 提交 + 推送 + 本地轮换）[实证: 用户 2026-09-10 指令「发布个小版本 提交 推送 本地更新轮换」；bh upgrade --offline 七步滚动终验全守护 0.6.7 看板 200]
- [x] 封版 0.6.8（D41 第 2 轮隐藏式分界按钮）：bump + CHANGELOG 封段 + pack/install/skill sync + `bh upgrade` 七步滚动 + 提交推送 + tag/Release [实证: 用户 2026-09-10 指令「继续」承接上一条发版口令]
