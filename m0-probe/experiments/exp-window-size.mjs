/**
 * _diag/winsize.mjs —— 把「360×44 变成 364×46」这件事查清楚
 *
 * 背景：M0 自检里验收 1 判 FAIL —— 请求 360×44，getBounds() 读出 364×46（宽 +4、高 +2）。
 * 而且 boundsRoundtrip 显示「原样写回再读回」会 +1px 漂移（stable=false）。
 *
 * 一段猜不出来的偏差，就该被量出来。本脚本做两件事：
 *   A. 枚举候选配置，看哪一个能让 getBounds() 精确等于请求值
 *      （thickFrame / useContentSize / roundedCorners / transparent / resizable）
 *   B. 反复「原样写回」，看漂移是收敛、发散还是随机
 *   C. 顺带试 dipToScreenRect 的三种传参方式，定位那个 conversion failure
 *
 * 全程不用顶层 await（ESM 主进程里那是死锁，见 B10）。
 */
import { app, BrowserWindow, screen } from 'electron';
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LOG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'winsize-experiment.txt'
);
const say = (s = '') => appendFileSync(LOG, s + '\n');
writeFileSync(LOG, '');

const W = 360;
const H = 44;

/** 共用的基础配置 —— 与 src/main/window.js 的 createCardWindow 保持一致 */
const BASE = {
  frame: false,
  transparent: true,
  alwaysOnTop: true,
  skipTaskbar: true,
  resizable: false,
  hasShadow: false,
  show: false,
  backgroundColor: '#00000000',
};

const COMBOS = [
  { id: 'baseline（与产品代码一致）', add: {} },
  { id: 'thickFrame:false', add: { thickFrame: false } },
  { id: 'useContentSize:true', add: { useContentSize: true } },
  { id: 'useContentSize+thickFrame:false', add: { useContentSize: true, thickFrame: false } },
  { id: 'roundedCorners:false', add: { roundedCorners: false } },
  { id: 'resizable:true', add: { resizable: true } },
  { id: 'transparent:false（对照）', add: { transparent: false } },
  { id: 'frame:true（对照）', add: { frame: true } },
];

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor;

  say('=== 窗口尺寸偏差实验 ===');
  say(`时间: ${new Date().toISOString()}`);
  say(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`);
  say(`主屏 scaleFactor = ${scale}（${Math.round(scale * 100)}%）  物理基准 ${Math.round(primary.size.width * scale)}×${Math.round(primary.size.height * scale)}`);
  say(`请求尺寸 ${W}×${H}（DIP）→ 物理应约 ${Math.round(W * scale)}×${Math.round(H * scale)}`);
  say('');

  /* ---------- A. 配置对照 ---------- */
  say('--- A. 哪种配置能让 getBounds() 精确等于请求值 ---');
  say('配置'.padEnd(34) + 'getBounds()'.padEnd(16) + 'getContentBounds()'.padEnd(20) + '物理推算');
  const results = [];

  for (const combo of COMBOS) {
    let win = null;
    let rec = { id: combo.id };
    try {
      win = new BrowserWindow({ ...BASE, ...combo.add, width: W, height: H, x: 50, y: 50 });
      const b = win.getBounds();
      const cb = win.getContentBounds();
      rec.bounds = b;
      rec.contentBounds = cb;
      rec.dw = b.width - W;
      rec.dh = b.height - H;
      rec.physical = { w: Math.round(b.width * scale), h: Math.round(b.height * scale) };
      say(
        combo.id.padEnd(34) +
          `${b.width}×${b.height}`.padEnd(16) +
          `${cb.width}×${cb.height}`.padEnd(20) +
          `${rec.physical.w}×${rec.physical.h}` +
          (rec.dw === 0 && rec.dh === 0 ? '   ✅ 精确' : `   ✗ Δw=${rec.dw} Δh=${rec.dh}`)
      );
    } catch (err) {
      rec.error = err.message;
      say(combo.id.padEnd(34) + 'THROW ' + err.message);
    } finally {
      if (win && !win.isDestroyed()) win.destroy();
    }
    results.push(rec);
  }
  say('');

  /* ---------- B. 原样写回漂移 ---------- */
  say('--- B. 反复「原样写回」的漂移（验收 8 的自动部分）---');
  const w2 = new BrowserWindow({ ...BASE, width: W, height: H, x: 60, y: 60 });
  say(`初始      : ${JSON.stringify(w2.getBounds())}`);
  let prev = w2.getBounds();
  for (let i = 1; i <= 6; i += 1) {
    w2.setBounds(prev);
    const now = w2.getBounds();
    const d = { dx: now.x - prev.x, dy: now.y - prev.y, dw: now.width - prev.width, dh: now.height - prev.height };
    say(
      `第 ${i} 次 : ${JSON.stringify(now)}  相对上次 Δx=${d.dx} Δy=${d.dy} Δw=${d.dw} Δh=${d.dh}` +
        (d.dx || d.dy || d.dw || d.dh ? '  ← 不幂等' : '  ✅ 幂等')
    );
    prev = now;
  }

  /* 再用「固定目标」重复写，看是否收敛 */
  say('');
  say('--- B2. 反复写同一个固定目标 (x=200,y=200,360×44) ---');
  for (let i = 1; i <= 4; i += 1) {
    w2.setBounds({ x: 200, y: 200, width: W, height: H });
    const now = w2.getBounds();
    say(`第 ${i} 次 : ${JSON.stringify(now)}  Δw=${now.width - W} Δh=${now.height - H}`);
  }

  /* 试 setSize / setContentSize */
  say('');
  say('--- B3. setSize vs setContentSize ---');
  try {
    w2.setSize(W, H);
    say(`setSize(${W},${H})        → getBounds=${JSON.stringify(w2.getBounds())} content=${JSON.stringify(w2.getContentBounds())}`);
  } catch (e) { say('setSize THROW ' + e.message); }
  try {
    w2.setContentSize(W, H);
    say(`setContentSize(${W},${H}) → getBounds=${JSON.stringify(w2.getBounds())} content=${JSON.stringify(w2.getContentBounds())}`);
  } catch (e) { say('setContentSize THROW ' + e.message); }

  /* ---------- C. dipToScreen* 传参方式 ---------- */
  say('');
  say('--- C. dipToScreenRect / dipToScreenPoint 传参方式 ---');
  const b3 = w2.getBounds();
  const variants = [
    ['dipToScreenRect(win, bounds)', () => screen.dipToScreenRect(w2, b3)],
    ['dipToScreenRect(null, bounds)', () => screen.dipToScreenRect(null, b3)],
    ['dipToScreenRect(bounds)', () => screen.dipToScreenRect(b3)],
    ['dipToScreenPoint(win, {x,y})', () => screen.dipToScreenPoint(w2, { x: b3.x, y: b3.y })],
    ['dipToScreenPoint(null, {x,y})', () => screen.dipToScreenPoint(null, { x: b3.x, y: b3.y })],
    ['screenToDipRect(win, bounds)', () => (screen.screenToDipRect ? screen.screenToDipRect(w2, b3) : '(不存在)')],
  ];
  for (const [name, fn] of variants) {
    try {
      say(`${name.padEnd(34)} → ${JSON.stringify(fn())}`);
    } catch (e) {
      say(`${name.padEnd(34)} → THROW ${e.message}`);
    }
  }

  /* ---------- D. 结论 ---------- */
  say('');
  say('--- D. 结论 ---');
  const exact = results.filter((r) => r.dw === 0 && r.dh === 0).map((r) => r.id);
  say(
    exact.length
      ? `以下配置能做到 getBounds() 精确等于请求值：${exact.join(' / ')}`
      : '⚠️ 所有测试配置都无法让 getBounds() 精确等于请求值 —— 说明偏差来自更底层（Windows 窗口管理），需要在产品侧接受或补偿。'
  );

  if (!w2.isDestroyed()) w2.destroy();
  say('');
  say('（实验结束）');

  app.exit(0);
});
