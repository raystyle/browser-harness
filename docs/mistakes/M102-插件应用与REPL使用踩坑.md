# M102：插件应用与 REPL 使用踩坑

> 分类文件：插件应用开发（medium-search 首落地）与 bh 片段求值使用的实证坑。行级条目接编在下方；新坑当场落行，二犯升格配机器约束。

| 行级编号 | 坑 | 处置 | 状态 |
| --- | --- | --- | --- |
| M009 | repl 对多语句片段（含分号/换行）不自动补 `return`，仅单表达式自动包 `return (...)`；片段求值结果 undefined 时 CLI **静默空输出且 exit 0**，极易误诊为「没执行」 | 片段末尾显式 `return`；已进 SKILL 陷阱速查 [实证: 2026-09-07 medium 研究期三度空输出后读 src/repl.ts:72-93 定位] | 已机制化（文档约束） |
| M010 | node 侧模板字面量内嵌 `'\n'` 与三反引号被外层先解释：`\n` 成真换行 -> 页内收到未闭合字符串 -> SyntaxError；三反引号直接终结模板。`js()` 不检查 exceptionDetails，页内异常一律**静默返 undefined**，与 M009 叠加成「空输出」假象 | 内嵌一律 `\\n` 与转义反引号，或单引号拼接；调试用裸 `cdp('Runtime.evaluate', ...)` 看原始响应（含 exceptionDetails）；已进 SKILL 陷阱速查 [实证: 2026-09-07 med-page/med-g 两脚本空输出根因] | 已机制化（文档约束） |
| M011 | CF 对页内同源 `fetch('?format=json')` 连续请求 tarpit：每页首约 2 次 200，其后连接挂起不响应；`awaitPromise` 的 evaluate 永不落定，CDP 层只见超时或静默 | 站点正文提取弃页内 fetch、全走 DOM（导航 + 块遍历）；SDK 方法保持同步不返回挂起 Promise；medium-search 已按此实现 [实证: 2026-09-07 med-d 同轮 a/b 成功 c 起全挂] | 已机制化（架构决策） |
| M012 | Medium 过墙后搜索结果被会话级限流：Stories tab 空、SPA 可能卡在 Topics 内容；文章页不受影响。表现为应用 TIMEOUT（20s deadline）而非错误，重导航与点 tab 均不恢复 | 如实 TIMEOUT 上报（不硬闯不伪装空结果）；SKILL 面记录已知行为；等会话恢复或换登录态 [实证: 2026-09-07 重启 daemon 后 cards=0，grab 同会话正常] | 已处置（观测记录） |
| M013 | supervisor-core 把缺心跳（age === null）当 stale：ensureCompanions 先起 page-detect 再起 supervisor，首拍尚无 page-watch.json 就杀刚起来的进程；unwatch 只杀会话写 stopped，监督面不读该状态，下一拍又拉起 | 缺心跳且会话仍活 → 不重启；stopped 状态跳过；新会话 SPAWN_GRACE；ensureCompanions 同样跳过 stopped [推断: 2026-09-07 review Issue 1/2，逻辑修复已落地，实机循环待复验] | 已机制化（代码约束） |
| M015 | ppu-paddle-ocr `recognize(string)` 只认以 `/` 或 `http` 开头的路径；Windows `D:\...` 被当成 Canvas，抛 `image.getContext is not a function` | 一律把 PNG 读成 ArrayBuffer 再传入；super-ocr 已按此实现 [实证: 2026-09-07 fixture 裁剪成功后 OCR 报 getContext] | 已机制化（代码约束） |
| M016 | Windows + fnm：`Get-Command npm` 是 `npm.ps1`，`spawnSync('npm.cmd')` 无 PATH 直调失败（status null） | setup 走 `node npm-cli.js`（与 node.exe 同目录），不经过 .cmd/.ps1 [实证: 2026-09-07 super-ocr setup 首跑 exit null] | 已机制化（代码约束） |

## 复发监控

- M009/M010 为使用层约束（文档），若再现考虑升格：repl 对多语句片段无 return 时打 warning（改 src/repl.ts 需 PRD）
- M011 已内化为 medium-search 架构；其他站点接入时沿用「DOM 优先、页内 fetch 限用」判据
