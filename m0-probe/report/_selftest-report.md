# M0 地基验证 · 验收记录

> 生成时间：2026/9/20 11:03:42
> 对应里程碑：MASTER-PLAN §4 · M0（9 条验收标准）
> 本记录由 `m0-probe` 自动生成，人工判定项请连同截图一并留档。

---

## 0. 结论摘要

| 状态 | 条数 |
|---|---|
| ✅ 通过 | 4 |
| ❌ 不通过 | 0 |
| ⚠️ 有保留 | 0 |
| ⛔ 无法验证 | 1 |
| ⬜ 未判定 | 4 |

> 仍有未判定或无法验证项，M0 尚未收尾。

---

## 1. 逐条验收

### 验收 1 · Electron 无边框透明置顶窗口正常渲染

- **结论**：✅ 通过
- **判定方式**：程序自动
- **怎么测的**：窗口创建成功 + 页面加载完成 + transparent/frame/alwaysOnTop 三个标志位实际生效
- **说明**：窗口已渲染，alwaysOnTop=true，尺寸 360×44 精确等于期望的 360×44
- **证据**：
  - transparent: true / frame: false / alwaysOnTop: true / skipTaskbar: true 均已按此配置创建
  - 显示方式：showInactive()（显示但不激活）
  - 坐标 (1336,36)，所在显示器 scaleFactor=1.5，物理像素网格步长=2（对齐后 Δ=0,0）
  - M0 血泪规则：构造参数 width/height 不可信（实测请求 360×44 得到 364×46），必须创建后 setBounds 校正一次；且坐标必须落在物理像素网格上（150% 缩放下为偶数），否则宽/高会各多 1px
  - Electron 44.4.2 / Chromium 152.0.7977.130

### 验收 2 · backdrop-filter 在透明窗口内确实生效

- **结论**：✅ 通过
- **判定方式**：程序自动
- **怎么测的**：在诊断区铺一层程序生成的高频棋盘格当可控背景（不依赖桌面壁纸），用 capturePage 截图后计算 A 区（有 blur）与 B 区（对照组）的拉普拉斯方差之比。内建校准：每次都先跑一遍「把 A 区 blur 也关掉」的状态，两区应当一致；若不一致说明尺子本身坏了，结论判 UNABLE。2026-09-18 起不再依赖肉眼，实现在 blurmeasure.js
- **说明**：backdrop-filter 确实生效：A 区（有 blur）拉普拉斯方差 0.0，只有对照组 B 区 8646.9 的 0.0% —— 高频被明显抹平
- **证据**：
  - gpu_compositing = enabled（GPU 合成已启用）
  - [校准态 blurOff] 图像 540×780px（DIP 540×780）｜A 区 varLap=8646.9，B 区 varLap=8646.9，比值=1.000
  - [正常态 blur] 图像 540×780px（DIP 540×780）｜A 区 varLap=0.0，B 区 varLap=8646.9，比值=0.000
  - 采样区：A = 截图高度 10%~40% 带，B = 60%~90% 带；两者均取宽度 15%~85%，避开圆角与分区边界
  - 阈值（第一版，待实测校准）：对照区最低方差 50；校准态比值区间 0.7~1.4；正常态判生效的上限 0.5
  - CSS.supports('backdrop-filter','blur(20px)') = true，-webkit- 前缀 = false

### 验收 3 · 窗口不抢焦点

- **结论**：✅ 通过
- **判定方式**：程序自动
- **怎么测的**：20 秒焦点测试：测试期内主动做一次"显示卡片"（hide → showInactive），再数卡片的 focus 事件数与面板的 blur 事件数。三态判定：有抢焦点 → fail；没抢但期间根本没显示过 → invalid（这不是通过）；显示过且没抢 → pass。需在面板点一次按钮触发；2026-09-18 起结论由程序自动判定并写回验收状态，人不再需要读数字自己判断
- **说明**：6 秒内主动显示卡片 1 次，卡片 focus 事件 0 次、面板 blur 事件 0 次 —— 显示动作确实发生了，且没有抢焦点
- **证据**：
  - 测试时长 6000ms；cardShowCount=1（证明"显示卡片"确实发生过），cardFocusCount=0，panelBlurCount=0
  - 判定口径：有抢焦点 → fail；无抢焦点但 cardShowCount=0 → invalid（不是 pass）；否则 pass。口径来源：window.js · getFocusTestState()，不在本处重算
  - 被测行为：测试开始 300ms 后调用一次 win.showInactive()（对应 window.js 的"显示卡片"路径）

### 验收 4 · 全屏应用时窗口自动隐去

- **结论**：⬜ 未判定
- **判定方式**：人工判定
- **怎么测的**：手动开一个全屏应用（视频/PPT），看卡片是否让位。M0 只验证可行性，不要求自动实现
- **说明**：需要人工：开一个全屏应用观察。M0 只验证可能性，不要求现在就自动实现。
- **证据**：
  - 步骤：面板点「隐藏」→ 打开一个全屏视频或幻灯片 → 点「唤回」→ 观察是否能盖在全屏应用之上
  - 若卡片能盖住全屏应用，说明需要用轮询外部前台窗口的方式主动让位（M1 处理）

### 验收 5 · 三档透明度在纯白 / 纯黑 / 花哨风景壁纸上对比度均 ≥ 4.5:1

- **结论**：⬜ 未判定
- **判定方式**：人工判定
- **怎么测的**：换三张壁纸，每张切三档透明度，共 9 次目视。文字看不清即不通过
- **说明**：需要人工：换三张壁纸 × 三档透明度，共 9 次目视确认。
- **证据**：
  - 三张壁纸：纯白 / 纯黑 / 花哨风景
  - 三档透明度用面板上的按钮切换（安静 96% / 标准 94% / 通透 86%）
  - 判定口径：正文 13px 文字在任意组合下都必须能轻松读清；任一组读着吃力即不通过

### 验收 6 · 100% / 125% / 150% 三档缩放下卡片物理尺寸一致、文字清晰

- **结论**：⬜ 未判定
- **判定方式**：程序给数据 + 人眼确认
- **怎么测的**：程序读出当前缩放下卡片的 DIP 与物理尺寸（自动）；切到另外两档缩放各测一次（手动）
- **说明**：本程序已记录当前缩放下的读数；请切到另外两档系统缩放各测一次（或至少确认当前档位正确）。

### 验收 7 · 双屏混合缩放下主屏与副屏均不模糊、不拉伸

- **结论**：⛔ 无法验证
- **判定方式**：人工判定
- **怎么测的**：需要两块分辨率/缩放不同的显示器。若本机不具备，必须显式记为「无法验证」而不是跳过
- **说明**：本机只检测到 1 块显示器，双屏混合缩放无法在此环境验证。这不是"通过"，是"没条件测"。
- **证据**：
  - 建议：接入第二块显示器后重跑本工程；若长期不具备条件，需把「混合缩放下的副屏」列为已知限制并写入 MASTER-PLAN §8

### 验收 8 · 卡片跨屏拖动后吸附位置与记忆坐标均正确，偏差 ≤ 5px

- **结论**：⬜ 未判定
- **判定方式**：程序给数据 + 人眼确认
- **怎么测的**：程序做坐标往返一致性与吸附落点测量（自动）；跨屏拖动的目视偏差需人确认
- **说明**：先点「坐标往返测试」看自动结果，再手动拖动卡片并目视确认松手后是否停在你放下的位置。

### 验收 9 · scaleFactor 的可靠读取方式已确认

- **结论**：✅ 通过
- **判定方式**：程序自动
- **怎么测的**：两条独立证据链交叉校验：分辨率一致性 + 缩放比一致性。任一不符即判读数不可信
- **说明**：两条独立证据链（分辨率一致性 + 缩放比一致性）全部吻合，scaleFactor 可以采信。
- **证据**：
  - (未命名显示器)（id=2891281163）：scaleFactor=1.5，Electron 推算物理 2561×1601，Windows 实测 2560×1600，证据A=pass，证据B=pass
  - 渲染进程 devicePixelRatio = 1.5，screen.width×height = 1707×1067

---

## 2. 环境与探测原始数据

### 2.1 Electron 侧读数

```json
{
  "primaryId": 2891281163,
  "count": 1,
  "displays": [
    {
      "id": 2891281163,
      "label": "(未命名显示器)",
      "internal": true,
      "rotation": 0,
      "scaleFactor": 1.5,
      "sizeDip": {
        "w": 1707,
        "h": 1067
      },
      "boundsDip": {
        "x": 0,
        "y": 0,
        "w": 1707,
        "h": 1067
      },
      "workAreaDip": {
        "x": 240,
        "y": 24,
        "w": 1467,
        "h": 1043
      },
      "physicalExpected": {
        "w": 2561,
        "h": 1601
      }
    }
  ]
}
```

### 2.2 Windows 侧真实读数（独立裁判）

```json
{
  "ok": true,
  "devmodeSize": 212,
  "displayDeviceSize": 840,
  "monitors": [
    {
      "device": "\\\\.\\DISPLAY1",
      "adapter": "NVIDIA GeForce RTX 4060 Laptop GPU",
      "x": 0,
      "y": 0,
      "width": 2560,
      "height": 1600,
      "logPixels": 144,
      "bitsPerPel": 32,
      "enumOk": true
    }
  ],
  "registry": {
    "LogPixels": null,
    "perMonitor": [],
    "LogPixelsRaw": ""
  },
  "errors": []
}
```

### 2.3 scaleFactor 交叉校验

```json
{
  "reliable": true,
  "verdict": "pass",
  "reason": "两条独立证据链（分辨率一致性 + 缩放比一致性）全部吻合，scaleFactor 可以采信。",
  "perDisplay": [
    {
      "displayId": 2891281163,
      "label": "(未命名显示器)",
      "scaleFactor": 1.5,
      "dipSize": "1707×1067",
      "electronThinksPhysical": "2561×1601",
      "windowsTruthPhysical": "2560×1600",
      "windowsLogPixels": 144,
      "windowsImpliedScale": 1.5,
      "evidenceA": "pass",
      "evidenceB": "pass",
      "matchedBy": "position-or-size"
    }
  ],
  "findings": []
}
```

### 2.4 GPU / 合成状态

```json
{
  "featureStatus": {
    "2d_canvas": "enabled",
    "direct_rendering_display_compositor": "disabled_off_ok",
    "gpu_compositing": "enabled",
    "multiple_raster_threads": "enabled_on",
    "opengl": "enabled_on",
    "rasterization": "enabled",
    "raw_draw": "disabled_off_ok",
    "skia_graphite": "disabled_off",
    "trees_in_viz": "disabled_off",
    "video_decode": "enabled",
    "video_encode": "enabled",
    "webgl": "enabled",
    "webgpu": "enabled",
    "webnn": "disabled_off"
  },
  "hardwareAccelerationRequested": true
}
```

---

## 3. M0 收尾待办

- [ ] 本记录已提交，且九项都有明确结论（没有"忘记测了"）
- [ ] 无法验证的项已显式记录为「无法验证」+ 原因，**不是留空**
- [ ] 若触发降级：`data-surface` 默认值已改为 `opaque`，并已在 MASTER-PLAN §7 记一次 P2 变更
- [ ] MASTER-PLAN §5 进度看板、§8 风险表（R8/R9 状态）已更新
- [ ] `design-critic` 已按 1.1.0 版第五组跑过双形态检查
- [ ] 运行 `node tools/sync-check.mjs` 全绿

---

*本文件由 m0-probe 生成，可按需补充截图与人工结论。*
