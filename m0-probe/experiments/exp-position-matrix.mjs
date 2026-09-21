/**
 * _diag/winsize3.mjs —— 宽度误差真的是「位置」的函数吗？
 *
 * 已观测（report/winsize2-timeline.txt）：
 *   x=300  → 360×44  精确
 *   x=1335 → 361×44  宽 +1
 *   show() / hide() / 重复读 / 再校正一次，都改变不了结果 → 与时间线无关。
 *
 * 两个竞争假设：
 *   H1「物理像素对齐」：DIP × 1.5 必须是整数，即 x 为偶数时精确。
 *                        （150% 缩放下 x 奇数 → 物理坐标落在 .5 上，只能取整）
 *   H2「右边界邻近」   ：靠近屏幕右边缘时 Windows 会微调，与奇偶无关。
 *
 * 用一张 x 取值的矩阵把两者分开。
 * 判定：若"远离右边界"那组也表现出奇偶规律 → H1；若只有"靠近右边界"那组偏 → H2。
 */
import { app, BrowserWindow, screen } from 'electron';
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOG = path.join(ROOT, 'report', 'winsize3-matrix.txt');
const say = (s = '') => appendFileSync(LOG, s + '\n');
writeFileSync(LOG, '');

const W = 360;
const H = 44;

function options(x, y) {
  return {
    width: W, height: H, x, y,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, hasShadow: false, show: false, backgroundColor: '#00000000',
  };
}

app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor;
  const wa = primary.workArea;

  say('=== 宽度误差 vs 水平位置 矩阵 ===');
  say(`scaleFactor=${scale}  请求 ${W}×${H}`);
  say(`workArea(DIP) = x:${wa.x}..${wa.x + wa.width}  y:${wa.y}..${wa.y + wa.height}`);
  say(`屏幕右边界(DIP) = ${wa.x + wa.width}`);
  say('');

  const win = new BrowserWindow(options(100, 100));
  // ⚠️ 不要等 ready-to-show：没有 loadURL 的空窗口永远不会触发它，会把实验挂死。
  await new Promise((r) => setTimeout(r, 900));

  const probe = async (x, y) => {
    win.setBounds({ x, y, width: W, height: H });
    await new Promise((r) => setTimeout(r, 120));
    const b = win.getBounds();
    let rect = null;
    try { rect = screen.dipToScreenRect(win, b); } catch (e) { rect = {}; }
    return {
      x, y,
      xPhysicalIdeal: x * scale,
      bounds: b,
      screenRect: rect,
      dw: b.width - W,
      dh: b.height - H,
      rightEdgeDip: x + W,
      gapToRight: wa.x + wa.width - (x + W),
    };
  };

  const runGroup = async (title, xs, y) => {
    say(`--- ${title} (y=${y}) ---`);
    say(
      'x'.padStart(6) +
        'x×1.5'.padStart(10) +
        '整数?'.padStart(7) +
        '读回宽度'.padStart(10) +
        '物理宽'.padStart(8) +
        'Δw'.padStart(5) +
        'Δh'.padStart(5) +
        '  距右边界'
    );
    for (const x of xs) {
      const r = await probe(x, y);
      const isInt = Number.isInteger(r.xPhysicalIdeal);
      say(
        String(r.x).padStart(6) +
          String(r.xPhysicalIdeal).padStart(10) +
          String(isInt ? '是' : '否').padStart(7) +
          String(`${r.bounds.width}×${r.bounds.height}`).padStart(10) +
          String(r.screenRect.width ?? '?').padStart(8) +
          String(r.dw).padStart(5) +
          String(r.dh).padStart(5) +
          String('  ' + r.gapToRight).padStart(12) +
          (r.dw === 0 && r.dh === 0 ? '   ✅' : '   ✗')
      );
    }
    say('');
  };

  /* 远离右边界：只测奇偶，排除"贴边"干扰 */
  await runGroup('A · 远离右边界（x 个小值，连续奇偶）', [700, 701, 702, 703, 704, 705], 300);
  /* 靠近右边界：既测奇偶又测贴边 */
  await runGroup('B · 靠近右边界（右边缘距屏边约 12 DIP）', [1330, 1331, 1334, 1335, 1336, 1337], 300);
  /* 右边界正贴（gap=0）与略微越界 */
  await runGroup('C · 右边缘紧贴屏幕边界', [wa.x + wa.width - W, wa.x + wa.width - W - 1, wa.x + wa.width - W - 2], 300);
  /* 竖直方向也扫一遍：高度是否同样受 y 奇偶影响 */
  say('--- D · 竖直方向（固定 x=700，扫 y）---');
  say('y'.padStart(6) + 'y×1.5'.padStart(10) + '读回尺寸'.padStart(12) + 'Δw'.padStart(5) + 'Δh'.padStart(5));
  for (const y of [301, 302, 303, 304, 305]) {
    const r = await probe(700, y);
    say(
      String(y).padStart(6) +
        String(y * scale).padStart(10) +
        String(`${r.bounds.width}×${r.bounds.height}`).padStart(12) +
        String(r.dw).padStart(5) +
        String(r.dh).padStart(5) +
        (r.dw === 0 && r.dh === 0 ? '   ✅' : '   ✗')
    );
  }

  say('');
  say('--- 判定 ---');
  say('若 A 组（远离右边界）也随奇偶变化 → 支持 H1「物理像素对齐」');
  say('若只有 B/C 组偏 → 支持 H2「右边界邻近」');

  if (!win.isDestroyed()) win.destroy();
  say('');
  say('（实验结束）');
  app.exit(0);
});
