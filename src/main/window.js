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

/**
 * 「第一次使用：配一个 API Key」窗口的尺寸（设计值）。
 *
 * = 内容 420×520 + WIN_PAD 20×2。**为什么不复用 CARD_SIZE**：
 *   ① 这扇窗里要塞进四段说明 + 一个输入框 + 两组按钮，卡片那个 400×340 的
 *      内容区装不下（真机上"底栏被裁"就是这个老毛病）；
 *   ② 它是**独立的窗口**，尺寸跟着自己的内容走，不该被卡片的形态变化牵着走。
 * ⚠️ **高度 560 是量出来的，不是拍的**（2026-10-01 真机 ＋ 用户当天拍板）：
 *   高 420 时正文内容 **410px**、可见只有 **287px** ⇒ `#keyInput`（top=358）
 *   落在折线（foot top=346）**下方 12px**，首屏最后一行只剩「打开申请页面」按钮。
 *   这扇窗**只弹一次**，用户很可能就此找不到输入框。
 *   ⇒ 取 **560**。改完的真机自检读数（2026-10-01，同一台机器）：
 *     `win 460×560`、`#keyInput 358–389`、正文视口 `59–486`、
 *     `scrollH 427 ≤ clientH 427`（也就是**不再溢出**，连滚动条都不出现）。
 *     ⚠️ 别把 427≤427 读成"只剩 0 的余量"：溢出时 scrollHeight 是内容真高
 *     （旧尺寸下的 410 就是真高），不溢出时它被**钳到** clientHeight
 *     ⇒ 相等恰恰是"装得下"的表现。
 *   判据在渲染层：welcome.js 自检里的「首屏看得见 Key 输入框」那条，
 *   它的 ✗ 分支就是这条尺寸失效的样子（静态断言只能守住"这条判据还在"）。
 * ⚠️ 与卡片同一条规矩：这里写的是**窗口**尺寸；卡片/面板本身仍由
 *    CSS 的 `inset: var(--win-pad)` 定位（见 styles/welcome.css）。
 */
export const WELCOME_SIZE = { w: 460, h: 560 };

/**
 * 创建「第一次使用」窗口（内容见 src/renderer/welcome.html）。
 *
 * 为什么必须**另开一扇窗**，而不是把这几句话塞进卡片里 —— 这是架构性的：
 *   卡片是 `HWND_BOTTOM` + `WS_EX_NOACTIVATE`（ADR-012：置底、不抢焦点、
 *   点了不激活）。把"第一件该做的事"放进一个**会沉到所有窗口下面**、
 *   而且点它不激活的地方，等于没做。所以这扇窗的全部参数都与卡片相反：
 *     · `alwaysOnTop: true`  —— 它是提示，飘到浏览器后面就等于没弹；
 *     · `skipTaskbar: false` —— 用户一时找不到时，任务栏里能把它叫回来；
 *     · `ready-to-show` 时 `show()`（**抢焦点**）—— 接下来他要往输入框里粘东西，
 *       不抢焦点等于让他先满屏找一遍窗口。全工程唯一一处抢焦点，且只弹一次。
 *   它**不参与**置底那套：`applyBottomLevel` 只对 cardWin 调。
 *
 * ⚠️ 其余参数（构造尺寸不可信 → setBounds 校正、物理网格对齐、preload 与
 *    sandbox 口径）与 createCardWindow 逐字一致 —— 那几条都是真机踩出来的。
 */
export function createWelcomeWindow() {
  const size = WELCOME_SIZE;
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const pos = alignToPhysicalGrid(
    wa.x + Math.round((wa.width - size.w) / 2),
    wa.y + Math.round((wa.height - size.h) * 0.24),
    display.scaleFactor,
  );

  const win = new BrowserWindow({
    width: size.w,
    height: size.h,
    x: pos.x,
    y: pos.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: false,
    movable: true,
    minimizable: true,
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

  // ★ 构造参数尺寸不可信 → 落定后校正一次（与卡片同一条真机结论）
  win.setBounds({ x: pos.x, y: pos.y, width: size.w, height: size.h });

  win.loadFile(path.join(RENDERER_DIR, 'welcome.html'));

  win.once('ready-to-show', () => {
    win.show(); // ★ 与卡片的 showInactive 相反：这里要焦点（见函数头）
    win.focus();
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
