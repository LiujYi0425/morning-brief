/**
 * _diag/winsize2.mjs —— 那 1~2px 到底是哪一步冒出来的？
 *
 * 已知（report/winsize-experiment.txt）：
 *   · 构造参数 width/height 不可信（请求 360×44 → 362×46）
 *   · 创建后 setBounds({width,height}) 在本实验里**精确且幂等**
 *
 * 但产品窗口（真实配置 + 加载 card.html + showInactive）实测是 361×44 或 362×44，
 * 而且宽度还会在几次操作之间上下漂 1px。
 *
 * 两者差在哪？不是配置，是**时间线** —— 实验窗口从未 show()。
 * 本脚本用与产品完全一致的配置，按时间线逐步读一次 bounds，
 * 把"哪一步把宽度顶大了"钉死。
 */
import { app, BrowserWindow, screen } from 'electron';
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = path.join(ROOT, 'report', 'winsize2-timeline.txt');
const say = (s = '') => appendFileSync(LOG, s + '\n');
writeFileSync(LOG, '');

const W = 360;
const H = 44;
const PRELOAD = path.join(ROOT, 'src', 'preload', 'index.cjs');
const RENDERER = path.join(ROOT, 'src', 'renderer');

/** 与 src/main/window.js · createCardWindow 完全一致的配置 */
function productWindowOptions(x, y) {
  return {
    width: W,
    height: H,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
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
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor;
  const wa = primary.workArea;
  const x = wa.x + wa.width - W - 12;
  const y = wa.y + 12;

  say('=== 宽度 +1~2px 的来源追踪 ===');
  say(`时间: ${new Date().toISOString()}`);
  say(`scaleFactor=${scale}  请求 ${W}×${H} @ (${x},${y})`);
  say('');

  const step = (label, win) => {
    const b = win.getBounds();
    let rect = null;
    try { rect = screen.dipToScreenRect(win, b); } catch (e) { rect = { err: e.message }; }
    say(
      `${label.padEnd(34)} getBounds=${String(b.width).padStart(4)}×${String(b.height).padStart(3)}` +
        `  物理(dipToScreenRect)=${rect.width}×${rect.height}` +
        `  Δw=${b.width - W} Δh=${b.height - H}` +
        (b.width === W && b.height === H ? '  ✅' : '  ✗')
    );
    return b;
  };

  /* ---- 场景 1：完全复刻产品顺序 ---- */
  say('--- 场景 1：复刻产品顺序（构造 → setBounds → load → show）---');
  let w1 = new BrowserWindow(productWindowOptions(x, y));
  step('① 构造完成后', w1);

  w1.setAlwaysOnTop(true, 'screen-saver');
  w1.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  step('② setAlwaysOnTop + setVisibleOnAll', w1);

  w1.setBounds({ x, y, width: W, height: H });
  step('③ setBounds 校正后', w1);

  w1.loadFile(path.join(RENDERER, 'card.html'));
  await new Promise((r) => w1.once('ready-to-show', r));
  step('④ ready-to-show 触发后', w1);

  w1.showInactive();
  step('⑤ showInactive 之后立刻', w1);
  await wait(400);
  step('⑥ show 之后 +400ms', w1);
  await wait(1200);
  step('⑦ show 之后 +1600ms', w1);

  /* ---- 场景 2：show 之后再校正一次 ---- */
  say('');
  say('--- 场景 2：show 之后再 setBounds 校正 ---');
  w1.setBounds({ x, y, width: W, height: H });
  step('⑧ show 后 setBounds', w1);
  await wait(600);
  step('⑨ +600ms', w1);
  await wait(1500);
  step('⑩ +2100ms', w1);

  /* ---- 场景 3：hide → showInactive 再来一遍 ---- */
  say('');
  say('--- 场景 3：hide 再 showInactive ---');
  w1.hide();
  await wait(200);
  step('⑪ hide 后', w1);
  w1.showInactive();
  await wait(500);
  step('⑫ showInactive +500ms', w1);

  /* ---- 场景 4：什么都不做的重复读 ---- */
  say('');
  say('--- 场景 4：不做任何操作，只重复读 5 次（看读数本身稳不稳）---');
  for (let i = 1; i <= 5; i += 1) {
    step(`⑬.${i} 纯读`, w1);
    await wait(120);
  }

  /* ---- 场景 5：把窗口移到屏外再移回来（看位置是否影响宽度）---- */
  say('');
  say('--- 场景 5：移动到屏中央（远离右边界）---');
  w1.setBounds({ x: 300, y: 300, width: W, height: H });
  await wait(400);
  step('⑭ 屏中央', w1);
  w1.setBounds({ x: wa.x + wa.width - W - 12, y, width: W, height: H });
  await wait(400);
  step('⑮ 回到右上角', w1);

  /* ---- 结论 ---- */
  say('');
  say('--- 小结 ---');
  say('看 ①→②③ 与 ④⑤⑥⑦ 两段的 Δw：前者说明构造参数的偏差，');
  say('后者说明 show() 是否又顶大了一次、以及 show 后校正是否管用。');

  if (!w1.isDestroyed()) w1.destroy();
  say('');
  say('（实验结束）');
  app.exit(0);
});
