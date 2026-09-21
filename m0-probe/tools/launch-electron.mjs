/**
 * tools/launch-electron.mjs —— Morning Brief 唯一的 Electron 启动入口
 * =====================================================================
 * 为什么不能让 `electron .` 直接跑（见 docs/04-项目审查报告.md · B10 / B11）：
 *
 *   B11 · 环境变量污染
 *     本机环境（以及不少 Electron 宿主应用的子进程）会带上 ELECTRON_RUN_AS_NODE=1。
 *     一旦存在，electron.exe 就退化为「普通 Node」：
 *       · 不开任何窗口
 *       · 不注入 Electron API
 *       · 于是 `import { app } from 'electron'` 报一句极度误导的
 *         "The requested module 'electron' does not provide an export named 'BrowserWindow'"
 *     变量在进程启动时被读取，进程内无法自救 —— 只能在 spawn 之前删掉。
 *     这就是本脚本存在的主要理由。
 *
 *   B10 · 顶层 await 死锁
 *     ESM 主进程里 `await app.whenReady()` 在顶层会死锁（Electron 要等入口模块
 *     求值完才发 ready）。本脚本通过「开机心跳」把这类静默失败变可见。
 *
 * 三重职责：
 *   1. 净化环境（删掉 ELECTRON_RUN_AS_NODE）
 *   2. 守护心跳（超时没看到 report/boot-heartbeat.txt 就大声报警 + 给出可能原因）
 *   3. 透传退出码（让它能被 CI / 自检脚本当作可靠的一步）
 *
 * 用法：
 *   node tools/launch-electron.mjs [appPath] [-- <传给 electron/app 的参数...>]
 *   node tools/launch-electron.mjs . --selftest
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/* ---------------- 参数解析 ---------------- */
const argv = process.argv.slice(2);
let appPath = '.';
const passThrough = [];
let sawSep = false;
for (const a of argv) {
  if (a === '--') { sawSep = true; continue; }
  if (!sawSep && !a.startsWith('-') && appPath === '.') { appPath = a; continue; }
  passThrough.push(a);
}
const APP_ABS = path.resolve(ROOT, appPath);

/* ---------------- 定位 electron.exe ---------------- */
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

const HEARTBEAT = path.join(ROOT, 'report', 'boot-heartbeat.txt');
const HEARTBEAT_TIMEOUT_MS = 20_000;

/**
 * 心跳守护只在「跑的是本项目主进程」时才生效。
 * _diag/ 下的一次性实验脚本不写心跳，若照样守护就会天天误报（这个坑已经踩过一次）。
 */
const GUARD_HEARTBEAT = APP_ABS === ROOT;

/* ---------------- 职责 1：净化环境 ---------------- */
const env = { ...process.env };
const poison = env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RUN_AS_NODE;

const say = (s = '') => process.stdout.write(s + '\n');

say('┌─ Morning Brief · Electron 启动器 ─────────────────────────');
say(`│ electron.exe : ${EXE}`);
say(`│ 存在          : ${existsSync(EXE)}`);
say(`│ app 路径      : ${APP_ABS}`);
say(`│ 透传参数      : ${passThrough.length ? passThrough.join(' ') : '(无)'}`);
if (poison !== undefined) {
  say(`│ ⚠️  检测到 ELECTRON_RUN_AS_NODE=${JSON.stringify(poison)}`);
  say('│     已为子进程移除 —— 否则 Electron 会退化成普通 Node（B11）');
} else {
  say('│ 环境干净      : ELECTRON_RUN_AS_NODE 未设置');
}
say('└───────────────────────────────────────────────────────────');
say();

if (!existsSync(EXE)) {
  say(`✗ 找不到 electron.exe：${EXE}`);
  say('  修复：npm install（或 node node_modules/electron/install.js）');
  process.exit(1);
}

/* ---------------- 清理旧心跳 ---------------- */
try { rmSync(HEARTBEAT, { force: true }); } catch { /* 无所谓 */ }

/* ---------------- 职责 2：spawn + 守护心跳 ---------------- */
const args = [APP_ABS, ...passThrough];
const t0 = Date.now();

const child = spawn(EXE, args, {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  windowsHide: false,
});

let heartbeatSeen = false;
let heartbeatContent = null;

const poll = GUARD_HEARTBEAT
  ? setInterval(() => {
      if (existsSync(HEARTBEAT)) {
        heartbeatSeen = true;
        clearInterval(poll);
        try { heartbeatContent = readFileSync(HEARTBEAT, 'utf8').trim(); } catch { /* ignore */ }
        say();
        say(`[launcher] ✓ 收到开机心跳（${Date.now() - t0}ms）`);
        say(`[launcher]   ${heartbeatContent}`);
        if (!heartbeatContent.includes('process.type=browser')) {
          say('[launcher] ✗✗ 严重：process.type 不是 browser —— 这不是真正的 Electron 主进程！');
        }
        say();
      }
    }, 150)
  : null;

const guard = GUARD_HEARTBEAT
  ? setTimeout(() => {
      if (heartbeatSeen) return;
      clearInterval(poll);
      say();
      say('┌─ ✗ 启动失败：20 秒内没有收到开机心跳 ──────────────────────');
      say('│ 这说明主进程模块根本没求值到第一行。按可能性排序：');
      say('│  1. 环境里仍有 ELECTRON_RUN_AS_NODE → 已由本脚本移除，若仍失败请手动确认');
      say('│  2. 主进程某处用了顶层 `await app.whenReady()` → 死锁（B10）');
      say('│  3. 主进程入口模块 import 阶段就抛异常（看上面 stderr 的 SyntaxError/TypeError）');
      say('│  4. 模块路径解析失败（ESM 下必须写全扩展名 .js/.mjs/.cjs）');
      say('└────────────────────────────────────────────────────────────');
      say();
    }, HEARTBEAT_TIMEOUT_MS)
  : null;

if (!GUARD_HEARTBEAT) {
  say(`[launcher] 本次跑的不是项目主进程（${path.relative(ROOT, APP_ABS)}），跳过心跳守护。`);
  say();
}

/* ---------------- 职责 3：透传退出码 ---------------- */
child.on('close', (code, signal) => {
  if (poll) clearInterval(poll);
  if (guard) clearTimeout(guard);
  say();
  say(`[launcher] electron 已退出：code=${code} signal=${signal ?? 'none'} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (GUARD_HEARTBEAT && !heartbeatSeen) {
    say('[launcher] 且全程没有心跳 —— 这次运行的结果不可信，别拿它的数据当依据。');
  }
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  if (poll) clearInterval(poll);
  if (guard) clearTimeout(guard);
  say(`[launcher] spawn 失败：${err.message}`);
  process.exit(1);
});
