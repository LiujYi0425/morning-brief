import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import contract from '../shared/contract.cjs';
import { computeFocusVerdict } from './focus-verdict.js';
import { diagResizable, DIAG_RESIZABLE_ENV } from './diag-flags.js';

const { CARD, SURFACE, WINDOW_STATE, OPACITY, IPC } = contract;
const here = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.resolve(here, '..', 'preload', 'index.cjs');
const RENDERER = path.resolve(here, '..', 'renderer');

/** 吸附留白 */
const SNAP_MARGIN = 12;

/* ------------------------------------------------------------------ */
/* 物理像素网格对齐 —— M0 实测得到的一条硬规则                            */
/* ------------------------------------------------------------------ */
/**
 * 使 step × scaleFactor 恰好为整数的最小正整数 step。
 *
 * 为什么需要它：M0 实测发现，置顶小浮窗的**尺寸误差只取决于坐标能不能落在
 * 整数物理像素上**，与"是否透明/无边框/靠近屏幕边缘"全都无关。
 * 原始数据见 report/winsize3-matrix.txt，规律 100% 一致：
 *
 *   x=700 → 700×1.5 = 1050  （整数）→ 读回 360×44  精确
 *   x=701 → 701×1.5 = 1051.5（非整数）→ 读回 361×44  宽 +1 DIP
 *   x=702 → 1053（整数）    → 360×44  精确
 *   …（B 组靠近右边界、C 组紧贴边界，表现完全相同）
 *   y 方向同理：y 为奇数时高度 +1，y 为偶数时精确。
 *
 * 机制尚未定论（疑似 Electron 在 DIP↔物理换算时对边界分别取整），
 * 但规律稳定到足以据此制定规则 —— 所以不猜机制，直接用规律。
 *
 * 各缩放档位下的 step：
 *   100% → 1   125% → 4   150% → 2   175% → 4   200% → 1
 * 即 150% 下坐标必须是偶数，125% 下必须是 4 的倍数。
 */
export function physicalGridStep(scale) {
  for (let n = 1; n <= 32; n += 1) {
    if (Math.abs(n * scale - Math.round(n * scale)) < 1e-6) return n;
  }
  return 1; // 罕见缩放比，放弃对齐
}

/** 把一组 DIP 坐标对齐到物理像素网格 */
export function alignToPhysicalGrid(x, y, scale) {
  const step = physicalGridStep(scale);
  return {
    x: Math.round(x / step) * step,
    y: Math.round(y / step) * step,
    step,
    changed: Math.round(x / step) * step !== x || Math.round(y / step) * step !== y,
  };
}

/**
 * 全局运行态。
 * 注意：M0 刻意不落 SQLite —— 探针不该带数据库依赖。
 * 但它必须按 displayId 分别记忆位置，因为「只存一组全局坐标」正是 B1 验收 8 要打的那个坑。
 */
export const state = {
  cardState: WINDOW_STATE.COLLAPSED,
  surface: SURFACE.GLASS,
  opacity: 'quiet',
  /** displayId -> { x, y }（DIP） */
  posMemory: new Map(),
  lastMoveDeviation: null,
  boundsRoundtrip: null,
  dipApi: { available: false, detail: null },
  card: null,
  panel: null,
};

export const focusTest = {
  running: false,
  durationMs: 20000,
  startedAt: 0,
  cardFocusCount: 0,
  panelBlurCount: 0,
  cardShowCount: 0,
  finished: false,
  timer: null,
};

/* ------------------------------------------------------------------ */
/* 卡片窗口（被测对象）                                                  */
/* ------------------------------------------------------------------ */

export function opacityAlpha(id) {
  const hit = OPACITY.find((o) => o.id === id);
  return hit ? hit.alpha : 0.96;
}

function targetSize(st) {
  return st === WINDOW_STATE.COLLAPSED ? CARD.COLLAPSED : CARD.EXPANDED;
}

/** 找一个合适的位置：优先用记忆坐标，没有就吸附到主屏右侧 */
function initialPosition(w, h) {
  const display = screen.getPrimaryDisplay();
  const remembered = state.posMemory.get(display.id);
  const scale = display.scaleFactor;

  if (remembered) {
    // 记忆坐标也要重新对齐 —— 用户可能把窗口拖到了奇数坐标上
    return alignToPhysicalGrid(remembered.x, remembered.y, scale);
  }

  const wa = display.workArea;
  return alignToPhysicalGrid(
    wa.x + wa.width - w - SNAP_MARGIN,
    wa.y + SNAP_MARGIN,
    scale,
  );
}

export function createCardWindow() {
  const { w, h } = targetSize(state.cardState);
  const pos = initialPosition(w, h);

  /* ★ 拖动诊断开关（2026-09-20）—— 默认关闭，只在一次诊断运行里临时打开。
   *
   * 它不是修复方案。长期打开有真实代价：用户可以拖窗口边缘改尺寸，
   * 而验收 6 要的恰恰是**精确的固定尺寸**（360×44 / 360×520）。
   * 打开方式：在终端先设 M0_DIAG_RESIZABLE=1 再 npm start。
   * 取值口径见 src/main/diag-flags.js，判据与步骤见 m0-probe/README.md
   * 「拖动把手的诊断」一节。
   */
  const resizable = diagResizable();

  const win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    // 允许交互（要能点击展开），但绝不能主动抢焦点 —— 靠 showInactive 保证
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  // 比普通置顶更强势的一档，确保压得住其他置顶窗口
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });

  /* ★ M0 实测结论（原始数据见 report/winsize-experiment.txt）
   *
   * 构造参数里的 width / height **不可信**。实测请求 360×44：
   *   · baseline（与本函数一致）           → getBounds() 读出 362×46   Δ+2/+2
   *   · thickFrame:false / useContentSize / roundedCorners:false /
   *     resizable:true                    → 一律 362×46              Δ+2/+2
   *   · transparent:false                 → 363×48                  Δ+3/+4
   *   · frame:true（有真边框的对照）        → 362×46                  Δ+2/+2
   * 说明偏差与"无边框/透明"无关，来自更底层；且不同运行间还不稳定
   * （自检时另一次读数是 364×46）。
   *
   * 而**创建之后**调用一次 setBounds({width,height}) 会精确命中请求值，
   * 并且完全幂等：连续 6 次「原样写回」Δx=Δy=Δw=Δh=0；反复写 360×44 每次都精确。
   *
   * → 规则：永远不要相信构造参数给出的尺寸，落定后必须显式校正一次。
   *   这是"必须遵守的书写规则"，不是"偶发的平台缺陷"。
   */
  win.setBounds({ x: pos.x, y: pos.y, width: w, height: h });

  /* 拖动诊断的留痕（2026-09-20）。
   *
   * 刻意**无条件**打这一行 —— 两次诊断运行（开关关 / 开关开）都会在自己的终端
   * 输出里留下"当时到底是什么状态"的铁证。
   * 只在开关打开时才打的话，"跑了一次但开关没生效"这种失败会**静默无声**，
   * 而它恰恰是最容易发生、又最容易被误读成「resizable 与拖动无关」的错误。
   */
  console.log(
    '[diag] 卡片窗口 resizable=' + win.isResizable() +
      ' movable=' + win.isMovable() +
      '（' + DIAG_RESIZABLE_ENV + '=' + (process.env[DIAG_RESIZABLE_ENV] ?? '未设置') + '）',
  );

  win.loadFile(path.join(RENDERER, 'card.html'));

  win.once('ready-to-show', () => {
    // ★ 关键：showInactive 而不是 show —— 显示但不激活，这是"不抢焦点"的命门
    win.showInactive();
  });

  // 焦点事件计数：验收 3 的证据来源
  win.on('focus', () => {
    if (focusTest.running) focusTest.cardFocusCount += 1;
  });
  win.on('show', () => {
    if (focusTest.running) focusTest.cardShowCount += 1;
  });

  // 位置记忆：按「卡片当前所在显示器」分别记
  let moveTimer = null;
  win.on('moved', () => {
    if (moveTimer) clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      const b = win.getBounds();
      const d = screen.getDisplayMatching(b);
      state.posMemory.set(d.id, { x: b.x, y: b.y });
    }, 150);
  });

  state.card = win;
  return win;
}

/** 切换收起/展开：改高度，宽度和左上角不动（位置稳定性优先） */
export async function setCardState(next) {
  const win = state.card;
  if (!win || win.isDestroyed()) return null;

  if (next === WINDOW_STATE.HIDDEN) {
    win.hide();
    state.cardState = next;
    broadcastCardState();
    return getCardState();
  }

  const wasHidden = state.cardState === WINDOW_STATE.HIDDEN;
  if (wasHidden) {
    // 从隐藏回来时同样用 showInactive，避免"唤回卡片"这个动作抢走焦点
    win.showInactive();
  }

  const from = win.getBounds();
  const to = targetSize(next);
  // 换尺寸时坐标也顺手对齐到物理像素网格 —— 否则尺寸切换后宽度会莫名多 1px
  const g = alignToPhysicalGrid(from.x, from.y, screen.getDisplayMatching(from).scaleFactor);
  const target = { x: g.x, y: g.y, width: to.w, height: to.h };

  state.cardState = next;
  await animateBounds(win, from, target, 160);
  // 落定后校正一次，确保尺寸绝对精确（验收 6 要的是精确的固定尺寸）
  win.setBounds(target);

  broadcastCardState();
  return getCardState();
}

function animateBounds(win, from, to, durationMs) {
  return new Promise((resolve) => {
    const steps = 10;
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      const k = i / steps;
      const lerp = (a, b) => Math.round(a + (b - a) * k);
      if (win.isDestroyed()) {
        clearInterval(t);
        resolve();
        return;
      }
      win.setBounds({
        x: lerp(from.x, to.x),
        y: lerp(from.y, to.y),
        width: lerp(from.width, to.width),
        height: lerp(from.height, to.height),
      });
      if (i >= steps) {
        clearInterval(t);
        resolve();
      }
    }, durationMs / steps);
  });
}

/** 吸附到当前显示器的右侧 */
export function snapToEdge() {
  const win = state.card;
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;

  // 先算"看上去对"的落点，再把它推到物理像素网格上。
  // 不推这一步的话，落点若在非整数物理像素上，窗口会自己胖 1px（见 physicalGridStep 注释）。
  const g = alignToPhysicalGrid(
    wa.x + wa.width - b.width - SNAP_MARGIN,
    Math.min(Math.max(b.y, wa.y + SNAP_MARGIN), wa.y + wa.height - b.height - SNAP_MARGIN),
    display.scaleFactor,
  );

  const target = { x: g.x, y: g.y, width: b.width, height: b.height };
  win.setBounds(target);
  state.posMemory.set(display.id, { x: target.x, y: target.y });

  const after = win.getBounds();
  return {
    displayId: display.id,
    expected: target,
    actual: after,
    gridAlign: g,
    deviation: {
      dx: after.x - target.x,
      dy: after.y - target.y,
      dw: after.width - target.width,
      dh: after.height - target.height,
    },
    gapToRightEdge: wa.x + wa.width - (after.x + after.width),
  };
}

/**
 * 验收 8 的自动部分：坐标往返一致性。
 * 手法：把当前 bounds 原样写回去，再读回来。若读写不等，说明坐标系内部就不自洽
 * （跨屏拖动偏移 30–50px 那个缺陷，本质上就是这个往返不成立）。
 */
export function boundsRoundtrip() {
  const win = state.card;
  if (!win || win.isDestroyed()) return null;
  const before = win.getBounds();
  win.setBounds(before);
  const after = win.getBounds();

  const result = {
    before,
    after,
    deviation: {
      dx: after.x - before.x,
      dy: after.y - before.y,
      dw: after.width - before.width,
      dh: after.height - before.height,
    },
    displayAtCard: describeDisplay(screen.getDisplayMatching(before)),
  };
  result.stable =
    result.deviation.dx === 0 &&
    result.deviation.dy === 0 &&
    result.deviation.dw === 0 &&
    result.deviation.dh === 0;

  state.boundsRoundtrip = result;
  return result;
}

/**
 * 验收 6 / 8 的核心数据：卡片尺寸与坐标在"当前缩放"下的真实读数。
 * 同时给出 DIP 与（若 API 可用）屏幕物理坐标两套视角，方便看出偏差从哪来。
 */
export function measureCard() {
  const win = state.card;
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  const display = screen.getDisplayMatching(b);
  const scale = display.scaleFactor;

  const out = {
    boundsDip: b,
    display: describeDisplay(display),
    expectedPhysical: {
      w: Math.round(b.width * scale),
      h: Math.round(b.height * scale),
    },
    isCollapsedSizeExact: null,
    dipApi: null,
  };

  // 若 Electron 提供了 dipToScreen* 系列 API，拿它当第三路证据。
  //
  // ⚠️ M0 实测（report/winsize-experiment.txt · C 段）：
  //   dipToScreenRect(win, bounds)  → 可用，返回 {300,300,540,66}（360×44 DIP @150% 正确）
  //   dipToScreenPoint(win, {x,y})  → 在 44.4.2 上抛 "Error processing argument at index 0,
  //                                   conversion failure from"（传 null 也一样）
  //   screenToDipRect(win, bounds)  → 可用
  // 第一次自检时把这两个调用写在了同一个 try 里，结果后者的异常把前者的成功一起吞掉，
  // 让 dipApi 假报「不可用」。教训：**一个 API 一个 try**，别让 A 的结论被 B 的异常污染。
  const want = targetSize(state.cardState);
  out.isCollapsedSizeExact = b.width === want.w && b.height === want.h;
  out.wantSize = want;

  const apiProbe = { rect: null, point: null, screenToDip: null, errors: [] };
  try {
    apiProbe.rect = typeof screen.dipToScreenRect === 'function' ? screen.dipToScreenRect(win, b) : null;
  } catch (err) {
    apiProbe.errors.push(`dipToScreenRect: ${err.message}`);
  }
  try {
    apiProbe.point = typeof screen.dipToScreenPoint === 'function'
      ? screen.dipToScreenPoint(win, { x: b.x, y: b.y })
      : null;
  } catch (err) {
    apiProbe.errors.push(`dipToScreenPoint: ${err.message}`);
  }
  try {
    apiProbe.screenToDip = typeof screen.screenToDipRect === 'function'
      ? screen.screenToDipRect(win, b)
      : null;
  } catch (err) {
    apiProbe.errors.push(`screenToDipRect: ${err.message}`);
  }

  const rectOk = !!(apiProbe.rect && apiProbe.rect.width);
  state.dipApi.available = rectOk;
  state.dipApi.detail = rectOk
    ? 'dipToScreenRect 可用' + (apiProbe.errors.length ? `；部分 API 抛错：${apiProbe.errors.join(' / ')}` : '')
    : `dipToScreen* 系列不可用：${apiProbe.errors.join(' / ') || 'API 不存在于当前 Electron 版本'}`;

  out.dipApi = {
    available: rectOk,
    detail: state.dipApi.detail,
    screenRect: apiProbe.rect,
    screenPoint: apiProbe.point,
    screenToDip: apiProbe.screenToDip,
    errors: apiProbe.errors,
  };

  return out;
}

function describeDisplay(d) {
  return {
    id: d.id,
    label: d.label || '(未命名显示器)',
    scaleFactor: d.scaleFactor,
    sizeDip: { w: d.size.width, h: d.size.height },
    boundsDip: { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height },
    workAreaDip: {
      x: d.workArea.x,
      y: d.workArea.y,
      w: d.workArea.width,
      h: d.workArea.height,
    },
    physicalExpected: {
      w: Math.round(d.size.width * d.scaleFactor),
      h: Math.round(d.size.height * d.scaleFactor),
    },
  };
}

export function setSurface(next) {
  state.surface = next;
  broadcastCardState();
  return getCardState();
}

export function setOpacity(id) {
  state.opacity = id;
  broadcastCardState();
  return getCardState();
}

export function setCardVisible(visible) {
  const win = state.card;
  if (!win || win.isDestroyed()) return null;
  if (visible) {
    win.showInactive();
    if (state.cardState === WINDOW_STATE.HIDDEN) state.cardState = WINDOW_STATE.COLLAPSED;
  } else {
    win.hide();
    state.cardState = WINDOW_STATE.HIDDEN;
  }
  broadcastCardState();
  return getCardState();
}

/**
 * 开关卡片诊断对照区。
 *
 * 参数从"单个布尔"扩成"布尔或对象"（2026-09-18 扩，为验收 2 的自动化铺路）：
 *   setDiag(true)                                  // 旧签名，仍然支持
 *   setDiag({ on: true, measure: true, blurOff })   // 新签名
 *
 * 两个新开关的用途 —— 都是为了让「backdrop-filter 是否真的生效」可被机器判定：
 *   measure: 藏掉 A/B 区的文字标签。文字边缘本身就是高频，
 *            会把"模糊度"这个统计量污染成噪声。
 *   blurOff: 校准态。把 A 区的 blur 也关掉，让两个区**应该**长得一模一样。
 *            用它来证明"这套测量确实能分辨生效与失效"——
 *            也就是把「考裁判」内建进验收本身（见 docs/05 §6.4 第 4 条）。
 *            校准态若测出两区不一样，说明测量本身坏了，结论必须作废。
 */
export async function setDiag(opts) {
  const o = typeof opts === 'object' && opts !== null ? opts : { on: !!opts };
  const on = !!o.on;
  const win = state.card;
  if (!win || win.isDestroyed()) return { diag: false };

  // 诊断对照区需要展开态才有足够面积 —— 44px 的细条放不下左右对照
  if (on && state.cardState === WINDOW_STATE.COLLAPSED) {
    await setCardState(WINDOW_STATE.EXPANDED);
  }
  win.webContents.send(contract.IPC.CARD_DIAG, {
    on,
    measure: !!o.measure,
    blurOff: !!o.blurOff,
  });
  return { diag: on, measure: !!o.measure, blurOff: !!o.blurOff };
}

export function getCardState() {
  const win = state.card;
  const alive = win && !win.isDestroyed();
  const b = alive ? win.getBounds() : null;
  return {
    cardState: state.cardState,
    surface: state.surface,
    opacity: state.opacity,
    opacityAlpha: opacityAlpha(state.opacity),
    bounds: b,
    visible: alive ? win.isVisible() : false,
    focused: alive ? win.isFocused() : false,
    posMemory: Array.from(state.posMemory.entries()).map(([id, p]) => ({ displayId: id, ...p })),
  };
}

function broadcastCardState() {
  const s = getCardState();
  for (const w of [state.card, state.panel]) {
    if (w && !w.isDestroyed()) w.webContents.send(IPC.WINDOW_STATE_CHANGED, s);
  }
}

/* ------------------------------------------------------------------ */
/* 验证面板（控制台，不透明普通窗口）                                     */
/* ------------------------------------------------------------------ */

export function createPanelWindow() {
  const win = new BrowserWindow({
    width: 620,
    height: 820,
    minWidth: 520,
    minHeight: 560,
    title: 'M0 地基验证控制台',
    backgroundColor: '#F7F7F5',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(RENDERER, 'probe.html'));
  win.once('ready-to-show', () => win.show());

  // 焦点测试的另一半证据：面板失焦次数
  win.on('blur', () => {
    if (focusTest.running) focusTest.panelBlurCount += 1;
  });

  state.panel = win;
  return win;
}

/* ------------------------------------------------------------------ */
/* 焦点测试（验收 3）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 开始焦点测试（验收 3）。
 *
 * @param durationMs 测试时长
 * @param onFinish   可选。测试**结束**时回调，参数是终态快照。
 *                   存在的理由：判定结果必须能流回验收状态（见 ipc.js 的 FOCUS_TEST_START）。
 *                   在此之前，verdict 算得再准也只是推给面板、然后被丢掉 ——
 *                   摘要里永远写着 "3. [pending]"，哪怕同一时刻 verdict 已经是 pass。
 */
export function startFocusTest(durationMs, onFinish) {
  if (focusTest.timer) clearTimeout(focusTest.timer);

  focusTest.running = true;
  focusTest.finished = false;
  focusTest.startedAt = Date.now();
  focusTest.durationMs = durationMs || focusTest.durationMs;
  focusTest.cardFocusCount = 0;
  focusTest.panelBlurCount = 0;
  focusTest.cardShowCount = 0;

  // 先把面板聚焦，这样"面板失焦"才是一个有意义的信号
  if (state.panel && !state.panel.isDestroyed()) state.panel.focus();

  /* ★ 2026-09-18 修正：让这个测试**真的能判出"错"**
   *
   * 原来的实现只是「focus 面板 → 干等 N 秒 → 数 focus 事件」。
   * 但那 N 秒里**根本没有任何"显示卡片"的动作** —— 卡片早在启动时就
   * showInactive 过了，之后再没人碰它。既然没人动，cardFocusCount 必然是 0。
   * 于是这个测试**恒 pass**：无论 showInactive 有没有被误写成 show()，
   * 得到的结论都一模一样。这是典型的「永远绿灯的假测试」——
   * 它不会给出错误结论，但它也永远不会给出任何结论。
   *
   * 修法：在测试窗口内**主动做一次"显示卡片"**，也就是真正被测的那个动作。
   * 时序故意留出间隔，好让 hide → showInactive 引发的事件落在测试期内：
   *
   *      0 ms   面板 focus
   *      0 ms   卡片 hide（先清掉"已显示"状态）
   *    300 ms   卡片 showInactive()   ← 被测行为；若被误写成 show()，这里会炸出 focus 事件
   *      N ms   收数、判定
   *
   * 校准判据（把 showInactive 换成 show，测试必须报 fail）：见 docs/05 §6.4 第 4 条。
   */
  const win = state.card;
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
    setTimeout(() => {
      if (!win.isDestroyed()) win.showInactive();
    }, 300);
  }

  focusTest.timer = setTimeout(() => {
    focusTest.running = false;
    focusTest.finished = true;
    const s = pushFocusTestState();
    if (typeof onFinish === 'function') {
      try {
        onFinish(s);
      } catch (err) {
        // 回调里出错不能连累窗口状态，但必须留痕而不是吞掉
        console.error('[window] focusTest 的 onFinish 回调抛错：', err);
      }
    }
  }, focusTest.durationMs);

  return getFocusTestState();
}

function getFocusTestState() {
  const elapsed = focusTest.startedAt ? Date.now() - focusTest.startedAt : 0;
  const remaining = focusTest.running
    ? Math.max(0, focusTest.durationMs - elapsed)
    : 0;

  /* verdict 是三态而不是两态（2026-09-18 修正）：
   *   fail    —— 卡片确实抢了焦点（有 focus 事件，或面板被挤得失焦）
   *   invalid —— 测试期内**没有发生"显示卡片"这个动作**，什么都没测到。
   *              这不是"通过"，是"没测到"（与验收 7 的 UNABLE 同理，不许冒充通过）。
   *              触发场景：卡片被用户手动隐藏时点开始测试。
   *   pass    —— 确实显示过，且一次焦点都没抢
   *
   * ★ 2026-09-19：判定逻辑已移到 `./focus-verdict.js`（纯函数，零依赖）。
   *   原因：本文件 import 了 electron，导致"判定"被绑死在"必须能启动 GUI 进程"上，
   *   无头环境里根本没法验证它对不对。拆出后可由 `tools/test-focus-verdict.mjs`
   *   在纯 Node 下逐条断言。**判定口径仍然只在这一处调用点产生**（口径唯一不变）。
   *   采集部分（真实 focus 事件会不会来）仍需 `tools/calibrate-focus-referee.mjs`。
   */
  const verdict = computeFocusVerdict(focusTest);

  return {
    running: focusTest.running,
    finished: focusTest.finished,
    durationMs: focusTest.durationMs,
    remainingMs: remaining,
    cardFocusCount: focusTest.cardFocusCount,
    panelBlurCount: focusTest.panelBlurCount,
    cardShowCount: focusTest.cardShowCount,
    verdict,
  };
}

export function pushFocusTestState() {
  const s = getFocusTestState();
  if (state.panel && !state.panel.isDestroyed()) {
    state.panel.webContents.send(IPC.FOCUS_TEST_STATE, s);
  }
  return s;
}

export { getFocusTestState };
