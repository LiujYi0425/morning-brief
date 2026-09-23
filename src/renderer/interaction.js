/**
 * src/renderer/interaction.js —— 拖动 / 点击的手势判定（经典脚本 · 无 ESM 语法）
 * =====================================================================
 * ⚠️⚠️ **本文件是经典脚本，不是 ES 模块。不许出现 `import` / `export`。**
 *
 * 这条在 m0-probe 上是用真机日志换来的，两次都栽在同一处：
 *   ① 写成 UMD（浏览器挂 window、Node 走 module.exports）——
 *      `package.json` 是 `type: module` ⇒ `module` 不存在 ⇒ 分支**静默失效**。
 *   ② 写成标准 ESM（`export`）+ 经典 `<script src>` ——
 *      浏览器抛 `Uncaught SyntaxError: Unexpected token 'export'`，
 *      **整个文件一个字都不执行**；而离线测试用 `import` 加载、全绿。
 *      ⇒ 表现是"离线全绿、真机全废"，用户侧只有三个字：拖不动。
 *
 * ⇒ 现在的形态：IIFE + 一条无条件的 `globalThis.MB_INTERACTION = {...}`，
 *   两个消费者（浏览器 / 离线考裁判）**用同一种方式加载**。
 *   考裁判会断言"本文件不含 ESM 语法"且"确实挂上了出口"。
 *
 * ---------------------------------------------------------------------
 * 判定为什么必须**同步**做
 * ---------------------------------------------------------------------
 * 拖动结束时浏览器会**顺带**产出一个 `click`，而那个 click 会落到顶栏的
 * "点击展开"处理器上 —— 用户看到的就是"拖到某个位置它自己展开了"。
 * 第一版修法是"等主进程回执里的净位移再决定吞不吞"，那有**一个必输的竞态**：
 * `click` 在 `pointerup` 之后同步派发，而 IPC 回执至少要一个来回。
 * ⇒ 判定放渲染层同步做完，主进程只管"窗口搬到哪"。
 * =====================================================================
 */
(function attachInteraction(global) {
  'use strict';

  /** 判定为"拖动"所需的最小净位移（DIP）。与主进程同一口径。 */
  var DRAG_TOLERANCE_DIP = 3;

  function finite(p) {
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  /**
   * 创建一份手势判定状态。
   * ⚠️ 工厂而不是模块级单例 —— 单例会让测试用例之间互相污染（假绿）。
   */
  function createInteractionGate() {
    var downPoint = null;
    var swallowNextClick = false;
    var dragGesture = false;
    var draggedThisGesture = false;
    var swallowedCount = 0;
    var dragGestureCount = 0;

    function distanceFromDown(p) {
      if (!downPoint || !finite(p)) return 0;
      return Math.max(Math.abs(p.x - downPoint.x), Math.abs(p.y - downPoint.y));
    }

    return {
      /** 指针按下：记起点，并清掉上一次的待吞标记（否则会把下一次点击也吞掉） */
      down: function (p) {
        if (!finite(p)) return;
        downPoint = { x: p.x, y: p.y };
        dragGesture = false;
        draggedThisGesture = false;
        swallowNextClick = false;
      },

      /** 手势进行中：**一旦超过容差就永久记为拖动**（拖出去又拖回来也算拖动） */
      isDragGesture: function (p) {
        if (!downPoint) return false;
        if (distanceFromDown(p) >= DRAG_TOLERANCE_DIP) {
          if (!dragGesture) {
            dragGesture = true;
            dragGestureCount += 1;
          }
          draggedThisGesture = true;
        }
        return dragGesture;
      },

      /** 指针抬起。@returns {boolean} 是否应当吞掉紧随其后的 click */
      up: function (p) {
        var dist = distanceFromDown(p);
        if (finite(p) && dist >= DRAG_TOLERANCE_DIP) {
          dragGesture = true;
          draggedThisGesture = true;
        }
        var wasDrag = draggedThisGesture;
        downPoint = null;
        dragGesture = false;
        draggedThisGesture = false;
        swallowNextClick = wasDrag;
        return wasDrag;
      },

      /** **只看，不消费** —— 一次 click 会经过捕获 + 冒泡两道监听器，
       *  两道都消费的话第一道清掉标记、第二道就放行了（等于没挡） */
      shouldSwallowClick: function () {
        return swallowNextClick;
      },

      /** **消费**标记：整条 click 事件链走完只调用一次；吞一次就复位 */
      consumeSwallow: function () {
        if (!swallowNextClick) return false;
        swallowNextClick = false;
        swallowedCount += 1;
        return true;
      },

      /** 拖动态里不许展开（用户要求"拖动前后状态保持一致"） */
      canExpand: function () {
        return !dragGesture;
      },

      snapshot: function () {
        return {
          downPoint: downPoint ? { x: downPoint.x, y: downPoint.y } : null,
          swallowNextClick: swallowNextClick,
          dragGesture: dragGesture,
          swallowedCount: swallowedCount,
          dragGestureCount: dragGestureCount,
        };
      },
    };
  }

  /* 唯一的出口 —— **无条件赋值，不做任何环境探测**（探测失败是静默的） */
  global.MB_INTERACTION = {
    DRAG_TOLERANCE_DIP: DRAG_TOLERANCE_DIP,
    createInteractionGate: createInteractionGate,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
