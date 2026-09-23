# 验收 3 · 考裁判（校准）记录

- 时间：2026-09-20T03:04:22.018Z
- 目标：`src/main/window.js` · `startFocusTest()` 的 `hide() → 300ms → (显示卡片)`
- 植入的已知错误：`win.showInactive()` → `win.show()`（会激活窗口 → 必然抢焦点）
- 期望：验收 3 报 `fail`

## 结论：**CALIBRATED · 裁判有效**

植入已知错误后，裁判确实报了 fail —— 这个检查**能判错**，读数从此可信。

## 原始读数

| 项 | 值 |
|---|---|
| 验收 3 状态 | `fail` |
| 验收 3 标题 | 窗口不抢焦点 :: 卡片抢了焦点：测试期卡片 focus 事件 1 次、面板 blur 事件 1 次（任一非 0 即失败） |
| cardShowCount（"显示卡片"发生了几次） | 1 |
| cardFocusCount（卡片抢到焦点几次） | 1 |
| panelBlurCount（面板被挤失焦几次） | 1 |
| 验收摘要 | `{"pass":3,"fail":1,"warn":0,"unable":1,"pending":4}` |
| launcher 退出码 | 0 |
| 还原 window.js | ✓ 已还原且逐字节一致 |
| 正式留痕（验收记录 / 日志） | ✓ 未被改动（正式验收记录与日志保持原样） |

## 校准器自己的可信度

- **能判出"裁判是假的"吗？** 能。若裁判恒报 pass（DEAD），本脚本退出码 1，绝不会把它读成"通过"。
- **能判出"测试没跑起来"吗？** 能。`cardShowCount === 0` 时判 INCONCLUSIVE（退出码 2），不冒充前两者。
- **会不会留下污染？** 三层：① **隔离** —— 子进程带 `M0_SELFTEST_TAG=.calib`，本次自检产物另存为
  `_selftest-report.calib.md` / `selftest-log.calib.txt`，**不碰**正式留痕；
  ② **守卫** —— 跑前快照、跑后逐字节比对正式产物，被改动就地还原并告警；
  ③ **还原源码** —— 逐字节校验，失败则本次结论一律降级为 INCONCLUSIVE。

  ⚠️ 这条曾经是**不准确**的：早期版本只还原源码，却放任这次自检覆盖掉
  `report/_selftest-report.md` —— 也就是 M0 验收记录本体，留下一份写着「M0 未通过」的
  假记录（2026-09-19 实际发生，见 `docs/05-M0验收记录.md`）。①②为此而加。

> 原始自检输出全文：`report/calib-focus-run.txt`　｜　原文备份：`report/window.js.calib-backup`

*由 `tools/calibrate-focus-referee.mjs` 于 2026-09-20T03:04:22.019Z 自动生成 —— 手工跑法见该脚本头部注释。*
