import { ipcMain, app, screen, shell } from 'electron';
import contract from '../shared/contract.cjs';
import * as cap from './capability.js';
import * as win from './window.js';
import * as probe from './probe.js';

const { IPC, WINDOW_STATE } = contract;

/** 缓存一份完整探测结果，避免面板每次刷新都去调 PowerShell */
let cachedFacts = null;

/** 词汇表一致性自检结果（见下方 CAPABILITY_RENDERER_FACTS 处理） */
let contractParity = null;

/**
 * 渲染进程上报的事实也要用模块级变量兜住 —— 不能只挂在 cachedFacts 上。
 *
 * 为什么：M0 自检时抓到过一个竞态 ——
 *   卡片窗口加载完（~200ms）就上报了 devicePixelRatio 与通道表，
 *   而 collectFacts() 还在等 PowerShell 返回（要几百毫秒）。
 *   那一刻 cachedFacts 还是 null，于是 `if (cachedFacts)` 把数据静默丢弃，
 *   表现为「渲染进程事实 = (未上报)」「词汇表自检 = (未完成)」，
 *   但同一份数据又通过 addEvidence 进了报告 —— 前后自相矛盾。
 *
 * 教训：**上报与聚合这两件事不能共用一个"稍后才存在"的容器。**
 * 上报先落模块级变量，聚合时再合并。
 */
let rendererFacts = null;

export function getContractParity() {
  return contractParity;
}

export function getRendererFacts() {
  return rendererFacts;
}

export async function collectFacts() {
  const electronDisplays = cap.getElectronDisplayFacts();
  const windowsDisplays = await cap.getWindowsDisplayFacts();
  const scaleCrossCheck = cap.crossCheckScaleFactor(electronDisplays, windowsDisplays);
  const gpu = cap.getGpuFacts();

  cachedFacts = {
    collectedAt: new Date().toISOString(),
    electron: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      isPackaged: app.isPackaged,
      highDpiSupport: app.commandLine.hasSwitch('high-dpi-support'),
      forceDeviceScaleFactor: app.commandLine.getSwitchValue('force-device-scale-factor') || null,
    },
    electronDisplays,
    windowsDisplays,
    scaleCrossCheck,
    gpu,
    // 合并：如果把上报数据丢掉，就会重现上面那个竞态
    rendererFacts: rendererFacts || null,
    contractParity: contractParity || null,
  };

  probe.setFacts(cachedFacts);
  return cachedFacts;
}

export function getCachedFacts() {
  return cachedFacts;
}

export function registerIpc(getWindows) {
  /* ---------------- 能力探测 ---------------- */

  ipcMain.handle(IPC.CAPABILITY_GET, async () => {
    const electronDisplays = cap.getElectronDisplayFacts();
    const scaleCrossCheck = cachedFacts
      ? cap.crossCheckScaleFactor(electronDisplays, cachedFacts.windowsDisplays)
      : null;
    if (cachedFacts) {
      cachedFacts.electronDisplays = electronDisplays;
      cachedFacts.scaleCrossCheck = scaleCrossCheck;
      probe.setFacts(cachedFacts);
    }
    return {
      electron: cachedFacts ? cachedFacts.electron : null,
      electronDisplays,
      windowsDisplays: cachedFacts ? cachedFacts.windowsDisplays : null,
      scaleCrossCheck,
      gpu: cachedFacts ? cachedFacts.gpu : null,
      rendererFacts: cachedFacts ? cachedFacts.rendererFacts : null,
      contractParity,
      dipApi: win.state.dipApi,
    };
  });

  ipcMain.handle(IPC.CAPABILITY_RENDERER_FACTS, (_e, data) => {
    /* 先落到模块级变量 —— 这样即使 cachedFacts 还没建好也不会丢数据（见上方竞态说明） */
    rendererFacts = { ...data, at: new Date().toISOString() };
    if (cachedFacts) cachedFacts.rendererFacts = rendererFacts;

    /* ---- 词汇表自检（M0 发现 · B2）----
       sandbox: true 让 preload 无法 require contract.cjs，只能在 preload 里内联一份副本。
       这份重复必须是"被检查的不变量"，而不是隐患。
       渲染进程每次上报都会带上它那份通道表，这里逐项比对。 */
    if (data && Array.isArray(data.channels)) {
      const expected = Object.values(IPC).slice().sort();
      const actual = data.channels.slice().sort();
      const missing = expected.filter((c) => !actual.includes(c));
      const extra = actual.filter((c) => !expected.includes(c));
      const drift = missing.length || extra.length;
      contractParity = {
        ok: !drift,
        expectedCount: expected.length,
        actualCount: actual.length,
        missing,
        extra,
      };
      if (drift) {
        console.error(
          '[contract] 词汇表漂移！preload 内联副本与 shared/contract.cjs 不一致。' +
            ` 缺失=${JSON.stringify(missing)} 多余=${JSON.stringify(extra)}`,
        );
      }
    }

    if (cachedFacts) {
      cachedFacts.contractParity = contractParity;
      probe.setFacts(cachedFacts);
    }

    // 渲染进程的 devicePixelRatio 是验收 9 的第三路证据
    if (data && data.devicePixelRatio != null) {
      probe.addEvidence(
        9,
        `渲染进程 devicePixelRatio = ${data.devicePixelRatio}` +
          (data.screenWidth ? `，screen.width×height = ${data.screenWidth}×${data.screenHeight}` : ''),
      );
    }
    if (data && data.backdropSupported != null) {
      probe.addEvidence(
        2,
        `CSS.supports('backdrop-filter','blur(20px)') = ${data.backdropSupported}` +
          `，-webkit- 前缀 = ${data.webkitBackdropSupported}`,
      );
    }
    return { ok: true };
  });

  ipcMain.handle(IPC.CONTRACT_PARITY, () => contractParity);

  /* ---------------- 验收状态 ---------------- */

  ipcMain.handle(IPC.PROBE_STATE, () => probe.getProbeState());

  ipcMain.handle(IPC.PROBE_PATCH, (_e, payload) => {
    const { id, status, detail, note } = payload || {};
    if (id) {
      if (status || detail) probe.setCheck(id, { status, detail });
      if (typeof note === 'string') probe.setNote(id, note);
    }
    broadcastProbe();
    return probe.getProbeState();
  });

  ipcMain.handle(IPC.REPORT_EXPORT, async () => {
    const file = await probe.saveReport();
    shell.showItemInFolder(file);
    return { ok: true, file };
  });

  /* ---------------- 窗口控制 ---------------- */

  ipcMain.handle(IPC.WINDOW_GET_STATE, () => win.getCardState());

  ipcMain.handle(IPC.WINDOW_SET_STATE, async (_e, next) => win.setCardState(next));

  ipcMain.handle(IPC.WINDOW_SET_SURFACE, (_e, next) => win.setSurface(next));

  ipcMain.handle(IPC.WINDOW_SET_OPACITY, (_e, id) => win.setOpacity(id));

  ipcMain.handle(IPC.WINDOW_SET_VISIBLE, (_e, visible) => win.setCardVisible(!!visible));

  ipcMain.handle(IPC.WINDOW_SET_DIAG, (_e, on) => win.setDiag(on));

  ipcMain.handle(IPC.WINDOW_SNAP, () => {
    const r = win.snapToEdge();
    if (r) {
      const worst = Math.max(
        Math.abs(r.deviation.dx),
        Math.abs(r.deviation.dy),
        Math.abs(r.deviation.dw),
        Math.abs(r.deviation.dh),
      );
      probe.setCheck(8, {
        // 自动部分通过不等于整条验收通过 —— 跨屏目视偏差人才能判，所以留 PENDING 而不是 PASS
        status: worst === 0 ? probe.STATUS.PENDING : probe.STATUS.FAIL,
        detail:
          worst === 0
            ? `自动部分通过：吸附落点与目标完全一致（偏差 0px，含物理像素网格对齐，步长 ${r.gridAlign && r.gridAlign.step}）。右侧留白 ${r.gapToRightEdge}px。仍需人工确认跨屏拖动后的目视落点。`
            : `吸附落点与目标不一致，最大偏差 ${worst}px。`,
      });
      probe.addEvidence(
        8,
        `吸附测试：目标 (${r.expected.x},${r.expected.y}) ${r.expected.width}×${r.expected.height}，` +
          `实际 (${r.actual.x},${r.actual.y}) ${r.actual.width}×${r.actual.height}，偏差 ${worst}px`,
      );
    }
    broadcastProbe();
    return { snap: r, card: win.getCardState() };
  });

  ipcMain.handle(IPC.WINDOW_RECORD_POS, () => {
    const rt = win.boundsRoundtrip();
    const m = win.measureCard();

    if (rt) {
      const worst = Math.max(
        Math.abs(rt.deviation.dx),
        Math.abs(rt.deviation.dy),
        Math.abs(rt.deviation.dw),
        Math.abs(rt.deviation.dh),
      );
      probe.addEvidence(
        8,
        `坐标往返一致性（原样写回再读回）：偏差 ${worst}px，显示器 ${rt.displayAtCard.label} scaleFactor=${rt.displayAtCard.scaleFactor}`,
      );
    }
    if (m) {
      probe.addEvidence(
        6,
        `当前缩放 ${m.display.scaleFactor}（${Math.round(m.display.scaleFactor * 100)}%）：` +
          `卡片 DIP ${m.boundsDip.width}×${m.boundsDip.height}，` +
          `物理 ${m.expectedPhysical.w}×${m.expectedPhysical.h}，` +
          `尺寸精确 = ${m.isCollapsedSizeExact}` +
          (m.dipApi && m.dipApi.available
            ? `，dipToScreenRect = ${JSON.stringify(m.dipApi.screenRect)}`
            : '，dipToScreen* API 不可用'),
      );
    }

    broadcastProbe();
    return { roundtrip: rt, measure: m, card: win.getCardState() };
  });

  ipcMain.handle(IPC.WINDOW_MOVE_TO_DISPLAY, (_e, displayId) => {
    const card = win.state.card;
    if (!card || card.isDestroyed()) return { ok: false, reason: '卡片窗口不存在' };
    const d = screen.getAllDisplays().find((x) => x.id === displayId);
    if (!d) return { ok: false, reason: `找不到显示器 id=${displayId}` };

    const b = card.getBounds();
    const wa = d.workArea;
    // 落点对齐到物理像素网格，否则窗口会自己胖 1px（见 window.js · physicalGridStep）
    const g = win.alignToPhysicalGrid(
      wa.x + wa.width - b.width - 12,
      wa.y + 12,
      d.scaleFactor,
    );
    const target = {
      x: g.x,
      y: g.y,
      width: b.width,
      height: b.height,
    };
    card.setBounds(target);
    const after = card.getBounds();
    win.state.posMemory.set(d.id, { x: after.x, y: after.y });

    probe.addEvidence(
      8,
      `移到显示器 ${d.label}（scaleFactor=${d.scaleFactor}）：目标 (${target.x},${target.y})，实际 (${after.x},${after.y})，` +
        `偏差 (${after.x - target.x},${after.y - target.y})，网格步长 ${g.step}`,
    );
    broadcastProbe();
    return { ok: true, target, after, display: { id: d.id, label: d.label, scaleFactor: d.scaleFactor } };
  });

  /* ---------------- 焦点测试 ---------------- */

  ipcMain.handle(IPC.FOCUS_TEST_START, (_e, durationMs) => {
    // 刻意不 await：面板要立刻拿到 running 快照去画进度条。
    // 结论由 recordFocusVerdict 在测试结束时写回，不在这里同步等 20 秒。
    runFocusTestAndRecord(durationMs);
    return win.getFocusTestState();
  });

  /* ---------------- 日志 ---------------- */

  ipcMain.handle(IPC.LOG, (_e, msg) => {
    console.log('[renderer]', msg);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ */
/* 验收 3 · 焦点测试的判定与写回                                          */
/* ------------------------------------------------------------------ */

/**
 * 跑一次焦点测试，并**把结论写回验收 3**。
 *
 * ★ 这就是验收 3 此前缺失的那根线（2026-09-18 补）。
 *
 * 症状：焦点测试一直在跑，window.js 里的 verdict 也算得对，
 *   但从来没有人把 verdict 写回验收状态 —— 它只被推给面板显示，然后就没了。
 *   于是摘要里永远写着 "3. [pending]"，哪怕面板上明明白白显示着「通过」。
 *   直接证据：同一次自检里 verdict=pass、cardFocusCount=0、panelBlurCount=0，
 *   而摘要里 3 却还是 pending。代价：M0 那 5 个 pending 里有 1 个是**虚高的**。
 *
 * 根因是两处叠加，缺一不可：
 *   1. 自检（index.js · runSelftest）直接调 win.startFocusTest()，绕过了 ipc 层；
 *   2. ipc 层的 handler 也只是把 startFocusTest 的返回值还给面板，同样没写回。
 * 也就是说 verdict 生产得很好，只是**没有任何消费者**。
 *
 * 修法：把"判定 + 写回"收进这一个函数，面板按钮与自检都走它 ——
 *   两条路径共用一个实现，避免"自检看到的结论"与"面板看到的结论"分叉。
 *
 * @returns {Promise<object>} 测试终态快照
 */
export function runFocusTestAndRecord(durationMs) {
  return new Promise((resolve) => {
    win.startFocusTest(durationMs, (s) => {
      recordFocusVerdict(s);
      resolve(s);
    });
  });
}

function recordFocusVerdict(s) {
  let status;
  let detail;
  if (s.verdict === 'pass') {
    status = probe.STATUS.PASS;
    detail =
      `${s.durationMs / 1000} 秒内主动显示卡片 ${s.cardShowCount} 次，` +
      `卡片 focus 事件 0 次、面板 blur 事件 0 次 —— 显示动作确实发生了，且没有抢焦点`;
  } else if (s.verdict === 'invalid') {
    // 关键：不许把"什么都没测到"算成通过（与验收 7 的 UNABLE 同理）
    status = probe.STATUS.UNABLE;
    detail =
      '测试期内没有发生"显示卡片"这个动作（cardShowCount=0），什么都没测到。' +
      '这不是通过，是测试没跑起来 —— 请确认卡片处于显示状态后重测';
  } else {
    status = probe.STATUS.FAIL;
    detail =
      `卡片抢了焦点：测试期卡片 focus 事件 ${s.cardFocusCount} 次、` +
      `面板 blur 事件 ${s.panelBlurCount} 次（任一非 0 即失败）`;
  }
  probe.setCheck(3, {
    status,
    detail,
    evidence: [
      `测试时长 ${s.durationMs}ms；cardShowCount=${s.cardShowCount}（证明"显示卡片"确实发生过），` +
        `cardFocusCount=${s.cardFocusCount}，panelBlurCount=${s.panelBlurCount}`,
      '判定口径：有抢焦点 → fail；无抢焦点但 cardShowCount=0 → invalid（不是 pass）；否则 pass。' +
        '口径来源：window.js · getFocusTestState()，不在本处重算',
      '被测行为：测试开始 300ms 后调用一次 win.showInactive()（对应 window.js 的"显示卡片"路径）',
    ],
  });
  broadcastProbe();
  return status;
}

export function broadcastProbe() {
  const s = probe.getProbeState();
  const { panel, card } = win.state;
  for (const w of [panel, card]) {
    if (w && !w.isDestroyed()) w.webContents.send(IPC.PROBE_STATE, s);
  }
}
