# 元素引用（版本化 ref 交互）

一文件一机制：`snapshot_interactives()` 出最小观测面，`click_ref` / `fill_ref` 按 ref 动作；陈旧引用如实报 `STALE_REF`，绝不盲点旧坐标。

## 机制

```js
// 1. 观测：可见可交互元素（button/a/input/select/textarea/[role]），带语义 role/name
const snap = await snapshot_interactives()
// { _v, version, total, items: [{ref:'@m1abc:e0', role:'button', name:'Search', tag:'button', box:{x,y,w,h}}] }

// 2. 动作：ref 经同一收集器重解析 + elementFromPoint 自证后执行
await click_ref('@m1abc:e0')          // 复用 click_at_xy 坐标真点击
await fill_ref('@m1abc:e3', 'hello')  // 复用 fill_input（回读严格相等 + activate 重试）
```

## 防陈旧语义

- ref 在**动作时**重新解析（不是记住坐标）：元素消失/位移/被遮挡 -> `STALE_REF: <ref> 页面已变化，重新 snapshot_interactives()`
- 畸形 ref -> `BAD_REF`；fill 到非输入元素 -> `BAD_REF`
- 页面导航后旧 ref 必然 STALE_REF（收集器序号已变）：这是特性不是缺陷

## 何时用

- agent 拿到的是「语义清单」而非整页 DOM：token 效率（上限 50 个/次，超出如实报 total，滚动后重新 snapshot）
- 替代「猜 CSS 选择器」：先 snapshot 看有哪些可点/可填，再按 ref 动作
- 与 domain-skills 互补：站点知识给结构，snapshot 给当下实时状态

## 边界

- 重 canvas/影子 DOM 页面：收集器只覆盖 light DOM 的标准交互元素；shadow 内元素走 shadow-dom.md 配方
- 虚拟列表（元素随滚动重建）：snapshot 与动作之间滚动会 STALE_REF，先滚后 snapshot 后动作
