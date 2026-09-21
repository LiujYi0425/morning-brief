/**
 * card.js —— 卡片渲染进程
 *
 * 职责边界（铁律 L4）：只负责画。不做抓取、不做 AI、不做解析。
 * 它甚至不自己决定形态 —— 形态由主进程通过 data-surface 推过来。
 */

const api = window.m0;

/** 短横线转小驼峰，避免在 HTML 里写内联样式（CSP 不允许） */
function applyRootAttrs({ state, surface, diag, measure, blurOff }) {
  const root = document.documentElement;
  if (state) root.setAttribute('data-state', state);
  if (surface) root.setAttribute('data-surface', surface);
  if (diag !== undefined) root.setAttribute('data-diag', diag ? 'on' : 'off');
  // 下面两个是验收 2 的自动化开关，见 styles/card.css 顶部注释
  if (measure !== undefined) root.setAttribute('data-diag-measure', measure ? 'on' : 'off');
  if (blurOff !== undefined) root.setAttribute('data-diag-blur', blurOff ? 'off' : 'on');
}

/**
 * 上报渲染进程自己看到的事实。
 * 这是验收 9 的第三路独立证据：
 *   devicePixelRatio 是浏览器内核眼里的缩放，与主进程 getPrimaryDisplay().scaleFactor
 *   是两条不同的代码路径。两者不一致，就说明主进程那条不可信。
 */
async function reportRendererFacts(reason) {
  const root = document.documentElement;
  let backdropSupported = null;
  let webkitBackdropSupported = null;
  try {
    backdropSupported = CSS.supports('backdrop-filter', 'blur(20px)');
    webkitBackdropSupported = CSS.supports('-webkit-backdrop-filter', 'blur(20px)');
  } catch (err) {
    /* 忽略：拿不到就是 null，不编造 */
  }

  const rect = document.querySelector('.card').getBoundingClientRect();

  const payload = {
    reason,
    // 词汇表自检用：这份内联在 preload 里的通道表，主进程会拿去和 contract.cjs 比对
    channels: api.__channels ? Array.from(api.__channels) : null,
    devicePixelRatio: window.devicePixelRatio,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    screenAvailWidth: window.screen.availWidth,
    screenAvailHeight: window.screen.availHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    cardRectCss: { w: Math.round(rect.width), h: Math.round(rect.height) },
    backdropSupported,
    webkitBackdropSupported,
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    currentSurface: root.getAttribute('data-surface'),
    currentState: root.getAttribute('data-state'),
  };

  try {
    await api.capability.reportRendererFacts(payload);
  } catch (err) {
    /* 上报失败不影响卡片显示，忽略 */
  }
  return payload;
}

/* ---------------- 主进程 → 渲染进程 ---------------- */

api.card.onStateChanged((s) => {
  if (!s) return;
  applyRootAttrs({ state: s.cardState, surface: s.surface });
  if (typeof s.opacityAlpha === 'number') {
    document.documentElement.style.setProperty('--card-alpha', String(s.opacityAlpha));
  }
});

api.card.onDiag(({ on, measure, blurOff }) => {
  applyRootAttrs({ diag: on, measure, blurOff });
});

/* ---------------- 交互 ---------------- */

document.getElementById('bar').addEventListener('click', () => {
  api.card.setState('expanded');
});

document.getElementById('btn-collapse').addEventListener('click', () => {
  api.card.setState('collapsed');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.card.setState('collapsed');
});

/* ---------------- 拖动诊断探针（2026-09-20 · 临时，非功能代码） ---------------- */

/**
 * ⚠️ 这是一段**诊断代码，不是功能代码**，应随"JS 手动拖动"落地一并删除。
 *
 * 它回答一个只有实测才能回答的问题：**鼠标按在拖动把手上时，事件到底有没有到达 DOM？**
 *
 *   · 日志**打出来**了 → `.grip` 是个普通元素，`-webkit-app-region: drag`
 *     **没有**被注册 → 与「resizable: false 让拖动区域失效」这一推论一致。
 *   · 日志**没打出来** → drag 区**已经注册**并生效，它按 Windows 的既定行为
 *     吞掉了鼠标事件（electron#29891，官方定性为 OS 限制），
 *     但 OS 层级的拖动没有发生 → 问题不在"区域没注册"，得往别处查。
 *
 * 这是一个**有判别力**的探针：两种结果指向两个不同的原因，
 * 而不是"跑一次试试看"。判据表与操作步骤见 m0-probe/README.md「拖动把手的诊断」。
 *
 * 日志的去向要说明白：`api.log` 的终点是**主进程终端**（ipc.js 里的
 * `console.log('[renderer]', …)`），卡片 UI 上看不到。这一次是刻意要它走终端 ——
 * 诊断结果本来就该落在终端的运行记录里。
 */
for (const el of document.querySelectorAll('.grip')) {
  el.addEventListener('mousedown', () => {
    api.log('[M0] grip mousedown 到达了渲染层 —— 说明 drag 区未注册');
  });
}

/* ---------------- 底栏 ---------------- */

const barMeta = document.querySelector('.bar__meta');
const toast = document.getElementById('toast');

let toastTimer = null;

/** 弹一条短暂提示。这是"死键"的直接解药 —— 让动作留下看得见的痕迹。 */
function showToast(text) {
  if (!toast) return;
  toast.textContent = text;
  toast.setAttribute('data-on', 'on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.removeAttribute('data-on'), 1400);
}

/**
 * 「刷新」在 M0 里的真实最小行为（2026-09-20 由占位升级为真功能）。
 *
 * 为什么必须动它：原本它与「设置」一起躺在占位循环里，点击只调 `api.log()`，
 * 而 `api.log` 的终点是**主进程的终端** —— 卡片 UI 上一个像素都不动。
 * 阿木的原话「存在大量无行为（无动作/无进展）的按键」指的就是它。
 * **"发了日志"不等于"有反馈"。**
 *
 * 现在的行为是三件有据可查的事：
 *   ① 重新上报渲染事实（主进程真的会收到，所以验收 2 的证据链会因此变长）；
 *   ② 更新收起条上的条数标签（`今天 7 条` → `今天 7 条 · 刚刚刷新`）；
 *   ③ 弹一条 1.4 秒的轻提示（`.toast`）—— 明确的视觉反馈。
 *
 * ⚠️ M0 里信息源是静态的，所以"刷新"的重活（真正重抓）还没来。
 *    这里刻意只做"能真实发生、且能被看见"的最小动作，
 *    而不是假装抓了一遍 —— 假装成功比承认没有更难查。
 */
document.getElementById('btn-refresh').addEventListener('click', async () => {
  const facts = await reportRendererFacts('manual-refresh');
  const count = document.querySelectorAll('.item').length;

  if (barMeta) barMeta.textContent = '今天 ' + count + ' 条 · 刚刚刷新';

  const dpr =
    facts && typeof facts.devicePixelRatio === 'number' ? ' · DPR ' + facts.devicePixelRatio : '';
  showToast('已刷新 · ' + count + ' 条' + dpr);
});

// ⚠️ 'btn-settings' 在 M0 里**刻意不绑定事件**，且按钮本身带 disabled 属性。
// 这不是遗漏，是决策：M0 没有设置面板。与其留一个"点了没反应"的假按钮，
// 不如让它诚实地看起来不可用（卡片内有 title 说明它将在 M1 开放）。
// 处置口径见 docs/02 §4.3 的 CardFooter 行。

/* ---------------- 尺寸 / 缩放变化时重新上报 ---------------- */

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => reportRendererFacts('resize'), 250);
});

// devicePixelRatio 变化 = 窗口被拖到了另一块缩放不同的屏幕上，这是验收 8 的关键信号
let lastDpr = window.devicePixelRatio;
setInterval(() => {
  if (window.devicePixelRatio !== lastDpr) {
    lastDpr = window.devicePixelRatio;
    reportRendererFacts('dpr-change');
  }
}, 800);

window.addEventListener('DOMContentLoaded', () => {
  applyRootAttrs({ state: 'collapsed', surface: 'glass', diag: false });
  document.documentElement.style.setProperty('--card-alpha', '0.96');
  reportRendererFacts('initial');
});

// DOMContentLoaded 可能已经过去（脚本在 body 末尾），兜底再报一次
if (document.readyState !== 'loading') {
  reportRendererFacts('script-ready');
}
