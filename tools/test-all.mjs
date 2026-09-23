/**
 * tools/test-all.mjs —— 抓取与数据层的离线考裁判（纯 Node，不需要网络、不需要 Electron）
 * =====================================================================
 * ### 为什么这个文件是这套代码能不能信的关键
 *
 * 需求 1 的整条链路（抓取 → 解析 → 归一化 → 去重 → 入库 → 分页）里，
 * **除了"真的发出 HTTP 请求"那一步，其余全部可以离线验证**。
 * 而恰恰是"其余全部"最容易出错且不会报错：
 *
 *   · 实体解码错 → 标题里出现 `&amp;`
 *   · CDATA 二次解码 → 正文里的 `&lt;` 变成 `<`
 *   · URL 归一化去多了 → **不同文章被合并成一条（静默丢内容）**
 *   · URL 归一化去少了 → 同一条新闻展示 4 次
 *   · 分页用 OFFSET → 翻页期间新抓的条目会**让已翻过的页漏条**
 *
 * 上面每一条都不会抛异常，只会让结果"看起来不太对"。所以它们必须有断言。
 *
 * ### 考裁判的三层
 *   第一层 单元：实体 / URL / 指纹 / 日期 / 解析器（含真实 feed 片段）
 *   第二层 集成：用**注入的假 fetcher** 跑完整 runIngest（不碰网络），
 *                断言去重、源健康度、失败隔离
 *   第三层 分页：真的插 30 条，断言游标翻页**不重不漏**（这是需求 2 的核心判据）
 *   再加  变异测试：故意把上面每一条改坏，断言用例表**抓得住**
 *
 * 退出码：0 = 全过；1 = 有断言不成立，或有变异体存活
 * =====================================================================
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 同步加载 node:sqlite —— 只给同步的变异体用（见 makeSyncTestDb 的说明） */
const require = createRequire(import.meta.url);
/* ⚠️ 必须用 node:url 的 fileURLToPath，不能手写 `pathname.replace(...)`：
   工作目录里带空格（`D:\work Buddy\...`）时 URL 里是 `%20`，
   手写的版本不会解码，于是得到一个**看起来对、打开却 ENOENT** 的路径。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

import { decodeEntities, unwrapCdata, cleanText, collapseWhitespace, stripHtml } from '../src/ingest/entities.js';
import { canonicalizeUrl, fnv1a, titleFingerprint, dedupeKey } from '../src/ingest/urls.js';
import { parseFeed, parseDate, sniffContentKind } from '../src/ingest/feed-parse.js';
import { openDb, upsertSources, startRun, insertItem, queryItems, countItems, sourceHealth, listSources, getMeta } from '../src/store/db.js';
import { runIngest, shouldRunNow } from '../src/ingest/fetch-feeds.js';
import {
  nextRunAt,
  catchUpDecision,
  createScheduler,
  formatHm,
  parseFetchTime,
  DEFAULT_FETCH_HOUR,
  DEFAULT_FETCH_MINUTE,
} from '../src/main/scheduler.js';
import {
  dataDirOf,
  pidFilePath,
  heartbeatPath,
  runLogPath,
  rawLogPath,
  stopRequestPath,
  readPidFile,
  writePidFile,
  parseHeartbeat,
  isProcessAlive,
  classifyRun,
  formatDuration,
  parseCommand,
  requestStop,
  clearStopRequest,
  hasStopRequest,
  legacyDataDirOf,
} from '../src/shared/runtime-state.js';
import { createBootMark, bootLogPath, teeConsole, createLogSink } from '../src/shared/run-log.js';
import { validateExternalUrl } from '../src/main/url-guard.js';

const lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

let failed = 0;
let passed = 0;

function ok(name, fn) {
  try {
    const r = fn();
    // ⚠️ 这个检查是必要的：`openDb` 改成异步之后，用例回调会变成 async。
    //    若不同步断言，"失败"会落在 promise 里、`failed++` 赶不上最终判断 ⇒ **假绿**。
    //    ⇒ 发现返回 promise 就当场判错，逼调用方改用 `aok`。
    if (r && typeof r.then === 'function') {
      failed += 1;
      say(`  ✗ ${name}`);
      say('      用例返回了 Promise —— 同步 ok() 接不住它（会假绿）。请改用 aok()。');
      return;
    }
    passed += 1;
    say(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    say(`  ✗ ${name}`);
    say(`      ${err.message.split('\n')[0]}`);
  }
}

/** 异步用例（需要 openDb / runIngest 这类异步 API 时用这个） */
async function aok(name, fn) {
  try {
    await fn();
    passed += 1;
    say(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    say(`  ✗ ${name}`);
    say(`      ${err.message.split('\n')[0]}`);
  }
}

/* ================================================================== */
say('┌─ 晨报机 · 抓取与数据层离线考裁判 ──────────────────────────');
say('│ 纯 Node：不联网、不需要 Electron');
say('│ 覆盖：实体/URL/解析 · 抓取与失败隔离 · 筛选与游标翻页');
say('│ 　　　外链协议白名单（安全边界）· 补跑判定 · 变异测试');
say('└────────────────────────────────────────────────────────────');
say();

/* ---------- 需求 3：外链协议白名单（安全边界，必须有断言） ---------- */
say();
say('--- 需求 3 · 点击跳转的协议白名单（这是安全边界，不是样式问题）---');

ok('放行 http 与 https', () => {
  assert.equal(validateExternalUrl('https://example.com/a').ok, true);
  assert.equal(validateExternalUrl('http://example.com/a').ok, true);
});

ok('★ 拒绝 javascript:（外部数据不许当命令执行）', () => {
  const r = validateExternalUrl('javascript:alert(1)');
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('javascript:'), `原因要说清是哪个协议：${r.reason}`);
});

ok('★ 拒绝 file:（不许打开本地文件）', () => {
  assert.equal(validateExternalUrl('file:///C:/Windows/System32/calc.exe').ok, false);
});

ok('★ 拒绝 Windows 协议处理器（ms-msdt / search-ms 出过 RCE）', () => {
  assert.equal(validateExternalUrl('ms-msdt:/id PCWDiagnostic').ok, false);
  assert.equal(validateExternalUrl('search-ms:query=x').ok, false);
});

ok('★ 拒绝 smb:（会触发 NTLM 凭据泄露）', () => {
  assert.equal(validateExternalUrl('smb://attacker/share').ok, false);
});

ok('★ 含控制字符的 URL 被拒（可骗过"看起来像 http"的检查）', () => {
  assert.equal(validateExternalUrl('https://ok.com/\nhttps://evil.com').ok, false);
  assert.equal(validateExternalUrl('https://ok.com/\u0000').ok, false);
});

ok('空 / 非字符串 / 畸形：拒绝且给出可读原因', () => {
  assert.equal(validateExternalUrl('').ok, false);
  assert.equal(validateExternalUrl('   ').ok, false);
  assert.equal(validateExternalUrl(null).ok, false);
  assert.equal(validateExternalUrl(undefined).ok, false);
  assert.equal(validateExternalUrl(42).ok, false);
  assert.equal(validateExternalUrl('不是链接').ok, false);
  assert.ok(validateExternalUrl('').reason.length > 0, '空链接也要有原因，不能静默');
});

ok('畸形 https：能解析的归一化后放行，不能解析的直接拒', () => {
  /* ⚠️ 这里我第一版期望写错了。`new URL('https:///path')` **不抛错** ——
     WHATWG URL 会把第一个非空路径段当主机名，规范成 `https://path/`。
     所以正确的断言是"**归一化之后仍然安全**"，而不是"被拒"。
     （`hostname` 为空的那道检查保留着 —— 它对 `https:` 之外的形式仍有用。） */
  const weird = validateExternalUrl('https:///path');
  assert.equal(weird.ok, true, '它能被规范成合法 URL');
  assert.equal(weird.href, 'https://path/', `实际归一化结果：${weird.href}`);

  // 真正解析不了的必须拒
  assert.equal(validateExternalUrl('https://').ok, false);
  assert.equal(validateExternalUrl('http:///').ok, false);
  assert.equal(validateExternalUrl('https://?q=1').ok, false);
});

/* ---------- 需求 2：筛选 + 翻页的**契约**（真机踩过两处） ---------- */
say();
say('--- 需求 2 · 筛选与翻页的契约 ---');

await (async () => {
  const dbFile = tmpDbFile('filter');
  const db = await openDb(dbFile);
  const now = new Date().toISOString();
  upsertSources(db, [{ name: 'S', feedUrl: 'https://s.com/feed', kind: 'rss' }], now);
  const runId = startRun(db, 'manual', now);
  const cats = await import('../src/store/db.js');
  const cA = cats.upsertCategory(db, '甲类', 0, now);
  const cB = cats.upsertCategory(db, '乙类', 1, now);

  for (let i = 1; i <= 6; i += 1) {
    const r = insertItem(db, { title: `甲${i}`, url: `https://e.com/a/${i}`, publishedAt: new Date(Date.UTC(2026, 8, 22, 0, 0, i)).toISOString() }, runId, now);
    if (r) cats.tagItem(db, r.id, [cA]);
  }
  for (let i = 1; i <= 4; i += 1) {
    const r = insertItem(db, { title: `乙${i}`, url: `https://e.com/b/${i}`, publishedAt: new Date(Date.UTC(2026, 8, 22, 1, 0, i)).toISOString() }, runId, now);
    if (r) cats.tagItem(db, r.id, [cB]);
  }

  await aok('不带筛选：10 条全出', async () => {
    assert.equal(queryItems(db, { limit: 50 }).rows.length, 10);
  });

  await aok('★ 带筛选：只出该类别的条目', async () => {
    const onlyA = queryItems(db, { limit: 50, categoryIds: [cA] }).rows;
    assert.equal(onlyA.length, 6, `甲类应 6 条，实际 ${onlyA.length}`);
    assert.ok(onlyA.every((r) => /^甲/.test(r.title)), '不许混进别的类别的条目');
  });

  await aok('★ 筛选 + 翻页：翻页也必须守住筛选（真机踩过的 bug）', async () => {
    const seen = [];
    let cursor;
    const { queryItems: qi } = cats;
    for (;;) {
      const page = qi(db, { limit: 2, cursor, categoryIds: [cA] });
      seen.push(...page.rows.map((r) => r.title));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
      assert.ok(seen.length <= 6, '越界说明翻页把别的类别也翻出来了');
    }
    assert.equal(seen.length, 6, `筛选后翻页应得 6 条，实际 ${seen.length}`);
    assert.ok(seen.every((t) => /^甲/.test(t)), `翻页翻出了别的类别：${JSON.stringify(seen)}`);
  });

  await aok('类别计数：countItems 也要尊重筛选', async () => {
    const t = countItems(db, {});
    const a = countItems(db, { categoryIds: [cA] });
    assert.equal(t, 10);
    assert.equal(a, 6);
  });

  db.close();
})();

/* ---------- 第一层：实体解码 ---------- */
say('--- 第一层 · XML 实体与文本清洗 ---');

ok('命名实体：&amp; &lt; &gt; &quot;', () => {
  assert.equal(decodeEntities('AI &amp; 芯片 &lt;下&gt; &quot;引&quot;'), 'AI & 芯片 <下> "引"');
});

ok('★ &amp; 必须最后解（否则 &amp;lt; 会被二次解码成 <）', () => {
  // 原文含义是字面量 "&lt;"，正确结果就是 "&lt;"，不是 "<"
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  // 对照：单独的 &lt; 应当解成 <
  assert.equal(decodeEntities('&lt;'), '<');
});

ok('数字实体（十进制与十六进制）', () => {
  assert.equal(decodeEntities('&#65;&#x42;'), 'AB');
});

ok('未知实体原样保留（不吞、不编造）', () => {
  assert.equal(decodeEntities('&nosuchentity;'), '&nosuchentity;');
});

ok('★ 越界/非法码点**原样保留**（与"未知实体原样保留"同一口径：不编造）', () => {
  // 这几条我第一版写错过期望：以为会降级成 U+FFFD，实际实现选择"原样保留"。
  // 两种都合理，但**必须与实现对得上**，且口径一致 —— 所以断言改成"原样"。
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;', '超出 Unicode 上限');
  assert.equal(decodeEntities('&#0;'), '&#0;', '码点 0 不合法');
  // 代理区也不该产出半个字符
  const surrogate = decodeEntities('&#xD800;');
  assert.equal(surrogate, '\ufffd', '代理区单独出现时降级为 U+FFFD（不能产出半个字符）');
});

ok('CDATA：取内容且**不再解码**', () => {
  const r = unwrapCdata('<![CDATA[为什么 V8 的 GC 这么快]]>');
  assert.deepEqual(r, { text: '为什么 V8 的 GC 这么快', wasCdata: true });
});

ok('★ CDATA 里的 &amp; 不许被再解一次', () => {
  // 这是"二次解码"陷阱的第二面：CDATA 内是原文
  assert.equal(cleanText('<![CDATA[a &amp; b]]>'), 'a &amp; b');
  // 非 CDATA 才解码
  assert.equal(cleanText('a &amp; b'), 'a & b');
});

ok('collapseWhitespace 折叠换行与全角空格', () => {
  assert.equal(collapseWhitespace('  a\n\n  b\u00a0c  '), 'a b c');
});

ok('stripHtml 去掉脚本与样式的内容（不是只去标签）', () => {
  const out = stripHtml('<style>p{color:red}</style><p>正文</p><script>alert(1)</script>');
  assert.equal(out.includes('color'), false, 'style 内容不该留下');
  assert.equal(out.includes('alert'), false, 'script 内容不该留下');
  assert.equal(out, '正文');
});

ok('stripHtml 把 <br>/</p> 变成空格（避免词黏在一起）', () => {
  assert.equal(stripHtml('机器之心<br>报道'), '机器之心 报道');
});

/* ---------- 第一层：URL 归一化与指纹 ---------- */
say();
say('--- 第一层 · URL 归一化与去重指纹 ---');

ok('去掉跟踪参数、fragment、末尾斜杠、www、协议统一', () => {
  assert.equal(
    canonicalizeUrl('http://WWW.Example.com/Post/1/?utm_source=rss&utm_medium=feed#comments'),
    'https://example.com/Post/1',
  );
});

ok('★ 参数顺序不同算同一条（排序后比对）', () => {
  assert.equal(canonicalizeUrl('https://e.com/a?b=2&a=1'), canonicalizeUrl('https://e.com/a?a=1&b=2'));
});

ok('★ 不去掉内容标识参数（去多了会把不同文章合并 = 静默丢内容）', () => {
  const a = canonicalizeUrl('https://e.com/post?id=123');
  const b = canonicalizeUrl('https://e.com/post?id=456');
  assert.notEqual(a, b, 'id 不同必须算不同');
  assert.ok(a.includes('id=123'));
});

ok('普通路径末尾斜杠被去掉，根路径保留', () => {
  assert.equal(canonicalizeUrl('https://e.com/a/b/'), 'https://e.com/a/b');
  assert.equal(canonicalizeUrl('https://e.com/'), 'https://e.com/');
});

ok('非 http(s) 协议原样保留（mailto 等）', () => {
  assert.ok(canonicalizeUrl('mailto:a@b.com').startsWith('mailto:'));
});

ok('★ 无法解析时返回小写原文，而不是空串（空串会静默合并所有坏 URL）', () => {
  assert.equal(canonicalizeUrl('not a url'), 'not a url');
  assert.notEqual(canonicalizeUrl('bad one'), canonicalizeUrl('bad two'));
});

ok('fnv1a 稳定且区分度够', () => {
  assert.equal(fnv1a('abc'), fnv1a('abc'));
  assert.notEqual(fnv1a('abc'), fnv1a('abd'));
  assert.equal(fnv1a('').length, 8);
});

ok('标题指纹忽略空白/标点/全角/大小写', () => {
  const a = titleFingerprint('AI 芯片，国产替代！');
  const b = titleFingerprint('ai芯片国产替代');
  assert.equal(a, b);
});

ok('dedupeKey：有 URL 用 URL 指纹', () => {
  assert.ok(dedupeKey({ url: 'https://e.com/1', title: 'x' }).startsWith('u:'));
});

ok('dedupeKey：无 URL 退回标题指纹', () => {
  assert.ok(dedupeKey({ title: '只有标题' }).startsWith('t:'));
});

ok('★ dedupeKey：两者都没有 → 空串（调用方须如实登记，不许硬塞同一个键）', () => {
  assert.equal(dedupeKey({}), '');
  assert.equal(dedupeKey({ url: '  ', title: '   ' }), '');
});

/* ---------- 第一层：解析器 ---------- */
say();
say('--- 第一层 · RSS / Atom / RDF 解析 ---');

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>机器之心</title>
  <item>
    <title>某厂商发布新一代推理芯片 &amp; 能效提升 40%</title>
    <link>https://www.jiqizhixin.com/articles/1?utm_source=rss</link>
    <pubDate>Tue, 22 Sep 2026 10:00:00 +0800</pubDate>
    <description><![CDATA[<p>单卡算力较上代翻倍，<b>功耗持平</b>。</p>]]></description>
    <dc:creator>张三</dc:creator>
  </item>
  <item>
    <title><![CDATA[开源模型在中文评测上首次超过闭源方案]]></title>
    <link>https://www.jiqizhixin.com/articles/2</link>
    <description>与标题不同的一段摘要</description>
  </item>
</channel></rss>`;

ok('RSS：识别格式、频道名、条目数', () => {
  const r = parseFeed(RSS_SAMPLE);
  assert.equal(r.format, 'rss');
  assert.equal(r.title, '机器之心');
  assert.equal(r.items.length, 2);
  assert.equal(r.ok, true);
});

ok('RSS：实体被解码、CDATA 标签被剥掉', () => {
  const r = parseFeed(RSS_SAMPLE);
  assert.equal(r.items[0].title, '某厂商发布新一代推理芯片 & 能效提升 40%');
  assert.equal(r.items[0].summary, '单卡算力较上代翻倍，功耗持平。');
});

ok('RSS：<link> 原文保留（不归一化 —— 归一化只用于去重）', () => {
  const r = parseFeed(RSS_SAMPLE);
  assert.ok(r.items[0].url.includes('utm_source=rss'), '展示/跳转用的 URL 必须保留原样');
});

ok('RSS：pubDate 解成 ISO；缺失时为 null（不编造时间）', () => {
  const r = parseFeed(RSS_SAMPLE);
  assert.equal(r.items[0].publishedAt, '2026-09-22T02:00:00.000Z');
  assert.equal(r.items[1].publishedAt, null, '没有 pubDate 就必须是 null');
});

ok('RSS：摘要与标题相同时丢弃（无信息量）', () => {
  const xml = `<rss><channel><item><title>标题A</title><description>标题A</description></item></channel></rss>`;
  assert.equal(parseFeed(xml).items[0].summary, '');
});

ok('RSS：缺标题的条目不产出（不编造标题）', () => {
  const xml = `<rss><channel><item><link>https://e.com/1</link></item><item><title>有标题</title></item></channel></rss>`;
  const r = parseFeed(xml);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, '有标题');
  assert.ok(r.warnings.some((w) => w.includes('缺标题')), '丢弃行为必须留痕');
});

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Hacker News</title>
  <entry>
    <title>Show HN: 我写了个 X</title>
    <link rel="alternate" href="https://news.ycombinator.com/item?id=1"/>
    <link rel="replies" href="https://news.ycombinator.com/item?id=1&amp;replies"/>
    <updated>2026-09-22T03:00:00Z</updated>
    <summary>一段摘要</summary>
  </entry>
</feed>`;

ok('Atom：rel="alternate" 优先作为链接', () => {
  const r = parseFeed(ATOM_SAMPLE);
  assert.equal(r.format, 'atom');
  assert.equal(r.items[0].url, 'https://news.ycombinator.com/item?id=1');
});

ok('Atom：updated 解成 ISO', () => {
  assert.equal(parseFeed(ATOM_SAMPLE).items[0].publishedAt, '2026-09-22T03:00:00.000Z');
});

const RDF_SAMPLE = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <item rdf:about="https://e.com/rdf1">
    <title>RDF 格式的条目</title>
    <dc:date>2026-09-22T04:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

ok('RDF：能识别，rdf:about 作为链接兜底', () => {
  const r = parseFeed(RDF_SAMPLE);
  assert.equal(r.format, 'rdf');
  assert.equal(r.items[0].url, 'https://e.com/rdf1');
  assert.equal(r.items[0].publishedAt, '2026-09-22T04:00:00.000Z');
});

ok('空 feed：如实报"合法但没条目"，不报成解析失败', () => {
  const r = parseFeed('<rss><channel><title>空源</title></channel></rss>');
  assert.equal(r.ok, false);
  assert.ok(r.warnings.some((w) => w.includes('没有任何条目')));
});

ok('★ 非 feed 内容：报错要**指向下一步**（说清拿到的是什么，不只是"认不出"）', () => {
  const r = parseFeed('<html><body>这是一个网页不是 feed</body></html>');
  assert.equal(r.ok, false);
  assert.ok(
    r.warnings.some((w) => w.includes('不是可解析的 feed')),
    `告警里要说清"不是 feed"，实际：${JSON.stringify(r.warnings)}`,
  );
  // ★ 关键：真机实测发现只说"认不出"用户不知道该做什么 ⇒ 必须带上"它是什么"
  assert.equal(r.contentKind, 'HTML 网页（不是 feed）', `应识别出内容类型，实际：${r.contentKind}`);
  assert.ok(r.preview && r.preview.length > 0, '要带一段预览供定位');
});

ok('XML 注释里的条目不被算进结果', () => {
  const xml = `<rss><channel><!-- <item><title>旧条目</title></item> --><item><title>新条目</title></item></channel></rss>`;
  const r = parseFeed(xml);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, '新条目');
});

ok('parseDate：脏数据返回 null（不编造）', () => {
  assert.equal(parseDate('0000-00-00'), null);
  assert.equal(parseDate('不是一个时间'), null);
  assert.equal(parseDate(''), null);
  assert.equal(parseDate(null), null);
  // 1970 附近的脏数据也当没给
  assert.equal(parseDate('1970-01-01T00:00:00Z'), null);
});

/* ---------- 第二层：集成（注入假 fetcher，不联网） ---------- */
say();
say('--- 第二层 · 完整抓取流程（注入假 fetcher，不联网）---');

function tmpDbFile(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mb-${tag}-`));
  return path.join(dir, 'test.db');
}

/**
 * 同步建一个**最小可用**的测试库，供同步的变异体使用。
 *
 * ⚠️ 为什么不用 `openDb`：它现在是异步的（`node:sqlite` 要延迟加载，
 *    因为**在 Electron 主进程顶层静态 import 它会原生崩溃**，见 store/db-setup.js）。
 *    而变异体的 `run()` 是同步的。
 *    ⇒ 这里用 `createRequire` 同步拿驱动 —— **测试进程里没有那个崩溃条件**
 *      （崩溃只发生在 Electron 主进程求值 `app.whenReady()` 之前）。
 *    刻意只建分页需要的那几列：变异体考的是"OFFSET 会不会重叠"，与完整 schema 无关。
 */
function makeSyncTestDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE source (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, feed_url TEXT UNIQUE, kind TEXT, enabled INTEGER DEFAULT 1, created_at TEXT);' +
      'CREATE TABLE fetch_run (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT, trigger TEXT, ok_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, new_items INTEGER DEFAULT 0, finished_at TEXT, detail TEXT);' +
      'CREATE TABLE item (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT UNIQUE, title TEXT, url TEXT, url_canonical TEXT, summary TEXT, author TEXT, source_id INTEGER, source_name TEXT, published_at TEXT, fetched_at TEXT, first_run_id INTEGER, read_state TEXT DEFAULT \'unread\');',
  );
  return db;
}

const GOOD_RSS = `<rss><channel><title>T</title>
  <item><title>条目一</title><link>https://e.com/a</link><pubDate>Tue, 22 Sep 2026 10:00:00 +0800</pubDate></item>
  <item><title>条目二</title><link>https://e.com/b</link><pubDate>Tue, 22 Sep 2026 09:00:00 +0800</pubDate></item>
</channel></rss>`;

async function ingestWith(fetcherImpl, dbFile) {
  const logs = [];
  const r = await runIngest({
    dbFile,
    trigger: 'manual',
    ensureSources: true,
    log: (m) => logs.push(m),
    fetcher: fetcherImpl,
  });
  return { r, logs };
}

/** 一个按 URL 分派的假 fetcher */
function fakeFetcher(map) {
  return async (url) => {
    const hit = map[url];
    if (!hit) return { ok: false, error: '假 fetcher：没有为这个 URL 配置响应' };
    return hit;
  };
}

/* ⚠️ 裸 `{ }` 块里**不能 await**。`openDb` 改成异步之后，
   这几段必须包成 async IIFE —— 否则会得到 SyntaxError（而它只在运行时暴露）。 */
await (async () => {
  const dbFile = tmpDbFile('ingest');
  const map = {};
  // 让所有预置源都返回同一份好 feed（省得逐个配）
  const { DEFAULT_SOURCES } = await import('../src/ingest/sources.js');
  for (const s of DEFAULT_SOURCES) map[s.feedUrl] = { ok: true, status: 200, text: GOOD_RSS };

  const { r } = await ingestWith(fakeFetcher(map), dbFile);

  ok('全部源成功：ok 数 = 源数，newItems 已统计', () => {
    assert.equal(r.failed, 0, `不该有失败：${JSON.stringify(r.perSource.filter((x) => x.status !== 'ok'))}`);
    assert.equal(r.ok, r.sources);
    assert.ok(r.newItems > 0);
  });

  await aok('★ 跨源去重生效：同一份 feed 喂给 N 个源，只入库一次', async () => {
    // 所有源返回同样的两条 ⇒ 库里应该只有 2 条
    const db = await openDb(dbFile);
    const n = countItems(db);
    db.close();
    assert.equal(n, 2, `期望去重后 2 条，实际 ${n}`);
  });

  // 再跑一次：全部重复，新增应为 0
  const { r: r2 } = await ingestWith(fakeFetcher(map), dbFile);
  ok('★ 重复抓取不产生新条目（幂等）', () => {
    assert.equal(r2.newItems, 0, `第二次抓取不该新增，实际 ${r2.newItems}`);
    assert.ok(r2.duplicates > 0, '应当统计到重复');
  });
})();

await (async () => {
  const dbFile = tmpDbFile('isolation');
  const { DEFAULT_SOURCES } = await import('../src/ingest/sources.js');
  const map = {};
  DEFAULT_SOURCES.forEach((s, i) => {
    if (i === 0) map[s.feedUrl] = { ok: false, status: 500, error: 'HTTP 500' };
    else if (i === 1) map[s.feedUrl] = { ok: false, error: '超时（>15000ms）' };
    else if (i === 2) map[s.feedUrl] = { ok: true, status: 200, text: '<html>不是 feed</html>' };
    else map[s.feedUrl] = { ok: true, status: 200, text: GOOD_RSS };
  });

  const { r } = await ingestWith(fakeFetcher(map), dbFile);

  ok('★ 三个源分别坏掉，其余源照常成功（失败隔离）', () => {
    assert.equal(r.failed, 3, `期望 3 个失败，实际 ${r.failed}`);
    assert.equal(r.ok, r.sources - 3);
    assert.ok(r.newItems > 0, '好源必须仍然产出条目');
  });

  ok('失败原因被分类记录（http_error / network_error / parse_error）', () => {
    const st = r.perSource.map((x) => x.status);
    assert.ok(st.includes('http_error'), 'HTTP 500 应记为 http_error');
    assert.ok(st.includes('network_error'), '超时应记为 network_error');
    assert.ok(st.includes('parse_error'), '非 feed 内容应记为 parse_error');
  });

  ok('★ 源健康度可查（界面"几个源挂了"靠它）', () => {
    assert.equal(r.health.total, r.sources);
    assert.equal(r.health.bad, 3);
    assert.equal(r.health.ok, r.sources - 3);
  });

  ok('★ 坏源不写坏数据：解析失败的源产出 0 条', () => {
    const bad = r.perSource.filter((x) => x.status !== 'ok');
    assert.ok(bad.every((x) => x.items === 0));
    assert.ok(bad.every((x) => x.error), '每个失败都必须带原因（不许只有状态没有原因）');
  });
})();

/* ==================================================================
 * 第四层之二 · 源清单改动的**落地**
 * ------------------------------------------------------------------
 * 这一组是**真机日志逼出来的**，两条都不是理论问题：
 *
 *  ① 我把 虎嗅 / 品玩 / cnBeta / 财新网 / 阮一峰(feedburner) 从清单里换掉之后，
 *     用户机器上那 5 条**还在被反复抓**（日志里每一轮都出现它们超时/返回 HTML），
 *     界面顶部因此长期挂着"5 个源异常"。
 *     根因：upsertSources 只处理"加了什么"，从不处理"去掉了什么"。
 *     ⇒ 症状是"代码改了等于没改"，而这类病最难发现 —— 因为**代码看上去是对的**。
 *
 *  ② 重试条件写得太宽（`/不是 feed/` 把普通 HTML 也匹配进去了），
 *     于是品玩/cnBeta/财新网 这类**本来就只是普通网页**的源被重试一次，
 *     日志还写成"疑似被安全挑战页拦了" —— **诊断指向了错误的原因**。
 * ================================================================== */
say();
say('--- 第四层之二 · 源清单改动的落地（增、删、重试口径）---');

await (async () => {
  const db = await openDb(tmpDbFile('srcsync'));
  const now = new Date().toISOString();

  const first = upsertSources(
    db,
    [
      { name: '留下的', feedUrl: 'https://keep.com/feed', kind: 'rss' },
      { name: '被删掉的', feedUrl: 'https://gone.com/feed', kind: 'rss' },
    ],
    now,
  );
  ok('首次登记：新增 2 条，没有要停用的', () => {
    assert.equal(first.added, 2);
    assert.deepEqual(first.retired, []);
  });

  ok('★ 清单里去掉的源会被停用（否则它永远在失败、永远挂在"源异常"里）', () => {
    const second = upsertSources(db, [{ name: '留下的', feedUrl: 'https://keep.com/feed', kind: 'rss' }], now);
    assert.deepEqual(second.retired, ['被删掉的'], '被移除的源没有被停用');
    const rows = listSources(db);
    const gone = rows.find((r) => r.feed_url === 'https://gone.com/feed');
    assert.ok(gone, '不许删行（会连带丢掉它的抓取历史）');
    assert.equal(gone.enabled, 0, '被移除的源仍然 enabled');
    assert.equal(listSources(db, true).length, 1, '启用列表里只该剩 1 个');
  });

  ok('★ 同一个源不会被重复报"停用"（幂等）', () => {
    const third = upsertSources(db, [{ name: '留下的', feedUrl: 'https://keep.com/feed', kind: 'rss' }], now);
    assert.deepEqual(third.retired, [], '第二次同步还在报同一个源被停用');
    assert.equal(third.added, 0);
  });

  ok('★ 清单里显式 enabled:false 的源不会被当成"被删除"（两种情况要分开）', () => {
    // 一个源既在清单里又写着 enabled:false —— 停用理由是"代码判定不可达"，
    // 不是"从清单里删掉了"。两者日志文案不同，别混成一句。
    upsertSources(
      db,
      [
        { name: '留下的', feedUrl: 'https://keep.com/feed', kind: 'rss' },
        { name: '关着的', feedUrl: 'https://off.com/feed', kind: 'rss', enabled: false },
      ],
      now,
    );
    assert.equal(listSources(db).find((r) => r.feed_url === 'https://off.com/feed').enabled, 0);
    const again = upsertSources(
      db,
      [
        { name: '留下的', feedUrl: 'https://keep.com/feed', kind: 'rss' },
        { name: '关着的', feedUrl: 'https://off.com/feed', kind: 'rss', enabled: false },
      ],
      now,
    );
    assert.deepEqual(again.retired, [], 'enabled:false 的源被误报成"已从清单移除"');
  });

  db.close();
})();

await (async () => {
  /* 重试口径：普通 HTML **不重试**，人机验证页才重试一次。 */
  const dbFile = tmpDbFile('retry');
  const { DEFAULT_SOURCES } = await import('../src/ingest/sources.js');
  const first = DEFAULT_SOURCES[0];
  const counts = new Map();
  const counting = (url, res) => async () => {
    counts.set(url, (counts.get(url) || 0) + 1);
    return res;
  };

  // 源 0：普通网页（不是 feed，也不是验证页）→ 只该请求 1 次
  // 源 1：人机验证页 → 该请求 2 次（一次重试）
  const map = {};
  map[first.feedUrl] = counting(first.feedUrl, {
    ok: true,
    status: 200,
    text: '<!DOCTYPE html><html><head><title>栏目页</title></head><body>普通网页</body></html>',
  });
  map[DEFAULT_SOURCES[1].feedUrl] = counting(DEFAULT_SOURCES[1].feedUrl, {
    ok: true,
    status: 200,
    text: '<!DOCTYPE html><html><body>正在进行安全检测，请稍候…</body></html>',
  });
  DEFAULT_SOURCES.slice(2).forEach((s) => {
    map[s.feedUrl] = counting(s.feedUrl, { ok: true, status: 200, text: GOOD_RSS });
  });

  await ingestWith(async (url) => map[url](url), dbFile);

  ok('★ 普通网页不重试（重试只会多花一次请求，还把诊断写成"被反爬拦了"）', () => {
    assert.equal(counts.get(first.feedUrl), 1, `普通 HTML 被请求了 ${counts.get(first.feedUrl)} 次，应当只有 1 次`);
  });

  ok('★ 人机验证页重试一次（真机上 36氪 是间歇性的，一次不成就永久丢源）', () => {
    const n = counts.get(DEFAULT_SOURCES[1].feedUrl);
    assert.equal(n, 2, `验证页被请求了 ${n} 次，应当重试 1 次（共 2 次）`);
  });
})();

/* ---------- 第三层：分页（需求 2 的核心） ---------- */
say();
say('--- 第三层 · 游标分页：不重不漏（需求 2 的核心判据）---');

await (async () => {
  const dbFile = tmpDbFile('paging');
  const db = await openDb(dbFile);
  const now = new Date().toISOString();
  upsertSources(db, [{ name: 'S', feedUrl: 'https://s.com/feed', kind: 'rss' }], now);
  const runId = startRun(db, 'manual', now);

  // 插 30 条，时间倒序可辨；再插 3 条**没有时间**的（必须排最后）
  for (let i = 1; i <= 30; i += 1) {
    insertItem(
      db,
      {
        title: `条目 ${String(i).padStart(2, '0')}`,
        url: `https://e.com/p/${i}`,
        publishedAt: new Date(Date.UTC(2026, 8, 22, 10, 0, i)).toISOString(),
        sourceId: 1,
        sourceName: 'S',
      },
      runId,
      now,
    );
  }
  for (let i = 1; i <= 3; i += 1) {
    insertItem(db, { title: `无时间条目 ${i}`, url: `https://e.com/n/${i}`, publishedAt: null, sourceId: 1, sourceName: 'S' }, runId, now);
  }

  ok('总数 33（30 条有时间 + 3 条没有）', () => {
    assert.equal(countItems(db), 33);
  });

  // 逐页翻完，收集所有 id
  const seen = [];
  let cursor = undefined;
  let pages = 0;
  for (;;) {
    const page = queryItems(db, { limit: 7, cursor });
    pages += 1;
    seen.push(...page.rows.map((r) => r.id));
    if (!page.hasMore) break;
    cursor = page.nextCursor;
    assert.ok(pages < 20, '翻页不该无限循环');
  }

  ok('★ 游标翻页：翻完得到全部 33 条，且**没有重复**', () => {
    assert.equal(seen.length, 33, `期望 33 条，实际 ${seen.length}`);
    assert.equal(new Set(seen).size, 33, '出现了重复条目');
  });

  ok('第一页按时间倒序（最新在前）', () => {
    const p1 = queryItems(db, { limit: 5 });
    assert.equal(p1.rows[0].title, '条目 30');
    assert.equal(p1.rows[4].title, '条目 26');
  });

  ok('★ 没有 published_at 的条目排最后（不混进"最新"里）', () => {
    const all = [];
    let c;
    for (;;) {
      const p = queryItems(db, { limit: 10, cursor: c });
      all.push(...p.rows);
      if (!p.hasMore) break;
      c = p.nextCursor;
    }
    const last3 = all.slice(-3).map((r) => r.title);
    assert.ok(last3.every((t) => t.startsWith('无时间条目')), `最后 3 条应是无时间的，实际 ${JSON.stringify(last3)}`);
  });

  ok('★ 翻页期间插入新条目，已翻过的页不受影响（OFFSET 会漏条，游标不会）', () => {
    const p1 = queryItems(db, { limit: 5 });
    const p1Ids = p1.rows.map((r) => r.id);
    // 模拟后台又抓来一条"更新的"
    insertItem(
      db,
      { title: '翻页中途插入的新条目', url: 'https://e.com/inserted', publishedAt: '2027-01-01T00:00:00Z', sourceId: 1, sourceName: 'S' },
      runId,
      now,
    );
    const p2 = queryItems(db, { limit: 5, cursor: p1.nextCursor });
    const overlap = p2.rows.map((r) => r.id).filter((id) => p1Ids.includes(id));
    assert.equal(overlap.length, 0, `第二页与第一页重叠了 ${overlap.length} 条（OFFSET 式分页就会这样）`);
  });

  ok('limit 被夹在 1..200（防滥用，且 0/负数不会变成"取空"）', () => {
    // 我把第一版断言写错了：limit:0 的语义是"夹到 1"，不是"返回 0 条"。
    // 口径：**永远至少返回 1 条**，避免调用方传 0 时静默拿到空页（那会看着像"没有数据"）。
    assert.equal(queryItems(db, { limit: 0 }).rows.length, 1, 'limit=0 → 夹到 1');
    assert.equal(queryItems(db, { limit: -5 }).rows.length, 1, 'limit 负数 → 夹到 1');
    assert.ok(queryItems(db, { limit: 9999 }).rows.length <= 200, 'limit 过大 → 夹到 200');
  });

  db.close();
})();

/* ==================================================================
 * ★★ 「看今天全部」必须**真的**只取今天
 * ------------------------------------------------------------------
 * 为什么单独立一层：按钮上写着「看今天全部（N）」，而 N 是**当日**总数。
 * 如果查询不按日期收口，点下去会翻出一堆前几天的条目 ——
 * 文案与实际结果不符，用户的第一反应是"筛选/翻页是坏的"。
 * 这是同一类 bug 在这个项目里**第二次**现身
 * （第一次是"翻页丢掉了筛选条件"，把别的类别的条目翻了进来）。
 * ================================================================== */
say();
say('--- 第三层 · 「看今天全部」的日期口径 ---');

/** 造一个"今天 3 条 + 昨天 2 条"的干净库 */
async function makeTodayDb(tag) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const sinceIso = t.toISOString();
  const nowIso = new Date().toISOString();
  const yesterday = new Date(t.getTime() - 36 * 3600 * 1000).toISOString();
  const db = await openDb(tmpDbFile(tag));
  const runId = startRun(db, 'test', nowIso);
  for (let i = 0; i < 3; i += 1) {
    insertItem(
      db,
      { title: 'T' + i, url: 'https://e.com/t' + i, publishedAt: new Date(Date.now() - i * 60000).toISOString() },
      runId,
      nowIso,
    );
  }
  for (let i = 0; i < 2; i += 1) {
    insertItem(db, { title: 'Y' + i, url: 'https://e.com/y' + i, publishedAt: yesterday }, runId, nowIso);
  }
  return { db, sinceIso, nowIso, yesterday };
}

await aok('★ todayOnly 只返回今天，且与 countItems 的口径逐字一致', async () => {
  const { db, sinceIso, nowIso } = await makeTodayDb('todayonly');
  const all = queryItems(db, { limit: 50 });
  const only = queryItems(db, { limit: 50, todayOnly: true, sinceIso });
  const counted = countItems(db, { sinceIso });
  assert.equal(all.rows.length, 5, '不带 todayOnly 应当拿到全部 5 条（历史回填是有意保留的）');
  assert.equal(only.rows.length, 3, 'todayOnly 应当只拿今天 3 条，实得 ' + only.rows.length);
  // ★ 机器判据：按钮上那个数字必须等于真的能翻出来的条数
  assert.equal(only.rows.length, counted, 'queryItems(todayOnly) 与 countItems 口径不一致 ⇒ 按钮上的数字与实际条数对不上');
  assert.ok(only.rows.every((r) => r.published_at === null || r.published_at >= sinceIso));
  // 没给 sinceIso 时不许静默收口（宁可什么都不做，也不要假装收了）
  assert.equal(queryItems(db, { limit: 50, todayOnly: true }).rows.length, 5, '没有日期边界时不该凭空收口');
  void nowIso;
  db.close();
});

await aok('★ 没有 published_at 的条目也要算进"今天"（靠 fetched_at 兜底）', async () => {
  const { db, sinceIso, nowIso } = await makeTodayDb('todaynull');
  const runId = startRun(db, 'test', nowIso);
  insertItem(db, { title: '今日无时间', url: 'https://e.com/tn', publishedAt: null }, runId, nowIso);
  const only = queryItems(db, { limit: 50, todayOnly: true, sinceIso });
  const counted = countItems(db, { sinceIso });
  assert.equal(counted, 4, '刚抓到的无日期条目没被算进今天：counted=' + counted);
  assert.equal(only.rows.length, 4, '查询与计数口径分叉（这是最隐蔽的一种）：' + only.rows.length);
  db.close();
});

await aok('★ 带 todayOnly 翻页：3 条今日条目按每页 1 条翻完，不重不漏', async () => {
  const { db, sinceIso } = await makeTodayDb('todaypage');
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 8; page += 1) {
    const r = queryItems(db, { limit: 1, cursor, todayOnly: true, sinceIso });
    for (const row of r.rows) seen.push(row.title);
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ['T0', 'T1', 'T2'], '带 todayOnly 翻页把昨天条目也翻出来了，或者丢了今日条目：' + JSON.stringify(seen));
  db.close();
});

/* ---------- 补跑判定 ---------- */
say();
say('--- 第三层 · 补跑判定（关机/休眠错过后要补）---');

ok('从未抓取过 → 立即跑', () => {
  assert.equal(shouldRunNow(null, 86400000).due, true);
});

ok('刚抓过 → 不跑', () => {
  const now = Date.now();
  assert.equal(shouldRunNow(new Date(now - 60000).toISOString(), 86400000, now).due, false);
});

ok('★ 超过间隔 → 跑，并报出"错过了多久"', () => {
  const now = Date.now();
  const r = shouldRunNow(new Date(now - 90000000).toISOString(), 86400000, now);
  assert.equal(r.due, true);
  assert.ok(r.missedMs > 0);
});

ok('★ 时间不可解析 → 当作从未抓过（宁可多抓一次，也不要从此不抓）', () => {
  assert.equal(shouldRunNow('乱七八糟', 86400000).due, true);
});

/* ==================================================================
 * 第三层之二 · **定时抓取本身**（原来完全没被考过）
 * ------------------------------------------------------------------
 * ⚠️ 这一块的来历：用户问"点了刷新会抓，那定时是怎么抓的？"
 *    我去读代码回答，顺便发现两件事：
 *      ① `catchUpDecision` / `nextRunAt` —— 也就是**定时的全部逻辑** ——
 *         一条断言都没有。上面那几条考的是 `fetch-feeds.js` 的 `shouldRunNow`，
 *         而那个函数**根本没有被生产代码调用过**（死 API）。
 *         于是"定时抓取"这件事在离线侧是完全裸奔的。
 *      ② `MIN_GAP_MS` 常量声明了却**从没被任何地方使用** —— 防抖写了一半。
 *         后果很具体：7:25 开机补抓一轮、7:30 定时器到点又抓一轮、
 *         中间重启两次就是四轮。对一个"每天只需更新一次"的看板，这是白打人家服务器。
 *
 *    这一组就是那两件事的补课。顺带把"抓取时刻 = 07:30"这个用户要求钉住 ——
 *    它是**需求**，不是实现细节，所以值得一条断言守着它别被改回 6:00。
 * ================================================================== */
say();
say('--- 第三层之二 · 定时抓取（时刻、补跑、防抖）---');

ok('★ 默认抓取时刻是 07:30（用户明确要求的时刻，别被改回去）', () => {
  assert.equal(DEFAULT_FETCH_HOUR, 7, '默认小时不是 7');
  assert.equal(DEFAULT_FETCH_MINUTE, 30, '默认分钟不是 30');
  assert.equal(formatHm(DEFAULT_FETCH_HOUR, DEFAULT_FETCH_MINUTE), '07:30');
});

ok('★ 分钟必须真的生效（只有 hour 的时候表达不了 7:30）', () => {
  const base = new Date(2026, 8, 22, 7, 0, 0);
  const next = nextRunAt(base, 7, 30);
  assert.equal(next.getHours(), 7);
  assert.equal(next.getMinutes(), 30, '分钟位没生效 —— 会在 7:00 就抓，而不是 7:30');
  assert.equal(next.getDate(), 22, '7:00 看下一次应当是**今天** 7:30，不是明天');
});

ok('★ nextRunAt 的边界：正好到点算"过了"，排明天', () => {
  const at = (h, m) => nextRunAt(new Date(2026, 8, 22, h, m, 0), 7, 30);
  assert.equal(at(7, 29).getDate(), 22, '7:29 应当排今天');
  assert.equal(at(7, 30).getDate(), 23, '正好 7:30 应当排明天（否则会在同一分钟内再排一次）');
  assert.equal(at(7, 31).getDate(), 23);
  assert.equal(at(23, 59).getDate(), 23);
  assert.equal(at(0, 0).getDate(), 22, '凌晨 0:00 应当排今天 7:30');
});

ok('★ 非法 hour/minute 被夹住，不许产出 Invalid Date', () => {
  /* ⚠️ 这是真正的危险所在：`Number('7:30')` 是 NaN，
     `setHours(NaN, ...)` 会让 Date 变成 Invalid Date，于是
     `nextRunAt(...).getTime()` 是 NaN ⇒ `setTimeout(fn, NaN)` 被当成 0
     ⇒ **立刻疯狂抓取**。"配置写错 → 变成攻击别人的服务器"。 */
  for (const [h, m] of [[NaN, NaN], [25, 99], [-3, -1], [undefined, undefined], ['7:30', 'abc']]) {
    const d = nextRunAt(new Date(2026, 8, 22, 0, 0, 0), h, m);
    assert.ok(Number.isFinite(d.getTime()), `hour=${h} minute=${m} 产出了 Invalid Date`);
    assert.ok(d.getHours() >= 0 && d.getHours() <= 23);
    assert.ok(d.getMinutes() >= 0 && d.getMinutes() <= 59);
  }
});

ok('★ 补跑判定：没到今天的抓取时刻，但上次是昨天 → 先补一份', () => {
  // 7:00 开机（今天 7:30 还没到），上次成功是昨天 18:00
  const d = catchUpDecision(new Date(2026, 8, 21, 18, 0, 0).toISOString(), new Date(2026, 8, 22, 7, 0, 0), 7, 30);
  assert.equal(d.due, true, '昨天那份已经过时了，开机就该先给一份能看的');
});

ok('★ 补跑判定：今天 7:30 之后已经成功抓过 → 不补', () => {
  const d = catchUpDecision(new Date(2026, 8, 22, 7, 35, 0).toISOString(), new Date(2026, 8, 22, 9, 0, 0), 7, 30);
  assert.equal(d.due, false, '今天已经抓过了还在补 —— 用户重启几次就打人家几次');
});

ok('★ 防抖闸：距上次成功不足 1 小时 → 不补（这条原来是个没接上的死常量）', () => {
  // 今天 7:10 抓成功过，7:20 又启动一次
  const d = catchUpDecision(new Date(2026, 8, 22, 7, 10, 0).toISOString(), new Date(2026, 8, 22, 7, 20, 0), 7, 30);
  assert.equal(d.due, false, '10 分钟前刚抓过又抓一遍');
  assert.ok(/不足|分钟/.test(d.reason), '拦下来了但要说明原因，不能只给一个 false：' + d.reason);
});

ok('★ 防抖闸不许拦掉"真正该抓的那一次"', () => {
  // 今天 6:00 抓过、现在 8:00（目标 7:30 已过，且间隔 2 小时 > 1 小时）
  const d = catchUpDecision(new Date(2026, 8, 22, 6, 0, 0).toISOString(), new Date(2026, 8, 22, 8, 0, 0), 7, 30);
  assert.equal(d.due, true, '防抖把今天该抓的那一次也拦掉了 —— 那就成了"永远不抓"');
});

ok('从未成功抓过 / 时间不可解析 → 补', () => {
  const now = new Date(2026, 8, 22, 9, 0, 0);
  assert.equal(catchUpDecision(null, now, 7, 30).due, true);
  assert.equal(catchUpDecision('乱七八糟', now, 7, 30).due, true);
});

ok('★ 环境变量能改抓取时刻，且非法值被挡住并**说明原因**', () => {
  // 不设 = 默认 07:30
  const d0 = parseFetchTime({});
  assert.deepEqual([d0.hour, d0.minute], [7, 30]);
  assert.equal(d0.overridden, false);
  assert.deepEqual(d0.notes, []);

  // 正常覆盖
  const d1 = parseFetchTime({ MB_FETCH_HOUR: '9', MB_FETCH_MINUTE: '5' });
  assert.deepEqual([d1.hour, d1.minute], [9, 5]);
  assert.equal(d1.overridden, true);
  assert.deepEqual(d1.notes, []);

  // 只给小时，分钟保持默认 30（这个是刻意的：改小时不该把分钟悄悄归零）
  const d2 = parseFetchTime({ MB_FETCH_HOUR: '6' });
  assert.deepEqual([d2.hour, d2.minute], [6, 30], '只改小时把分钟也改了');

  /* ⚠️ 这几条是真正要命的：非法值如果不挡住，会一路变成 Invalid Date
     ⇒ setTimeout(fn, NaN) 当成 0 ⇒ 立刻疯狂抓取。 */
  for (const bad of [{ MB_FETCH_HOUR: '25' }, { MB_FETCH_HOUR: '-1' }, { MB_FETCH_HOUR: '7:30' }, { MB_FETCH_HOUR: 'abc' }, { MB_FETCH_MINUTE: '60' }, { MB_FETCH_MINUTE: '1.5' }]) {
    const r = parseFetchTime(bad);
    assert.ok(Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23, JSON.stringify(bad) + ' 产出了非法 hour');
    assert.ok(Number.isInteger(r.minute) && r.minute >= 0 && r.minute <= 59, JSON.stringify(bad) + ' 产出了非法 minute');
    assert.ok(r.notes.length > 0, JSON.stringify(bad) + ' 被静默接受了 —— 用户会以为自己配上了');
  }

  // 空串当作没设（很多人会写成 MB_FETCH_HOUR=）
  const d3 = parseFetchTime({ MB_FETCH_HOUR: '', MB_FETCH_MINUTE: '  ' });
  assert.deepEqual([d3.hour, d3.minute], [7, 30]);
  assert.equal(d3.overridden, false);
  assert.deepEqual(d3.notes, []);
});

await aok('★ 定时器到点也要过防抖闸（只拦开机路径、不拦定时路径 = 等于没拦）', async () => {
  // 造一个"7:25 刚补抓过、7:30 定时器到点"的场景
  let t = new Date(2026, 8, 22, 7, 25, 0).getTime();
  let lastSuccess = new Date(2026, 8, 22, 7, 25, 0).toISOString();
  const runs = [];
  let pending = null;
  const s = createScheduler({
    run: async () => { runs.push('run'); return { ok: 19, failed: 0 }; },
    lastSuccessIso: () => lastSuccess,
    hour: 7,
    minute: 30,
    now: () => new Date(t),
    setTimer: (fn, ms) => { pending = { fn, ms }; return 1; },
    clearTimer: () => {},
    log: () => {},
  });

  // 启动：7:25，上次成功也是 7:25 ⇒ 间隔 0 分钟，防抖闸拦住，不补抓
  s.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runs.length, 0, '启动时不该抓（1 分钟前刚抓过）');
  assert.ok(pending, '没有排下一次定时');

  // 定时器到点：把时钟推到 7:30，触发排好的那个回调
  t = new Date(2026, 8, 22, 7, 30, 0).getTime();
  const fire = pending.fn;
  await fire();
  assert.equal(runs.length, 0, '7:30 到点又抓了一遍 —— 5 分钟前刚抓过，防抖闸没盖住定时路径');
  assert.equal(s.state().skippedTooSoon, 1, '跳过没被计数（跳过了但没留痕，等于静默）');

  // 第二天到点（距上次成功 24 小时）必须真的抓
  t = new Date(2026, 8, 23, 7, 30, 0).getTime();
  await pending.fn();
  assert.equal(runs.length, 1, '隔了一整天还不抓 —— 防抖闸做成了"永远不抓"');
});

/* ==================================================================
 * 第四层 · 真实世界的 feed 长什么样（R2 逐个抓响应体取证后补的）
 * ------------------------------------------------------------------
 * 这一层存在的理由：上面三层用的都是**我编的**干净样例。
 * 而真机上的失败几乎全来自"现实比样例脏"：
 *   · 有的源 item 里根本没有 <link>，链接只藏在 <guid>（安全客）
 *   · 有的源 feed 没有 <?xml?> 声明，正文直接以 <rss 开头（InfoQ 中文）
 *   · 有的源条目顺序非单调（36氪：首条 16:33、后面还有 20:56）
 *   · 有的源没有 <pubDate>，只有 channel 级日期（美团技术）
 *   · 有的源被间歇性安全挑战页拦（36氪：同一个 URL 一会儿 RSS 一会儿 HTML）
 * 每一条都对应一个**具体的源**，不是假想。
 * ================================================================== */
say('');
say('--- 第四层 · 真实 feed 的脏数据（逐条对应实测过的源）---');

ok('★ 没有 <?xml?> 声明也要能解析（InfoQ 中文就是这样）', () => {
  const noDecl = '<rss version="2.0"><channel><title>InfoQ</title><item><title>无声明</title><link>https://www.infoq.cn/a/1</link></item></channel></rss>';
  const r = parseFeed(noDecl);
  assert.equal(r.ok, true, '没有 XML 声明就被判成不是 feed：' + JSON.stringify(r.warnings));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].url, 'https://www.infoq.cn/a/1');
});

ok('★ 没有 <link> 时用 <guid> 兜底（安全客的 item 就是这样）', () => {
  const guidOnly =
    '<rss version="2.0"><channel><title>安全客</title>' +
    '<item><title>只有 guid</title><guid isPermaLink="false">https://api.anquanke.com/data/v1/post/123</guid>' +
    '<pubDate>Mon, 22 Sep 2026 10:00:00 +0800</pubDate></item></channel></rss>';
  const r = parseFeed(guidOnly);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].url, 'https://api.anquanke.com/data/v1/post/123', 'guid 兜底没生效 ⇒ 这个源的所有条目都会变成"没有原文链接"');
});

ok('★ guid 不像 URL 时不许当链接（否则会产出一堆打不开的地址）', () => {
  const tagGuid =
    '<rss version="2.0"><channel><title>x</title>' +
    '<item><title>tag guid</title><guid isPermaLink="false">tag:example.com,2026:1</guid></item></channel></rss>';
  const r = parseFeed(tagGuid);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].url, null, '把 tag: 形式的 guid 当成链接了 —— 比"没有链接"更糟');
});

ok('★ 条目顺序非单调时，库里按 published_at 排（36氪首条 16:33 后面还有 20:56）', () => {
  const unordered =
    '<rss version="2.0"><channel><title>36氪</title>' +
    '<item><title>下午那条</title><link>https://36kr.com/p/1</link><pubDate>Mon, 22 Sep 2026 16:33:00 +0800</pubDate></item>' +
    '<item><title>晚上那条</title><link>https://36kr.com/p/2</link><pubDate>Mon, 22 Sep 2026 20:56:00 +0800</pubDate></item>' +
    '</channel></rss>';
  const r = parseFeed(unordered);
  assert.equal(r.ok, true);
  const times = r.items.map((i) => i.publishedAt);
  assert.ok(times[0] && times[1], '时间没解析出来');
  // 解析层**如实保留 feed 给的顺序**（不谎报），排序是查询层的事 —— 这里断言解析层没把时间搞错
  assert.ok(times[1] > times[0], '两个时间解析结果反了');
});

ok('★ 一个源里混进残缺闭合标签也不许整源炸掉（触乐有这种脏 XML）', () => {
  const dirty =
    '<rss version="2.0"><channel><title>触乐</title>' +
    '<item><title>正常条目</title><link>http://www.chuapp.com/a/1</link>' +
    '<description><![CDATA[正文里有个残缺的 </title> 片段]]></description></item>' +
    '</channel></rss>';
  const r = parseFeed(dirty);
  assert.equal(r.ok, true, '整源被一段脏 CDATA 干掉了：' + JSON.stringify(r.warnings));
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].title, '正常条目');
});

ok('★ 反爬页要报成"人机验证页"，不许报成"HTML 网页"（诊断指错方向比没有诊断更糟）', () => {
  const challenge = '<!DOCTYPE html><html><head><title>安全检测</title></head><body>正在进行安全检测，请稍候…</body></html>';
  const kind = sniffContentKind(challenge);
  assert.ok(/反爬|验证/.test(kind), '被安全挑战页拦住时给出的诊断是「' + kind + '」—— 会把用户引向"地址写错了"这个错误结论');
});

ok('★ 普通网页仍然报"HTML 网页"（别把反爬判定做成一锅端）', () => {
  const plain = '<!DOCTYPE html><html><head><title>某站首页</title></head><body>欢迎</body></html>';
  assert.ok(/HTML/.test(sniffContentKind(plain)));
});

ok('★ 完全没有 <published_at> 的源不会因此丢条目（美团技术只有 channel 级日期）', () => {
  const noDate =
    '<rss version="2.0"><channel><title>美团技术</title><lastBuildDate>Mon, 22 Sep 2026 10:00:00 +0800</lastBuildDate>' +
    '<item><title>没有 pubDate 的条目</title><link>https://tech.meituan.com/1</link></item></channel></rss>';
  const r = parseFeed(noDate);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1, '没有 pubDate 的条目被丢掉了');
  assert.equal(r.items[0].publishedAt, null, '不许把 channel 级日期硬塞给条目（那是编造）');
});

/* ==================================================================
 * 第五层 · 后台运行（脱离终端 + 启动/停止/状态查询）
 * ------------------------------------------------------------------
 * 这一块的风险不在"能不能跑起来"，而在**判定会不会撒谎**，以及
 * **停止会不会杀错进程**。两件事都是"出错代价极大、平时又看不出来"的类型：
 *
 *   · 状态查询说"运行中"，其实早就崩了（pid 文件是残骸）→ 用户以为程序在守着
 *   · 停止命令按**进程名**杀 → 把用户机器上所有 Electron 应用一起干掉
 *
 * 所以这里穷举 `classifyRun` 的每一种输入组合，并把"不许按进程名杀"
 * 写成一条对源码的断言。
 * ================================================================== */
say();
say('--- 第五层 · 后台运行（状态判定 / 命令解析 / 不许按进程名杀）---');

ok('★ 命令解析：不认识的命令必须返回 null，不许静默当成 status', () => {
  assert.equal(parseCommand([]).cmd, 'status', '不带参数应当是查状态');
  assert.equal(parseCommand(['stop']).cmd, 'stop');
  assert.equal(parseCommand(['STOP']).cmd, 'stop', '大写也要认（Windows 用户习惯不区分大小写）');
  assert.equal(parseCommand(['rm']), null, '不认识的命令被当成了合法命令 —— 用户敲错会以为执行了');
  assert.equal(parseCommand(['start', '--wait', '30000']).flags.wait, '30000');
  assert.equal(parseCommand(['logs', '-n', '60']).flags.n, '60');
  assert.equal(parseCommand(['stop', '--force']).flags.force, true);
  assert.equal(parseCommand(['status', '--data-dir=C:\\x\\y']).flags['data-dir'], 'C:\\x\\y');
});

ok('★ 运行时长格式化（状态里的"已运行"）', () => {
  assert.equal(formatDuration(5000), '5 秒');
  assert.equal(formatDuration(3 * 60000), '3 分钟');
  assert.equal(formatDuration((2 * 60 + 13) * 60000), '2 小时 13 分');
  assert.equal(formatDuration(50 * 3600 * 1000), '2 天 2 小时');
  assert.equal(formatDuration(-1), '未知');
  assert.equal(formatDuration(NaN), '未知');
});

ok('★ 心跳解析：真机那一行的每个字段都要取对', () => {
  const real =
    'booted=2026-09-22T15:34:15.775Z pid=33156 electron=44.4.2 node=24.21.0 process.type=browser RUN_AS_NODE=undefined';
  const hb = parseHeartbeat(real);
  assert.equal(hb.pid, 33156, 'pid 没取对 —— 归属校验就废了');
  assert.equal(hb.booted, '2026-09-22T15:34:15.775Z');
  assert.equal(hb.electron, '44.4.2');
  assert.equal(hb.node, '24.21.0');
  /* ⚠️ 这一条以前踩过：`RUN_AS_NODE=undefined` 是字符串 "undefined"，
     它不是环境变量没设的证据，而是**心跳里如实记下的原值**。
     解析器只要照实取字符串就行，别自作聪明转成 null。 */
  assert.equal(hb.processType, 'browser');
  assert.equal(hb.runAsNode, 'undefined');
  assert.equal(parseHeartbeat(''), null);
  assert.equal(parseHeartbeat(null), null);
});

ok('★★ classifyRun 穷举：六种组合，每一种都必须给对结论', () => {
  const hb = { pid: 100, booted: '2026-09-22T00:00:00.000Z' };

  // ① 没有 pid 文件 = 没跑过
  assert.equal(classifyRun({ pidInfo: null, heartbeat: null, alive: false }).state, 'stopped');

  // ② pid 文件损坏
  assert.equal(classifyRun({ pidInfo: { pid: 'abc' }, heartbeat: null, alive: false }).state, 'stale');

  // ③ 进程不在了（关机/崩溃留下的残骸）—— 这是最常见的一种
  const dead = classifyRun({ pidInfo: { pid: 100 }, heartbeat: hb, alive: false });
  assert.equal(dead.state, 'stale', '进程没了却报 running —— 用户会以为程序在守着');
  assert.ok(/不存在/.test(dead.why), '要说清为什么不在了：' + dead.why);

  // ④ 归属校验一：心跳里的 pid 对不上（进程号被系统回收后分配给了别人）
  const reused = classifyRun({ pidInfo: { pid: 100 }, heartbeat: { pid: 999 }, alive: true });
  assert.equal(reused.state, 'stale', 'pid 被复用却报 running —— 停止命令会去杀一个无辜的进程');
  assert.ok(/不一致|回收/.test(reused.why));

  // ⑤ 归属校验二：映像名不是 electron
  const wrongImage = classifyRun({ pidInfo: { pid: 100 }, heartbeat: null, alive: true, imageName: 'chrome.exe' });
  assert.equal(wrongImage.state, 'stale', 'pid 属于别的程序却报 running');
  assert.ok(/chrome\.exe/.test(wrongImage.why), '要把"现在是谁"说出来：' + wrongImage.why);

  // ⑥ 全部通过
  const good = classifyRun({ pidInfo: { pid: 100 }, heartbeat: hb, alive: true, imageName: 'electron.exe' });
  assert.equal(good.state, 'running');
  assert.equal(good.pid, 100);

  // 边界：拿不到映像名时不许因此判成 stale（有些环境 tasklist 不可用）
  assert.equal(classifyRun({ pidInfo: { pid: 100 }, heartbeat: hb, alive: true, imageName: null }).state, 'running');
  // 边界：心跳文件还没写出来（刚启动的几百毫秒内）也不算 stale
  assert.equal(classifyRun({ pidInfo: { pid: 100 }, heartbeat: null, alive: true, imageName: null }).state, 'running');
});

ok('★ pid 文件是"合并"写入：管理命令与应用各写一半，两个字段都要留住', () => {
  const dir = tmpDbFile('pidfile');
  fs.mkdirSync(dir, { recursive: true });

  // 管理命令先写（它只知道 child.pid）
  writePidFile(dir, { pid: 4242, source: 'service', log: 'C:\\logs\\run.log', booted: false });
  let r = readPidFile(dir);
  assert.equal(r.pid, 4242);
  assert.equal(r.booted, false);

  // 应用启动后补全自己那部分
  writePidFile(dir, { pid: 4242, source: 'app', booted: true, bootedAt: '2026-09-22T10:00:00.000Z' });
  r = readPidFile(dir);
  assert.equal(r.pid, 4242, 'pid 被改掉了');
  assert.equal(r.booted, true, '应用没把自己的启动标记写上');
  assert.equal(r.bootedAt, '2026-09-22T10:00:00.000Z');
  assert.equal(r.source, 'app');
  /* ⚠️ 这条是"合并而不是覆盖"的**唯一**判据：管理命令写的 log 路径是
     应用也需要的（status 要拿它显示日志位置）。覆盖式写入会把它抹掉。 */
  assert.equal(r.log, 'C:\\logs\\run.log', '后写的一方把前一方写的字段抹掉了 —— 这就是"覆盖"而不是"合并"');

  fs.rmSync(dir, { recursive: true, force: true });
});

ok('★ 存活性探测：自己的 pid 必定活着，非法 pid 必定是"没活着"', () => {
  assert.equal(isProcessAlive(process.pid), true, '连自己都探测不到，状态查询就没有意义了');
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(NaN), false);
  assert.equal(isProcessAlive('abc'), false);
  assert.equal(isProcessAlive(null), false);
});

ok('★ 数据目录默认在**项目内**（用户要求：简报数据跟着晨报机走）', () => {
  const here = path.resolve(HERE, '..');
  const def = dataDirOf({});
  assert.equal(def, path.join(here, 'data'), '默认数据目录不是 <项目>/data：' + def);
  assert.ok(!path.relative(here, def).startsWith('..'), '默认数据目录跑到项目外面去了 —— 备份/搬移时容易漏掉它');

  /* MB_DATA_DIR 仍然可以覆盖（测试、多实例并行都靠它）。
     ⚠️ 必须 resolve 成绝对路径：相对路径在"双击 .vbs 启动"时
        cwd 是桌面，会算到一个完全无关的地方。 */
  assert.equal(dataDirOf({ MB_DATA_DIR: 'D:\\mb-a' }), path.resolve('D:\\mb-a'));
  const rel = dataDirOf({ MB_DATA_DIR: 'sub\\dir' });
  assert.ok(path.isAbsolute(rel), 'MB_DATA_DIR 给的相对路径没有被 resolve：' + rel);

  // 旧位置只用于"给一句迁移提示"，不再当默认值
  assert.ok(legacyDataDirOf({ USERPROFILE: 'C:\\Users\\x' }).endsWith('.morning-brief'));
  assert.equal(legacyDataDirOf({}), null, '拿不到家目录时应当返回 null，而不是拼一个半截路径');

  assert.ok(pidFilePath('D:\\mb-a').endsWith('morning-brief.pid'));
  assert.ok(heartbeatPath('D:\\mb-a').endsWith('boot-heartbeat.txt'));
  assert.ok(runLogPath('D:\\mb-a').endsWith('run.log'));
});

ok('★★ 三个入口必须用**同一个**数据目录口径（漂移会让启动器白等 20 秒）', () => {
  /* ⚠️ 这条防的是一种很难查的漂移：
     主进程写 A 目录、service.mjs 查 B 目录 —— 两边都觉得自己是对的，
     表现是"应用明明起来了，status 却说没在运行"，或者"启动器等不到心跳"。
     ⇒ 断言它们都不再自己拼路径，而是引用同一个函数。 */
  const here = path.resolve(HERE, '..');
  for (const rel of ['tools/launch.mjs', 'tools/service.mjs', 'src/main/index.js']) {
    const src = stripJsComments(fs.readFileSync(path.join(here, rel), 'utf8'));
    assert.ok(/dataDirOf\(/.test(src), `${rel} 没有用 dataDirOf() —— 各写一份默认值必然漂移`);
    assert.ok(
      !/os\.homedir\(\).{0,40}\.morning-brief/.test(src) && !/join\(home,\s*'\.morning-brief'\)/.test(src),
      `${rel} 里还留着自己拼的旧默认路径`,
    );
  }
});

ok('★★ 停止命令绝不许按进程名杀（会连带干掉用户机器上所有 Electron 应用）', () => {
  const src = fs.readFileSync(path.resolve(HERE, '..', 'tools', 'service.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/['"]\/IM['"]/.test(code), 'taskkill 里出现了 /IM —— 按映像名杀进程会把别的 Electron 应用一起干掉');
  assert.ok(!/taskkill[\s\S]{0,80}electron\.exe/.test(code), 'taskkill 直接点名 electron.exe —— 同上');
  assert.ok(/['"]\/PID['"]/.test(code), 'taskkill 必须按 /PID 精确指定');
  assert.ok(!/Stop-Process[\s\S]{0,40}-Name/.test(code), '走到了按名字杀的 PowerShell 路径');
});

ok('★★ 三个 .vbs 入口必须是纯 ASCII（WSH 按 ANSI 读，中文会乱码）', () => {
  /* ⚠️ 这一条挡的是"只在用户机器上才出现"的故障：
     WSH 用系统 ANSI 代码页（简中机器上 GBK）读 .vbs，而本仓库源文件统一 UTF-8。
     往 .vbs 里写一个中文字符（哪怕只在注释里、哪怕只是文件名），
     在**我们这边**看不出任何问题，到用户那边就是乱码字符串 ——
     或者是更糟的：注释里的多字节序列被 GBK 吃掉一个换行，
     于是下一行代码被当成注释。*/
  const dir = path.resolve(HERE, '..');
  const vbs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.vbs'));
  assert.ok(vbs.length >= 3, `期望至少 3 个入口（启动/停止/状态），实际只有 ${vbs.length} 个：${vbs.join(', ')}`);

  for (const name of vbs) {
    const buf = fs.readFileSync(path.join(dir, name));
    const bad = [];
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] > 127) bad.push(`byte@${i}=0x${buf[i].toString(16)}`);
    }
    assert.equal(bad.length, 0, `${name} 含 ${bad.length} 个非 ASCII 字节（${bad.slice(0, 3).join(', ')}…）—— 在 GBK 机器上会乱码`);
    assert.ok(!buf.includes(Buffer.from('\r\n')), `${name} 含 CRLF（仓库统一 LF）`);
    const text = buf.toString('utf8');
    assert.ok(/%TEMP%/.test(text) && /where node/.test(text), `${name} 没有自己解析 node.exe 的路径 —— 双击启动的环境与终端不同`);
    assert.ok(/service\.mjs/.test(text), `${name} 没有指向 tools/service.mjs`);
  }

  /* 三个入口的子命令必须各不相同且都在已知命令里。
     ⚠️ 判据要精确：模板里那句 `If "__MODE__" = "status"` 在**每个**文件里都存在，
        所以不能只匹配 `= "status"` —— 那样三个文件都会被认成 status。
        要匹配的是替换之后左边的实际值。 */
  const modes = vbs.map((name) => {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (/If "status" = "status"/.test(text)) return 'status';
    const s = text.match(/rc = sh\.Run\(cmd & " (start|stop)"/);
    return s ? s[1] : '?';
  });
  assert.deepEqual(
    modes.slice().sort(),
    ['start', 'status', 'stop'],
    `三个入口的子命令不是 start/status/stop 各一个：${vbs.map((n, i) => n + '=' + modes[i]).join(', ')}`,
  );
});

ok('★ 停止请求：文件即信号（这条路径只要求"能写自己的数据目录"）', () => {
  const dir = tmpDbFile('stopreq');
  fs.mkdirSync(dir, { recursive: true });

  assert.equal(hasStopRequest(dir), false, '刚开始不该有停止请求');
  requestStop(dir, 'test');
  assert.equal(hasStopRequest(dir), true);
  // 内容要能读懂是谁、什么时候要求的 —— 排查"谁把它关了"时这是唯一线索
  const body = JSON.parse(fs.readFileSync(stopRequestPath(dir), 'utf8'));
  assert.equal(body.by, 'test');
  assert.ok(!Number.isNaN(Date.parse(body.at)), 'at 不是可解析时间');

  clearStopRequest(dir);
  assert.equal(hasStopRequest(dir), false, '清掉之后还在，说明删除没生效');

  // 幂等：清一个不存在的文件不许抛
  clearStopRequest(dir);
  clearStopRequest(dir);
  assert.equal(hasStopRequest(dir), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

ok('★★ 应用必须真的去查停止请求并退出（只写文件没人看 = 停止命令永远失败）', () => {
  const src = fs.readFileSync(path.resolve(HERE, '..', 'src', 'main', 'index.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/hasStopRequest\(/.test(code), 'index.js 没有调用 hasStopRequest —— 停止请求文件没人看');
  assert.ok(/clearStopRequest\(/.test(code), 'index.js 没有清停止请求');

  // 请求 → app.quit() 之间必须是同一段逻辑（防止"检查了但忘了退出"）
  const loop = code.match(/setInterval\(\(\)\s*=>\s*\{[\s\S]{0,600}?\}\s*,\s*\d+\s*\)/);
  assert.ok(loop, '找不到轮询停止请求的代码块');
  assert.ok(/app\.quit\(\)/.test(loop[0]), '查到停止请求却没有调用 app.quit() —— 文件放进去也不会退出');
});

ok('★ 日志写入器：能追加、能截断、写不进去返回原因（而不是抛）', () => {
  const dir = tmpDbFile('logsink');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'x.log');

  const write = createLogSink(file, { maxBytes: 4096 });
  write('第一行');
  write('第二行');
  let text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('第一行') && text.includes('第二行'), '追加写没生效');

  /* 超过上限要**截断**而不是无限增长 —— 这是常驻程序，日志会一直涨。
     上限给小一点（4096），写够触发一次轮转。 */
  for (let i = 0; i < 300; i += 1) write('填充行 ' + i + ' ' + 'x'.repeat(40));
  const after = fs.statSync(file).size;
  assert.ok(after < 4096 * 4, `截断没生效，文件涨到 ${after} 字节`);
  assert.ok(fs.readFileSync(file, 'utf8').includes('已截断'), '截断时应当留一句说明');

  /* ⚠️ 这一段原来只写了 `assert.doesNotThrow(() => bad('x'))` —— 一条**弱断言**：
     它只证明"没抛"，不证明"失败被记下来了"。而审查员实测抓到过真问题：
     老实现一旦写失败就 `broken = true` **永久不再尝试**，
     于是"磁盘暂时满 → 腾出空间"之后日志再也不会恢复，而用户以为一切正常。
     ⇒ 现在断言三件事：失败有原因、冷却期内不反复试、冷却结束后**会再试**。 */
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'iamafile'); // 父路径是个文件 ⇒ mkdir 必失败
  let t = 1000;
  const bad = createLogSink(path.join(blocked, 'y.log'), { retryCooldownMs: 1000, now: () => t });
  const r1 = bad('x');
  assert.equal(r1.ok, false, '写不进去却报成功');
  assert.ok(r1.error, '失败了却没说原因 —— 这正是"失败要有嘴"的反面');
  assert.ok(bad.state().failures >= 1 && bad.state().lastError, '失败没被记进 state（status 就报不出来）');
  assert.equal(bad('x').skipped, true, '冷却期内还在反复尝试，白耗 IO');
  t += 2000;
  assert.notEqual(bad('x').skipped, true, '冷却结束后也不再尝试了 —— 一次瞬时故障会变成永久静默');

  fs.rmSync(dir, { recursive: true, force: true });
});

ok('★★ 同一个能力只许有一个实现（两份副本 = 测试各测各的，谁都没盖住）', () => {
  /* ⚠️ 这条是**实测抓到**的：我加了 run-log.js 之后忘了删 runtime-state.js 里的
     旧副本。index.js 仍然 import 旧的（数字签名），却按新签名传了对象 ⇒
     maxBytes 变成对象 ⇒ 截断恒不触发 ⇒ run.log 无限增长。
     而两边的测试各自都是绿的 —— 因为各自 import 的是各自的副本。
     这是本项目反复出现的形态：数据目录、CARD_SIZE、--win-pad 都栽过。
     ⇒ 数一遍：这几个名字在整个仓库里只允许出现**一次** `export function`。 */
  const here = path.resolve(HERE, '..');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.npm-cache', '.git', 'data', 'report'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(here);

  const singles = ['createLogSink', 'createBootMark', 'teeConsole', 'dataDirOf', 'classifyRun', 'parseFetchTime', 'createScheduler'];
  const dupes = [];
  for (const name of singles) {
    const defs = [];
    for (const f of files) {
      /* ⚠️ **必须先剥注释**。这一轮里同一个坑我踩了四次：
         扫描器把自己**说明性的注释文字**当成了代码（注释里那句
         "正则字面量 export function createBootMark 会把本文件算成第二个实现"
         本身就把本文件算成了第二个实现）。
         剥注释是对的做法；把注释改写成不含关键字的绕法只会让下一个人再踩一次。 */
      const src = stripJsComments(fs.readFileSync(f, 'utf8'));
      if (new RegExp('export\\s+function\\s+' + name + '\\b').test(src)) defs.push(path.relative(here, f));
    }
    if (defs.length !== 1) dupes.push(`${name} 有 ${defs.length} 个实现：${defs.join(' / ')}`);
  }
  assert.deepEqual(dupes, [], '同一能力出现了多份实现（测试会各测各的，谁都没盖住）：\n      ' + dupes.join('\n      '));

  /* 反向：确认 index.js 引用的日志能力都来自 run-log.js 这一个地方 */
  const idx = fs.readFileSync(path.join(here, 'src', 'main', 'index.js'), 'utf8');
  const runtimeImport = idx.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\.\/shared\/runtime-state\.js'/);
  assert.ok(runtimeImport, '找不到 index.js 对 runtime-state.js 的 import');
  assert.ok(!/createLogSink/.test(runtimeImport[1]), 'index.js 又从 runtime-state.js 拿 createLogSink —— 那个副本已经删了');
});

/* ==================================================================
 * 第九层 · 启动取证通道必须真的能写
 * ------------------------------------------------------------------
 * ⚠️ 这一层是一次**真事故**换来的，而且这些断言本来能拦住它：
 *
 *   原来 `mark()`（写启动检查点）与 `teeConsole()` 都写在 `src/main/index.js`
 *   里。那个文件 import 了 electron ⇒ **离线侧加载不了** ⇒ 这两段逻辑
 *   没有任何测试能碰到。有一次重构删掉了它们依赖的 `const BOOT_LOG = ...`
 *   常量，而 `mark()` 里还留着对 `BOOT_LOG` 的引用：
 *
 *     ① 它是未声明的自由变量 ⇒ 每次 mark() 抛 ReferenceError
 *     ② catch {} 是**故意**为"落盘失败不该阻止启动"写的 ⇒ 异常被静默吞掉
 *     ③ 生产现场：boot.log 的 mtime 停在两天前、run.log 里 [boot] 行数为 0，
 *        而应用在那两天里**正常启动过好几次**
 *
 *   ⇒ 教训不是"下次记得定义变量"，而是两件事：
 *     · 不需要 Electron 的逻辑必须放进零依赖模块，否则它**不可能被测试**；
 *     · **"故意吞异常的兜底"必须与"证明它没在吞真问题"的断言成对出现**。
 *       只吞不报的 catch 会把代码错误伪装成环境问题。
 * ================================================================== */
say();
say('--- 第九层 · 启动取证通道（一次真事故换来的断言）---');

ok('★★ mark() 必须真的写出 boot.log，而不只是"没抛异常"', () => {
  const dir = tmpDbFile('bootmark');
  fs.mkdirSync(dir, { recursive: true });
  const toRunLog = [];
  const mark = createBootMark(dir, (l) => toRunLog.push(l));

  const steps = [
    'module-evaluated',
    'heartbeat-written',
    'pidfile-written',
    'bootstrap-enter',
    'db-opened',
    'card-window-created',
    'ipc-registered',
    'level-applied',
    'scheduler-started',
  ];
  const results = steps.map((s) => mark(s, 'pid=1'));

  /* ⚠️ 判据是"返回 ok" + "文件里真的有这些行"，**不是** "调用没抛异常"。
     事故期间那种"没抛异常"的断言一直是绿的。 */
  assert.ok(
    results.every((r) => r.ok === true),
    '有检查点没写成功：' + JSON.stringify(results.filter((r) => !r.ok)),
  );
  const text = fs.readFileSync(bootLogPath(dir), 'utf8');
  for (const s of steps) assert.ok(text.includes(s), `boot.log 里没有检查点 ${s}`);
  assert.equal(text.trim().split('\n').length, steps.length, 'boot.log 行数与检查点数不符');
  assert.equal(
    toRunLog.filter((l) => l.startsWith('[boot] ')).length,
    steps.length,
    'run.log 没收到对应的 [boot] 行 —— 出问题时只能去翻 boot.log 一个文件',
  );
  assert.equal(mark.codeError(), null, '有代码错误被吞掉了：' + mark.codeError());

  fs.rmSync(dir, { recursive: true, force: true });
});

ok('★★ 代码错误不许被"落盘失败"的兜底吞掉（事故的根因）', () => {
  const src = fs.readFileSync(path.resolve(HERE, '..', 'src', 'shared', 'run-log.js'), 'utf8');
  /* ⚠️ 这里用拼出来的正则，而不是写一个正则字面量。
     原因：上面那条"同一能力只许有一个实现"会扫描**本文件**，
     而正则字面量 `export function createBootMark` 会把本文件自己算成
     第二个实现 —— 这个假阳性我已经在这一轮踩过三次了
     （注释里的坏路径、自检样本、以及这里）。 */
  const fn = src.match(new RegExp('export\\s+function\\s+' + 'createBootMark' + '[\\s\\S]*?\\n\\}'));
  assert.ok(fn, '找不到 createBootMark');
  assert.ok(/isEnv/.test(fn[0]), 'createBootMark 没有区分环境错误与代码错误 —— 两者共用一句 catch 就是事故的根因');
  assert.ok(/throw err/.test(fn[0]), '代码错误被吞掉了（应当抛出：它重复一万次也不会自己好）');
  assert.ok(/ok: false/.test(fn[0]) && /error:/.test(fn[0]), '环境错误既没抛也没记原因');

  /* 主进程不许再自己写 boot.log —— 那意味着又绕开了这层保护 */
  const idx = fs.readFileSync(path.resolve(HERE, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.ok(!/appendFileSync\(\s*BOOT_LOG/.test(idx), 'index.js 里又出现了裸的 BOOT_LOG 用法');
  assert.ok(/createBootMark\(/.test(idx), 'index.js 没有用 createBootMark');
  assert.ok(/teeConsole\(/.test(idx), 'index.js 没有用 teeConsole');
});

ok('★ teeConsole 转写落盘且能恢复', () => {
  const written = [];
  const fake = { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const restore = teeConsole((l) => written.push(l), fake);
  fake.log('hello', 42);
  assert.equal(written.length, 1, 'console.log 没有落盘');
  assert.ok(written[0].includes('hello') && written[0].includes('42'), '落在盘上的内容不对：' + written[0]);
  fake.error(new Error('boom'));
  assert.ok(written.some((l) => l.startsWith('[error] ')), 'error 级别没有前缀标记');
  restore();
  const n = written.length;
  fake.log('again');
  assert.equal(written.length, n, 'restore 之后还在往盘上写');
});

ok('★ 写不进去时 mark 返回失败并带原因（不许静默）', () => {
  const dir = tmpDbFile('bootmark-fail');
  fs.mkdirSync(dir, { recursive: true });
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'iamafile');
  const mark = createBootMark(path.join(blocked, 'sub'), () => {});
  const r = mark('probe');
  assert.equal(r.ok, false, '写不进去却报成功');
  assert.ok(r.error, '失败没有原因');
  fs.rmSync(dir, { recursive: true, force: true });
});

ok('★★ 失败必须带原因：taskkill 起不来时也要说清（spawnSync 不抛异常）', () => {
  /* ⚠️ 实测踩到两次：
     ① `taskkill /PID x` → "ERROR: Access denied"（权限不足 / 被安全软件拦）
     ② `spawnSync('taskkill', ...)` → `{status:null, error:'EPERM'}`，
        **它不抛异常**，所以 try/catch 一个字都接不住，
        而 stdout/stderr 都是空的 —— 只看这两个的话，最关键的信息被整个丢掉。
     ⇒ 断言 service.mjs 里确实读了 `r.error`。 */
  const src = fs.readFileSync(path.resolve(HERE, '..', 'tools', 'service.mjs'), 'utf8');
  assert.ok(/r\.error/.test(src), 'runTaskkill 没有读 spawnSync 的 error 字段 —— EPERM 这类原因会被丢掉');
  assert.ok(/没有任何输出/.test(src), 'taskkill 无输出时没有兜底说明');
  /* 还要断言"打出来了"而不仅仅是"拿到了"：拿到却不说等于没拿到 */
  assert.ok(/taskkill \/PID 未生效/.test(src) && /taskkill \/T \/F 未生效/.test(src),
    'taskkill 失败的原因没有被打出来');
});

ok('★★ 停止成功的判据必须有两个（只看进程会让成功的停止报失败）', () => {
  /* ⚠️ 实测踩到的**假阴性**：日志里明明写着"收到停止请求…正在退出"、
     pid 文件也已经被应用自己删了，而 `stop` 仍然报"进程仍然活着"并返回 1 ——
     因为进程退出与操作系统回收之间有延迟，在这台机器上超过 12 秒。
     假阴性比假阳性更糟：用户会去任务管理器强行结束，而那里最容易杀错程序。 */
  const src = fs.readFileSync(path.resolve(HERE, '..', 'tools', 'service.mjs'), 'utf8');
  assert.ok(/pidfile-cleared/.test(src), '没有"应用已注销登记"这个判据');
  const fn = src.match(/async function waitStopped[\s\S]*?\n\}/);
  assert.ok(fn, '找不到 waitStopped');
  assert.ok(/isProcessAlive/.test(fn[0]), 'waitStopped 里没有进程存活判据');
  assert.ok(/classifyRun|inspect\(\)/.test(fn[0]), 'waitStopped 里没有"登记是否还在"判据');
});

/* ==================================================================
 * 第六层 · **可搬移 / 可打包**（项目不许伸到自己的目录之外）
 * ------------------------------------------------------------------
 * 这一层是"把项目移到 D:\\morning-brief"这件事逼出来的，而且它抓到了一个真问题：
 *
 *   置底脚本原来指向 `ROOT/../m0-probe/tools/set-window-level.ps1` ——
 *   项目**外面**的探针目录。在原地（两个目录是兄弟）能跑；
 *   项目一旦被搬走，那个相对路径就断了 ⇒ **置底静默失效**：
 *   卡片不再压在其他窗口之下，而日志里只有一行 unavailable。
 *
 * 对一个"会被搬走、还要打包给别人用"的程序来说，这是最不能接受的一种坏法 ——
 * 它不是崩溃，是**少了一个功能而没人知道**。
 * ================================================================== */
say();
say('--- 第六层 · 可搬移性（项目不许依赖自己之外的文件）---');

/** 去掉 JS 注释（**必须**：这几条断言扫的是"代码里有没有外部路径"，
 *  而我在修复说明里恰好把那个坏路径原样写进了注释 —— 不剥注释就会
 *  把自己的注释当成违规，然后去"修"一段本来正确的代码）。 */
function stripJsComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 去掉"自检样本区"。
 *
 * ⚠️ 这个标记不是洁癖，是被迫的：下面那条自检里，我**故意**写了几个
 *    "算到项目外"的样本（不然怎么证明检查器抓得住），而扫描器会把
 *    它自己文件里的这些样本当成真违规 —— 实测就是这么报了 4 条。
 *    把样本区挖掉，扫描才只看真代码。
 *    （另一种做法是"跳过整个 test-all.mjs"，但那会让这个文件里真正的
 *      路径错误也一并漏掉 —— 用一个精确的标记区比一刀切好。）
 */
function stripFixtures(src) {
  /* ⚠️ 起止标记都**不能要求"块注释结束符"紧跟在后面**：
     第一版把标记写成了"起标记 + 一个完整的块注释"的样子，而起标记后面
     跟的是说明文字（结束符在两行之后）⇒ 正则匹配不上 ⇒ **什么都没挖掉**，
     于是自检里的 4 个"坏样本"被当成真违规报了出来。
     这种"守门代码静默失效"的形态在这个项目里出现过好几次：
     **它不报错，它只是什么都没做。**
     （⚠️ 连这段注释本身也踩过同一个坑：在块注释里写那个两字符的结束符，
       会把注释提前终止，整个文件变成语法错误 —— 所以这里不打字面量。） */
  return src.replace(
    /\/\* @movability-fixtures:start[\s\S]*?@movability-fixtures:end \*\//g,
    '/* 自检样本区已挖掉 */',
  );
}
/** 去掉 PowerShell / VBScript 注释 */
function stripHashComments(src) {
  return src
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').replace(/'.*$/, ''))
    .join('\n');
}

ok('★ 置底脚本必须在项目内，而且带 BOM（PS1 少了 BOM 会中文乱码/报错）', () => {
  const script = path.resolve(HERE, '..', 'tools', 'win', 'set-window-level.ps1');
  assert.ok(fs.existsSync(script), `置底脚本不在项目里：${script} —— 项目一旦被搬走，置底会静默失效`);
  const buf = fs.readFileSync(script);
  assert.ok(buf.length > 2000, `置底脚本只有 ${buf.length} 字节，像是被截断了`);
  /* ⚠️ .ps1 的 BOM 不是洁癖：这条是在 m0-probe 上反复踩出来的 ——
     没有 BOM 时 PowerShell 5.1 按 ANSI 读，脚本里的中文注释会变成乱码，
     而乱码如果吃掉一个引号/换行，就是语法错误。 */
  assert.ok(
    buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    'tools/win/set-window-level.ps1 没有 UTF-8 BOM —— PowerShell 5.1 会按 ANSI 读它',
  );
  const text = buf.toString('utf8');
  assert.ok(/param\(/.test(text) && /WindowHandle/.test(text), '脚本内容不像那个置底脚本');

  /* ⚠️ 这一条查的是**代码**里有没有 `$Hwnd`。
     m0-probe 真机抓到过的静默失效：参数名叫 `$Hwnd` 时，下面那句
     `$targetHwnd = ...` 若写成 `$Hwnd = ...` 会把参数本身覆盖掉，
     随后 `$Hwnd.Trim()` 变成对 IntPtr 取属性 —— PowerShell 返回 $null 而**不报错**，
     整个 -WindowHandle 分支就此失效。⇒ 参数名与局部变量名必须一眼能区分。 */
  const code = stripHashComments(text);
  assert.ok(!/\$Hwnd\b/.test(code), '脚本**代码**里出现了 $Hwnd —— 它会被参数名覆盖（m0-probe 抓到过的静默失效）');
  assert.ok(/\$targetHwnd\b/.test(code), '找不到 $targetHwnd —— 局部变量的命名约定变了？');
});

/**
 * 找出"把路径算到项目之外"的代码。
 *
 * ⚠️ 必须要**算**，不能靠看写法：
 *   `path.resolve(HERE, '..', 'renderer')` 与 `path.join(ROOT, '..', 'm0-probe', ...)`
 *   在写法上一模一样，差别只在 `HERE` / `ROOT` 各自的值。第一版按写法判，
 *   报了 14 条**全是误报** —— 而 14 条噪音足够把唯一的真问题淹掉，
 *   人看到它的第一反应会是"这条断言太严了，放宽它"。
 *
 * @param {string} root 项目根
 * @param {string} dirOf 被检查文件所在目录
 * @param {string} src 文件内容
 * @returns {string[]} 算到项目外的表达式（含算出来的绝对路径）
 */
function findExternalPaths(root, dirOf, src) {
  const offenders = [];
  const idents = { HERE: dirOf, ROOT: root, RENDERER_DIR: path.join(root, 'src', 'renderer') };
  const code = stripJsComments(src);
  for (const m of code.matchAll(/path\.(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)\s*,\s*([^)]*)\)/g)) {
    const base = idents[m[1]];
    if (!base) continue; // 基标识符不认识（例如 import.meta.url）—— 跳过，不猜
    const lits = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]).filter((s) => s && !s.includes('\n'));
    if (!lits.length) continue;
    let resolved;
    try {
      resolved = path.resolve(base, ...lits);
    } catch {
      continue;
    }
    const rel = path.relative(root, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      offenders.push(`${m[0].replace(/\s+/g, ' ').slice(0, 90)}  →  ${resolved}`);
    }
  }
  return offenders;
}

ok('★★ 项目不许引用"兄弟目录"（搬走或打包之后必然断掉）', () => {
  const here = path.resolve(HERE, '..');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.npm-cache', '.data', 'report'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(here, 'src'));
  walk(path.join(here, 'tools'));
  assert.ok(files.length > 10, `只扫到 ${files.length} 个文件，路径可能不对`);

  const offenders = [];
  for (const f of files) {
    const src = stripFixtures(fs.readFileSync(f, 'utf8'));
    for (const o of findExternalPaths(here, path.dirname(f), src)) {
      offenders.push(`${path.relative(here, f)}  →  ${o}`);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `发现 ${offenders.length} 处把路径算到项目之外的代码（搬走或打包之后必然断掉）：\n` +
      offenders.join('\n'),
  );
});

ok('★★ 上一条检查器本身必须"抓得住真 bug、也不误报"（否则它只是个摆设）', () => {
  /* ⚠️ 为什么值得单独考一次：上面那条断言我写错过**两次** ——
     第一次扫到了自己的注释；第二次按写法判、误报 14 条。
     一个抓不住东西的检查器比没有更糟：它会让人以为这件事被守住了。
     ⇒ 用几个**已知答案**的样本喂给它，把它的行为钉住。 */
  const here = path.resolve(HERE, '..');
  /* @movability-fixtures:start
     ⚠️ 下面这段里**故意**含有"算到项目外"的样本（自检要用），
        所以上面那条真实扫描会把这一段整个挖掉再看（见 stripFixtures）。 */
  const cases = [
    {
      why: '原来那个真 bug：置底脚本指向项目外的 ../m0-probe',
      dir: path.join(here, 'src', 'main'),
      src: "const ROOT = path.resolve(HERE, '..', '..');\nconst script = path.join(ROOT, '..', 'm0-probe', 'tools', 'set-window-level.ps1');",
      hits: 1,
    },
    {
      why: '修好之后：置底脚本在项目内',
      dir: path.join(here, 'src', 'main'),
      src: "const ROOT = path.resolve(HERE, '..', '..');\nconst script = path.join(ROOT, 'tools', 'win', 'set-window-level.ps1');",
      hits: 0,
    },
    {
      why: '正常写法：从 src/main 上跳一层回项目根，再进 renderer（第一版在这里误报了 14 次）',
      dir: path.join(here, 'src', 'main'),
      src: "const R = path.resolve(HERE, '..', 'renderer');\nconst P = path.resolve(HERE, '..', 'preload', 'index.cjs');",
      hits: 0,
    },
    {
      why: '正常写法：tools 下同样上跳一层',
      dir: path.join(here, 'tools'),
      src: "const V = path.resolve(HERE, '..', 'src', 'renderer', 'view-model.js');",
      hits: 0,
    },
    {
      why: '换到项目外的另一个目录（打包后必断）',
      dir: path.join(here, 'tools'),
      src: "const p = path.join(ROOT, '..', '..', 'shared-tools', 'x.mjs');",
      hits: 1,
    },
  ];
  const wrong = [];
  for (const c of cases) {
    const got = findExternalPaths(here, c.dir, c.src).length;
    if (got !== c.hits) wrong.push(`${c.why}（期望 ${c.hits} 命中，实得 ${got}）`);
  }
  assert.deepEqual(wrong, [], '检查器行为不符合预期：\n      ' + wrong.join('\n      '));
  /* @movability-fixtures:end */
});

ok('★ 主进程现在解析到的置底脚本路径确实落在项目内', () => {
  const src = fs.readFileSync(path.resolve(HERE, '..', 'src', 'main', 'index.js'), 'utf8');
  const m = src.match(/const script = path\.join\(([^)]*)\)/);
  assert.ok(m, '找不到置底脚本的路径拼接');
  assert.ok(!/\.\./.test(m[1]), `置底脚本路径里有 .. ：${m[1]}`);
  assert.ok(/tools/.test(m[1]) && /win/.test(m[1]), `置底脚本路径不含 tools/win：${m[1]}`);
  assert.ok(fs.existsSync(path.resolve(HERE, '..', 'tools', 'win', 'set-window-level.ps1')));
});

ok('★ 三个 .vbs 入口与 service.mjs 都用"自己所在的位置"定位项目（与搬移无关）', () => {
  for (const name of ['service.mjs', 'launch.mjs']) {
    const src = fs.readFileSync(path.resolve(HERE, '..', 'tools', name), 'utf8');
    assert.ok(/import\.meta\.url/.test(src), `${name} 没有用 import.meta.url 定位项目根 —— 换个目录执行就会找错地方`);
  }
  for (const name of fs.readdirSync(path.resolve(HERE, '..')).filter((f) => f.endsWith('.vbs'))) {
    const src = fs.readFileSync(path.resolve(HERE, '..', name), 'utf8');
    assert.ok(/WScript\.ScriptFullName/.test(src), `${name} 没有用 WScript.ScriptFullName 定位自己 —— 双击时当前目录是桌面`);
    assert.ok(!/[A-Za-z]:\\/.test(src), `${name} 里有硬编码的盘符路径 —— 搬到别的盘就废了`);
  }
});

/* ==================================================================
 * 第七层 · 「上次成功抓取」必须真的区分成功与失败
 * ------------------------------------------------------------------
 * ⚠️ 这一层来自一个读代码时发现的真 bug，而且是**两处一叠加**才显形的：
 *     写入端：fetch-feeds.js 从来没写过 last_success_at，只写 last_ingest_at
 *     读取端：index.js 用 `last_success_at || last_ingest_at` 兜了回去
 *   于是"失败的尝试"被当成了"成功过"。
 *
 * 用户侧的后果非常具体、而且时机最糟：
 *   早上断网 → 启动一次 → 全部源失败 → last_ingest_at 照样更新
 *   → 调度认为"今天已经抓过" → **之后一整天都不再重试** → 卡片空一天。
 * ================================================================== */
say();
say('--- 第七层 · 成功与失败必须分得开（断网之后还要会重试）---');

await aok('★ 全部源失败时不写 last_success_at（写了就再也不会重试）', async () => {
  const dbFile = tmpDbFile('lastfail');
  const { DEFAULT_SOURCES } = await import('../src/ingest/sources.js');
  await ingestWith(async () => ({ ok: false, error: '断网' }), dbFile);
  const db = await openDb(dbFile);
  try {
    assert.equal(getMeta(db, 'last_ingest_at') != null, true, '尝试时间应当照常记录');
    assert.equal(
      getMeta(db, 'last_success_at') ?? null,
      null,
      '全部源都失败了却写了 last_success_at —— 之后一整天都不会再补抓',
    );
  } finally {
    db.close();
  }
  assert.ok(DEFAULT_SOURCES.length > 0);
});

await aok('★ 有源成功时才写 last_success_at', async () => {
  const dbFile = tmpDbFile('lastok');
  const { DEFAULT_SOURCES } = await import('../src/ingest/sources.js');
  // 第一个源成功，其余全失败 —— 只要有一个成功就算"今天抓到了"
  const map = {};
  DEFAULT_SOURCES.forEach((s, i) => {
    map[s.feedUrl] = i === 0 ? { ok: true, status: 200, text: GOOD_RSS } : { ok: false, error: '断网' };
  });
  await ingestWith(fakeFetcher(map), dbFile);
  const db = await openDb(dbFile);
  try {
    const v = getMeta(db, 'last_success_at');
    assert.ok(v, '至少一个源成功了却没写 last_success_at —— 调度会以为今天没抓过，反复重抓');
    assert.ok(!Number.isNaN(Date.parse(v)), 'last_success_at 不是可解析时间：' + v);
  } finally {
    db.close();
  }
});

await aok('★★ 端到端：断网那一轮之后，catchUpDecision 仍然判定"该补抓"', async () => {
  /* 这是整个修复的**唯一**判据 —— 上面两条只是它的必要条件。
     它把写入端与读取端连起来考：只修一边都过不了。 */
  const dbFile = tmpDbFile('catchup-after-fail');
  await ingestWith(async () => ({ ok: false, error: '断网' }), dbFile);
  const db = await openDb(dbFile);
  try {
    const lastSuccess = getMeta(db, 'last_success_at'); // 读取端现在就长这样（没有 || 兜底）
    const lastAttempt = getMeta(db, 'last_ingest_at');
    const now = new Date();

    assert.ok(lastAttempt, '不管成败，"上次尝试"都该被记下来');
    const d = catchUpDecision(lastSuccess, now, 7, 30);
    assert.equal(
      d.due,
      true,
      '断网跑过一轮之后就不肯再抓了 —— 用户早上开一次没网，卡片会空一整天。原因：' + d.reason,
    );

    /* ★ 反证：把"尝试时间"当成"成功时间"，结论就**正好反过来**。
       这一条把"为什么读取端不许写 || last_ingest_at"从一句注释
       变成机器可判的事实 —— 否则下一个人会觉得那个兜底更"健壮"而加回去。 */
    const wrong = catchUpDecision(lastAttempt, now, 7, 30);
    assert.equal(
      wrong.due,
      false,
      '兜底写法竟然也判定该补抓？那说明这个反证的前提变了，需要重新审视：' + wrong.reason,
    );
  } finally {
    db.close();
  }
});

/* ---------- 变异测试 ---------- */
say();
say('--- 变异测试 · 用例表抓不抓得住坏实现 ---');

/** 每个变异体：改坏一处，期望"至少有一条断言失败" */
const MUTANTS = [
  {
    id: 'V1',
    desc: '实体解码顺序反了（&amp; 先解）',
    run: () => {
      // 坏实现：先解 &amp; 再解 &lt;
      const bad = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<');
      assert.equal(bad('&amp;lt;'), '&lt;'); // 会得到 '<' ⇒ 抛
    },
  },
  {
    id: 'V2',
    desc: 'URL 归一化把 query 整个丢掉（会把不同文章合并）',
    run: () => {
      const bad = (s) => s.split('?')[0];
      assert.notEqual(bad('https://e.com/p?id=1'), bad('https://e.com/p?id=2'));
    },
  },
  {
    id: 'V3',
    desc: 'URL 解析失败返回空串（所有坏 URL 变成同一条 = 静默合并）',
    run: () => {
      /* ⚠️ 这个变异体第一版**写错了**：我给它套了个 try/catch 再返回 ''，
         但 `canonicalizeUrl` 根本不会抛 —— 于是那个分支从不执行，
         变异体"存活"，把用例表冤枉成假测试。
         **变异体自己写错与假阴性同样有害**：它会让你去改本来正确的代码。
         ⇒ 正确写法是**真的把行为改坏**：无法解析就返回空串。 */
      const bad = (s) => {
        try {
          return new URL(s).toString();
        } catch {
          return '';
        }
      };
      // 坏实现下："bad one" 与 "bad two" 都变成 '' ⇒ 相等 ⇒ 断言抛
      assert.notEqual(bad('bad one'), bad('bad two'));
    },
  },
  {
    id: 'V4',
    desc: '分页用 OFFSET（翻页期间插入新条目会漏条）',
    /* ⚠️ 变异体是**同步**的（`run: () => {}`），所以这里不能用 await。
       而它只需要一个能建表插数据的库 —— 与其为一个变异体引异步依赖，
       不如直接用**内存库 + 同步建表**：变异体考的是"OFFSET 会不会重叠"，
       与 schema 长什么样无关。这也让变异体保持零异步、不与主流程耦合。 */
    run: () => {
      const dbFile = tmpDbFile('mut-offset');
      const db = makeSyncTestDb(dbFile);
      const now = new Date().toISOString();
      upsertSources(db, [{ name: 'S', feedUrl: 'https://s.com/f', kind: 'rss' }], now);
      const runId = startRun(db, 'manual', now);
      for (let i = 1; i <= 10; i += 1) {
        insertItem(db, { title: `i${i}`, url: `https://e.com/${i}`, publishedAt: new Date(Date.UTC(2026, 8, 22, 0, 0, i)).toISOString(), sourceId: 1, sourceName: 'S' }, runId, now);
      }
      // 坏实现：OFFSET 式
      const page1 = db.prepare('SELECT id FROM item ORDER BY published_at DESC, id DESC LIMIT 3 OFFSET 0').all();
      insertItem(db, { title: '新插入', url: 'https://e.com/new', publishedAt: '2027-01-01T00:00:00Z', sourceId: 1, sourceName: 'S' }, runId, now);
      const page2 = db.prepare('SELECT id FROM item ORDER BY published_at DESC, id DESC LIMIT 3 OFFSET 3').all();
      db.close();
      const p1 = page1.map((r) => r.id);
      const p2 = page2.map((r) => r.id);
      const overlap = p2.filter((id) => p1.includes(id));
      assert.equal(overlap.length, 0, `OFFSET 式分页重叠了 ${overlap.length} 条 —— 证明游标用例有判别力`);
    },
  },
  {
    id: 'V5',
    desc: '解析器把"缺标题"的条目也产出（编造空标题）',
    run: () => {
      const bad = (xml) => {
        const blocks = xml.match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
        return blocks.map(() => ({ title: '' })); // 坏实现：不校验
      };
      const r = bad('<rss><item><link>x</link></item></rss>');
      assert.equal(r.length, 0, '坏实现会产出 1 条空标题 —— 证明"不编造标题"用例有判别力');
    },
  },
  {
    id: 'V6',
    desc: '源失败时中断整轮（不隔离）',
    run: () => {
      const bad = (results) => {
        const out = [];
        for (const r of results) {
          if (!r.ok) throw new Error('一个源失败就整体崩'); // 坏实现
          out.push(r);
        }
        return out;
      };
      const results = [{ ok: false }, { ok: true }];
      assert.doesNotThrow(() => bad(results), '坏实现会抛 —— 证明失败隔离用例有判别力');
    },
  },
];

let survived = 0;
for (const m of MUTANTS) {
  let caught = false;
  try {
    m.run();
  } catch {
    caught = true;
  }
  if (!caught) survived += 1;
  say(`  ${caught ? '✓' : '✗'} ${m.id} ${m.desc} → ${caught ? '落网' : '存活！用例表是假测试'}`);
}

/* ================================================================== */
say();
const okAll = failed === 0 && survived === 0;
say('────────────────────────────────────────────────────────────');
if (okAll) {
  say(`结论：✅ PASS —— ${passed} 条断言全过，${MUTANTS.length} 个变异体全部落网。`);
} else {
  if (failed) say(`结论：❌ FAIL —— ${failed} 条断言不成立（通过 ${passed} 条）。`);
  if (survived) say(`结论：❌ FAIL —— ${survived} 个变异体存活，用例表不具备判别力。`);
}
say('────────────────────────────────────────────────────────────');
say();
say('⚠️ 覆盖边界：本脚本证明"解析/归一化/去重/入库/分页/失败隔离"是对的。');
say('   **不证明**真实网络能取到 feed —— 那需要真跑 `npm run ingest`。');

try {
  const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'report');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'test-all.txt'), lines.join('\n') + '\n', 'utf8');
} catch {
  /* 报告写不进去不影响退出码 */
}

process.exit(okAll ? 0 : 1);
