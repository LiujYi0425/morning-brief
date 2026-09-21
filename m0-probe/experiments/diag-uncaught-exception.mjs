/**
 * diag-uncaught-exception.mjs —— 取证实验：未捕获异常到底会不会让进程退出？
 *
 * ===================================================================
 * 背景
 * ===================================================================
 * `src/main/index.js` 末尾有这么一段：
 *
 *     process.on('uncaughtException', (err) => {
 *       console.error('[main] uncaughtException:', err);
 *     });
 *
 * 它**只打日志、不退出**。而 Node 的**默认**行为是：打印错误栈 → `process.exit(1)`。
 * 也就是说，这个监听器把「进程会死」改成了「进程带着未知状态继续跑」——
 * 所谓的"半死"。
 *
 * **但这只是推断，没验证过。** 需要实测三个问题：
 *   ① Node/Electron 的默认行为到底是什么？（退出码？）
 *   ② 注册了这个监听器之后，退出真的被抑制了吗？进程还活着吗？
 *   ③ Electron 自己有没有已经注册过 uncaughtException？（若有，index.js 那段就是多余的）
 *
 * ===================================================================
 * 用法与判读
 * ===================================================================
 *   node tools/launch-electron.mjs experiments/diag-uncaught-exception.mjs
 *   node tools/launch-electron.mjs experiments/diag-uncaught-exception.mjs --handle
 *
 *   无 --handle（对照组）：抛异常后应**立即退出**，退出码 1，日志里没有 [alive] / [end]
 *   有 --handle（实验组）：抛异常后**继续运行**，能看到多行 [alive] 和 [end]，退出码 99
 *
 * 输出同时追加到 `report/diag-uncaught-exception.txt`（Electron 的 stdout 在 Windows 上不好抓）。
 * ===================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'report', 'diag-uncaught-exception.txt');

const WITH_HANDLER = process.argv.some((a) => a === '--handle');
const MODE = WITH_HANDLER ? 'with-handler' : 'no-handler';

/** 必须保持引用：Electron 的 BrowserWindow 被 GC 后原生窗口会关闭 */
let keepAlive = null;

const say = (s = '') => {
  const line = `[${MODE}] ${s}`;
  try {
    fs.appendFileSync(OUT, line + '\n', 'utf8');
  } catch {
    /* 落盘失败不阻塞实验 */
  }
  console.log(line);
};

fs.appendFileSync(OUT, `\n===== run @ ${new Date().toISOString()} mode=${MODE} =====\n`, 'utf8');

/* ① 关键事实：进来时到底有几个人在听 uncaughtException？
 *    如果 Electron 自己已经注册了，那"不注册对照组"也不会退出，
 *    说明 index.js 那段监听器**不是**（唯一）导致进程不退出的原因。 */
say(`process.type=${process.type}`);
say(`listenerCount('uncaughtException') = ${process.listenerCount('uncaughtException')}`);
say(`listenerCount('unhandledRejection') = ${process.listenerCount('unhandledRejection')}`);

if (WITH_HANDLER) {
  // 与 index.js 完全同款的监听器：只打日志，不退出、不清理
  process.on('uncaughtException', (err) => {
    say(`★★ handler 捕获到：${err && err.message}`);
    say(`   —— 注意：捕获之后进程**没有**退出，这就是"半死"的现场`);
  });
  say('已注册 uncaughtException 监听器（与 index.js 同款）');
} else {
  say('未注册任何监听器（对照组）');
}

app.whenReady().then(() => {
  say('app ready');

  /* ★ 必须建一个隐藏窗口 —— 这是第一次跑本实验踩出来的坑，记在这里免得再踩：
   *
   * 本机环境里，Electron 主进程**不建窗口**时，GPU 进程会反复崩溃：
   *     ERROR:gpu_process_host.cc:1035] GPU process exited unexpectedly: exit_code=1   （连续 9 次）
   *     FATAL:gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
   * 然后整个主进程 FATAL 退出，退出码 0x80000003。
   * 于是两次对照都死在"抛异常之前"，实验看起来像"异常导致了退出"——**完全是误读**。
   *
   * 建窗口后运行环境与 src/main/index.js 一致，实验才有意义。
   * 顺带说明：这个 GPU 崩溃与本次要验证的 uncaughtException **毫无关系**，
   * 它只是"无窗口的 Electron 主进程"在本机的一个特性。 */
  keepAlive = new BrowserWindow({ show: false, width: 200, height: 200 });
  say('已创建隐藏窗口（保持进程存活，与 src/main/index.js 的运行环境一致）');

  // 存活心跳：只要还能打印，就说明进程没死
  let ticks = 0;
  const alive = setInterval(() => {
    ticks += 1;
    say(`[alive #${ticks}] ${new Date().toISOString()}`);
  }, 400);

  setTimeout(() => {
    say('>>> 现在抛出一个未捕获异常');
    throw new Error('BOOM-未捕获异常');
  }, 1000);

  // 若 4 秒后进程还在，说明异常没能杀掉它 —— 主动退出并打上明确标记
  setTimeout(() => {
    clearInterval(alive);
    say(`[end] 异常发生 3 秒后进程**仍然存活**（存活心跳 ${ticks} 次）`);
    say('[end] => 判定：未捕获异常**没有**导致退出，进程进入"半死"状态');
    app.exit(99);
  }, 4000);
});

app.on('window-all-closed', () => {
  /* 本实验不建窗口，这里不会触发；留着只为说明"不依赖窗口生命周期" */
});
