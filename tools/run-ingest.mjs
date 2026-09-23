/**
 * tools/run-ingest.mjs —— 抓取一次（纯 Node，不需要 Electron）
 * =====================================================================
 * 用法：
 *     npm run ingest                # 抓一次
 *     npm run ingest -- --dry       # 只解析不入库（看源通不通）
 *     npm run ingest -- --db <path> # 指定库文件
 *
 * 为什么要有这条**独立于 Electron** 的入口：
 *   抓取层是整条链路里最需要反复试的部分（源会挂、会改版、会被墙）。
 *   如果它只能通过"启动整个应用"来试，那么每次调源都要等窗口起来，
 *   而且失败了还不知道是抓取的问题还是界面的问题。
 *   **能脱离 GUI 跑，是抓取层可维护的前提。**
 * =====================================================================
 */

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runIngest } from '../src/ingest/fetch-feeds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const dbIdx = argv.indexOf('--db');
const dbFile =
  dbIdx !== -1 && argv[dbIdx + 1]
    ? path.resolve(argv[dbIdx + 1])
    : path.join(process.env.MB_DATA_DIR || path.join(os.homedir(), '.morning-brief'), 'brief.db');

const t0 = Date.now();
console.log('晨报机 · 抓取');
console.log(`库文件：${dbFile}`);
console.log(`模式  ：${dry ? 'dry-run（只解析，不入库）' : '正常（解析 + 入库）'}`);
console.log('');

if (dry) {
  // dry 模式：只跑网络与解析，不碰数据库 —— 用来单独判断"源通不通"
  const { fetchText } = await import('../src/ingest/fetch-feeds.js');
  const { parseFeed } = await import('../src/ingest/feed-parse.js');
  const { DEFAULT_SOURCES } = await import('../src/ingest/sources.js');
  for (const s of DEFAULT_SOURCES) {
    const r = await fetchText(s.feedUrl);
    if (!r.ok) {
      console.log(`✗ ${s.name.padEnd(14)} ${r.error}`);
      continue;
    }
    const p = parseFeed(r.text, { sourceName: s.name });
    console.log(
      `${p.ok ? '✓' : '✗'} ${s.name.padEnd(14)} ${p.ok ? `${p.items.length} 条（${p.format}）` : p.warnings.join(' / ')}`,
    );
  }
  console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

const r = await runIngest({
  dbFile,
  trigger: 'manual',
  log: (m) => console.log(m),
});

console.log('');
console.log('── 汇总 ──────────────────────────────');
console.log(`源       ：${r.sources} 个（成功 ${r.ok} / 失败 ${r.failed}）`);
console.log(`新条目   ：${r.newItems}`);
console.log(`重复跳过 ：${r.duplicates}`);
if (r.skippedNoKey) console.log(`⚠️ 无去重键：${r.skippedNoKey} 条（既无 URL 也无标题，已如实跳过）`);
console.log(
  `源健康度 ：正常 ${r.health.ok} / 异常 ${r.health.bad} / 从未抓过 ${r.health.never}`,
);
console.log(`耗时     ：${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 抓取失败必须让调用方知道（CI / 定时任务靠退出码判断）
process.exit(r.failed > 0 && r.ok === 0 ? 1 : 0);
