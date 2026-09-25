/**
 * tools/run-ingest.mjs —— 抓取一次（纯 Node，不需要 Electron）
 * =====================================================================
 * 用法：
 *     npm run ingest                # 抓一次
 *     npm run ingest -- --dry       # 只解析不入库（看源通不通）
 *     npm run ingest -- --db <path> # 指定库文件
 *     npm run ingest -- --enable-local   # 打开「本机 RSSHub」那一组预置源
 *     npm run ingest -- --disable-local  # 再关掉它们
 *
 * ⚠️ 为什么"开本机源"是**命令行**而不是界面上的勾选框（与 MB_ALLOW_LOCAL_FEEDS 同一个理由）：
 *    那组源要的是"你本机跑着一个服务"，而能让程序去打本机端口的开关，
 *    应当由**明确知道自己开了什么**的人来打开 —— 写进启动脚本或敲一行命令，成本刚好。
 *    另外它也是**唯一**的路径：预置源原来连 enabled 都改不了（见 db.js 的 upsertSources）。
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
const setLocal = argv.includes('--enable-local') ? true : argv.includes('--disable-local') ? false : null;
console.log('晨报机 · 抓取');
console.log(`库文件：${dbFile}`);
console.log(`模式  ：${dry ? 'dry-run（只解析，不入库）' : '正常（解析 + 入库）'}`);
console.log('');

if (setLocal !== null) {
  /* 只做一件事：把「本机 RSSHub」那组预置源开 / 关，然后退出。
     ⚠️ 必须先跑过一次抓取（或它已经跑过）—— 那时源才登记进库。 */
  const { openDb, setLocalSourcesEnabled, listSources } = await import('../src/store/db.js');
  const db = await openDb(dbFile);
  const before = listSources(db).filter((s) => String(s.feed_url).startsWith('http://127.0.0.1:'));
  const r0 = setLocalSourcesEnabled(db, setLocal);
  const after = listSources(db).filter((s) => String(s.feed_url).startsWith('http://127.0.0.1:'));
  db.close();
  console.log(`本机预置源：${r0.total} 条，本次改动 ${r0.changed} 条`);
  console.log(`  之前启用 ${before.filter((s) => s.enabled).length} 条 → 现在启用 ${after.filter((s) => s.enabled).length} 条`);
  if (!r0.total) console.log('  ⚠️ 一条都没有 —— 先跑一次 npm run ingest 让预置源登记进库');
  console.log(setLocal ? '\n下一步：用 MB_ALLOW_LOCAL_FEEDS=1 启动晨报机，并确认本机 RSSHub 已经跑起来' : '');
  process.exit(0);
}

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
