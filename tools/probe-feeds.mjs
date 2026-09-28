#!/usr/bin/env node
/**
 * tools/probe-feeds.mjs —— 选源探针：**批量实测候选 feed 到底能不能用**。
 * =====================================================================
 * 为什么要有它（而不是每次临时写一段脚本）：
 *   本项目选源有一条硬口径 —— **「实测通不过的源不许默认打开」**（见 sources.js 口径⑤）。
 *   于是"加一个源"这件事的真实成本不在写那一行，而在**验它**：
 *   历史上有过三次"约 90 个候选逐个真抓"的会话，每次都是临时脚本，
 *   结论留在 HANDOFF 里，**下一次没人能原样重跑**。
 *   ⇒ 固化成一个工具：候选清单进、结论表出，谁都能复核。
 *
 * ⚠️ 判据与真机口径**完全一致**（用的是项目自己的 fetchText + parseFeed，
 *    不是另写一份 curl/解析）：
 *     · `items`     解析出多少条
 *     · `withDate`  有多少条带发布时间 —— **没有时间的源不能默认打开**
 *                   （排序靠时间，没时间的条目会永远沉在列表最后）
 *     · `withLink`  有多少条带链接 —— 点开是死的条目等于没有
 *     · `latest`    最新一条的时间，用来判"这个源是不是已经馊了"
 *   ⇒ 三个数字都合格 → `可用`；能解析但缺时间/链接/太旧 → `慎用/馊`；解析不了 → `不是 feed`。
 *
 * 用法：
 *   node tools/probe-feeds.mjs candidates.json                 # 表格
 *   node tools/probe-feeds.mjs candidates.json --out r.json    # 同时落盘（给下一步合并用）
 *   node tools/probe-feeds.mjs candidates.json --timeout 20000 --concurrency 6
 *
 * 候选文件格式（数组，字段只有 url 必需）：
 *   [{ "name": "中新网·军事", "url": "https://www.chinanews.com.cn/rss/military.xml", "for": "领域·军事" }]
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchText } from '../src/ingest/fetch-feeds.js';
import { parseFeed } from '../src/ingest/feed-parse.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = opt('out', '');
const TIMEOUT = Number(opt('timeout', 15000));
const CONC = Math.max(1, Number(opt('concurrency', 4)));

if (!file) {
  console.error('用法：node tools/probe-feeds.mjs <candidates.json> [--out result.json] [--timeout 15000] [--concurrency 4]');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
const candidates = (Array.isArray(raw) ? raw : raw.candidates || [])
  .map((c) => (typeof c === 'string' ? { url: c } : c))
  .filter((c) => c && c.url);

/** 一个候选的实测结论 */
async function probe(c) {
  const t0 = Date.now();
  const res = await fetchText(c.url, { timeoutMs: TIMEOUT });
  const ms = Date.now() - t0;
  if (!res.ok) {
    return { ...c, ok: false, ms, error: res.error || '抓取失败', verdict: '取不到' };
  }
  const body = res.text || '';
  const isHtml = /^\s*<(!doctype|html)/i.test(body);
  const p = parseFeed(body);
  const items = p.items || [];
  const dates = items.map((it) => it.publishedAt).filter(Boolean).sort();
  const latest = dates.length ? dates[dates.length - 1] : '';
  const ageH = latest ? Math.round((Date.now() - new Date(latest).getTime()) / 3600000) : -1;
  const withLink = items.filter((it) => it.url).length;

  /* 判据（与 sources.js 口径⑤一致）：条数 / 时间 / 链接三样都得有 */
  let verdict = '可用';
  if (!items.length) verdict = '0 条（空 feed）';
  else if (!dates.length) verdict = '没有时间字段（不能默认打开）';
  else if (!withLink) verdict = '条目没有链接（点开是死的）';
  else if (ageH > 24 * 7) verdict = '馊了（最新一条 ' + latest.slice(0, 10) + '）';

  return {
    ...c,
    ok: true,
    status: res.status,
    ms,
    bytes: body.length,
    html: isHtml,
    format: p.format,
    title: p.title,
    items: items.length,
    withDate: dates.length,
    withLink,
    latest,
    ageHours: ageH,
    sample: String((items[0] && items[0].title) || '').slice(0, 60),
    warnings: (p.warnings || []).slice(0, 2),
    verdict,
  };
}

const results = [];
let next = 0;
const workers = Array.from({ length: Math.min(CONC, candidates.length) }, async () => {
  while (next < candidates.length) {
    const c = candidates[next++];
    let r;
    try {
      r = await probe(c);
    } catch (err) {
      r = { ...c, ok: false, error: String((err && err.message) || err), verdict: '探针异常' };
    }
    results.push(r);
    const mark = r.verdict === '可用' ? '✓' : '✗';
    console.log(
      `${mark} ${String(r.name || r.url).slice(0, 22).padEnd(22)} ` +
        `${r.verdict.padEnd(24)} ` +
        (r.ok ? `${String(r.items).padStart(3)} 条 · 时间 ${String(r.withDate).padStart(3)} · 链接 ${String(r.withLink).padStart(3)} · ${r.ms}ms` : r.error),
    );
  }
});
await Promise.all(workers);

const good = results.filter((r) => r.verdict === '可用');
console.log('\n────────────────────────────────────────');
console.log(`候选 ${results.length} 个：可用 ${good.length} · 其它 ${results.length - good.length}`);
if (good.length) {
  console.log('\n可用清单（可直接进 sources.js）：');
  for (const r of good) console.log(`  · ${r.name || ''} ${r.url}  → ${r.format} · ${r.items} 条 · 最新 ${String(r.latest).slice(0, 16)}`);
}
if (OUT) {
  const abs = path.resolve(process.cwd(), OUT);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify({ probedAt: new Date().toISOString(), timeoutMs: TIMEOUT, results }, null, 2) + '\n', 'utf8');
  console.log(`\n结论已落盘：${path.relative(HERE, abs)}`);
}
process.exit(0);
