# GOAL：任务目标管理

> 角色：工作任务管理，四个部分：起点、锚点、进程、历史。随工作实时更新。

## 起点

- **日期**：2026-09-04
- **起点**：上游 browser-harness-js 跑在 Bun 运行时上，agent 生态（Node 原生环境）需要零依赖的原生版本，遂发起 Node/TypeScript 移植（D01），当日完成并继续平台能力补齐（D02，六期验收通过）。随后建立 project-evo 文档体系（D03），把移植过程、架构决策与踩坑沉淀为可复用资产，需求从此走 PRD 驱动。

## 锚点

- **锚定的目标**：x-intel 监控与搜索分道独立（D40）+ 看板双侧栏折叠（D41，2026-09-10 立项）
  - 依据：用户指令「监控应该是自己轮询扫描有没有打开的 x.com 主页去附着，没有就继续等；x-intel 的搜索应该是自己新打开 tab 页去搜」。此前监控与搜索的 tab 归属混在一起（监控无 x.com tab 时自建 home tab，harvest 复用/导航它找到的 `/search` tab）
  - 追加：用户「看板左右两列都可以收缩折叠，按钮放到最下方，用两个箭头按钮」+「应用描述字数精炼一些」
  - 动作：worker 只附着 + 全 eval 钉 target；harvest 专属 tab 自开自收；看板底栏两箭头折叠双栏；SKILL/G002/P0002/README 同步；引擎隔离实验 + 看板 DOM 探针验收；0.6.7 提交推送封版

### 推进时间线

| 日期 | 进展 |
| --- | --- |
| 2026-09-10 | D41 看板形态：左右两列各自可折叠，折叠入口统一到最下方控制栏的两个箭头按钮（左端管左栏、右端管右栏，箭头指向下一次点击后的移动方向），状态存 localStorage；x-intel/page-detect 应用卡片描述收敛一句话。同日 0.6.7 封版（D40+D41 同版）：bump + CHANGELOG 封段 + pack/install/sync + `bh upgrade --offline --yes` 七步滚动终验全守护 0.6.7 看板 200，提交推送 + tag/Release |
| 2026-09-10 | D40 x-intel 分道：监控只附着（无 home tab 持续等待，永不自建 tab）+ 探针/收割 eval 钉 targetId 不抢活动 tab；harvest 自开专属 tab 自收自了；引擎隔离实验三景实证（无 home tab 只等不建 / 有 home tab 附着收割零建 tab / harvest 自开自收归还）；同版 0.6.6 资产滚动到本机安装态 |
| 2026-09-10 | 文档账实全面对齐：git 全史 review（86 提交/16 tag）-> proven 补齐 P0002（附着模型与人机共存）/P0003（看板与守护面运营化）/P0004（插件应用生态深化）-> GOAL 历史补 D12-D38 -> INDEX 同步（归档节、engine.ts、测试数 82） |
| 2026-09-09 | D38 收割风暴限流接线（0.6.4）+ 状态文案对齐（0.6.5）双发版；hs.d3fend.cn 看板事件混排诊断定案（x-monitor 只认 x.com，空白告警出自 page-detect watch）；封版规矩立档（版本三件套先问用户） |
| 2026-09-08 | 0.6.0 封版（D35 版本化元素引用/D36 技能资产激活/D37 自起 headless 引擎，吸收 S002/S003）+ 0.6.1-0.6.3 headless 命名三连定稿；同日 D28-D34 工程化七连（TS7/CLI 工程化 0.4.0/升级轮换 0.4.1/单飞锁清算 0.4.3/apps 类型护栏 0.4.5/Defuddle 0.5.0/看板旁路 0.5.1）；S004 发版流程定案 + 密钥扫描全史零命中；远程发布链路常态化（gh release + upgrade 闭环） |
| 2026-09-08 | 第三方封版评审（codex reviewer）：四项关键修复确认落地、74 用例全绿；3 项元数据阻塞当日修复，tag v0.3.0 |
| 2026-09-05 | D11 架构落地：S001 生死门通过（Chrome 144+ 官方 auto-connect 通道 + 本机 PoC 全链路 + 不抢焦点实证）-> 测试网 48 用例全绿 -> 移除 spawn 家族（agentChrome/taskIsolation/locks、bh chrome 与 chrome-mode）-> 附着发现（补 Chrome Dev/Beta、排除 Edge）+ 专属 tab 铁律 + x-monitor 改造 -> 真机附着冒烟（doctor attachable/current_tab 专属 tab/sessions 全景）；文档基线同步 README/SKILL/R001/CHANGELOG |
| 2026-09-05 | D11 立项：三轮拷问定共识（架构转向、彻底移除 spawn、专属 tab 铁律、用户自开为主、证伪即告警退出）；S001 研究启动 |
| 2026-09-04 | D10 x-monitor 关闭原语：stop|close 按序拆栈（supervisor -> worker -> 专属 daemon），start 显式化；空态幂等与按序停止均实测 |
| 2026-09-04 | D09 rmux 探测原语：bh rmux（panes 结构化 list + status 聚合），补齐监督面可观测性；同日完成 Python 版指代更新（browser-harness-py）与首提交推送（CI 六格首跑全绿） |
| 2026-09-04 | D08 状态探测原语落地：bh sessions（代码事实提炼的对象模型 + 实例清单 + 窗口分组 tab 表 + 附着策略）与 bh --new-tab；首用即发现 2 僵尸注册 + 4 残留 tab 并清理 |
| 2026-09-04 | D07 google-search 标准化落地：ensure_app_sdk 基建（源指纹注册判重）+ __gs SDK 1.1.0 + esbuild 构建链 + 两步契约；G002 六项门禁全过；踩坑 M008 四连环（execCommand 受控框/导航毁上下文/注册快照挡新版/过渡期瞬态）全部机制化 |
| 2026-09-04 | D06 应用开发标准形成：通读 skills 生态四仓（browse/twitter/google/sdk），差距矩阵评估 -> R002 方法手册 + G002 标准（强制项/禁令/验收门禁/迁移分级）；识别 SDK 注入基建 gap（ensure_app_sdk） |
| 2026-09-04 | D05 锁与浏览器互斥重构完成（学习 nu_plugin_browse）：Infinity 只死抢占 + meta 归属记录 + 端口表强杀三级关停；并发双 start 单实例、daemon 自愈重附着均验证 |
| 2026-09-04 | D04 五步闭环完成：双引擎实搜（google 直连成功、bing 中文命中）+ 两篇正文抓取；执行中发现 M006（bh chrome start 静默兜底 Edge）并当场修复验证（注册表扫描发现 + marker 停止 + 身份明示） |
| 2026-09-04 | 文档体系建成：根六原语、docs 六目录、R001/G001/M101/P0001、三平台基建（.gitattributes + CI 三系统矩阵） |
| 2026-09-04 | project-evo init 骨架生成；三问澄清（平台矩阵/骨架规模/历史回溯） |

## 进程

- 0.6.7 封版（D40 x-intel 分道 + D41 看板双栏折叠）：bump/CHANGELOG/pack/install/skill sync/`bh upgrade --offline --yes` 七步滚动全绿（全守护 0.6.7、看板 200），代码与文档随提交推送，tag v0.6.7 + GitHub Release 附件浏览器侧 tgz

## 历史

| 日期 | 目标 | 结果 |
| --- | --- | --- |
| 2026-09-10 | D41 看板双侧栏折叠与描述精炼 | 达成：底栏两箭头按钮各自控制左右栏（贴底 y=876）、宽度与箭头翻转状态实测、localStorage 持久化；x-intel/page-detect 描述一句话 |
| 2026-09-10 | D40 x-intel 监控与搜索分道 | 达成：监控只附着（无 home tab 等待、永不建 tab）+ eval 全钉 targetId；harvest 专属 tab 自开自收；x-search 仍只读本地库；82 测全绿 + 引擎隔离实验三景 |
| 2026-09-10 | 文档账实全面对齐 | 达成：git 全史 review 提炼 proven P0002/P0003/P0004，GOAL 历史补 D12-D38，INDEX 归档节与源码表同步 |
| 2026-09-09 | D38 x-monitor 收割风暴限流 + 状态文案对齐 | 达成：限流闸接线（声明未接线的 MIN_ROUND_SPACING）+ 节奏值模板引用常量；0.6.4/0.6.5 双发版，实机轮间隔 8-13 秒变 69-74 秒 |
| 2026-09-08 | 0.6.x 能力三连与命名定稿 | 达成：D35 元素引用 + D36 技能资产激活 + D37 headless 引擎封版 0.6.0；0.6.1-0.6.3 命名三连裁定（实例名/命令名/别名） |
| 2026-09-08 | D28-D34 工程化与稳定性七连 | 达成：TS7 配置对齐、CLI 工程化（0.4.0）、升级轮换（0.4.1/0.4.3）、单飞锁清算（0.4.3）、apps 类型护栏（0.4.5）、Defuddle（0.5.0）、看板只读旁路（0.5.1） |
| 2026-09-08 | S004 发版流程定案 + 密钥扫描 | 达成：单人 trunk 直推定合法形态、维持手动封版八步；git 全历史零密钥、HIGH 残留清零 |
| 2026-09-08 | D26/D27 共存双修 | 达成：GitHub issues 双修（tab 所有权马标记、后台 fill_input 回读）；非 home 页等待容错（0.3.1） |
| 2026-09-07 | 0.2.0 封板（守护面首波） | 达成：D12 只读看板、D13 四层结构重组、x-core 合一后解耦；D14 vendor 豁免；D16-D18 墙通知与应用卡片与页面守护、D19-D21 初始化收敛与 supervisor-core、D22-D25 应用四连（bing/super-ocr/x-intel 合约/medium）随后落地 |
| 2026-09-08 | 0.3.0 封版 + 文档账实对齐 | 达成：第三方评审无代码级阻断；3 项元数据阻塞修复（版本号两文件、README 示例、CHANGELOG 封版）；tag v0.3.0 |
| 2026-09-07 | D11 触发版复验 | 达成：x.com/home 标题 `(1)`，x-intel 启动 14s 内收割入库 +9（1003 至 1012），非 5min 兜底 |
| 2026-09-07 | D25 super-ocr 验证码图识别 | 达成：扫描当前页定位验证码图 + ppu-paddle-ocr；fixture 识别 K8M2；交互式拼图 CAPTCHA\|WALL |
| 2026-09-07 | D22 bing-search G002 | 达成：__bs + bs_search；实搜 5 条 title 非空 |
| 2026-09-07 | D23 x-intel search/harvest 合约 | 达成：固定形 JSON；stats 604 帖 |
| 2026-09-07 | D24 搜索与抓取极限测试 | 达成：双引擎 5+5 + 抓取一篇正文、一篇 DNS 失败如实 |
| 2026-09-04 | D10 x-monitor 关闭原语 | 达成：stop|close 按序拆栈，生命周期闭环（启停对称） |
| 2026-09-04 | D09 rmux 探测原语 | 达成：bh rmux 命令；监督面（x-monitor 链）可观测 |
| 2026-09-04 | D08 状态探测原语 | 达成：sessions + --new-tab；对象模型以代码为准（用户纠偏生效） |
| 2026-09-04 | D07 google-search 标准化 | 达成：G002 标准首个落地，基建 ensure_app_sdk 就位，六项门禁全过 |
| 2026-09-04 | D06 应用开发标准 | 达成：R002 + G002 落地，现有 9 应用完成迁移分级 |
| 2026-09-04 | D05 锁与浏览器互斥重构 | 达成：三乱源清零（M007），nu_plugin_browse 方法零依赖落地 |
| 2026-09-04 | D03 文档体系运转 | 达成：骨架+回溯建成，首个真实需求（D04）走完五步闭环 |
| 2026-09-04 | D04 实搜 TypeScript 稳定操作浏览器技术 | 达成：双引擎 13 条结果 + 2 篇正文；附带修复 M006 三连锁缺陷 |
| 2026-09-04 | D02 平台能力补齐 | 达成：P1-P6 六期全部验收通过（daemon 语义/语义层/插件生态/agent Chrome/任务隔离/录制视频/技能分发），方案归档 P0001 |
| 2026-09-04 | D01 Node 移植 | 达成：652 方法带类型，生成物与上游字节级保真（仅头两行注释不同），方案归档 P0001 |
