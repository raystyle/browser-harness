# PLAN：当前目标实施计划

> 角色：当前目标方案文档：基于 research（为什么）与 references（怎么做）的执行计划；每条挂依据来源，不存历史目标。

## 当前目标

D25 super-ocr 验证码图定位与识别（GOAL 回指 PRD D25）

## 计划项

| # | 计划 | 依据 |
| --- | --- | --- |
| 1 | 新增 `assets/sdk/ocr.ts`（`__ocr`：ready / locate / export；关键词+邻近标签+尺寸启发式；交互式拼图单独报告）+ `npm run build:sdk` | G002 结构与命名；page-detect 附着现有 tab |
| 2 | 新增 `assets/apps/super-ocr.mjs`：扫描当前/匹配 tab → 定位验证码图 → 裁剪/导出海报 → ppu-paddle-ocr 识别；`setup` 把引擎装到 `<BH_HOME>/ocr`；不自动填写 | G002 强制项 1/3/5/6；零 runtime 依赖不进 package.json |
| 3 | 同步 SKILL / README / G002 / CHANGELOG / INDEX | AGENTS 行为基线 |
| 4 | 开发态冒烟：无引擎 `ready` 如实报；fixture 页 locate 命中 canvas；有引擎则识别出文本 | G002 验收门禁 |

## 完成的定义

- [x] `bh super-ocr [url片段]` 扫描当前页，JSON `{_ok,_v,_ts,count,items[{text,box,...}]}` [实证: fixture canvas text=K8M2 conf=0.9997]
- [x] `bh super-ocr locate` 只定位不 OCR [实证: count=1 kind=canvas label=验证码]
- [x] 交互式拼图（reCAPTCHA/滑块）走 CAPTCHA\|WALL，不假装 OCR 成功 [实证: recaptcha iframe]
- [x] 引擎缺失走 NOT_FOUND，提示 `bh super-ocr setup` [实证: setup 前]
- [x] SKILL 面登记命令 / 错误决策树 / 版本合约 1.0.0
- [x] 安装态：全局 `bh super-ocr` 识别 K8M2；引擎在 `~/.config/browser-harness/ocr` [实证: 2026-09-07 npm-global]
