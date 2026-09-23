/**
 * tools/service.mjs —— 守护式管理：后台启动 / 停止 / 查状态 / 看日志
 * =====================================================================
 * 要解决的问题：原来只能 `node tools/launch.mjs`，那要求**一直开着一个终端**。
 * 关掉终端窗口，进程就跟着走 —— 这不是"常驻程序"，只是个长命令。
 *
 * ### 怎么做到脱离终端
 *   ① `spawn(..., { detached: true })` —— Windows 上新开一个进程组，
 *      子进程不再挂在父进程的作业对象里，父进程退出它照活。
 *   ② `stdio` 指向**文件**（不是 pipe）——pipe 的另一头是父进程，
 *      父进程一死 pipe 就断，子进程下一次写日志就 EPIPE 崩掉。
 *      这是"看起来 detach 了、跑一会儿却自己死"的最常见原因。
 *   ③ `.unref()` —— 让 Node 的事件循环不再等它，父进程才能真的退出。
 *   ④ electron.exe 是 **GUI 子系统**程序，本身不申请控制台 —— 所以
 *      后台启动之后不会弹出黑窗口（`windowsHide: true` 是第二道保险）。
 *
 * ### 命令
 *   node tools/service.mjs start    后台启动（立即返回，不占终端）
 *   node tools/service.mjs status   运行状态（这是默认命令）
 *   node tools/service.mjs stop     停止（先优雅、超时才强杀）
 *   node tools/service.mjs restart  重启
 *   node tools/service.mjs logs     看日志尾巴（-n 60）
 *
 * 通用参数：`--data-dir <路径>`（等价于设 MB_DATA_DIR，支持多份数据目录并行）
 *
 * ### 一个刻意的取舍：**不按进程名杀进程**
 *   最省事的"停止"是 `taskkill /IM electron.exe /F`。它会连带杀掉用户机器上
 *   **所有** Electron 应用（各种聊天工具、编辑器……）。绝对不能用。
 *   ⇒ 只认 pid 文件里的那一个 pid，并且做完归属校验才动手。
 * =====================================================================
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  dataDirOf,
  pidFilePath,
  readPidFile,
  writePidFile,
  removePidFile,
  readHeartbeat,
  isProcessAlive,
  classifyRun,
  formatDuration,
  parseCommand,
  runLogPath,
  rawLogPath,
  requestStop,
  clearStopRequest,
  probeWritable,
} from '../src/shared/runtime-state.js';
import { nextRunAt, parseFetchTime, formatHm } from '../src/main/scheduler.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

const say = (s = '') => process.stdout.write(s + '\n');
const HR = '─'.repeat(58);

/* ------------------------------------------------------------------ */
/* 命令行                                                              */
/* ------------------------------------------------------------------ */
const parsed = parseCommand(process.argv.slice(2));
if (!parsed) {
  usage(2);
}
const { cmd, flags } = parsed;
const DATA_DIR = typeof flags['data-dir'] === 'string' ? path.resolve(flags['data-dir']) : dataDirOf(process.env);
const LOG_FILE = runLogPath(DATA_DIR);

function usage(code) {
  say('晨报机 · 后台运行管理');
  say(HR);
  say('  node tools/service.mjs start      后台启动（不占终端，关掉终端也不退出）');
  say('  node tools/service.mjs status     查询运行状态（默认命令）');
  say('  node tools/service.mjs stop       停止（先请求优雅退出，超时才强制结束）');
  say('  node tools/service.mjs restart    重启');
  say('  node tools/service.mjs logs       查看运行日志（-n 60 指定行数）');
  say();
  say('  可选参数：--data-dir <路径>   用另一份数据目录（可并行跑多个实例）');
  process.exit(code);
}
if (cmd === 'help') usage(0);

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 拿进程映像名（用来做归属校验）。拿不到就返回 null，判定逻辑会退到心跳那一层。 */
function imageNameOf(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    const line = String(r.stdout || '').split('\n').map((s) => s.trim()).find((s) => s.startsWith('"'));
    if (!line) return null;
    return line.split('","')[0].replace(/^"/, '').trim() || null;
  } catch {
    return null;
  }
}

/** 当前运行状态（把判定所需的输入都取齐） */
function inspect() {
  const pidInfo = readPidFile(DATA_DIR);
  const heartbeat = readHeartbeat(DATA_DIR);
  const alive = pidInfo ? isProcessAlive(pidInfo.pid) : false;
  const imageName = alive ? imageNameOf(pidInfo.pid) : null;
  const verdict = classifyRun({ pidInfo, heartbeat, alive, imageName });
  return { pidInfo, heartbeat, alive, imageName, verdict };
}

function tailFile(file, n) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - n - 1)).join('\n');
  } catch {
    return null;
  }
}

/**
 * 启动失败时该给用户看什么。
 *
 * ⚠️ 两个文件都要看，顺序不能反：
 *   ① `run.log` —— 应用自己写的正式日志。正常情况下这里有全部信息。
 *   ② `run.raw.log` —— 子进程原始 stdout 的兜底。
 *      只有"应用还没装上自己的日志就崩了"时它才有内容，而**那正是最需要
 *      线索的情况**（import 期抛异常、原生层崩溃）。只看 run.log 的话，
 *      用户拿到的永远是"连第一行都没写出来"这句最没用的话。
 */
function diagnosticTail(lines = 30) {
  const run = tailFile(LOG_FILE, lines);
  const raw = tailFile(rawLogPath(DATA_DIR), lines);
  const parts = [];
  if (run && run.trim()) parts.push(`--- ${LOG_FILE} ---\n${run.trim()}`);
  if (raw && raw.trim()) parts.push(`--- ${rawLogPath(DATA_DIR)} ---\n${raw.trim()}`);
  if (!parts.length) {
    return '两个日志文件都是空的 —— 说明连模块求值的第一行都没跑到。\n' +
      '按可能性排序：① ELECTRON_RUN_AS_NODE 未清干净；② import 阶段就有语法/路径错误；\n' +
      '③ electron.exe 本身跑不起来（用 npm start 前台跑一次，报错会直接显示在屏幕上）。';
  }
  return parts.join('\n\n');
}

const fetchAt = () => {
  const t = parseFetchTime(process.env);
  return { ...t, text: formatHm(t.hour, t.minute) };
};

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */
async function doStart() {
  const cur = inspect();
  if (cur.verdict.state === 'running') {
    say(`已经在本机运行（PID ${cur.verdict.pid}）—— 不重复启动。`);
    say('想重启用：node tools/service.mjs restart');
    return 0;
  }
  if (cur.verdict.state === 'stale') {
    // 上一次是异常退出（关机/崩溃），pid 文件是残留。清掉再启动。
    say(`清理上次留下的 pid 文件：${cur.verdict.why}`);
    removePidFile(DATA_DIR);
  }
  /* ⚠️ 顺带清掉**陈旧的停止请求**。
     上一次 `stop` 可能没能送达（应用当时已经卡死），文件就留在那儿了；
     不清掉的话，这一次刚起来的实例会在 1 秒内看到它并自己退出 ——
     用户看到的是"启动成功，窗口一闪就没了"，是最难查的那种现象。
     应用自己启动时也会清一次（双保险：它也怕自己在写入之前就被别的东西
     先放了文件）。 */
  clearStopRequest(DATA_DIR);

  if (!fs.existsSync(EXE)) {
    say(`✗ 找不到 electron.exe：${EXE}`);
    say('  修复：在项目目录执行 npm install');
    return 1;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  /* ★ 先确认数据目录**真的可写**，再往下走。
   *
   * ⚠️ 实测踩到：数据目录不可写时（权限不足、被安全软件锁、放在只读位置、
   *    网盘同步锁着），原来的代码会抛一个裸的 EPERM 调用栈：
   *        Error: EPERM: operation not permitted, open '...\run.raw.log'
   *          at Object.openSync (node:fs:622)
   *    用户看到的是一串栈 —— 既不知道卡在哪一步，也不知道该怎么办。
   *    ⇒ 在门口先试一下，把"目录不可写"翻译成人话。
   *
   * ⚠️ 探针实现在 `runtime-state.js`，与主进程共用**同一份**。
   *    两边各写一份的话，会出现"管理命令说能写、应用说不能写"这种最难查的分歧。 */
  const probe = probeWritable(DATA_DIR);
  if (!probe.ok) {
    say(`✗ 数据目录不可写：${DATA_DIR}`);
    say(`  原因：${probe.error}`);
    say('  这个目录要放数据库与运行日志，所以它是必需的。可以：');
    say('    ① 换一个目录：node tools/service.mjs start --data-dir <别的路径>');
    say('    ② 检查目录权限，或看杀毒软件有没有拦住它');
    say('    ③ 若它落在网盘同步目录里，先暂停同步再启动');
    return 1;
  }

  /* ⚠️ 净化 `ELECTRON_RUN_AS_NODE`（B11 的老结论，一条都不能少）：
     本机环境里有它，而它会让 electron.exe 静默退化成普通 Node ——
     不开窗口、不注入 API、报错还指向别处。它只在进程启动时被读取，
     进程内无法自救，**只能 spawn 之前删掉**。 */
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.MB_DATA_DIR = DATA_DIR;

  /* ⚠️ 这里指向的是 **raw** 日志，不是 `run.log`。
   *
   * 实测（本机）：把 stdout 指到 `run.log` 之后，应用**确实**正常启动了
   * （心跳、数据库、定时器全跑了），而那个文件是 **0 字节** ——
   * Electron/Chromium 在 Windows 上不保证把主进程的 `console.log`
   * 送到继承来的句柄，脱离终端时尤其如此。
   * ⇒ 正式日志由**应用自己**写进 `run.log`；这里的重定向只当兜底，
   *   专门覆盖"应用还没装上自己的日志就崩了"那一小段（import 期崩溃、
   *   原生层崩溃）—— 那种情况下 raw 文件是**唯一**的线索。
   * 两个文件分开还有一个好处：不会出现两个写者往同一个文件里交错追加。 */
  const rawLog = rawLogPath(DATA_DIR);
  const out = fs.openSync(rawLog, 'a');
  const banner =
    `\n${HR}\n[service] 启动于 ${new Date().toLocaleString()}  ` +
    `数据目录 ${DATA_DIR}\n${HR}\n`;
  fs.writeSync(out, banner);

  let child;
  try {
    child = spawn(EXE, [ROOT], {
      cwd: ROOT,
      env,
      /* ①②③ 三件事缺一不可，见文件头注释 */
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
  } catch (err) {
    fs.closeSync(out);
    say(`✗ 启动失败：${err.message}`);
    return 1;
  }
  fs.closeSync(out);

  const pid = child.pid;
  child.unref();

  /* 先由管理命令登记 pid（这一刻就知道），应用启动后会**补全**同一份记录。
     好处：即使应用在写出自己的 pid 之前就崩了，status/stop 也找得到它。 */
  writePidFile(DATA_DIR, {
    pid,
    source: 'service',
    exe: EXE,
    root: ROOT,
    dataDir: DATA_DIR,
    log: LOG_FILE,
    booted: false,
  });

  // 等心跳 —— 没有它就只能说"进程起来了"，不能说"真的起来了"
  const heartbeatWaitMs = Number(flags['wait'] ?? 25000);
  const t0 = Date.now();
  let hb = null;
  while (Date.now() - t0 < heartbeatWaitMs) {
    if (!isProcessAlive(pid)) break;
    hb = readHeartbeat(DATA_DIR);
    if (hb && hb.pid === pid && hb.processType === 'browser') break;
    hb = null;
    await sleep(150);
  }

  if (hb) {
    say(`✓ 已在后台启动（PID ${pid}，${Date.now() - t0}ms）`);
    say(`  数据目录：${DATA_DIR}`);
    say(`  抓取时刻：每天 ${fetchAt().text}`);
    say(`  运行日志：${LOG_FILE}`);
    say('  关掉这个终端窗口它也会继续运行。');
    return 0;
  }

  if (!isProcessAlive(pid)) {
    say(`✗ 启动失败：进程 ${pid} 已经退出。`);
    say(HR);
    say(diagnosticTail(30));
    say(HR);
    removePidFile(DATA_DIR);
    return 1;
  }

  say(`⚠️ 进程 ${pid} 活着，但 ${heartbeatWaitMs}ms 内没等到心跳 —— 结果不可信。`);
  say('   按可能性排序：ELECTRON_RUN_AS_NODE 未清干净 / 顶层 await app.whenReady() 死锁 /');
  say('   import 阶段抛异常。');
  say(HR);
  say(diagnosticTail(30));
  say(HR);
  return 1;
}

/* ------------------------------------------------------------------ */
/* stop                                                                */
/* ------------------------------------------------------------------ */
async function doStop() {
  const cur = inspect();
  if (cur.verdict.state === 'stopped') {
    say('没有在运行（也没有 pid 文件）。');
    return 0;
  }
  if (cur.verdict.state === 'stale') {
    say(`pid 文件是过期的：${cur.verdict.why}`);
    removePidFile(DATA_DIR);
    say('已清理，现在状态是"未运行"。');
    return 0;
  }

  const pid = cur.verdict.pid;
  say(`正在停止 PID ${pid} …`);

  /* ★ 主路径：**文件即信号**。
     ⚠️ 为什么不直接用 taskkill：实测撞到两次权限问题 ——
        `taskkill /PID x` 返回 "Access denied"，以及 `spawnSync('taskkill')`
        直接 `{status:null, error:'EPERM'}`（而且它**不抛异常**，
        所以 try/catch 完全没用）。杀进程依赖操作系统权限，而权限恰恰是
        常驻程序最不该依赖的东西。往自己的数据目录里放一个文件则是**最低权限**，
        与启动它所需要的权限完全一致。 */
  requestStop(DATA_DIR, 'service.mjs stop');
  say('  已发出停止请求（数据目录里的 stop-request），等应用自己退出…');
  let st = await waitStopped(pid, 15000);
  if (st.ok) {
    finishStop(st.how);
    return 0;
  }
  say('  应用在 15 秒内没有退出（可能卡住了，或者根本没跑到主循环）。');

  const force = flags.force === true;
  if (!force) {
    /* 兜底②：`taskkill` 不带 `/F` 会向该进程的顶层窗口发 WM_CLOSE。
       ⚠️ 刻意**不加 `/T`**：/T 会连带结束子进程，而 Electron 的渲染/GPU 进程
          在主进程正常退出时会自己消失；提前强杀它们反而可能让主进程收不到
          窗口关闭事件，变成"优雅不成、还得强杀"。 */
    const r = runTaskkill(['/PID', String(pid)]);
    st = await waitStopped(pid, 8000);
    if (st.ok) {
      finishStop(st.how);
      return 0;
    }
    /* ⚠️ **必须把 taskkill 说的话打出来**（连它自己没起来也要说）。
       实测踩过：`spawnSync` 返回 `{status:null, error:'EPERM'}` ——
       进程都没起来、stdout/stderr 都是空的。原来的代码只看 stdout，
       于是这种情况下一句解释都没有。**失败要有嘴。** */
    say(`  taskkill /PID 未生效：${r.output}`);
  }

  const rf = runTaskkill(['/PID', String(pid), '/T', '/F']);
  st = await waitStopped(pid, 6000);
  if (st.ok) {
    finishStop(st.how);
    say(force ? '  （--force 路径）' : '  （强制结束路径）');
    return 0;
  }
  say(`  taskkill /T /F 未生效：${rf.output}`);

  say(`✗ 进程 ${pid} 仍然活着，而且登记也还在。`);
  say('  可能的原因：权限不足（试试以管理员身份运行）、被安全软件拦下、');
  say('  或者它卡在无法中断的系统调用里。可以在任务管理器里按 PID 找它。');
  say('  注意：停止请求文件已经留下 —— 应用只要恢复响应就会自己退出。');
  return 1;
}

/**
 * 跑一次 taskkill 并**把它的输出留下来**。
 *
 * ⚠️ 两个细节都是实测踩出来的：
 *   ① `spawnSync` **不抛异常** —— 命令起不来时它返回 `{status:null, error}`。
 *      只看 stdout/stderr 的话，`EPERM` 这种最关键的信息会被整个丢掉。
 *   ② stdout 与 stderr 要**合并**看：taskkill 的报错走哪一路并不固定
 *      （在 PowerShell 里看到的是 stderr，直接 spawn 时又可能是 stdout）。
 */
function runTaskkill(args) {
  try {
    const r = spawnSync('taskkill', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const parts = [String(r.stdout || ''), String(r.stderr || '')]
      .join('\n')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (r.error) parts.push(`（命令本身没能执行：${r.error.code || r.error.message}）`);
    if (!parts.length) parts.push(`（没有任何输出，退出码 ${r.status}）`);
    return { ok: r.status === 0, output: parts.join(' / '), status: r.status };
  } catch (err) {
    return { ok: false, output: `调用 taskkill 时抛错：${err && err.message}`, status: null };
  }
}

/**
 * 等进程消失，并判断"这次停止到底算不算成功"。
 *
 * ⚠️⚠️ 关键修正（实测踩到的一个**假阴性**）：
 *    原来只看"pid 还活着吗"。实测中出现过这一幕：
 *      · 日志里明明写着 `[main] 收到停止请求…正在退出`
 *      · `morning-brief.pid` 已经被应用自己删掉了（说明它跑完了整个退出流程）
 *      · 而 `stop` 仍然报 `✗ 进程仍然活着` 并返回 1
 *    原因是进程退出与操作系统回收之间有延迟（Electron 拆子进程、DLL 卸载都要时间），
 *    在这台机器上超过了 12 秒。
 *
 *    假阴性比假阳性更糟：用户看到"停止失败"会去任务管理器强行结束 ——
 *    而那里正是最容易杀错别的程序的地方。
 *
 * ⇒ 判据改成**两个**，满足任一即算停止成功：
 *    ① 进程真的没了；
 *    ② 应用自己注销了登记（pid 文件消失 / 判定不再是 running）。
 *       登记是应用在 `will-quit` 里撤的，它撤了就说明退出流程走完了。
 *    第 ② 条同时覆盖了"进程卡在退出中"这一类情形。
 */
async function waitStopped(pid, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!isProcessAlive(pid)) return { ok: true, how: 'process-exited' };
    if (inspect().verdict.state !== 'running') return { ok: true, how: 'pidfile-cleared' };
    await sleep(150);
  }
  /* 最后一次机会：两种判据都再看一眼（循环里刚看过，但这里是为了
     让"超时"这个结论也有明确依据，而不是靠循环边界）。 */
  if (!isProcessAlive(pid)) return { ok: true, how: 'process-exited' };
  if (inspect().verdict.state !== 'running') return { ok: true, how: 'pidfile-cleared' };
  return { ok: false, how: 'still-running' };
}

/** 停止成功后的收尾（清掉两份登记痕迹） */
function finishStop(how) {
  removePidFile(DATA_DIR);
  clearStopRequest(DATA_DIR);
  if (how === 'process-exited') say('✓ 已停止（进程已退出）。');
  else say('✓ 已停止（应用已注销登记并退出）。');
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */
function doStatus() {
  const { pidInfo, heartbeat, verdict } = inspect();
  const at = fetchAt();

  if (verdict.state === 'stopped') {
    say('晨报机：**未运行**');
    say(HR);
    say(`  数据目录：${DATA_DIR}`);
    say(`  抓取时刻：每天 ${at.text}（下次启动时按"今天抓过没有"决定要不要补抓）`);
    say(`  启动命令：node tools/service.mjs start`);
    return 0;
  }

  if (verdict.state === 'stale') {
    say('晨报机：**未运行**（但留有陈旧的 pid 文件）');
    say(HR);
    say(`  pid 文件：${pidFilePath(DATA_DIR)}`);
    say(`  原因    ：${verdict.why}`);
    say('  建议    ：node tools/service.mjs start（会自动清理后启动）');
    return 0;
  }

  /* 运行中。uptime 优先用应用自己登记的启动时刻（最准），退到心跳里的时间戳。 */
  const bootedIso = pidInfo.bootedAt || pidInfo.at || (heartbeat && heartbeat.booted) || null;
  const bootedMs = bootedIso ? Date.parse(bootedIso) : NaN;

  say(`晨报机：**运行中**（PID ${verdict.pid}）`);
  say(HR);
  say(`  已运行  ：${Number.isFinite(bootedMs) ? formatDuration(Date.now() - bootedMs) : '未知'}${bootedIso ? `（启动于 ${new Date(bootedMs).toLocaleString()}）` : ''}`);
  say(`  数据目录：${DATA_DIR}`);
  say(`  抓取时刻：每天 ${at.text}`);
  say(`  下次抓取：${nextRunAt(new Date(), at.hour, at.minute).toLocaleString()}`);
  if (heartbeat) {
    say(`  心跳    ：${heartbeat.booted || '?'}  electron=${heartbeat.electron || '?'}  node=${heartbeat.node || '?'}`);
    if (heartbeat.runAsNode && heartbeat.runAsNode !== 'undefined') {
      say(`  ⚠️ RUN_AS_NODE=${heartbeat.runAsNode} —— 这个实例可能退化成了普通 Node（不是真 Electron）`);
    }
  }
  say(`  运行日志：${LOG_FILE}`);

  /* 真实数据：**只读**打开数据库看一眼。
     ⚠️ 三层保护，缺一不可：
        ① `readOnly: true` —— 绝不能因为查一次状态就改了应用的数据；
        ② 整段 try/catch —— 库被写锁住、schema 还没建、驱动加载不了……
           任何一种情况下 status 都必须**照样出结果**（只是少几行数字）。
           "查状态"这个动作本身绝不允许失败。
        ③ 不用 `openDb()` —— 它会跑建表与迁移，那是**写**操作。 */
  const dbInfo = readDbSummary();
  if (dbInfo) {
    say(`  数据    ：今日 ${dbInfo.todayItems} 条 · 启用源 ${dbInfo.enabledSources} 个 · 上次成功抓取 ${dbInfo.lastSuccess ? new Date(dbInfo.lastSuccess).toLocaleString() : '从未'}`);
  } else {
    say('  数据    ：(暂时读不到，不影响运行状态判定)');
  }
  return 0;
}

/** 只读地看一眼数据库；任何异常都返回 null，绝不打断 status */
function readDbSummary() {
  try {
    const dbFile = path.join(DATA_DIR, 'brief.db');
    if (!fs.existsSync(dbFile)) return null;
    /* `node:sqlite` 只能**动态**加载 —— 与主进程同一条理由
       （静态 import 在 Electron 主进程里会原生崩溃）。这里虽然跑在普通 Node 下，
       保持同一种加载方式可以避免"两边行为不一样"这种最难查的分歧。 */
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const sinceIso = start.toISOString();
      const today = db
        .prepare('SELECT COUNT(*) AS n FROM item WHERE (published_at >= ? OR (published_at IS NULL AND fetched_at >= ?))')
        .get(sinceIso, sinceIso).n;
      const src = db.prepare('SELECT COUNT(*) AS n FROM source WHERE enabled = 1').get().n;
      let lastSuccess = null;
      try {
        const row = db.prepare("SELECT value FROM meta WHERE key = 'last_success_at'").get();
        lastSuccess = row ? row.value : null;
      } catch {
        /* meta 表可能还没有 */
      }
      return { todayItems: today, enabledSources: src, lastSuccess };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* logs                                                                */
/* ------------------------------------------------------------------ */
function doLogs() {
  const n = Number(flags.n ?? 40);
  const lines = Number.isFinite(n) && n > 0 ? Math.min(2000, Math.floor(n)) : 40;
  const run = tailFile(LOG_FILE, lines);
  const raw = tailFile(rawLogPath(DATA_DIR), lines);

  if (!run && !raw) {
    say('（还没有任何日志）');
    say(`  期望的文件：${LOG_FILE}`);
    say('  先启动一次：node tools/service.mjs start');
    return 0;
  }
  if (run) {
    say(`=== ${LOG_FILE} （末尾 ${lines} 行）===`);
    process.stdout.write(run.endsWith('\n') ? run : run + '\n');
  }
  /* 原始输出只在有内容时才显示 —— 正常情况下它是空的，不该每次都占屏幕。
     它非空 = "应用还没装上自己的日志就出事了"，那正是要看的时候。 */
  if (raw && raw.trim()) {
    say();
    say(`=== ${rawLogPath(DATA_DIR)} （子进程原始输出，末尾 ${lines} 行）===`);
    process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n');
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 分发                                                                */
/* ------------------------------------------------------------------ */
let code = 0;
if (cmd === 'start') code = await doStart();
else if (cmd === 'stop') code = await doStop();
else if (cmd === 'status') code = doStatus();
else if (cmd === 'logs') code = doLogs();
else if (cmd === 'restart') {
  code = await doStop();
  if (code === 0) {
    say();
    code = await doStart();
  }
}
process.exit(code);
