# PLAN：当前目标实施计划

> 角色：当前目标方案文档：基于 research（为什么）与 references（怎么做）的执行计划；每条挂依据来源，不存历史目标。

## 当前目标

D11 重构为「附着用户浏览器 + 人机共存」形态（GOAL 锚点回指 PRD D11）

## 计划项

| # | 计划 | 依据 |
| --- | --- | --- |
| 1 | S001 研究：用户自开浏览器附着通道可行性（Chrome 新版限制核查、通道盘点、发现机制与引导设计、PoC 实测） | PRD D11 生死门裁定：证伪则告警退出 |
| 2 | 补测试网：存活模块（session/paths/env/helpers/harness 语义）单测锁行为，绿了才动结构 | 拷问第 1 轮门禁裁定 |
| 3 | 架构落地：新 discovery 模块（用户浏览器发现与附着）；Harness 默认路径改附着；空态如实报 + 一次性引导 | PRD D11 共识：agentChrome 整文件删重写；M006 教训：不静默兜底 |
| 4 | 移除 spawn 家族：agentChrome、taskIsolation、agent-chrome 锁与归属记录；PRD 已记录 D02 子能力被取代 | 拷问第 2、3 轮裁定 |
| 5 | 共存铁律落地：专属 tab（后台创建不抢焦点）+ 显式授权（调用方指定 targetId/tab）；attachFirstPage 重写为永不选用户真实页面；x-monitor 改造为附着用户浏览器专属 tab 跑监控，supervisor 只重拉 worker | 拷问第 2、3 轮裁定 |
| 6 | 验收归档：build + test + 实测冒烟（附着、共存、授权、空态、x-monitor 五景）；README 与 SKILL 行为基线同步；CHANGELOG；GOAL 历史回填 | AGENTS 义务表 |

## 完成的定义

- [ ] S001 结论为可行 [待验证: PoC 实测用户自开浏览器被发现、附着、专属 tab 操作、不抢焦点]
- [ ] 存活模块测试网全绿后再动结构 [待验证]
- [ ] spawn 家族零残留（rg 验证无 launchAgentChrome 与 taskIsolation 引用） [待验证]
- [ ] 五景冒烟实测通过 [待验证]
- [ ] 若 S001 证伪：告警退出、PRD 记录终止、不做代码改动 [假设: 按 PRD 裁定执行]
