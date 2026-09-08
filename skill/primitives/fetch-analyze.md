# 原语：抓取分析（fetch and analyze）

- **升级链固定**：HTTP 优先 -> 三条件升级附着浏览器（空 / 墙词 / 正文 <20 词）-> 正文抽取（站点选择器 + 兜底抽取）
- **墙如实报**：被墙、限流、付费墙都是**状态**不是空结果；付费墙截断要说明取到多少、缺多少（登录墙：停下让用户登录，凭据越界）
- 抽取产物不含 bh 自己的痕迹（马标记剥除）
- 异常页先跑 `bh detect`（见 detect.md），不轻言站点故障

## 命令

- `bh web-fetch <url> [--browser|--current]`

## 正文提取引擎（0.5.0 起）

浏览器路径在已渲染页面内注入 Defuddle（Obsidian Web Clipper 同源库，自包含 IIFE，零 runtime 依赖）：干净正文 + title/author/published/description/content_html，GitHub/Wikipedia/Reddit/YouTube 有站点专用提取器；失败自动降级启发式不断供（stderr 一行诊断）。HTTP 优先与三条件升级不变。Medium 付费墙截断如实呈现，浏览器登录态下 `--browser` 可拿全文。

## Defuddle 实测基线（2026-09-08，--browser 路径）

| 站 | 结果 | 说明 |
| --- | --- | --- |
| medium.com 文章页 | 专用提取器命中，title/author/published 全出 | 文章型页面是 Defuddle 最强场景 |
| github.com 仓库页 | generic 命中，正文 302 词 | 专用提取器未触发，generic 质量可用 |
| en.wikipedia.org | defuddle 未命中，自动降级启发式（不断供） | SPA 水合时序或提取器 DOM 不匹配；兜底设计验证 |
| reddit.com 版面页 | 同上，降级启发式 | 同上 |
| youtube.com | 网络不可达，chrome-error 如实报（ERR_TIMED_OUT） | 与提取器无关，墙/断网如实语义 |

结论：文章型页面优先吃 Defuddle 元数据红利；SPA 大站依赖兜底启发式；两者都拿不到时如实报错不伪装。
