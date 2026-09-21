/**
 * blurmeasure.js —— 用「截图 + 拉普拉斯方差」自动判定 backdrop-filter 是否真的生效
 *
 * 归属：验收 2（MASTER-PLAN §4 · M0）。
 *
 * ===================================================================
 * 一、为什么需要它
 * ===================================================================
 * 验收 2 原来只能靠肉眼：打开卡片诊断区，看 A 区（有 blur）和 B 区（无 blur）
 * 看起来是不是不一样。两个问题：
 *   1. 慢，而且每次都要人来看一眼；
 *   2. 更糟的是 —— 如果卡片背后的桌面是**纯色**，模糊与不模糊看起来完全一样。
 *      人会看到"两半一模一样"，然后得出"静默失效"的结论。**这个结论是错的。**
 *      这叫假阴性，而它恰恰出现在最需要判断的时候。
 *
 * ===================================================================
 * 二、怎么绕开"纯色背景"这个陷阱
 * ===================================================================
 * 不依赖桌面：在诊断区里铺一层**程序生成的高频棋盘格**（.diag__texture，
 * 见 renderer/styles/card.css），让 A 区背后的东西永远是高频纹理。
 * 于是"模糊生效" = 高频被抹平 = 统计量必然崩塌。
 *
 * 信号完全落在窗口内部：既不怕用户壁纸是纯色，也不需要去捕获桌面
 * （透明窗口下捕获桌面背景是另一件麻烦事，见 docs/05 §6.2 验收 5）。
 *
 * ===================================================================
 * 三、指标：拉普拉斯方差
 * ===================================================================
 * 拉普拉斯算子是二阶差分，对高频最敏感 —— 图像处理里标准的模糊度度量。
 *   清晰图像 → 相邻像素差大 → 二阶差分大 → 方差大
 *   模糊图像 → 相邻像素差小 → 二阶差分小 → 方差趋近 0
 *
 * 取 A 区与 B 区的方差之比 ratio = varLap(A) / varLap(B)：
 *   两区一样     → ratio ≈ 1
 *   A 明显更模糊 → ratio 远小于 1
 *
 * ===================================================================
 * 四、内建的「考裁判」
 * ===================================================================
 * 光有 ratio 还不够 —— 凭什么相信这把尺子？
 * 所以每次测量都先跑一遍**校准态**（data-diag-blur='off'，把 A 区的 blur 也关掉）。
 * 校准态下两个区**应该**长得一模一样。若测出来不一样，那不是被测对象有问题，
 * 而是**尺子本身有问题** —— 此时必须判 UNABLE，而不是硬报一个 pass 或 fail。
 *
 * 这一步不需要人额外去试，它内建在每一次测量里。
 * 对应 docs/05-M0验收记录.md §6.4 第 4 条「考裁判不可跳过」。
 *
 * ===================================================================
 * 五、阈值从哪来（重要）
 * ===================================================================
 * 阈值一开始是**声明在先**的估计值，然后必须被实测数据校准。
 * 这件事已经做了一轮（2026-09-18）：已知生效 ratio=0.000、已知失效 ratio=1.000，
 * 两个端点都拿在手里之后，阈值才定下来 —— 完整的实测原始数据记在下面的
 * 「实测校准记录」里，也同步登记在 docs/05-M0验收记录.md。
 *
 * 之所以要专门写这一段：自动化最危险的地方就在阈值上。
 * 它把模糊的口径变成具体的数字，看起来更严谨；
 * 但若这个数字是拍脑袋定的，它比人眼**更**不可靠 ——
 * 人至少有"看着不对劲"的直觉警报，而一个错误的阈值
 * 只会安静地、年年给出漂亮结论。
 */

import * as win from './window.js';

/* ------------------------------------------------------------------ */
/* 阈值                                                                 */
/*                                                                      */
/* ★ 实测校准记录（2026-09-18，本机：2560×1600 @150%，RTX 4060 Laptop）  */
/*   展开态 360×520 DIP → 截图 540×780 物理像素                          */
/*                                                                      */
/*     [已知失效] 校准态 blurOff=true ：A=8646.9  B=8646.9  ratio=1.000  */
/*     [已知生效] 正常态 blurOff=false：A=   0.0  B=8646.9  ratio=0.000  */
/*                                                                      */
/*   两个端点都拿在手里了，下面这几个阈值就不再是拍脑袋的：               */
/*   · MIN_TEXTURE_VARIANCE=50 —— 实际对照区高达 8646.9，留了 170 倍余量，
/*     所以它只会在"纹理压根没渲染出来"时才触发，不会误伤。             */
/*   · CALIB_RATIO_MIN/MAX=0.7~1.4 —— 实测校准态恰好 1.000，
/*     区间取在两端点之间，用来抓"尺子坏了"而不是"小数点抖动"。          */
/*   · BLUR_RATIO_MAX=0.5 —— 取已知生效(0.000)与已知失效(1.000)的中点。   */
/*                                                                      */
/* ⚠️ 已知的覆盖缺口：只有两个端点被测过。**中间地带没有数据** ——
/*    比如有人把 blur(24px) 改成 blur(2px)，ratio 会落在哪、该判生效还是
/*    失效，现在没有依据。真要收紧就得再造几档模糊度各采一次。           */
/* ------------------------------------------------------------------ */

/** 采样区（相对整张截图的比例）。避开圆角与两区交界，只取各自的中心带。 */
const REGION_A = { x0: 0.15, x1: 0.85, y0: 0.1, y1: 0.4 }; // 上半 = 有 blur
const REGION_B = { x0: 0.15, x1: 0.85, y0: 0.6, y1: 0.9 }; // 下半 = 对照组

/** 对照组（清晰区）至少要有这么多拉普拉斯方差，否则说明纹理根本没渲染出来 */
const MIN_TEXTURE_VARIANCE = 50;

/** 校准态下两区应几乎一致；超出这个区间说明"尺子"本身有问题 */
const CALIB_RATIO_MIN = 0.7;
const CALIB_RATIO_MAX = 1.4;

/** 正常态下 A/B 方差比低于此值，即认定"模糊确实生效" */
const BLUR_RATIO_MAX = 0.5;

/** 状态切换后等合成器重绘的时间 */
const SETTLE_MS = 450;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 图像数学                                                             */
/* ------------------------------------------------------------------ */

/**
 * 从 NativeImage 与其 bitmap 反推"这张图到底有多少物理像素"。
 *
 * 为什么不能想当然地拿 getSize() 当物理像素用（2026-09-18 实测修正）：
 * 本机实测（150% 缩放、展开态 360×520 DIP）里 getSize() 返回的是 **540×780**，
 * 也就是**物理像素**，恰好等于 toBitmap() 隐含的尺寸，两个约束自然吻合。
 * 但文档对这个返回值在不同平台/缩放组合下给什么并无保证 ——
 * 一旦它哪天真的返回 DIP（360×520），直接拿它当行跨距用，
 * 抠出来的"区域"就是斜着切的：**它不会报错，只会给出一堆看着很合理的垃圾数字**。
 *
 * 所以这里不赌它的语义，而是用两个自洽约束联立求解：
 *   ① bitmap.length = W × H × 4（BGRA，每像素 4 字节）
 *   ② W / H = getSize 的长宽比（无论它是 DIP 还是物理，长宽比都不变）
 */
function deriveGeometry(img, bitmap) {
  const dip = img.getSize();
  const total = bitmap.length / 4; // 总像素数

  // getSize() 恰好与像素数自洽（本机即属此列）—— 直接用
  if (dip.width > 0 && dip.height > 0 && dip.width * dip.height === total) {
    return { w: dip.width, h: dip.height, derived: false };
  }

  // 否则按长宽比反推
  const ratio = dip.width / dip.height;
  const h = Math.round(Math.sqrt(total / ratio));
  const w = Math.round(total / h);
  return { w, h, derived: true };
}

/**
 * 抠出一块区域并转灰度。
 * 注意通道顺序是 **BGRA**（Windows 上的 bitmap 格式），不是 RGBA ——
 * 搞反了不会报错，只是把红蓝对调，灰色权重恰好相近，于是又得到一个"看着合理"的错数。
 */
function extractGray(bitmap, imgW, imgH, region) {
  const x0 = Math.floor(region.x0 * imgW);
  const x1 = Math.floor(region.x1 * imgW);
  const y0 = Math.floor(region.y0 * imgH);
  const y1 = Math.floor(region.y1 * imgH);
  const w = x1 - x0;
  const h = y1 - y0;

  const gray = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const srcRow = (y0 + y) * imgW * 4;
    for (let x = 0; x < w; x += 1) {
      const p = srcRow + (x0 + x) * 4;
      gray[y * w + x] = 0.299 * bitmap[p + 2] + 0.587 * bitmap[p + 1] + 0.114 * bitmap[p];
    }
  }
  return { gray, w, h, box: { x0, y0, w, h } };
}

/**
 * 拉普拉斯方差（4 邻域）。
 * 边界一圈跳过 —— 不是图省事，是因为缺了邻居的二阶差分没有意义。
 */
function laplacianVariance(gray, w, h) {
  if (w < 3 || h < 3) return 0;

  const n = (w - 2) * (h - 2);
  const lap = new Float64Array(n);
  let i = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const c = gray[y * w + x];
      lap[i] =
        4 * c -
        gray[(y - 1) * w + x] -
        gray[(y + 1) * w + x] -
        gray[y * w + (x - 1)] -
        gray[y * w + (x + 1)];
      i += 1;
    }
  }

  let sum = 0;
  for (let k = 0; k < n; k += 1) sum += lap[k];
  const mean = sum / n;

  let sq = 0;
  for (let k = 0; k < n; k += 1) {
    const d = lap[k] - mean;
    sq += d * d;
  }
  return sq / n;
}

/* ------------------------------------------------------------------ */
/* 采样                                                                 */
/* ------------------------------------------------------------------ */

/** 在指定诊断状态下截一次图，返回两区的拉普拉斯方差 */
async function sampleOnce({ measure, blurOff }) {
  const card = win.state.card;
  if (!card || card.isDestroyed()) return null;

  await win.setDiag({ on: true, measure, blurOff });
  await delay(SETTLE_MS); // 等 CSS 状态切换 + 合成器重绘

  const img = await card.webContents.capturePage();
  const bitmap = img.toBitmap();
  const geo = deriveGeometry(img, bitmap);

  const a = extractGray(bitmap, geo.w, geo.h, REGION_A);
  const b = extractGray(bitmap, geo.w, geo.h, REGION_B);

  const varA = laplacianVariance(a.gray, a.w, a.h);
  const varB = laplacianVariance(b.gray, b.w, b.h);

  return {
    blurOff,
    imageSizeDip: img.getSize(),
    imageSizePx: { w: geo.w, h: geo.h, derived: geo.derived },
    boxA: a.box,
    boxB: b.box,
    lapA: varA,
    lapB: varB,
    ratio: varB > 0 ? varA / varB : null,
  };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 跑一次完整的 backdrop-filter 生效性测量。
 *
 * 流程：校准态（内建考裁判）→ 正常态 → 关掉诊断区恢复现场 → 判定。
 *
 * @returns {Promise<object>} 含 ok / measured / status / detail / evidence / raw
 */
export async function measureBackdropBlur() {
  const card = win.state.card;
  if (!card || card.isDestroyed()) {
    return { ok: false, measured: false, reason: '卡片窗口不存在或已销毁' };
  }

  // 记下测量前的卡片状态 —— 测量会为了拿到足够面积把卡片撑成展开态，
  // 测完必须还原。否则会污染紧随其后的自检项（自检里"展开态尺寸"那一步
  // 依赖卡片此刻处于收起态，它会先 setCardState(EXPANDED) 再量）。
  const prevCardState = win.state.cardState;

  let calib = null;
  let live = null;
  let error = null;
  let restoreError = null;

  try {
    calib = await sampleOnce({ measure: true, blurOff: true });
    live = await sampleOnce({ measure: true, blurOff: false });
  } catch (err) {
    error = err && err.message ? err.message : String(err);
  } finally {
    // 无论成败都恢复现场：关掉诊断区，并把卡片状态还原
    try {
      await win.setDiag({ on: false, measure: false, blurOff: false });
      if (prevCardState && win.state.cardState !== prevCardState) {
        await win.setCardState(prevCardState);
      }
    } catch (err) {
      restoreError = err && err.message ? err.message : String(err);
    }
  }

  if (error || !calib || !live) {
    return {
      ok: false,
      measured: false,
      reason: `截图或测量过程抛错：${error || '采样返回空'}`,
      raw: { calib, live },
    };
  }

  const raw = { calib, live };
  const line = (s) =>
    `[${s.blurOff ? '校准态 blurOff' : '正常态 blur'}] 图像 ${s.imageSizePx.w}×${s.imageSizePx.h}px` +
    `（DIP ${s.imageSizeDip.width}×${s.imageSizeDip.height}${s.imageSizePx.derived ? '，已按比例反推' : ''}）` +
    `｜A 区 varLap=${s.lapA.toFixed(1)}，B 区 varLap=${s.lapB.toFixed(1)}，` +
    `比值=${s.ratio === null ? 'N/A' : s.ratio.toFixed(3)}`;

  const evidence = [
    line(calib),
    line(live),
    `采样区：A = 截图高度 ${(REGION_A.y0 * 100).toFixed(0)}%~${(REGION_A.y1 * 100).toFixed(0)}% 带，` +
      `B = ${(REGION_B.y0 * 100).toFixed(0)}%~${(REGION_B.y1 * 100).toFixed(0)}% 带；两者均取宽度 15%~85%，避开圆角与分区边界`,
    `阈值（第一版，待实测校准）：对照区最低方差 ${MIN_TEXTURE_VARIANCE}；` +
      `校准态比值区间 ${CALIB_RATIO_MIN}~${CALIB_RATIO_MAX}；正常态判生效的上限 ${BLUR_RATIO_MAX}`,
  ];
  if (restoreError) evidence.push(`⚠️ 关掉诊断区时抛错（不覆盖主结论）：${restoreError}`);

  /* ---- 判定树。每一层的失败原因都不同，不许合并成一个"不通过" ---- */

  // 第 1 层：有没有可测的信号？
  // 对照组（清晰区）方差太低 = 纹理没渲染出来 / 截图是空的 / 窗口不可见。
  // 此时无论比值多好看都毫无意义 —— 分子分母都是噪声。
  if (live.lapB < MIN_TEXTURE_VARIANCE) {
    return {
      ok: true,
      measured: true,
      status: 'unable',
      detail:
        `对照组（B 区）拉普拉斯方差只有 ${live.lapB.toFixed(1)}（低于下限 ${MIN_TEXTURE_VARIANCE}），` +
        `说明高频纹理没有渲染出来、或截图内容为空 —— 没有可测的信号，无法判定`,
      evidence,
      raw,
    };
  }

  // 第 2 层：尺子可信吗？（内建考裁判）
  // 校准态下 A 区的 blur 也被关掉，两区应当一致。
  // 若不一致，问题出在测量本身（区域切偏了 / 两区蒙层其实不同 / 截图不稳定），
  // 此时任何 pass/fail 都是在给一把坏尺子的读数盖章。
  if (calib.ratio === null || calib.ratio < CALIB_RATIO_MIN || calib.ratio > CALIB_RATIO_MAX) {
    return {
      ok: true,
      measured: true,
      status: 'unable',
      detail:
        `校准态自检未通过：把 A 区 blur 也关掉后两区本应一致，实测比值却是 ` +
        `${calib.ratio === null ? 'N/A' : calib.ratio.toFixed(3)}（要求落在 ${CALIB_RATIO_MIN}~${CALIB_RATIO_MAX}）。` +
        `问题出在测量本身而不是被测对象 —— 这个读数不可用于验收`,
      evidence,
      raw,
    };
  }

  // 第 3 层：正式判定
  if (live.ratio !== null && live.ratio < BLUR_RATIO_MAX) {
    return {
      ok: true,
      measured: true,
      status: 'pass',
      detail:
        `backdrop-filter 确实生效：A 区（有 blur）拉普拉斯方差 ${live.lapA.toFixed(1)}，` +
        `只有对照组 B 区 ${live.lapB.toFixed(1)} 的 ${(live.ratio * 100).toFixed(1)}% —— 高频被明显抹平`,
      evidence,
      raw,
    };
  }

  return {
    ok: true,
    measured: true,
    status: 'fail',
    detail:
      `backdrop-filter 疑似静默失效：A 区与 B 区的拉普拉斯方差几乎相同` +
      `（A=${live.lapA.toFixed(1)}，B=${live.lapB.toFixed(1)}，` +
      `比值 ${live.ratio === null ? 'N/A' : live.ratio.toFixed(3)}，判生效要求 < ${BLUR_RATIO_MAX}）` +
      `—— 加了 blur 的那一半并没有真的被模糊`,
    evidence,
    raw,
  };
}
