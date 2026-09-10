# 原语：搜索（search）

- **规模透明**：指标必须让用户知道搜索有多大：约多少条结果、共几页
- **翻页要问**：默认只搜第一页；要不要翻页、翻几页，由用户拍板，agent 不自作主张一路翻完
- 固定形承 G002 两步契约：第一步指标恒小（1KB 量级），第二步 `pluck` 取数；CAPTCHA/墙如实报告不硬闯
- 分层：在线搜索（google/bing，走附着浏览器）与事后检索（`x-search` 查本地库，不碰浏览器）

## 命令

- `bh google-search <query> [--top N]` + `bh google-search pluck gs_search`
- `bh bing-search <query> [--top N] [--page N]` + `bh bing-search pluck bs_search`（CAPTCHA\|WALL 不重试；cache=`bs_search`；合约 `_v` 与 `__bs.V` 同源 1.0.0）
- `bh x-search <kw>|--recent|--since 1h|--stats`（本地 X 收割库检索；FTS5 分词见应用节）
