# S003：Lightpanda 适配可行性

> 缘起：2026-09-08 用户裁定「全面适配 Lightpanda」先研究（AskUserQuestion：研究先行）；补充平台事实「Lightpanda 只能 Linux/macOS，Windows 下支持 WSL」。回答：Lightpanda 能否进 bh 的浏览器面，什么形态的适配有价值。状态：已完成（2026-09-08，文档级核查，未实机 PoC）。

## 研究问题

| # | 问题 | 类型 |
| --- | --- | --- |
| Q1 | Lightpanda 的平台支持与 Windows 可用形态 | 外部事实 |
| Q2 | 其自动化协议面（CDP 兼容度）能否承载 bh 的 652 方法直调 | 外部事实 |
| Q3 | 「全面适配」（发现/附着/应用全链）是否可行 | 结论 |
| Q4 | 有价值的适配形态是什么 | 结论 + 待立项 |

## 外部事实核查（2026-09-08，官方 README）

- 平台：Linux（x86_64/aarch64，glibc 系；musl/Alpine 不可）与 macOS 原生；**Windows 无原生构建，仅 WSL2**；WSL 自动转发 localhost:9222，客户端可在 WSL 或 Windows 侧 [实证: 官方 README；用户平台事实与之相符]
- 协议面：内置 **CDP server**（`serve --protocol cdp`，ws://host:port，仅 TCP/WS 无 pipe）+ WebDriver BiDi + 原生 MCP server（JSON-RPC stdio/HTTP）；Puppeteer/Playwright 可连；**CDP 域/方法覆盖未文档化**，要看其 WPT 结果与实测 [实证: 官方 README；覆盖面存疑，标注待 PoC]
- 形态：**headless by design，无图形渲染引擎**——png/pdf dump 为「文本渲染」；fetch 模式一次性输出 `--dump html/markdown/png/pdf` 自带等待判官（wait-until/wait-selector/wait-script）[实证: 官方 README]
- 能力面：v8 JS、DOM API、XHR/Fetch、点击、表单、cookie、自定义头、代理、网络拦截、adblock、CORS（实验）、robots.txt 遵从 [实证: 官方 README]
- 性能宣称：100 页爬取内存约 1/16、速度约 9 倍于 headless Chrome（项目自发布基准）[记忆: 自发布基准，未独立复验]
- 默认开遥测（LIGHTPANDA_DISABLE_TELEMETRY=true 关）[实证: 官方 README]

## 结论

- Q1 定案：bh 的主平台 Windows 上 Lightpanda 只能经 WSL2（额外依赖链：WSL + glibc 发行版 + 安装）；Linux/macOS 侧原生可用 [实证]
- Q2 定案：CDP server 存在但方法覆盖未知且**无渲染引擎**（Page.captureScreenshot 等视觉域必缺）——bh 的 652 方法全类型直调在其上必然大面积 unsupported：「协议即 API」的产品面在 Lightpanda 上不成立 [推断: README 未列覆盖面 + 无渲染引擎事实，PoC 可定案]
- Q3 定案：**「全面适配」（发现/附着/应用/录制全链）不可行也不该做**：bh 的价值面（附着用户真浏览器、人机共存、全协议直调、录制截图）全部依赖真 Chromium；Lightpanda 是另一物种：无头、无渲染、批量取数 [推断]
- Q4 结论：有价值的适配形态是 **web-fetch 引擎分级的可选中层**（Kinbrowser 模式，S002 已旁证）：HTTP（现有）-> Lightpanda（JS 渲染 + markdown 输出 + 低内存，fetch --dump markdown 或 serve + CDP 调它的 fetch）-> Chrome（现有，登录态与复杂页）。bh 的 BH_CDP_WS 钉死通道现已可直连其 CDP server 尝鲜（能力子集内）；正式形态建议 D37：BH_LIGHTPANDA=1 启用，Windows 经 wsl -e lightpanda 探测 [推断: 价值判断，PoC 验证 WSL 转发与 fetch 输出质量后立项]

## 信源

- lightpanda-io/browser 官方 README（raw.githubusercontent.com，2026-09-08 取）
- S002 赛道全景（Kinbrowser 分级引擎同构旁证）
