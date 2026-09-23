/**
 * src/main/window.js —— 卡片窗口（置底 + 玻璃 + 拖动）
 * =====================================================================
 * 这四件事全部照搬 M0 探针**已经真机取证过**的结论，不重新发明：
 *
 *   1. **置底**：`SetWindowPos(HWND_BOTTOM)` + `WS_EX_NOACTIVATE`，
 *      且**必须显式传卡片自己的 HWND**（不许让脚本用 MainWindowHandle 猜 ——
 *      一个 Electron 进程有多个顶层窗口，猜错是静默的）。
 *   2. **尺寸**：构造参数 `width/height` **不可信**，落定后必须 `setBounds` 校正。
 *   3. **坐标**：必须对齐物理像素网格（150% 下 x 必须是偶数），否则尺寸会多 1px。
 *   4. **拖动**：JS 手动实现（`pointerdown → IPC → setBounds`），
 *      坐标**进入算术前取整**，尺寸取**设计值**而不是每帧现读。
 *
 * 这些不是"最佳实践"，每一条都对应一次真机实测的失败。详见 m0-probe/README.md。
 * =====================================================================
 */

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RENDERER_DIR = path.resolve(HERE, '..', 'renderer');
const PRELOAD = path.resolve(HERE, '..', 'preload', 'index.cjs');

/**
 * 卡片尺寸（设计值）。
 *
 * ⚠️ **尺寸不是随便定的，是按内容算出来的**（真机踩过）：
 * 第一版收起态给 132px，而里面的固定部分就要
 *   bar 38（含 padding）+ headline ~42 + filters 40 + foot 42 = 162px
 * ⇒ **比窗口还高**，于是底栏三个按钮被裁掉、筛选条也点不到。
 * 用户侧看到的是"查看更多/看今天全部/刷新显示不完整"与"筛选点了没反应"——
 * 两个问题**同一个根因**。
 *
 * ---------------------------------------------------------------------
 * 第三轮：**收起态从 208 提到 320**
 * ---------------------------------------------------------------------
 * 上一轮为了把底栏救回来，采取了"收起态干脆不显示筛选条"的办法。
 * 那确实让底栏回到了可视区，但代价是**用户要的功能在收起态不存在** ——
 * 真机反馈："展开后执行收起时，用于选择不同类型资讯条的分类选项会消失"。
 * ⇒ 正确的解法不是删掉控件，而是**把窗口给够**：
 *
 *   收起态固定部分 = bar(40) + 总览句(25，一行) + chips(31) + 滑动条(30) + 底栏(49)
 *                  = 175px
 *   窗口给 340 ⇒ 列表拿 ~165px ≈ **3 条**（收起态标题只占一行，见 card.css）
 *
 * ⚠️ 仍然是"留余量、不卡着算"：字体在不同 DPI 下会差 1–3px，
 *    卡着算的数字**一定**会在某个缩放档位上把底栏挤出去。
 *    展开态 = 收起态 + 更长的总览句 + 更多列表空间 = 700（**内容**高度）。
 *
 * ---------------------------------------------------------------------
 * 第四轮：**窗口要比卡片大一圈**（给投影留画布）
 * ---------------------------------------------------------------------
 * 上面那套算法算出来的是**卡片内容**的尺寸（400×340 / 400×700）——
 * 一个字节都不用改。但窗口尺寸不能再等于它了：
 *
 *   透明无边框窗口里，`--surface-shadow` 的三层外投影**只能画在视口之内**。
 *   旧代码 `.card{width:100vw;height:100vh}` 让卡片等于整个视口 ⇒
 *   投影唯一的可见区域（border box 之外）落在视口之外 ⇒
 *   **三层投影一个像素都到不了屏幕**，"立体感"这条需求实际上没实现。
 *
 * ⇒ 窗口 = 内容尺寸 + 2×WIN_PAD，卡片用 `position:absolute; inset` 居中，
 *   于是四周多出 WIN_PAD 供投影铺开，而**内容尺寸逐字不变**（列表高度、
 *   可见条数、上面那套算术全部照旧）。
 *
 * ⚠️ WIN_PAD 必须与 tokens.css 的 `--win-pad` **同时**改。
 *    两边不一致时：CSS 大 ⇒ 卡片被裁；CSS 小 ⇒ 四周多出空白。
 *    这是本文件里唯一一处跨进程的常量耦合。
 * ⚠️ 尺寸取法：本机常见的缩放档位里，150% 的物理网格步长是 2（偶数即可），
 *    125% 是 8、175% 是 4（440/740 在 125% 下会被系统四舍五入到最近的 8 的倍数，
 *    于是卡片四周的留白差几个像素 —— 只影响留白是否完全均匀，不影响卡片内容尺寸，
 *    因为卡片是 `inset` 定位、不会随窗口被拉伸）。100%/150% 下完全精确。
 */
export const CARD_SIZE = {
  collapsed: { w: 440, h: 380 }, // = 内容 400×340 + WIN_PAD 20×2
  expanded: { w: 440, h: 740 },  // = 内容 400×700 + WIN_PAD 20×2
};

/**
 * 窗口内边距（每边）= tokens.css 的 `--win-pad`。
 *
 * ⚠️ 两处是同一个数的两个副本，**必须同时改**。之所以不做成"从 CSS 读"：
 *    主进程建窗口时 CSS 还没加载，尺寸必须是已知常量（setBounds 也要用它）。
 *    之所以导出来：让"这两个数必须相等"这件事**可被离线断言**（见
 *    tools/test-interaction.mjs 里读 CSS 与这里比对的那条），
 *    而不是只写在注释里指望下一个人记得。
 */
export const WIN_PAD = 20;

/** 屏幕边距 */
const MARGIN = 16;

/** 不可信 → 校正前的对齐工具（与探针同一份实现，真机验过） */
export function physicalGridStep(scale) {
  for (let n = 1; n <= 32; n += 1) {
    if (Math.abs(n * scale - Math.round(n * scale)) < 1e-6) return n;
  }
  return 1;
}

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
 * 创建卡片窗口。
 * @param {{expanded?: boolean, onDrag?: Function}} [opts]
 */
export function createCardWindow(opts = {}) {
  const state = opts.expanded ? 'expanded' : 'collapsed';
  const size = CARD_SIZE[state];
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const pos = alignToPhysicalGrid(
    wa.x + wa.width - size.w - MARGIN,
    wa.y + MARGIN,
    display.scaleFactor,
  );

  const win = new BrowserWindow({
    width: size.w,
    height: size.h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    // ★ 置底形态（ADR-012）：不用 alwaysOnTop
    alwaysOnTop: false,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
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

  // ★ 构造参数尺寸不可信 → 落定后校正一次（真机实测：请求 380×132 曾读回 382×134）
  win.setBounds({ x: pos.x, y: pos.y, width: size.w, height: size.h });

  win.loadFile(path.join(RENDERER_DIR, 'card.html'));

  win.once('ready-to-show', () => {
    // ★ showInactive 而不是 show —— 显示但不抢焦点
    win.showInactive();
  });

  return win;
}

/** 切换收起/展开（保持左上角不动 —— 位置稳定性优先） */
export function setCardState(win, next) {
  if (!win || win.isDestroyed()) return null;
  const size = CARD_SIZE[next] || CARD_SIZE.collapsed;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  const g = alignToPhysicalGrid(b.x, b.y, d.scaleFactor);
  win.setBounds({ x: g.x, y: g.y, width: size.w, height: size.h });
  return win.getBounds();
}

/**
 * 取窗口的原生句柄（十进制字符串）。
 *
 * ⚠️ 这是"置底打到别的窗口上"那个真机缺陷的防线：**不许猜，直接要**。
 * @returns {string|null}
 */
export function nativeHwnd(win) {
  try {
    const buf = win.getNativeWindowHandle();
    if (!buf || !buf.length) return null;
    let v = 0n;
    const width = buf.length >= 8 ? 8 : 4;
    for (let i = width - 1; i >= 0; i -= 1) v = (v << 8n) | BigInt(buf[i]);
    return v > 0n ? v.toString() : null;
  } catch {
    return null;
  }
}
