# Browser Harness

从 LLM 到 Chrome 的最短路径：**652 个 Chrome DevTools Protocol 方法全类型直调** + 一条常驻守护进程，附着**你自己打开的浏览器**。

```
bh 'await session.Page.navigate({url: "https://example.com"})'
```

没有选择器框架，没有截图猜测：协议即 API，Chrome 能做的你就能调用。

![dashboard](docs/images/dashboard-board.png)

## 为什么是它

- **协议即 API**：56 域 652 方法带 TypeScript 类型直调；语义层助手（`goto_url` / `js` / `snapshot_interactives` / `click_ref`）与 Python 主仓同名对齐
- **人机共存**：永不启动浏览器，附着你正在用的 Chrome（144+ 官方调试通道）；只在专属 tab 工作，绝不碰你看着的页面
- **常驻守护**：session、活动标签、全局变量跨调用保持；监控、看板、自愈、升级轮换全自动
- **站点知识自动装载**：导航到 94 个站内任何一个，自动提示该站的既存操作知识（选择器/结构），一条命令读到全文：不重新发明轮子
- **即用应用**：网页抓取（Defuddle 正文提取）、谷歌/必应/Medium 搜索、页面被拦截实时弹窗告警、X 时间线监控入库、验证码图识别

## 安装

要求 Node ≥ 22。任选其一：

```bash
# 方式一：Release 包（推荐）
npm install -g ./browser-harness-ts-*.tgz    # 从 Releases 下载最新版
# 方式二：源码
git clone https://github.com/raystyle/browser-harness.git && cd browser-harness
npm install && npm run build && npm pack && npm install -g ./browser-harness-ts-*.tgz
```

浏览器一次性开启（之后忘了它）：

> 打开你的 Chrome，地址栏访问 `chrome://inspect/#remote-debugging`，启用「Allow remote debugging」，首次连接弹窗点 Allow

验证：

```bash
bh doctor        # 应显示 browser attachable
```

## 30 秒上手

```bash
bh 'return await list_tabs()'                  # 你打开的所有标签页
bh 'await goto_url("https://example.com")'     # 导航（daemon 记住状态）
bh 'return await snapshot_interactives()'      # 页面可点/可填元素清单
echo 'return 1+1' | bh                         # 管道；heredoc 多语句也行
bh web-fetch https://medium.com/some-article   # 抓正文（自动过反爬）
bh x-intel start                               # 后台监控你的 X 时间线
bh engine start                                # 自起无头 Chrome 引擎（临时、隔离、用完即杀）
```

agent 只需一句提示即可接入（技能自动同步到 Claude Code 与 Codex）：

```
用 browser 技能驱动我的浏览器：查看我打开的标签页，按主题分组，截最有意思的一张图。
```

## 无头引擎（可选）

不想动你正开着的浏览器？起一个隔离的临时 Chrome（`bh headless`，缩写 `bh hl`）：

```bash
bh headless start                  # 临时 profile，用完即杀
bh headless start --cookies github.com  # 克隆该域登录态
BH_NAME=headless-engine bh '<js>'  # 像操作任何浏览器一样操作引擎
bh web-fetch <url> --engine        # 抓取走引擎
bh headless stop                   # 杀进程、清目录，你的浏览器全程无扰
```

## 升级

```bash
bh upgrade --yes    # 检测老守护进程 -> 下载安装 -> 稳定轮换 -> 终验
```

日常命令发现版本漂移会自动提示；写操作默认 dry-run（`--yes` 才执行）。

## 内置应用

`web-fetch`（正文抓取）· `google/bing/medium-search`（两步契约搜索）· `page-detect`（页面被 Cloudflare/验证码拦截时弹窗告警）· `x-intel`（X 时间线监控入库）· `super-ocr`（验证码图识别）· `cookie-io`（登录态迁移）· `supervisor-core`（常驻应用自愈），全部经 `bh <name>` 调用，墙与人机验证如实报告，不硬闯。

## 深入

- **[skill/SKILL.md](skill/SKILL.md)**：完整命令面、意图路由、站点知识库、交互配方（agent 与人类的共同入口）
- **[INDEX.md](INDEX.md)**：全仓唯一索引：源码文件职责、方案/研究/规范/踩坑编号表，找任何东西先进这里
- **[docs/](docs/)**：架构归档、研究报告、踩坑速查
- **[Releases](https://github.com/raystyle/browser-harness/releases)**：每个版本的 tgz 与变更日志

零运行时白名单（commander/zod 之外全是 Node 内置）· Windows / macOS / Linux · Node ≥ 22
