/* ------------------------------------------------------------------ */
/* ⚠️ 两条 Electron 环境陷阱，写在这里以免后人再踩（见审查报告 B10 / B11）
 *
 * 1) 本机环境预设 ELECTRON_RUN_AS_NODE=1（由宿主 Electron 应用泄漏给子进程）。
 *    只要它存在，electron.exe 会退化成「普通 Node」：不开窗口、不注入 Electron API，
 *    于是 import { app } from 'electron' 会以一句极难懂的
 *    "does not provide an export named 'BrowserWindow'" 崩掉。
 *    → 变量在进程启动时即被读取，进程内无法自救；只能由 tools/launch-electron.mjs
 *      在 spawn 之前删掉。所以启动入口必须走 npm start / npm run selftest。
 *
 * 2) ESM 主进程里**不能**在顶层 `await app.whenReady()`。
 *    Electron 要等入口模块求值完毕才发 ready，而你在等 ready 才结束求值 —— 死锁。
 *    → 一律写成 app.whenReady().then(...)。（已用 _diag 对照实验坐实）
 * ------------------------------------------------------------------ */

import path from 'node:path';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, screen } from 'electron';
import * as win from './window.js';
import * as probe from './probe.js';
import { registerIpc, collectFacts, getCachedFacts, broadcastProbe, runFocusTestAndRecord } from './ipc.js';
import { measureBackdropBlur } from './blurmeasure.js';
import { installFailureHandlers, takePendingCrash, describeCrash } from './crashlog.js';
import { tagFromEnv, selftestReportName, selftestLogName } from './artifact-names.js';
import contract from '../shared/contract.cjs';

const { WINDOW_STATE } = contract;
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* 开机心跳 —— 把「Electron 到底有没有真跑起来」变成可机械判定的事实       */
/* 写在哪：report/boot-heartbeat.txt                                    */
/* 谁看：tools/launch-electron.mjs 会盯着这个文件，超时没出现就大声报警    */
/* 注：故意用同步写，避免顶层 await（顶层 await 在 ESM 主进程里是个雷区）  */
/* ------------------------------------------------------------------ */
const HEARTBEAT_FILE = path.resolve(HERE, '..', '..', 'report', 'boot-heartbeat.txt');

/* ------------------------------------------------------------------ */
/* 失败语义（B13 / B3 合并处置，2026-09-19）                             */
/*                                                                     */
/* 「上一次运行有没有崩过」必须在**任何可能抛异常的事情之前**取走：         */
/* 否则本次崩溃写下的标记，会被下一次启动当成"上次崩溃"报告 ——            */
/* 而那其实是它自己写的。顺序错了，这个机制就会开始说假话。                */
/* 取一次即消费（标记文件被删），保证同一场崩溃只被报告一次。             */
/* ------------------------------------------------------------------ */
const bootCrash = takePendingCrash();
const bootCrashTag = bootCrash
  ? `${bootCrash.kind}@${bootCrash.at}(${String(bootCrash.message).replace(/\s+/g, ' ').slice(0, 120)})`
  : 'none';

{
  const line =
    `booted=${new Date().toISOString()} ` +
    `process.type=${process.type} ` +
    `electron=${process.versions.electron} chrome=${process.versions.chrome} ` +
    `node=${process.versions.node} pid=${process.pid} ` +
    `ELECTRON_RUN_AS_NODE=${JSON.stringify(process.env.ELECTRON_RUN_AS_NODE)} ` +
    `prev_crash=${JSON.stringify(bootCrashTag)}\n`;
  mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
  writeFileSync(HEARTBEAT_FILE, line, 'utf8');
}

if (bootCrash) {
  // 崩溃过就必须有人看见 —— 打到 stderr，同时下面自检日志里也会显示
  console.error(`[main] ⚠️ 上一次运行崩溃过：${describeCrash(bootCrash)}`);
  console.error(`[main]    崩溃流水：${path.resolve(HERE, '..', '..', 'report', 'crash-log.jsonl')}`);
}

/**
 * 自检模式：npm run selftest
 * 跑完自动化环节（探测 + 状态 + 吸附 + 往返 + 尺寸 + 焦点测试），
 * 自动导出报告并退出 —— 目的是让"这套机制能不能跑通"可以被机械验证，
 * 而不是靠人手点一遍。人工判定项在自检模式下会保持"未判定"，这是正确的。
 */
const SELFTEST = process.argv.includes('--selftest');

/**
 * 自检产物的文件名后缀（默认空串 = 正式产物，一切照旧）。
 *
 * 为什么需要它：`npm run calibrate`（考裁判）内部会跑一次 `--selftest`，
 * 而那一次 `src/main/window.js` 是**故意改坏**的（`showInactive()` → `show()`）。
 * 若不做隔离，那一次的产物会盖掉 `report/_selftest-report.md`
 * —— 也就是 **M0 验收记录本体** —— 留下一份写着「M0 未通过」的假记录。
 * 这不是假设：2026-09-19 实际踩到，且当时校准器只还原了源码、没管报告。
 * 现在由校准器传入 `M0_SELFTEST_TAG=.calib`，让那一次的产物另存。
 *
 * ⚠️ 命名与合法性校验都在 `./artifact-names.js`（零依赖 · 可离线验证，见 R-B11）。
 *    那边同时是校准器那一侧的**唯一真源**，两侧不会漂移。
 */
const SELFTEST_TAG = tagFromEnv();

/** 自检模式下的日志，直接落盘（Electron 的 stdout 在 Windows 上不好抓） */
async function selftestLog(lines) {
  const file = path.resolve(HERE, '..', '..', 'report', selftestLogName(SELFTEST_TAG));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/* ------------------------------------------------------------------ */
/* 安全基线（对应审查报告 B2）                                           */
/* 这不是优化项，是基线性要求 —— 本应用会渲染外部不可信内容。              */
/* ------------------------------------------------------------------ */

// 单实例锁（对应审查报告 D1）：常驻工具绝不能跑出两份卡片、两个写库连接
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on('second-instance', () => {
  // 不报错、不弹窗，直接把卡片唤到展开态
  if (win.state.card && !win.state.card.isDestroyed()) {
    win.state.card.showInactive();
    win.setCardState(WINDOW_STATE.EXPANDED);
  }
  if (win.state.panel && !win.state.panel.isDestroyed()) {
    win.state.panel.show();
    win.state.panel.focus();
  }
});

/** 全局兜底：任何窗口都不允许导航到外部地址，也不允许自己开新窗口 */
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    const local = url.startsWith('file://');
    if (!local) {
      event.preventDefault();
      console.warn('[security] 已拦截导航:', url);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    console.warn('[security] 已拦截新开窗口:', url);
    return { action: 'deny' };
  });

  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});

/* ------------------------------------------------------------------ */
/* 启动流程                                                            */
/* ------------------------------------------------------------------ */

/**
 * 等卡片窗口把页面加载完。
 * 验收 2 的截图法需要页面已经渲染出来 —— 截一张白屏得到的是"没有信号"，
 * 而那会被判定树当成 UNABLE 而不是它真正的原因，所以宁可先等。
 */
async function waitForCardLoaded(maxMs = 8000) {
  const card = win.state.card;
  if (!card || card.isDestroyed()) return false;
  const wc = card.webContents;
  if (!wc.isLoading()) return true;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), maxMs);
    wc.once('did-finish-load', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

async function runStartupChecks() {
  const facts = getCachedFacts() || (await collectFacts());

  /* 验收 1 · 透明窗口渲染 */
  const card = win.state.card;
  const bounds = card.getBounds();
  const want = contract.CARD.COLLAPSED;
  const flagsOk =
    card.isAlwaysOnTop() &&
    !card.isDestroyed() &&
    bounds.width === want.w &&
    bounds.height === want.h;

  const d0 = screen.getDisplayMatching(bounds);
  const gridStep = win.physicalGridStep(d0.scaleFactor);
  const grid = win.alignToPhysicalGrid(bounds.x, bounds.y, d0.scaleFactor);

  probe.setCheck(1, {
    status: flagsOk ? probe.STATUS.PASS : probe.STATUS.FAIL,
    detail: flagsOk
      ? `窗口已渲染，alwaysOnTop=${card.isAlwaysOnTop()}，尺寸 ${bounds.width}×${bounds.height} 精确等于期望的 ${want.w}×${want.h}`
      : `尺寸不符：期望 ${want.w}×${want.h}，实际 ${bounds.width}×${bounds.height}（Δ${bounds.width - want.w}/${bounds.height - want.h}）`,
    evidence: [
      `transparent: true / frame: false / alwaysOnTop: true / skipTaskbar: true 均已按此配置创建`,
      `显示方式：showInactive()（显示但不激活）`,
      `坐标 (${bounds.x},${bounds.y})，所在显示器 scaleFactor=${d0.scaleFactor}，物理像素网格步长=${gridStep}（对齐后 Δ=${bounds.x - grid.x},${bounds.y - grid.y}）`,
      `M0 血泪规则：构造参数 width/height 不可信（实测请求 360×44 得到 364×46），必须创建后 setBounds 校正一次；` +
        `且坐标必须落在物理像素网格上（150% 缩放下为偶数），否则宽/高会各多 1px`,
      `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    ],
  });

  /* 验收 9 · scaleFactor 可靠读取方式 */
  const cc = facts.scaleCrossCheck;
  if (cc && cc.verdict === 'pass') {
    probe.setCheck(9, {
      status: probe.STATUS.PASS,
      detail: cc.reason,
      evidence: cc.perDisplay.map(
        (d) =>
          `${d.label}（id=${d.displayId}）：scaleFactor=${d.scaleFactor}，` +
          `Electron 推算物理 ${d.electronThinksPhysical}，Windows 实测 ${d.windowsTruthPhysical}，` +
          `证据A=${d.evidenceA}，证据B=${d.evidenceB}`,
      ),
    });
  } else if (cc && cc.verdict === 'fail') {
    probe.setCheck(9, {
      status: probe.STATUS.FAIL,
      detail: cc.reason,
      evidence: [...cc.perDisplay.map((d) => `${d.label}：证据A=${d.evidenceA}，证据B=${d.evidenceB}`), ...cc.findings],
    });
  } else {
    probe.setCheck(9, {
      status: probe.STATUS.UNABLE,
      detail: cc ? cc.reason : '未采集到交叉校验数据',
      evidence: ['Windows 侧探测失败 —— 注意：Electron 自身读数无法自证，缺了外部基准就不能下结论'],
    });
  }

  /* 验收 2 · backdrop-filter 是否真的生效
   *
   * 2026-09-18 起不再依赖肉眼：改用「截图 + 拉普拉斯方差」自动判定。
   * 实现见 blurmeasure.js，判据与阈值出处都在那个文件顶部写清了。
   *
   * 关键设计：测量本身内建了「考裁判」——每次都会先跑一遍校准态
   * （把 A 区的 blur 也关掉，两区本应一致）。若校准态就不一致，
   * 说明尺子坏了，结论一律判 UNABLE 而不是硬报 pass/fail。
   */
  const gpuStatus = facts.gpu && facts.gpu.featureStatus ? facts.gpu.featureStatus : {};
  const compositing = gpuStatus.gpu_compositing || gpuStatus.gpu_compositing_status || '(未知)';
  const compositingOk = String(compositing).toLowerCase().includes('enabled');

  const cardLoaded = await waitForCardLoaded();
  const blur = cardLoaded
    ? await measureBackdropBlur()
    : { ok: false, measured: false, reason: '卡片未在 8 秒内加载完成' };

  const gpuEvidence = `gpu_compositing = ${compositing}${compositingOk ? '（GPU 合成已启用）' : '（GPU 合成未启用）'}`;

  if (blur.measured) {
    const map = { pass: probe.STATUS.PASS, fail: probe.STATUS.FAIL, unable: probe.STATUS.UNABLE };
    probe.setCheck(2, {
      status: map[blur.status] || probe.STATUS.WARN,
      detail: blur.detail,
      evidence: [gpuEvidence, ...blur.evidence],
    });
  } else {
    // 截图法没能跑起来 —— 这不是"通过"，但也不该静默降级成人工项。
    // 判 WARN 并写明原因，让人知道现在的自动化覆盖在这里断了。
    probe.setCheck(2, {
      status: probe.STATUS.WARN,
      detail: `自动截图测量未能完成（${blur.reason}），本项退回到只能靠肉眼核对。${gpuEvidence}`,
      evidence: [gpuEvidence, '截图法失败原因见上；修复后重跑自检即可恢复自动判定'],
    });
  }

  /* 验收 7 · 双屏混合缩放 */
  const displayCount = facts.electronDisplays.count;
  if (displayCount < 2) {
    probe.setCheck(7, {
      status: probe.STATUS.UNABLE,
      detail: `本机只检测到 ${displayCount} 块显示器，双屏混合缩放无法在此环境验证。这不是"通过"，是"没条件测"。`,
      evidence: [
        `建议：接入第二块显示器后重跑本工程；若长期不具备条件，需把「混合缩放下的副屏」列为已知限制并写入 MASTER-PLAN §8`,
      ],
    });
  } else {
    probe.setCheck(7, {
      status: probe.STATUS.PENDING,
      detail: `检测到 ${displayCount} 块显示器，可用面板上的「移到指定显示器」逐个验证。`,
      evidence: facts.electronDisplays.displays.map(
        (d) => `${d.label}：scaleFactor=${d.scaleFactor}，DIP ${d.sizeDip.w}×${d.sizeDip.h}`,
      ),
    });
  }

  /* 验收 4 / 5 · 纯人工项，给出手测步骤而不是留空 */
  probe.setCheck(4, {
    status: probe.STATUS.PENDING,
    detail: '需要人工：开一个全屏应用观察。M0 只验证可能性，不要求现在就自动实现。',
    evidence: [
      '步骤：面板点「隐藏」→ 打开一个全屏视频或幻灯片 → 点「唤回」→ 观察是否能盖在全屏应用之上',
      '若卡片能盖住全屏应用，说明需要用轮询外部前台窗口的方式主动让位（M1 处理）',
    ],
  });
  probe.setCheck(5, {
    status: probe.STATUS.PENDING,
    detail: '需要人工：换三张壁纸 × 三档透明度，共 9 次目视确认。',
    evidence: [
      '三张壁纸：纯白 / 纯黑 / 花哨风景',
      '三档透明度用面板上的按钮切换（安静 96% / 标准 94% / 通透 86%）',
      '判定口径：正文 13px 文字在任意组合下都必须能轻松读清；任一组读着吃力即不通过',
    ],
  });

  /* 验收 3 / 6 / 8 · hybrid，先说明怎么测 */
  probe.setCheck(3, {
    status: probe.STATUS.PENDING,
    detail: '点「开始 20 秒焦点测试」，然后随便去别的窗口打字，别碰卡片。',
    evidence: ['判定口径：测试期间卡片 focus 事件数 = 0 且面板 blur 事件数 = 0'],
  });
  probe.setCheck(6, {
    status: probe.STATUS.PENDING,
    detail: '本程序已记录当前缩放下的读数；请切到另外两档系统缩放各测一次（或至少确认当前档位正确）。',
    evidence: [],
  });
  probe.setCheck(8, {
    status: probe.STATUS.PENDING,
    detail: '先点「坐标往返测试」看自动结果，再手动拖动卡片并目视确认松手后是否停在你放下的位置。',
    evidence: [],
  });

  broadcastProbe();
}

app.whenReady().then(async () => {
  registerIpc(null);

  win.createCardWindow();
  win.createPanelWindow();

  // 卡片加载完成后拉一次渲染进程侧的事实
  win.state.card.webContents.on('did-finish-load', () => {
    sendRendererFactsRequest(win.state.card);
  });

  // 探测（含一次 PowerShell 调用）放到后面，不挡窗口出现
  await collectFacts();
  await runStartupChecks();

  // 等渲染进程回报自己的 devicePixelRatio 后再刷新一次面板
  setTimeout(broadcastProbe, 1200);

  if (SELFTEST) {
    await runSelftest();
  }
});

async function runSelftest() {
  const log = [];
  log.push('=== M0 自检模式 ===');
  log.push(`时间: ${new Date().toISOString()}`);

  try {
    // 等卡片把 devicePixelRatio 报上来
    await new Promise((r) => setTimeout(r, 2500));

    const facts = getCachedFacts();
    log.push('');
    log.push('--- 探测结果 ---');
    log.push(
      `显示器数量: ${facts.electronDisplays.count}，主屏 scaleFactor=${facts.electronDisplays.displays[0].scaleFactor}`,
    );
    for (const d of facts.electronDisplays.displays) {
      log.push(
        `  [Electron] ${d.label} id=${d.id} scale=${d.scaleFactor} DIP=${d.sizeDip.w}x${d.sizeDip.h} 推算物理=${d.physicalExpected.w}x${d.physicalExpected.h}`,
      );
    }
    for (const m of (facts.windowsDisplays && facts.windowsDisplays.monitors) || []) {
      log.push(
        `  [Windows]  ${m.device} 物理=${m.width}x${m.height} logPixels=${m.logPixels}`,
      );
    }
    log.push('');
    log.push('--- scaleFactor 交叉校验（验收 9）---');
    log.push(`verdict=${facts.scaleCrossCheck.verdict}`);
    log.push(`reason=${facts.scaleCrossCheck.reason}`);
    for (const d of facts.scaleCrossCheck.perDisplay || []) {
      log.push(
        `  ${d.label}: 证据A=${d.evidenceA} 证据B=${d.evidenceB} Electron=${d.electronThinksPhysical} Windows=${d.windowsTruthPhysical}`,
      );
    }
    for (const f of facts.scaleCrossCheck.findings || []) log.push(`  ! ${f}`);

    log.push('');
    log.push('--- 渲染进程事实 ---');
    const rf = facts.rendererFacts;
    if (rf) {
      log.push(`devicePixelRatio=${rf.devicePixelRatio} screen=${rf.screenWidth}x${rf.screenHeight}`);
      log.push(`CSS.supports backdrop-filter=${rf.backdropSupported} (-webkit-=${rf.webkitBackdropSupported})`);
      log.push(`cardRectCss=${rf.cardRectCss ? rf.cardRectCss.w + 'x' + rf.cardRectCss.h : '?'}`);
    } else {
      log.push('(未上报)');
    }

    log.push('');
    log.push('--- 词汇表自检 ---');
    const cp = facts.contractParity;
    log.push(cp ? (cp.ok ? `通过（${cp.actualCount} 条一致）` : `漂移！缺失=${cp.missing} 多余=${cp.extra}`) : '(未完成)');

    // 自动跑一遍坐标与尺寸相关的验收
    log.push('');
    log.push('--- 自动验收动作 ---');
    const snap = win.snapToEdge();
    log.push(`吸附: ${JSON.stringify(snap && snap.deviation)}`);
    const rt = win.boundsRoundtrip();
    log.push(`坐标往返: ${JSON.stringify(rt && rt.deviation)} stable=${rt && rt.stable}`);
    const m = win.measureCard();
    log.push(
      `尺寸测量: DIP=${m.boundsDip.width}x${m.boundsDip.height} 物理=${m.expectedPhysical.w}x${m.expectedPhysical.h} 精确=${m.isCollapsedSizeExact}`,
    );
    log.push(`dipToScreen* API: ${JSON.stringify(m.dipApi)}`);

    // 展开态也测一次
    await win.setCardState(WINDOW_STATE.EXPANDED);
    await new Promise((r) => setTimeout(r, 600));
    const m2 = win.measureCard();
    log.push(
      `展开态尺寸: DIP=${m2.boundsDip.width}x${m2.boundsDip.height} 物理=${m2.expectedPhysical.w}x${m2.expectedPhysical.h} 精确=${m2.isCollapsedSizeExact}`,
    );
    await win.setCardState(WINDOW_STATE.COLLAPSED);

    // 焦点测试（自检模式下缩短到 6 秒）
    // ★ 走 runFocusTestAndRecord，而不是直接 win.startFocusTest ——
    //   前者会把 verdict 写回验收 3（setCheck(3)）。直接调 window.js 就绕过了写回，
    //   那正是"verdict=pass 而摘要仍写 pending"的老毛病（2026-09-18 修）。
    log.push('');
    log.push('--- 焦点测试（6 秒，结论自动写回验收 3）---');
    const fts = await runFocusTestAndRecord(6000);
    log.push(JSON.stringify(fts));

    log.push('');
    log.push('--- 主进程失败记录（B13 / B3）---');
    log.push(`上次启动前是否崩溃过: ${bootCrash ? describeCrash(bootCrash) : '无'}`);
    log.push(`本次进程内未处理的 promise 拒绝: ${failures.rejectionCount()} 次`);
    log.push('策略: uncaughtException → 同步落盘 + exit(1) ｜ unhandledRejection → 同步落盘 + 不退出');
    log.push('离线考裁判: npm run test:crash');

    log.push('');
    log.push('--- 验收摘要 ---');
    const state = probe.getProbeState();
    log.push(JSON.stringify(state.summary));
    for (const c of state.checks) {
      log.push(`  ${c.id}. [${c.status}] ${c.title} :: ${String(c.detail).slice(0, 100)}`);
    }

    const report = await probe.saveReportAs(selftestReportName(SELFTEST_TAG));
    log.push('');
    log.push(`报告已写入: ${report}`);
    if (SELFTEST_TAG) {
      log.push(`（隔离运行：本产物带后缀 "${SELFTEST_TAG}"，未覆盖正式验收记录）`);
    }
  } catch (err) {
    log.push('');
    log.push(`!! 自检过程抛错: ${err && err.stack ? err.stack : err}`);
  }

  const logFile = await selftestLog(log);
  console.log(log.join('\n'));
  console.log(`\n[selftest] log: ${logFile}`);

  setTimeout(() => app.quit(), 500);
}

function sendRendererFactsRequest(target) {
  if (!target || target.isDestroyed()) return;
  // 渲染进程加载完会主动上报，这里只是兜底再推一次状态
  target.webContents.send(contract.IPC.PROBE_STATE, probe.getProbeState());
}

/* ------------------------------------------------------------------ */
/* 失败语义（B13 / B3 合并处置，2026-09-19）                             */
/*                                                                     */
/* 这一段**取代**了原来那个"只打日志、不退出"的 uncaughtException 监听器。 */
/*                                                                     */
/* 为什么不是"删掉旧的那段就完事"：                                        */
/*   实测证明 **Electron 自己就注册了一个 uncaughtException 监听器**       */
/*   （进程刚起来、我们还没注册时 listenerCount 已经是 1）。                */
/*   所以光删旧监听器**恢复不了**「崩溃即退出」—— 它连"半死"状态都改不了。  */
/*   正确的问题是"要不要主动处理"，而不是"要不要删"。                       */
/*                                                                     */
/* 策略（完整理由见 src/main/crashlog.js 头部）：                          */
/*   uncaughtException  → 同步落盘完整上下文 → process.exit(1)            */
/*   unhandledRejection → 同步落盘 → **不退出**，但可见                   */
/* 为什么必须同步写：落盘后马上退出，异步写会被直接丢掉 ——                  */
/*   崩溃记录会恰好在最需要它的时候不存在。                                */
/* ------------------------------------------------------------------ */
const failures = installFailureHandlers();

app.on('window-all-closed', () => {
  app.quit();
});
