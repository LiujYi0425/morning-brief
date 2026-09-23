# experiments/ —— M0 期间做过的对照实验

> 这里放的不是产品代码，是**取证记录**。
> 每一个文件都回答一个具体的、当时不确定的技术问题；
> 结论已经固化进 `docs/04-项目审查报告.md`（B10 / B11 / B12）与
> `docs/05-M0验收记录.md`，脚本留在这里是为了让结论**可复现、可反驳**。

---

## 为什么要把实验脚本留下来

M0 的三个发现全都是"先猜错、再被数据打回来"的：

| 一开始的判断 | 实验之后 |
|---|---|
| Electron ESM 主进程不支持具名 import，得写垫片 | **错**。真因是环境变量污染（B11），具名 import 完全正常 |
| 透明无边框窗口在 150% 缩放下会变胖，得接受它 | **错**。变胖的是**构造参数**，且误差取决于坐标的物理像素对齐（B12） |
| `dipToScreenRect` 在 44.4.2 上不可用 | **错**。是紧随其后的 `dipToScreenPoint` 抛异常，把前者的成功吞了 |

如果只留下"结论"而不留脚本，这三条以后没人能验证，也没人敢推翻。
所以：**脚本 + 原始输出一起留档。**

---

## 怎么跑

统一走项目的启动器（不要直接 `electron .`，本机 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 静默退化，见 B11）：

```powershell
# 在 m0-probe/ 目录下
node tools/launch-electron.mjs experiments/exp-window-size.mjs
```

`run.ps1` 把上面这条包成了批次执行，顺带清理残留的 electron 进程。

---

## 清单

### 诊断类（证明"环境/运行时到底是什么状态"）

| 脚本 | 问的问题 | 结论 | 原始输出 |
|---|---|---|---|
| `diag-electron-api.mjs` | ESM 主进程里 `require('electron')` / `import('electron')` 分别拿到什么？`module.isBuiltin('electron')` 是 true 吗？ | 拿到的是**二进制路径字符串**，`isBuiltin` 为 **false** → 说明当时进程根本没跑在 Electron 浏览器进程里 | `report/diag-electron-api.txt` |
| `diag-tla-deadlock.mjs` | 顶层 `await app.whenReady()` 会死锁吗？ | **会**。看门狗 8 秒准点打响，退出码 2，`STEP3` 从未打印 | `report/diag-tla-deadlock.txt` |

### 尺寸类（证明"那 1~4px 从哪来"）

| 脚本 | 问的问题 | 结论 | 原始输出 |
|---|---|---|---|
| `exp-window-size.mjs` | 8 种窗口配置，哪种能让 `getBounds()` 精确等于请求的 360×44？ | **一种都没有**（全 +2/+2，`transparent:false` 是 +3/+4）。但创建后 `setBounds({width,height})` 精确且幂等。顺带发现 `dipToScreenRect` 其实可用 | `report/winsize-experiment.txt` |
| `exp-size-timeline.mjs` | 按产品真实顺序（构造→校正→load→show）逐步读，误差出现在哪一步？ | 误差在**构造**那一步就产生了（364×46）；`setBounds` 校正后变 361×44；**移到屏幕中央 `x=300` 后变成精确的 360×44** → 指向"位置" | `report/winsize2-timeline.txt` |
| `exp-position-matrix.mjs` | 是"靠近屏幕右边界"还是"坐标落在非整数物理像素"？ | **后者，100% 一致**。`x` 偶→精确、`x` 奇→宽 +1；`y` 奇→高 +1。A/B/C 三组（远离边缘 / 靠近边缘 / 紧贴边缘）表现完全相同 | `report/winsize3-matrix.txt` |

---

## 三条可以直接抄进产品代码的结论

1. **永远不要相信 `BrowserWindow` 构造参数里的 `width` / `height`。**
   构造后必须 `setBounds({width, height})` 校正一次。校正后完全幂等（连续 6 次写回 Δ=0）。

2. **窗口坐标必须对齐到物理像素网格。**
   步长 = 使 `step × scaleFactor` 为整数的最小正整数：
   `100%→1 · 125%→4 · 150%→2 · 175%→4 · 200%→1`。
   代码在 `src/main/window.js` 的 `physicalGridStep()` / `alignToPhysicalGrid()`。

3. **一个 API 一个 `try`。**
   `dipToScreenPoint` 在 Electron 44.4.2 上抛 `conversion failure from`，
   把它和 `dipToScreenRect` 写进同一个 `try` 会让前者的成功被后者的异常吞掉 —— 这个坑第一次自检就踩了。
