import { app, screen } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const PS1_PATH = path.resolve(here, '..', '..', 'tools', 'win-display-facts.ps1');

/**
 * Electron 自己看到的显示器世界。
 * display.size / display.bounds 单位都是 DIP（CSS px），scaleFactor 是缩放比。
 */
export function getElectronDisplayFacts() {
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();

  return {
    primaryId: primary.id,
    count: all.length,
    displays: all.map((d) => ({
      id: d.id,
      label: d.label || '(未命名显示器)',
      internal: !!d.internal,
      rotation: d.rotation,
      scaleFactor: d.scaleFactor,
      sizeDip: { w: d.size.width, h: d.size.height },
      boundsDip: {
        x: d.bounds.x,
        y: d.bounds.y,
        w: d.bounds.width,
        h: d.bounds.height,
      },
      workAreaDip: {
        x: d.workArea.x,
        y: d.workArea.y,
        w: d.workArea.width,
        h: d.workArea.height,
      },
      // 这是 Electron「以为」的物理分辨率
      physicalExpected: {
        w: Math.round(d.size.width * d.scaleFactor),
        h: Math.round(d.size.height * d.scaleFactor),
      },
    })),
  };
}

/**
 * 问 Windows 要真实答案。这是外部基准，不接受 Electron 的任何输入。
 */
export async function getWindowsDisplayFacts() {
  const outFile = path.join(os.tmpdir(), `mb-display-facts-${process.pid}-${Date.now()}.json`);
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH, '-OutFile', outFile],
      { timeout: 20000, windowsHide: true },
    );
    const raw = await fs.readFile(outFile, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    return { ok: false, monitors: [], errors: [`调用 PowerShell 失败: ${err.message}`] };
  } finally {
    fs.unlink(outFile).catch(() => {});
  }
}

/**
 * GPU / 合成状态。用于判断「backdrop-filter 静默失效」是否有可能与软件渲染路径有关。
 */
export function getGpuFacts() {
  let featureStatus = null;
  try {
    featureStatus = app.getGPUFeatureStatus();
  } catch (err) {
    featureStatus = { error: String(err.message) };
  }
  return {
    featureStatus,
    // 只取基本信息，避免较慢的完整 GPU 信息收集
    hardwareAccelerationRequested: !app.commandLine.hasSwitch('disable-gpu'),
  };
}

/**
 * ⭐ 验收 9 的核心：交叉校验 scaleFactor 可不可信。
 *
 * 两条独立的证据链，任何一条对不上就说明读数有问题：
 *   证据 A（分辨率一致性）：dip尺寸 × scaleFactor 应当等于 Windows 报的物理分辨率
 *   证据 B（缩放比一致性）：scaleFactor 应当等于 Windows 的 logPixels / 96
 *
 * 两条都过 → 可信；任一条不过 → 不可信，并给出具体差多少。
 */
export function crossCheckScaleFactor(electronFacts, windowsFacts) {
  const findings = [];
  const monitors = (windowsFacts && windowsFacts.monitors) || [];

  if (!windowsFacts || !windowsFacts.ok || monitors.length === 0) {
    return {
      reliable: null,
      verdict: 'unknown',
      reason: '拿不到 Windows 侧的真实显示参数，无法交叉校验。',
      findings,
    };
  }

  const TOL = 3; // 允许 ±3 物理像素，吸收 DIP 取整带来的误差
  const perDisplay = [];

  for (const d of electronFacts.displays) {
    const entry = {
      displayId: d.id,
      label: d.label,
      scaleFactor: d.scaleFactor,
      dipSize: `${d.sizeDip.w}×${d.sizeDip.h}`,
      electronThinksPhysical: `${d.physicalExpected.w}×${d.physicalExpected.h}`,
      windowsTruthPhysical: null,
      windowsLogPixels: null,
      windowsImpliedScale: null,
      evidenceA: null,
      evidenceB: null,
    };

    // 匹配：优先按物理坐标，退而按分辨率
    const expX = Math.round(d.boundsDip.x * d.scaleFactor);
    const expY = Math.round(d.boundsDip.y * d.scaleFactor);
    let m =
      monitors.find((c) => Math.abs(c.x - expX) <= TOL && Math.abs(c.y - expY) <= TOL) ||
      monitors.find(
        (c) =>
          Math.abs(c.width - d.physicalExpected.w) <= TOL &&
          Math.abs(c.height - d.physicalExpected.h) <= TOL,
      ) ||
      null;

    // 匹配失败的兜底：单显示器时直接对第一个
    if (!m && monitors.length === 1 && electronFacts.count === 1) {
      m = monitors[0];
      entry.matchedBy = 'fallback-single-monitor';
    } else if (m) {
      entry.matchedBy = 'position-or-size';
    }

    if (!m) {
      entry.evidenceA = 'unmatched';
      findings.push(
        `显示器 ${d.label}（id=${d.id}）在 Windows 侧找不到对应实体 —— 坐标或分辨率对不上。`,
      );
      perDisplay.push(entry);
      continue;
    }

    entry.windowsTruthPhysical = `${m.width}×${m.height}`;
    entry.windowsLogPixels = m.logPixels;

    // 证据 A
    const dW = Math.abs(d.physicalExpected.w - m.width);
    const dH = Math.abs(d.physicalExpected.h - m.height);
    entry.evidenceA = dW <= TOL && dH <= TOL ? 'pass' : `fail(差 ${dW}×${dH}px)`;
    if (entry.evidenceA !== 'pass') {
      findings.push(
        `证据 A 不通过：显示器 ${d.label} —— Electron 算出物理尺寸 ${entry.electronThinksPhysical}，` +
          `Windows 报的是 ${entry.windowsTruthPhysical}。` +
          `说明 scaleFactor=${d.scaleFactor} 与 DIP 尺寸不自洽。`,
      );
    }

    // 证据 B
    if (m.logPixels && m.logPixels > 0) {
      const implied = m.logPixels / 96;
      entry.windowsImpliedScale = Number(implied.toFixed(4));
      const diff = Math.abs(implied - d.scaleFactor);
      entry.evidenceB = diff <= 0.02 ? 'pass' : `fail(Windows 认为 ${implied}，Electron 报 ${d.scaleFactor})`;
      if (entry.evidenceB !== 'pass') {
        findings.push(
          `证据 B 不通过：显示器 ${d.label} —— Windows 的 logPixels=${m.logPixels} 推出缩放应为 ${implied}，` +
            `但 Electron 报 scaleFactor=${d.scaleFactor}。**这就是已知缺陷的复现：scaleFactor 读数不可靠。**`,
        );
      }
    } else {
      entry.evidenceB = 'no-data';
    }

    perDisplay.push(entry);
  }

  const anyFail = perDisplay.some(
    (e) => e.evidenceA === 'fail' || String(e.evidenceA).startsWith('fail') ||
           String(e.evidenceB).startsWith('fail') || e.evidenceA === 'unmatched',
  );
  const allPass = perDisplay.length > 0 && !anyFail;

  return {
    reliable: allPass,
    verdict: allPass ? 'pass' : anyFail ? 'fail' : 'unknown',
    reason: allPass
      ? '两条独立证据链（分辨率一致性 + 缩放比一致性）全部吻合，scaleFactor 可以采信。'
      : '存在不一致，scaleFactor 不可直接采信，需要改用 getDisplayNearestPoint() 或在渲染进程侧交叉校验。',
    perDisplay,
    findings,
  };
}
