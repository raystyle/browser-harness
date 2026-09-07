# 原语：附着（attach）

一切操作的第一步是**附着**，bh 永远只附加已经打开的对象，并按意图精准解析目标。

## 三种附着

- **附着已打开的浏览器**：发现（DevToolsActivePort 文件）-> WS 直连 -> 用户点一次 Allow。永不 spawn、永不兜底别的浏览器（Edge 不在发现范围）
- **附着已打开的网站（tab）**：按意图定位既有 tab（URL/标题匹配），附着它操作。不新开重复 tab、不导航用户正在看的页面
- **意图精准附着**：调用方表达「操作某站」时，解析意图 -> 定位**唯一**既有目标 -> 附着。找不到就如实报告并询问，不自作主张创建

## 授权粒度

Chrome 的许可是**每条 WS 连接**一次（防 infostealer 的设计，无「记住此应用」）。daemon 持单条长连 = 一天只弹开关机各一次；重连按指数退避（30 秒起步、10 分钟封顶），绝不机枪弹窗。toggle（chrome://inspect/#remote-debugging）常开，浏览器重启不掉。

## 守护链（daemon 的维护）

```
lazy 拉起（ensureDaemon，CDP 应答才算就绪）
自愈（WS 断开 -> 指数退避重连；应用失败轮内自愈 daemon）
退出（空闲 30 分钟自退 / 显式 --stop；只关自身连接）
```

外部进程守护：无（设计如此，lazy 语义）。唯一有 supervisor 的是 x-monitor 链（rmux 守 worker，worker 自愈 daemon）。**用户的浏览器不在任何守护范围内**。

## 落地形态

- 浏览器级：daemon 自动发现附着（session.ts detectBrowsers）
- tab 级：`list_tabs()` 定位 + `switch_tab(targetId)` 后台附着（不抢前台）
- 应用面钉 tab：`BH_ATTACH_URL_MATCH=x.com`（daemon 附着既有站点 tab，不开新页）
- 实例分工：default = 临时工位（lazy），具名实例 = 长跑应用工位，互不抢 tab
