# PLAN：当前目标实施计划

> 角色：当前目标方案文档：基于 research（为什么）与 references（怎么做）的执行计划；每条挂依据来源，不存历史目标。

## 当前目标

D22 bing-search 按 G002 升级（GOAL 回指 PRD D22；同批 D23/D24 排在本目标之后）

## 计划项

| # | 计划 | 依据 |
| --- | --- | --- |
| 1 | 新增 `assets/sdk/bing.ts`（`__bs`，ready/results/extract，挑战检测，Bing `/ck/a` 解码）+ `npm run build:sdk` | G002 结构与命名；google-search 全套路 |
| 2 | 重写 `assets/apps/bing-search.mjs`：ensure_app_sdk -> ready -> goto `/search?q=` -> 轮询 results -> stash `bs_search`；`pluck` / `ready`；墙 CAPTCHA\|WALL 不重试 | G002 强制项 1-6；M004/M008 |
| 3 | 同步 SKILL / README / primitives/search.md / G002 迁移表 / CHANGELOG | AGENTS 行为基线 |
| 4 | 开发态实搜一轮：指标 <1KB、pluck 有 title/url、墙如实报或无墙记 diary | G002 验收门禁 |

## 完成的定义

- [x] `bh bing-search <q> --top N` 只打指标 JSON（`_ok/_v/_ts/count/shape/bytes/cache`） [实证: 2026-09-07 count=5]
- [x] `bh bing-search pluck bs_search` 取出本批结果，title 非空 [实证: 五条均有 title]
- [x] 墙/挑战走 CAPTCHA\|WALL，不返回空数组、不自动重试（本轮无挑战页，代码路径已接）
- [x] SKILL 面登记命令 / cache 名 / 错误决策树 / 版本合约
