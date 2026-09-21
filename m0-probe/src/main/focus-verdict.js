/**
 * focus-verdict.js —— 焦点测试的**判定逻辑**，纯函数，零依赖
 * =====================================================================
 *
 * ---------------------------------------------------------------------
 * 为什么单独一个文件：**为了让"判定"本身能被考裁判**
 * ---------------------------------------------------------------------
 * `window.js` 第一行就是 `import { BrowserWindow, screen } from 'electron'`，
 * 所以**只要 import 它就必须有 Electron 运行时**。而"判定"这件事与 Electron
 * 毫无关系 —— 它只是「三个计数器 → 三态结论」的一个映射。
 *
 * 把它留在 `window.js` 里，等于**把判定逻辑绑死在"必须能启动一个 GUI 进程"的
 * 环境上**，后果有两个：
 *   1. 在无头环境 / CI 里无法验证判定是否正确；
 *   2. 只能靠"真跑一次 Electron"来间接验证 —— 成本高、覆盖面窄，
 *      而且一旦环境不允许启动 GUI（沙箱、远程会话、CI），这一项就**永远验不了**。
 *
 * 拆出来之后：
 *   · `window.js · getFocusTestState()` 调它 —— **产品路径唯一**（判定口径只在一处产生）；
 *   · `tools/test-focus-verdict.mjs` 直接调它 —— **纯 Node，不需要 Electron**，
 *      可以把每一种计数器组合（含"植入已知错误"）逐条断言。
 *
 * ---------------------------------------------------------------------
 * ⚠️ 边界必须说清楚：**本文件只负责「判定」，不负责「采集」**
 * ---------------------------------------------------------------------
 * 「`hide() → showInactive()` 到底会不会产生 focus 事件」这件事，
 * 属于**采集**，只能靠真跑一遍（`tools/calibrate-focus-referee.mjs`，需要 Electron）。
 *
 * 两者不可互相冒充：
 *   · 本文件 + `test-focus-verdict.mjs` 证明的是 —— **给定读数，判定转得对不对**；
 *   · `calibrate-focus-referee.mjs` 证明的是 —— **真实世界里那个读数会不会出现**。
 * 缺了后者，判定再正确也可能永远拿不到能触发它的读数（这正是"永远绿灯的假测试"）。
 *
 * ---------------------------------------------------------------------
 * 三态语义（不许合并）
 * ---------------------------------------------------------------------
 *   running —— 测试还没结束，没有结论
 *   fail    —— 卡片确实抢了焦点（有 focus 事件，或面板被挤得失焦）
 *   invalid —— 测试期内**没有发生"显示卡片"这个动作**，什么都没测到。
 *              这不是"通过"，是"没测到"（与验收 7 的 UNABLE 同理）。
 *   pass    —— 确实显示过，且一次焦点都没抢
 *
 * 判定顺序是有讲究的：**先看"抢没抢"，再看"测没测到"**。
 * 理由：`cardFocusCount > 0` 本身就是铁证 —— 它证明"抢焦点"这个行为真的发生过，
 * 此时若因为 `cardShowCount === 0` 就判 `invalid`，等于**把一条确凿的失败证据
 * 降级成"没测到"**，那正是"把 UNABLE 洗成干净"的反向版本，同样危险。
 */

export const FOCUS_VERDICT = Object.freeze({
  RUNNING: 'running',
  PASS: 'pass',
  FAIL: 'fail',
  INVALID: 'invalid',
});

/**
 * 由焦点测试的计数器推出结论。**纯函数**：同样的输入永远给同样的输出，无副作用。
 *
 * @param {{finished?: boolean, cardFocusCount?: number, panelBlurCount?: number, cardShowCount?: number}} s
 * @returns {'running' | 'pass' | 'fail' | 'invalid'}
 */
export function computeFocusVerdict(s) {
  if (!s || !s.finished) return FOCUS_VERDICT.RUNNING;

  const grabbed = (s.cardFocusCount || 0) > 0 || (s.panelBlurCount || 0) > 0;
  if (grabbed) return FOCUS_VERDICT.FAIL;

  // 没有抢焦点，但整个测试期里"显示卡片"一次都没发生 → 什么都没测到
  if ((s.cardShowCount || 0) === 0) return FOCUS_VERDICT.INVALID;

  return FOCUS_VERDICT.PASS;
}

/** 三态里哪些是"已判定"（不再是 running）。给调用方省一次字符串比较。 */
export function isFocusVerdictDecided(v) {
  return v === FOCUS_VERDICT.PASS || v === FOCUS_VERDICT.FAIL || v === FOCUS_VERDICT.INVALID;
}
