# 原语层（primitives）

> 交互契约的唯一权威源：一原语一文件。SKILL.md 只做索引；机制细节在 interaction-skills/（机制层），站点知识在 domain-skills（站点层），长跑业务在 workspace apps（应用层）。层间引用：原语 -> 机制 -> 站点 -> 应用。

| 原语 | 文件 | 一句话 |
| --- | --- | --- |
| 附着 | `attach.md` | 一切操作的第一步：只附加已打开的浏览器与网站，意图精准定位，永不 spawn |
| 搜索 | `search.md` | 规模透明、翻页要问、两步契约、墙如实报 |
| 抓取分析 | `fetch-analyze.md` | HTTP 优先三条件升级，付费墙截断说明，抽取不含 bh 痕迹 |
| 检测 | `detect.md` | 页面异常先七判（挑战卡死/网络停滞/被拦截/登录墙/空白/资源限流/正常），不轻言站点故障 |
| 可观测 | `observability.md` | 守护链 lazy 拉起 + 就绪探测 + 退避自愈；看板只读 peek 不清空 |

**关闭边界（硬规则，程序级强制）**：bh 可关自己开的 tab；绝不关用户开的 tab、绝不关闭/重启/最小化附着的浏览器。守卫在 `Session._call` 层（`Browser.close`/`Browser.setWindowBounds` 一律拒绝，`Target.closeTarget` 只放行自建 ∪ 马标记），直调 `session.domains.*` 同样被拦。
