# S004：GitHub 发版与分支开发合并标准流程调研

> 缘起：2026-09-08 用户完成独立调研并提供全文。本仓现状为「单 main 直推 + Conventional Commits + 手动 tag/Release 八步（R001）」，本文归档调研结论并给出对照应用。状态：已完成（归档 + 对照）。

## 一、结论速览（调研原文要点）

1. 没有「唯一标准」，主流三选一：GitHub Flow（官方轻量流，持续交付类首选）、Git Flow（显式版本化、多版本并存）、Trunk-Based（大团队高吞吐）。Git Flow 作者本人在 2020 反思注明确：持续交付 Web 应用别用它 [实证: nvie.com 原文反思注]
2. 分支开发合并的落地单元是 PR + 分支保护六步：建分支、提交、开 PR、评审、合并、删分支 [实证: docs.github.com github-flow 全文]
3. 合并三式（merge commit / squash / rebase）选型决定历史形态；发版官方载体是基于 Git tag 的 Release + 自动生成 notes [实证: about-releases]
4. 自动化发版生态：semantic-release（24.0k）、GoReleaser（16.0k）、release-please（7.5k），共同前提是 Conventional Commits [实证: 2026-09-08 gh search 星数]

## 二、三种分支模型与合并三式

| | GitHub Flow | Git Flow | Trunk-Based |
| --- | --- | --- | --- |
| 长命分支 | main 一条 | master + develop | trunk 一条 |
| 短命分支 | feature | feature/release-*/hotfix-* | 单人短命（<1 天） |
| 发布动作 | 合并即部署候选 | release 分支定版本，合回 master 打 tag | trunk 即切或直发，fix forward |
| 适用 | Web/持续交付 | 多版本并存（客户端、库） | 大团队高吞吐 |

合并三式：merge commit（保留分组，log 噪音）/ squash（最干净，丢逐提交 SHA）/ rebase（线性保逐提交，GitHub 重写 committer 不带签名）。仓库可只允许一种合并方式；Require linear history 可强制 squash 或 rebase [实证: about-merge-methods + about-protected-branches]。

## 三、分支保护标准配置（PR 门禁）

- Require PR reviews（N 批准、code owner、dismiss stale）
- Require status checks（CI 必过；strict 要求与 base 同步；merge queue 是无痛替代）
- Require conversation resolution
- Require merge queue（排队逐个验证，杜绝合并后 CI 才红）
- 默认禁 force push、禁删分支；新版形态 rulesets [实证: about-protected-branches 全文]

## 四、发版（GitHub Releases）

Release 基于 Git tag；notes 手写/模板/自动生成；源码 zip/tarball 自动附；额外资产上限 1000 个、单文件 2GiB；write 权限管理；安全修复 release 应同步 security advisory [实证: about-releases]。

标准手动序列：定 SemVer 版本 -> 打 tag（git tag -s 可签名）-> 建 Release 填 notes -> 传资产。

## 五、发版自动化工具

| 工具 | 星数 | 机制 |
| --- | --- | --- |
| semantic-release | 24028 | 解析 Conventional Commits，全自动 bump/changelog/Release/npm |
| goreleaser | 16024 | Go 生态多平台交叉构建+发布 |
| release-please | 7462 | Release PR 攒 changelog，人保留最终点击权 |

前置纪律均为 Conventional Commits [推断: 三工具文档共同要求，复核点各自 README quickstart]。

## 六、调研合成推荐（典型项目）

1. main 保护：PR 必须、1-2 批准、CI 必过、禁 force push
2. 短命 feature/fix 分支（一天内合完），不养长命 develop（除非多版本需求）
3. 默认 squash 换线性历史；仓库关闭不用的合并方式
4. Conventional Commits 纪律
5. release-please（保留人工决策）或 semantic-release（全自动）驱动发版；无自动化按第四节手动序列
6. 热修：持续交付型 fix forward；多版本型从生产 tag 切 hotfix 双合回

选型速查：Web/SaaS = GitHub Flow + squash + semantic-release；开源库/多版本 = release 分支 + release-please；大团队 = Trunk-Based + merge queue + feature flags。

## 七、本仓对照应用（browser-harness-ts，2026-09-08）

| 调研项 | 本仓现状 | 对照结论 |
| --- | --- | --- |
| 分支模型 | 单 main 直推（单人开发） | 即 GitHub Flow 的单人退化形态（trunk 直推），**维持**；不引入 develop/release 长命分支（无多版本并存需求，库与 CLI 同版发布） |
| Conventional Commits | AGENTS 规定 feat:/fix:/docs:/chore:/test: 一事一提交 | 已达标，且为将来自动化供料就绪 |
| 合并策略 | 无 PR（直推） | 单人期不适用；**开源接受外部贡献后启用 PR + squash**（届时在仓库设置关闭其余两式） |
| 分支保护 | 未设 | 可选吸收：**禁 force push 到 main**（防误推，单人也有价值）；review/CI 门禁待外部贡献出现再开 |
| 发版 | R001 封版八步（手动：版本/CHANGELOG/test/pack/install/upgrade 滚动/tag/Release/diary） | 即调研第四节标准序列的工程化加强版（多了本地安装验收与守护滚动），**维持手动**：自动化（semantic-release/npm 发布）与「不走 npm registry」裁定冲突，且会砍掉 diary/四原语治理链 |
| Release 资产 | tgz 附件 + notes | 符合官方机制（bh upgrade 的 Release 查询即消费此资产） |

净结论：现状是调研推荐谱系里「单人 GitHub Flow + Conventional Commits + 手动 tag/Release」的合法形态；唯一值得即刻采纳的是 main 禁 force push，其余按「外部贡献出现」为触发点演进。[推断: 对照判断，演进触发点待实践验证]

## 信源

- docs.github.com：github-flow / about-releases / about-merge-methods / about-protected-branches（全文）
- nvie.com Git Flow 原文（2010，2020 反思注，全文）
- trunkbaseddevelopment.com（首页）
- 工具星数：gh search 实测 2026-09-08
- 用户调研报告原文（2026-09-08 提供）
