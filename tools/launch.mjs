/**
 * tools/launch.mjs —— 唯一启动入口（净化环境 + 心跳守护 + 透传退出码）
 * =====================================================================
 * 照搬 M0 探针的启动器。三条理由一条都没变：
 *
 *   ① **净化 `ELECTRON_RUN_AS_NODE`**（B11）。本机有它，而它会让 electron.exe
 *      静默退化成普通 Node：不开窗口、不注入 API、报错还指向别处。
 *      这个变量在进程启动时就被读取，**进程内无法自救** —— 只能 spawn 前删。
 *   ② **心跳守护**（B10）。顶层 `await app.whenReady()` 会死锁，且**不报错**。
 *      超时没看到心跳就大声报警，把静默失败变成可判定报警。
 *   ③ **透传退出码**，让它能被脚本当一步用。
 * =====================================================================
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dataDirOf } from '../src/shared/runtime-state.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
/* ⚠️ 数据目录的口径来自 runtime-state.js，**不在这里另写一份**：
   各写一份必然漂移，而漂移的表现是"应用写这个目录、启动器等那个目录的心跳"
   —— 于是每次启动都白等 20 秒再报"启动失败"，而应用其实好好的。 */
const DATA_DIR = dataDirOf(process.env);
const HEARTBEAT = path.join(DATA_DIR, 'boot-heartbeat.txt');
const HEARTBEAT_TIMEOUT_MS = 20000;

const say = (s = '') => process.stdout.write(s + '\n');

const env = { ...process.env };
const poison = env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RUN_AS_NODE;

say('┌─ 晨报机 · 启动器 ─────────────────────────────────────────');
say(`│ electron : ${EXE}`);
say(`│ 存在     : ${existsSync(EXE)}`);
say(`│ 应用     : ${ROOT}`);
say(`│ 数据目录 : ${DATA_DIR}`);
if (poison !== undefined) {
  say(`│ ⚠️  检测到 ELECTRON_RUN_AS_NODE=${JSON.stringify(poison)} —— 已为子进程移除`);
} else {
  say('│ 环境干净 : ELECTRON_RUN_AS_NODE 未设置');
}
say('└───────────────────────────────────────────────────────────');
say();

if (!existsSync(EXE)) {
  say(`✗ 找不到 electron.exe：${EXE}`);
  say('  修复：在本目录执行 npm install');
  process.exit(1);
}

try {
  rmSync(HEARTBEAT, { force: true });
} catch {
  /* 无所谓 */
}

const t0 = Date.now();
const child = spawn(EXE, [ROOT], { cwd: ROOT, env, stdio: 'inherit', windowsHide: false });

let seen = false;
const poll = setInterval(() => {
  if (!existsSync(HEARTBEAT)) return;
  seen = true;
  clearInterval(poll);
  let content = '';
  try {
    content = readFileSync(HEARTBEAT, 'utf8').trim();
  } catch {
    /* ignore */
  }
  say();
  say(`[launcher] ✓ 收到开机心跳（${Date.now() - t0}ms）`);
  say(`[launcher]   ${content}`);
  if (!content.includes('process.type=browser')) {
    say('[launcher] ✗✗ 严重：process.type 不是 browser —— 这不是真正的 Electron 主进程！');
  }
  say();
}, 150);

const guard = setTimeout(() => {
  if (seen) return;
  clearInterval(poll);
  say();
  say('┌─ ✗ 启动失败：20 秒内没有心跳 ──────────────────────────────');
  say('│ 主进程模块根本没求值到第一行。按可能性排序：');
  say('│  1. 环境里仍有 ELECTRON_RUN_AS_NODE（本脚本已移除，若仍失败请手动确认）');
  say('│  2. 主进程用了顶层 `await app.whenReady()` → 死锁');
  say('│  3. 入口模块 import 阶段就抛异常（看上面 stderr）');
  say('│  4. ESM 下 import 没写全扩展名（.js/.cjs）');
  say('└────────────────────────────────────────────────────────────');
  say();
}, HEARTBEAT_TIMEOUT_MS);

child.on('close', (code, signal) => {
  clearInterval(poll);
  clearTimeout(guard);
  say();
  say(`[launcher] 退出：code=${code} signal=${signal ?? 'none'} 用时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!seen) say('[launcher] 且全程没有心跳 —— 这次运行的结果不可信。');
  process.exit(code ?? 1);
});

child.on('error', (err) => {
  clearInterval(poll);
  clearTimeout(guard);
  say(`[launcher] spawn 失败：${err.message}`);
  process.exit(1);
});
