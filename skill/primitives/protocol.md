# 协议层 CDP 域与方法索引

> 权威口径：协议唯一源 `protocol/*.json`（browser_protocol.json 50 域 + js_protocol.json 6 域）= **56 域、667 条声明命令、237 事件**；其中 15 条命令是协议自身的 redirect 别名（thin alias，浏览器直接重定向到别域实现），gen 过滤后 **652 个方法全类型绑定**。本文按域族给路由；方法级清单不必背，用运行时探针即取即用。

## 验证口径（可复算）

```powershell
# 源头：域/命令/事件计数
python -c "import json,glob; ds=[d for f in glob.glob('protocol/*.json') for d in json.load(open(f,encoding='utf-8'))['domains']]; print(len(ds), sum(len(x.get('commands',[])) for x in ds), sum(len(x.get('events',[])) for x in ds))"
# 绑定面：与 652 对账（dist 构建后）
node --input-type=module -e "import {Session} from './dist/session.js'; const s=new Session(); let n=0; for (const d of Object.keys(s.domains)) n+=Object.keys(s.domains[d]).length; console.log(Object.keys(s.domains).length, n)"
```

## 域族路由（按意图选域）

| 意图 | 域（方法数） |
| --- | --- |
| 页面导航/截图/打印/事件 | Page(61)、DOMSnapshot(4)、Preload(2) |
| DOM 查询与修改 | DOM(53)、DOMStorage(6)、CSS(38) |
| 运行时求值与执行上下文 | Runtime(23)、Console(3)、Inspector(2)、Schema(1) |
| JS 断点调试与性能剖析 | Debugger(33)、Profiler(9)、HeapProfiler(12)、Performance(4)、PerformanceTimeline(1)、Memory(11)、Tracing(6)、Animation(10)、LayerTree(9) |
| 网络抓取/拦截/缓存 | Network(41)、Fetch(9)、CacheStorage(5)、IO(3) |
| 存储与后台服务 | Storage(34)、IndexedDB(9)、ServiceWorker(12)、PWA(7)、BackgroundService(4)、FileSystem(1) |
| 输入注入与设备仿真 | Input(13)、Emulation(48)、DeviceOrientation(2)、DeviceAccess(4)、Autofill(4)、HeadlessExperimental(3) |
| 标签页/浏览器/实例管理 | Target(19)、Browser(20)、SystemInfo(3)、Tethering(2)、Extensions(8)、WebMCP(4) |
| 安全与身份凭据 | Security(5)、WebAuthn(13)、FedCm(7)、SmartCardEmulation(12)、BluetoothEmulation(15) |
| 视觉调试与媒体 | Overlay(30)、Media(2)、WebAudio(3)、Cast(6) |
| 语义与审计 | Accessibility(8)、Audits(4)、Log(5)、DOMDebugger(10)、EventBreakpoints(3)、CrashReportContext(1) |

## 运行时方法探针（即取即用）

```js
bh 'Object.keys(session)'                    // 全部 56 域
bh 'Object.keys(session.Network)'            // 该域全部方法
bh 'return String(session.Page.printToPDF)'  // 函数源码（参数名即文档）
```

完整类型面：包内 `dist/generated.d.ts`（IDE 悬停即签名）。调用范式：`session.<Domain>.<method>(params)`（带类型直调）或 `cdp('<Domain>.<method>', params)`（动态分发）；事件 `session.waitFor(method, pred, timeoutMs)`。

## redirect 别名（15 条，勿用，用真身）

`DOM.hideHighlight / DOM.highlightNode / DOM.highlightRect` -> Overlay；`DOMDebugger.set/removeInstrumentationBreakpoint` -> EventBreakpoints；`Network.setUserAgentOverride`、`Page.clearDeviceMetricsOverride`、`Page.clearGeolocationOverride`、`Page.setDeviceMetricsOverride`、`Page.setGeolocationOverride`、`Page.setTouchEmulationEnabled` -> Emulation；`Page.clear/setDeviceOrientationOverride` -> DeviceOrientation；`Page.deleteCookie` -> Network；`Runtime.setAsyncCallStackDepth` -> Debugger。

gen.ts 头注即此规则的权威声明（Skip events；Include experimental/deprecated；Skip redirected commands）。
