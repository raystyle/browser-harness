# 原语：抓取分析（fetch and analyze）

- **升级链固定**：HTTP 优先 -> 三条件升级附着浏览器（空 / 墙词 / 正文 <20 词）-> 正文抽取（站点选择器 + 兜底抽取）
- **墙如实报**：被墙、限流、付费墙都是**状态**不是空结果；付费墙截断要说明取到多少、缺多少（登录墙：停下让用户登录，凭据越界）
- 抽取产物不含 bh 自己的痕迹（马标记剥除）
- 异常页先跑 `bh detect`（见 detect.md），不轻言站点故障

## 命令

- `bh web-fetch <url> [--browser|--current]`

## 正文提取引擎（0.5.0 起）

浏览器路径在已渲染页面内注入 Defuddle（Obsidian Web Clipper 同源库，自包含 IIFE，零 runtime 依赖）：干净正文 + title/author/published/description/content_html，GitHub/Wikipedia/Reddit/YouTube 有站点专用提取器；失败自动降级启发式不断供（stderr 一行诊断）。HTTP 优先与三条件升级不变。Medium 付费墙截断如实呈现，浏览器登录态下 `--browser` 可拿全文。
