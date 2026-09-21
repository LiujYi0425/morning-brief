// diag-tla-deadlock.mjs —— 对照实验：顶层 await app.whenReady() 会不会死锁？
//
// 结论（已登记 docs/04-项目审查报告.md · B10）：**会死锁**。
// 8 秒看门狗准点打响，退出码 2，STEP3 从未被打印。
// 原因：Electron 要等入口模块求值完毕才发 ready，而顶层 await 正在等 ready。
//
// 判读方法：若输出里出现 STEP3 → 没死锁；只出现 WATCHDOG → 死锁成立。
import { writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app, screen } from 'electron';

const LOG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'diag-tla-deadlock.txt'
);
const say = (s) => appendFileSync(LOG, s + '\n');
writeFileSync(LOG, '');
say('[TLA 组] STEP1 模块开始求值');

setTimeout(() => {
  say('[TLA 组] WATCHDOG 8 秒到了：whenReady 始终没 resolve → 顶层 await 死锁成立');
  app.exit(2);
}, 8000);

say('[TLA 组] STEP2 即将顶层 await app.whenReady()');
await app.whenReady();
say('[TLA 组] STEP3 whenReady 已 resolve（说明没有死锁）');
try {
  const d = screen.getPrimaryDisplay();
  say(`[TLA 组] primary = ${d.size.width}x${d.size.height} scale=${d.scaleFactor}`);
} catch (e) {
  say('[TLA 组] screen THROW ' + e.message);
}
app.exit(0);
