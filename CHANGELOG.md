# Changelog

本文件记录可交付变更。粒度纪律：只留版本级里程碑（定位变更/发布/阶段完成/核心能力整体落地）。

## [0.6.7] - 2026-09-10

- **x-intel 监控与搜索分道（D40）**：此前监控与搜索共用一套 tab 心智：监控在无 x.com tab 时自作主张后台新建 home tab，harvest 又会抓任意 `/search` tab 直接导航（用户自己的搜索页被劫走）。现分三条独立线：① **监控只附着**，6-8 秒轮询找用户已打开的 x.com 主页（根 / `/home` 时间线）去附着，没有就持续等待（看板显示「等待打开 x.com 主页 tab」），**永不新建 tab**；探针与收割 eval 全部按 targetId 钉死（`js(expr, tid)`），不再抢 daemon 活动 tab。② **搜索（`bh x-intel harvest`）自开自收**：无参 `new_tab()` 必建全新后台 tab 跑 x.com/search 分片（绕开空白页复用，不劫持用户空 tab），跨分片复用一个 tab，收工 `finally` 关闭；若期间用户接管该 tab 则保留不动。③ `bh x-intel search` 仍只读本地库。验收：引擎隔离实验三景（无 home tab 只等不建 tab / 有 home tab 附着收割零建 tab / harvest 自开自收归还）
- **看板双侧栏可折叠（D41）**：左右两列各自可收起/展开（右侧栏此前不可折叠），折叠按钮从左侧接缝的小圆点改为**窗口最下方的一条控制栏 + 两个箭头按钮**（左栏在左端、右栏在右端；箭头指向「下一次点击后侧栏移动的方向」，收起态 ▸ / 展开态 ◂），状态按浏览器存 localStorage。顺带精炼应用卡片描述（x-intel / page-detect 收敛成一句话）

## [0.6.6] - 2026-09-10

- **命令输错 CTA 提示（D39）**：退役命令名（如 0.6.2 已改名 `headless` 的 `engine`）此前掉 legacy 裸片段直通，被 daemon eval 炸 `ReferenceError` 误导为程序 bug。现两层 CTA：退役表精确拦截（stderr 给改名说明 + **带用户原参数拼出的可直接执行命令**，exit 2）；postEval 的 ReferenceError 通用层追一行双路径指引（`bh --help` 查命令表 / 检查 JS 片段变量与助手名拼写），agent 可直接执行 stderr 指令。顺带修正 0.6.4/0.6.5 两版 package-lock version 漏同步欠账

## [0.6.5] - 2026-09-09

- **x-intel 状态文案与实际节奏对齐（D38 收尾）**：应用卡片「检测节奏」与启动日志仍写「5 秒探测」，为 D34 错峰改造前残留（实际 6-8 秒随机探测），且未体现 D38 轮间隔限流。两处文案改为模板引用常量：`6-8 秒随机探测 · 轮间隔 ≥${MIN_ROUND_SPACING} 秒`（X_MIN_SPACING 可配时随动），防文案再漂移

## [0.6.4] - 2026-09-09

- **x-monitor 收割风暴限流接线（D38）**：`MIN_ROUND_SPACING`（`X_MIN_SPACING`，默认 60s）自声明以来从未接入主循环（`lastRoundAt` 只写不读）；叠加触发探针的标题徽章 `(N)` 路径在后台 tab 永不清零，实机 ~10s 一轮空转收割（每轮「新贴 6 · 已存在 6」刷屏看板）。主循环接线轮间最小间隔（带心跳等待，supervisor 视角存活不变），触发语义与收割面不变

## [0.6.3] - 2026-09-08

- **技能面与文档对齐 0.6.x 能力**：SKILL.md frontmatter 补元素引用/无头引擎/升级轮换；CLI 表加 `bh upgrade`、`bh headless`（hl 别名）、`skill sites/site`；错误规约升级为退出码表（0/1/2/3）+ 写操作 dry-run 纪律；timeout 段补 remote 429 退避重试与挂锁自动清算。README 补无头引擎小节（`bh headless start --cookies`）与站点知识自动装载条目；仓库描述精简为一句

## [0.6.2] - 2026-09-08

- **命令定名 `bh headless`（别名 `bh hl`）**：无头引擎命令从 engine 收敛为语义直白的 headless + 两字母缩写；实例名 headless-engine 与 `--engine` flag 不变；usage 与提示文案同步

## [0.6.1] - 2026-09-08

- **引擎实例改名 headless-engine**：`bh engine` 命令名不变，专属 daemon 实例（BH_NAME/注册表/web-fetch 转发）统一为 `headless-engine`（语义精确）；修全局替换误伤命令名导致的 `bh engine` 掉落裸片段路径；二进制定位 CLIXML 噪音收敛（stderr 隔离）

## [0.6.0] - 2026-09-08

- **封版前增补（A+B+C+D37 PoC）**：rmux 会话 cwd 统一落 BH_HOME（四处 ensureSession 补 cwd，安装态进程不再挂仓库目录）；`/health` 增 `buildTime`（dist mtime），漂移检测比对版本+构建戳，同版本号热修重装不再骗过 upgrade（当天踩中两次）；Defuddle 四站实测基线入 fetch-analyze 配方（medium 专用提取器最优、GitHub generic 可用、Wikipedia/Reddit 降级兜底、断网如实报）；D37 引擎 PoC 实证：自起 headless Chrome（临时 profile + port 0）经 `BH_CDP_WS` 连接，D11 全部纪律与 D35 引用机制在 headless 上完整工作，用完即杀用户面无扰，自起 headless 是 Lightpanda 中层的超集方案（S003 增补），正式集成待 D37 立项
- **版本化元素引用（D35，S002 吸收 + PinchTab a11y 观测面合并）**：新增 `snapshot_interactives()` / `click_ref(ref)` / `fill_ref(ref, text)` 语义助手。snapshot 出**最小观测面**：可见可交互元素（button/a/input/select/textarea/[role]）的语义清单 `{version, items:[{ref, role, name, tag, box}]}`（a11y 风格 role/name，上限 50 + total 如实，替代整页 DOM 喂模型）；动作时 ref 经**同一收集器重解析 + elementFromPoint 自证**，元素消失/位移/被遮挡如实报 `STALE_REF`（防 agent 记旧状态盲点），畸形 ref 报 `BAD_REF`；click 复用 click_at_xy 坐标真点击、fill 复用 fill_input（回读严格相等 + activate 重试）。附 element-refs 配方（interaction-skills 第 17 篇）与 SKILL 路由
- 上游同步核查（js 仓 09-04 以来 9 条合并）：video#757 结构免疫（ffmpeg 路线）、auth#755 回流为 cookie-io 受控 JSON 解析、raw-cdp#764 文档不冲突（TS 形态不同）；py 主仓停 09-04 基线
- CI 三平台矩阵今日全部 push 连续 success

## [0.5.2] - 2026-09-08

- **技能资产激活（D36）**：interaction-skills/domain-skills 长期低触发的三重根因修复。分发面补全：`bh skill sync` 现在把 `primitives/` 与 `domain-skills/`（94 站，1.6MB）一并铺进 ~/.claude 与 ~/.codex 的技能目录，agent 技能树自包含；domain-skills 提示**默认开启**（`BH_DOMAIN_SKILLS=0` 显式关），`goto_url()` 返回自动附 `domain_skills` 文件清单与 `bh skill site <段>` 提示；新原语 `bh skill sites`（列 94 站）与 `bh skill site <段>`（一条命令读站点知识全文，NOT_FOUND 退码 3）；SKILL.md 加「动手前硬性两步」路由（站点任务先读站点知识、冷门交互先查配方）

## [0.5.1] - 2026-09-08

- **看板只读旁路消除高频抢锁（D34）**：看板每秒快照对每实例发 list_tabs/current_tab eval 几乎常占 daemon 单飞锁，worker 探测/收割高频撞 429（实测 12 点后 x-intel 38 次、page-detect 50 次，看似两应用冲突实为看板两头抢锁）。修复四件套：daemon 新增只读旁路端点 `GET /tabs`（list_tabs + current_tab 合并）与 `GET /peek`（事件环窥视），不占 eval 单飞锁；看板 tabs/peek 改走旁路；remote 层（worker/应用统一通道）遇 429 自动退避重试（400ms/1.2s 两级），瞬时锁竞争不再上抛为应用失败；应用节奏错峰标准落 G002 第 8 条（page-detect 10s ±15% 抖动 + 页间 150ms、x-intel 6-8s 随机，互质 + 抖动防定点对齐）

## [0.5.0] - 2026-09-08

- **web-fetch 正文提取升级 Defuddle（D33）**：浏览器路径改为在已渲染页面内注入 Defuddle（kepano/Obsidian Web Clipper 同源库）解析：干净正文 + 元数据（title/author/published/description/content_html/markdown）+ 站点专用提取器（GitHub/Wikipedia/Reddit/YouTube 等）；defuddle 为构建期 devDependency，esbuild 打成自包含 IIFE（`assets/sdk/extract.min.js`），**运行时依赖白名单不变**；失败降级原启发式不断供（stderr 一行诊断）；HTTP 优先与三条件升级不变；输出形状向后兼容（新字段可选追加）。顺带消除 medium.com 等大页「老是 500」的根因：旧路径回传整页 outerHTML（几 MB）触发 CDP 大返回冻结（M102 同源），新路径只回传 KB 级干净正文；付费墙截断如实呈现（登录态经附着浏览器可用）

## [0.4.5] - 2026-09-08

- **apps 层类型护栏（D32）**：新增 `tsconfig.apps.json`（allowJs + checkJs + noEmit，strict 继承、隐式 any 渐进后置）纳管 assets/apps 全部 .mjs 的类型检查，`npm test` 前置执行（`typecheck:apps`）；分发模型零变化（apps 仍是纯 .mjs 原样铺装）。清 41 处真错误（空值/属性访问/参数匹配）：null 初始化容器 JSDoc cast、catch 变量 instanceof 收窄、`process.argv[1]` 兜底、spawn 返回 cast；顺带清掉 worker `setTimeout(r*1||r)` 的 NaN 把戏（行为等价改直写）。两步契约模板（bing/google/medium/cookie-io）入口与工具函数补 JSDoc 形参类型

## [0.4.3] - 2026-09-08

- **单飞锁僵尸清算（D31）**：挂起且不结算的 eval 此前会闩死 daemon 单飞锁，守护类应用（page-detect watch）随之 429 瘫痪到人工重启。两层修复：daemon 侧每个 eval 都有清算上限（客户端 `?timeout=` 或默认 `BH_EVAL_TIMEOUT` 300s；超时未结算，过宽限期后单飞槽自动释放，孤儿 snippet 的残余 CDP 调用各自带短超时自然排干）；page-detect watch 连续 2 次 `eval busy` 自动重启自身 named daemon 清锁（兜底旧版 daemon）。实机验证：`await new Promise(()=>{})` 挂锁 504 后约 36 秒新 eval 恢复正常
- **upgrade 补 named daemon 步**：companions 重拉只附着已活 daemon 不换代码，page-detect 这类 named daemon 须显式重启；upgradePlan 增该步（附单测），漂移终验实机抓出该盲区后修复；x-intel 终验改轮询重试（start 返回时 daemon 尚在附着）

## [0.4.1] - 2026-09-08

- **升级轮换原语 `bh upgrade`（D30）**：守护进程版本漂移检测自动化：任何 bh 命令启动时轻量比对 `/health` 自报 version（缺字段视为 pre-0.4.0 老版），漂移则 stderr 提示一行；轮换显式执行：默认 dry-run 打印五步滚动计划，`--yes` 执行（x-intel 按序拆栈、companions 停、default daemon 重生、dashboard 换新、x-intel 恢复），spawn 子进程复用既有 stop/start 语义，用户 stopped 状态尊重不拉，终验 health.version 全对版 + 看板 200。包源三态：默认查 GitHub Release 最新版（不高于本地绝不降级，查询失败离线降级为滚动本地）；`--from <tgz|URL>` 显式源（URL 自动下载；安装经后台引导进程在本进程退出后执行，规避 Windows 运行中 dist 文件锁，装完自动续跑滚动）；`--offline` 跳过 Release 查询
- **修复 Commander 选项三连环**：新命令未注册 KNOWN_COMMANDS 被裸片段路径吞给 daemon；action 回调参数语义误用（无参命令第一参是 opts 非命令对象，统一闭包 `cmd.opts()`）；顶层 `-y/-n` 与子命令同名 flag 抢占（`enablePositionalOptions()`：子命令前的 flag 归顶层、后的归子命令）；program 级操作数改从 `program.args` 取。实机滚动验收 0.4.0 至 0.4.1 五步全绿

## [0.4.0] - 2026-09-08

- **CLI 工程化（D29）**：引入 Commander（结构化命令解析）与 Zod（环境变量与写操作选项校验）两个运行时依赖，零运行时依赖承诺改为白名单制（AGENTS/README/SKILL 同步）；裸 JS 片段与插件路由保持原直通路径（agent/插件合约零变化）；用法错误退出码统一为 2（G002 退出码表：0 成功 / 1 失败 / 2 用法 / 3 NOT_FOUND）；写操作默认只读：`bh --restart` 与 `bh skill sync` 不带 `--yes` 只打印计划（dry-run 语义），`--yes` 才执行（R001/README 步骤同步）；`--help` 升级为 Commander 标准帮助
- **TypeScript 7 升级与编译配置对齐（D28）**：devDependencies typescript 5.9.3 升 7.0.2（原生编译器），零错误直过；tsconfig 增量严格开关 `exactOptionalPropertyTypes`（清 12 处「可选属性赋 undefined」：接口侧显式 `| undefined` 联合 + fetch signal 条件展开 + rmux version 条件展开）、`noImplicitOverride`、`isolatedModules`、`incremental`（tsbuildinfo 入 gitignore）；`strict` 与 `noUncheckedIndexedAccess` 原有。module 保持 NodeNext（纯 Node ESM 库正解，preserve/bundler 为打包器场景不采纳）；74 用例全绿

## [0.3.1] - 2026-09-08

- **x-monitor 人机共存容错（D27）**：用户浏览 x.com 非 home 页（推文详情/搜索/主页）时不再「刷新失败」报错刷屏：探测与收割只认时间线 tab（`x.com` 根或 `/home`），用户浏览期间静默等待（状态卡记「等待时间线 tab」，不写 degraded 不发错误事件），回到时间线即恢复；完全无 x.com tab 时仍后台自建 home（原行为不变）

## [0.3.0] - 2026-09-08

- **review 收尾（bug 6 与建议 7-11）**：看板 URL 判定改 URL 解析精确匹配 host+port（`127.0.0.1:98700` 这类前缀同形端口不再被误判为控制面），page-detect/super-ocr 复用 dist host.ts 共享判定，附 host.test.ts；`fill_input` 表单控件回读改严格相等（预含针值不再误判成功而跳过重试）；`setDiscoverTargets` 失败不再闩死本连接的 target 发现；super-ocr `NOT_FOUND` 退码 3 对齐 G002 命令层契约；cdp() JSDoc 归位、看板 1s 推送与快照形状注释对齐；README 重整：内置应用一览表、环境变量配置表、修落单代码围栏与「没有 helpers 文件」过时表述
- **第三方 review 修复（6f1bf28..ca23f93 范围，5 bug）**：page-detect 白屏持久化告警从未触发（streak 达标时边沿条件必然不成立）改为阈值跨越告警一次/回合（M017）；`bh x-intel start` 冷启动补拉 supervisor-core（selfManaged 应用此前无人守护 worker）；`/eval` 单飞互斥，超时未结算的 snippet 期间新求值 429 拒绝，不再与上次并发；Target 脱离追踪改用 sessionId（params.targetId 系可选废弃字段，缺省时附着状态滞留）附回归测试（M018）；page-detect 巡检 interval 持久化到 status 文件，ensureCompanions 与 supervisor-core 重拉沿用，`watch --interval` 请求不同节奏时杀会话重拉
- **issue #1/#2**：daemon 重启后认领马标记 tab 进 ownedTargets；`fill_input` 填后回读，吞掉则 activate 重试；`/eval?timeout=` + CLI `BH_EVAL_TIMEOUT`（默认 300s），超时提示 daemon 上可能仍在跑；wait/fill 的 timeout 单位为秒，>3600 告警并封顶 600s
- **super-ocr 验证码图识别（D25）**：扫描当前网页定位验证码图片，用 ppu-paddle-ocr 识别（不自动填写）；交互式拼图/滑块如实报 CAPTCHA\|WALL；引擎按需安装到 `<BH_HOME>/ocr`
- **ffmpeg 探测与 mp4 导出**：合并 Windows 用户 PATH（agent 进程也能找到 `D:\ohmyenv\ffmpeg\bin`）；ffmpeg 9 改 `-fps_mode vfr`（`-vsync` 已删除）
- **看板左侧栏**：去掉标题栏「部署信息」按钮，改为主区左侧分割条箭头收起/展开
- **看板禁止当工作 tab**：default 与应用 attach/goto/switch/new_tab 拒绝 `http://127.0.0.1:9870`；已附着则跳到新空白页再导航，不把看板页开走
- **墙通知文案**：标题 `bh · <判定>`，正文三行（页面 / 原因 / 地址）
- **bing-search G002 升级（D22）**：常驻 `__bs` SDK + 就绪判官 + 两步契约 `bs_search`；墙走 CAPTCHA\|WALL 不重试；修 title 偶发空（M004）
- **x-intel search/harvest 合约对齐（D23）**：JSON 固定形 `_ok/_v/_ts`；空库 count=0；harvest 完成打指标不打正文
- **supervisor-core 通用守护**：监督 page-detect 与 x-intel worker；删掉 x-intel 内嵌 supervisor / rmux `x-supervisor`。`bh x-intel start` 只拉 `x-monitor` worker，stop 先写 stopped 再杀 worker。按需应用（x-intel）未启动不拉起
- **监督面纠偏**：supervisor-core 不再把缺心跳当 stale（冷启动/unwatch 不再误杀 page-detect）；`unwatch` 写 stopped 后 ensureCompanions / supervisor 都跳过；init companions 先 provisionWorkspace 再拉起
- **X 监控应用定名为 x-intel**：去掉旧名与 CLI 别名；workspace 退役旧入口与组件目录
- **看板**：lazy 未附着显示待命（不再误报已脱离）；应用卡拖放监听只绑一次；最近事件按契约渲染（x-intel 零入库不写 event）
- **medium-search 插件应用（D15）**：medium.com 站内搜索 + 文章抓取（SDK `__ms` 常驻 + 两步契约 `ms_search`/`ms_article` + 人机共存 tab 策略）；G002 六门禁验收，墙场景被真 CF 挑战实证
- **看板墙提醒（D16/D18）**：墙类判定边沿弹 Chrome 系统通知（requireInteraction + tag 去重 + 点击只聚焦看板）+ 右栏钉住横幅 + 权限引导；page-detect 转 watch 常驻监测全部页面（Google 验证/Cloudflare 挑战/登录墙/资源阻断/白屏持久化），通知吃 alerts 流防重放
- **看板应用卡片区（D17）**：独立「应用」区七卡（描述/运行流水/日志行/库存/墙高亮，折叠拖拽持久化）；平台层 app-runs.jsonl 运行流水（应用零改造）；部署信息栏默认隐藏；刷新 tick 内联 tag 流
- **初始化原语（D19）**：首次使用判系统环境自动带起默认守护 + rmux 守护 + 看板（幂等、不动既有附着、Node ≥22 闸）；看板页版本握手自动重载
- **tab 所有权注册两处修复（issue #1）**：createTarget 所有权注册从 dispatchRaw 下沉到 Session._call 传输层（守卫与注册同层，`bh --new-tab` 建的 tab 此前永远关不掉）；连接后调 `Target.setDiscoverTargets` 接通 targetInfoChanged（马标记所有权分支此前是死代码）；附回归测试
- 全仓术语修正：封板 -> 封版

## [0.2.1] - 2026-09-07

- **看板实例状态渲染 BUG 修复**：数据层早已平铺（alive 在实例行上），前端仍读旧嵌套结构（i.daemon.alive）导致 x-intel 恒显 down；渲染层全面改读平铺字段
- **独立应用与 x-intel 组件解耦**：google-search/web-fetch/bing-search/cookie-io/page-detect 内联 bhHome（修复 google-search 因 import 已删 x-lib 而崩溃）；cookie-io 用法文案同步改名
- **page-detect 七判建议中文化**；domain-skills 副本遗留（x 系空壳 + .py）清理，源=副本=94 站
- 全面 review 验证：55 测试、六应用冒烟、守护铁律拦截（Browser.close / 外来 targetId）、domain-skills 四机制（挂载/内容/回退/一致性）

## [0.2.0] - 2026-09-07

- 新增只读网页看板 `bh dashboard`（D12，127.0.0.1:9870）：macOS 风格单页，SSE 每 2 秒推送：守护实例健康、附着面（各实例活动 tab 与全部可操作 tab，马标记归属）、rmux 会话/pane 树、x-monitor worker 心跳与日志尾、页面健康判定、事件流尾；事件用新增的 `__bh_meta peek` 原语非破坏窥视（绝不 drain，不干扰 x-monitor 触发器）
- 新增检测应用 `bh detect [url片段]`：附着既有 tab 的页面诊断（challenge-stuck / network-stalled / blocked / login-wall / blank / asset-throttled / ok 七判），事件流证据（失败请求、4xx/5xx、Cloudflare 挑战平台、墙词）+ 处置建议，固定形合约报告恒小；首跑实测揪出 Medium 登录失败真因（graphql 429 限流 + 挑战 + 第三方脚本超时叠加）
- **架构转向（D11）：附着用户浏览器 + 人机共存**。bh 永不 spawn 浏览器：daemon 经 DevToolsActivePort 发现并 WS 直连用户自己打开的 Chrome（144+，chrome://inspect/#remote-debugging 官方 auto-connect 通道；每条新连接弹一次 Allow）；专属 tab 铁律（马标记 -> 空白孤儿 -> 后台新建 background:true 不抢焦点，永不自动选中用户正在看的页面；操作用户 tab 须显式 switch_tab/set_session 授权）；空态如实报错并给开启指引；发现范围覆盖 Chrome Stable/Dev/Beta/Canary 并排除 Edge；idle 退出与 daemon 关停只关自身连接。移除 spawn 家族：agentChrome.ts、taskIsolation.ts（--once/--batch）、locks.ts、`bh chrome start/stop/status`、`bh chrome-mode`；x-monitor 改为附着用户浏览器（无可附着时如实报指引，用户关浏览器即监控暂停）。测试网先行：48 用例锁存活语义（键位真值、tab 纪律、自愈链、发现排序、Edge 排除、专属 tab 铁律）
- 新增状态探测原语 `bh sessions`：浏览器对象模型（instance/browser/session/tab/placeholder/window/navigation，按代码实际结构定义）+ 全实例清单（含僵尸注册如实报）+ 窗口分组 tab 表 + 新任务附着策略（attach / app 复用 / explicit / isolated）；新增 `bh --new-tab '<js>'` 显式新开 tab 执行原语
- google-search 标准化升级（G002 首个落地）：新增 `ensure_app_sdk` 基建（Page.addScriptToEvaluateOnNewDocument 源指纹注册 + 自动重注入）；`__gs` 页面常驻 SDK（固定形合约 `_ok/_v/_ts`，版本 1.1.0）；esbuild 构建链（devDependency，零 runtime 依赖不变）；两步契约（`bh google-search <q> --top N` 出指标落盘，`bh google-search pluck gs_search` 取数，指标恒 <1KB）；CAPTCHA/墙如实报告不自动重试（M008）
- 锁与浏览器互斥重构（学习 nu_plugin_browse）：锁文件支持 meta 与 `stealAfterMs: Infinity`（只认 pid 死亡，消灭偷活锁双 spawn）；agent Chrome 启动在锁内写归属记录（bh-agent.json），运行判定从「端口活着」升级为「端口活 + 归属一致 + UA 家族匹配」；stop 补端口表强杀兜底（netstat/lsof -> kill -9）（M007）
- 修复 Windows 浏览器发现：chromeBinary 改注册表扫描（StartMenuInternet + App Paths）+ CDP 偏好排序，替代硬编码路径与失效的 `--version` 探测；`bh chrome stop` 改命令行 marker 定位（可停掉任意 Chromium 系浏览器）；`bh chrome start` 输出明示所选浏览器（M006）

## [0.1.0] - 2026-09-04

- 协议层：CDP 56 域 652 方法带类型直调，生成物与上游 browser-harness-js 字节级保真（仅头两行注释差异）
- 语义层：Python 同名 snake_case 助手（Host 无关），domain-skills 97 站资产原样可用
- daemon：事件环形缓冲、马标记、陈旧 session 自愈、看门狗；`bh` CLI 自动拉起与转发
- agent Chrome：继承老栈 profile 登录态；`bh chrome start/stop/status`、`bh chrome-mode`
- 插件生态：web-fetch / google-search / bing-search / cookies / x-monitor（rmux 自愈监督 + sqlite 存储）
- 录制与视频：每动作一帧；导出 HTML 幻灯片（mp4 合成待 ffmpeg）
- 任务隔离：`bh --once` / `bh --batch`（独立实例 + 克隆登录 profile + 内核保留端口）
- 技能分发：三线哈希防漂移、只增不删（`bh skill status/sync`）
- 工程化：零运行时依赖（Node >=22）、project-evo 文档体系、CI 三系统矩阵
