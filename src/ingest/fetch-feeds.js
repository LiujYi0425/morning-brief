/**
 * src/ingest/fetch-feeds.js —— 抓取 + 归一化 + 入库（一个源失败不拖垮整体）
 * =====================================================================
 * 这个文件是整个需求 1 的落点。四条硬口径：
 *
 * ### ① 一个源失败，不许拖垮其它源
 * 每个源独立 try/catch，失败**记进 source_state**（含 `consecutive_fail`），
 * 然后继续下一个。这是"采集失败不能拖垮整体"的直接实现。
 *
 * ### ② 失败必须**可见**，不能只是 console.log
 * 返回结构里带 `health`：界面顶部要能显示"10 个源，8 个正常，2 个挂了"。
 * 否则用户只会看到"今天怎么没更新" —— 而这是最糟的失败形态。
 *
 * ### ③ 不编造时间
 * 源没给 `pubDate` 就存 NULL。**不要用当前时间填** ——
 * 那会让"源没给时间"和"这条就是现在发的"混成一样，翻页排序也跟着乱。
 *
 * ### ④ 超时与体积都设上限
 * 常驻程序最怕"卡在一个不响应的源上"。超时 15s、单 feed 上限 5MB。
 *
 * ⚠️ 本文件**不需要 Electron**：抓取层必须能纯 Node 跑（`npm run ingest`），
 *    否则它又会变成"只能靠人手点一次才知道行不行"。
 * =====================================================================
 */

import { parseFeed } from './feed-parse.js';
import {
  openDb,
  upsertSources,
  listSources,
  recordSourceResult,
  startRun,
  finishRun,
  insertItem,
  upsertCategory,
  tagItem,
  sourceHealth,
  setMeta,
} from '../store/db.js';
import { DEFAULT_SOURCES, DEFAULT_CATEGORIES } from './sources.js';

const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 5 * 1024 * 1024;
const USER_AGENT = 'MorningBrief/0.1 (+https://github.com/LiujYi0425/morning-brief)';

/**
 * "拿到的东西不像 feed"时的重试次数。
 *
 * ⚠️ 为什么必须有（真机取证，R2 实测）：36氪 `https://36kr.com/feed` 是同一个 URL，
 *    **间歇性**返回 HTTP 200 + 一张 JS 安全挑战页（"正在进行安全检测…"）。
 *    并行两个 worker 一个拿到挑战页、一个拿到真 RSS。
 *    一次不成就永久把这个源记为失败 ⇒ **把"偶发"变成了"必然缺失"**，
 *    而且用户看到的结论是"这个源地址不对"，方向完全指错了。
 *
 * ⚠️ 边界（这条很重要，别把它做成反爬对抗）：
 *    · 只重试 **1 次**，只针对"响应成功但内容不是 feed"
 *      —— 明确的 404/403/超时**不重试**（那是真没有）。
 *    · **不换 UA、不伪造指纹、不带 Cookie**，就是同一个请求再问一次。
 *    · 间隔带随机抖动，避免所有源在同一毫秒重试。
 */
const RETRY_NOT_FEED = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取一个 URL 的文本内容。
 *
 * ⚠️ 用 `AbortController` 做超时 —— `fetch` 自身**没有** timeout 选项，
 *    不加这个，一个不响应的源会把整个抓取挂住。
 *
 * @param {string} url
 * @returns {Promise<{ok:boolean, status?:number, text?:string, error?:string}>}
 */
export async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status} ${res.statusText || ''}`.trim() };
    }
    // 体积上限：先看头，再兜底截断（有些服务器不给 content-length）
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) {
      return { ok: false, status: res.status, error: `响应过大（${Math.round(len / 1048576)}MB），拒绝读取` };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { ok: false, status: res.status, error: `响应过大（${Math.round(buf.byteLength / 1048576)}MB），拒绝读取` };
    }
    // ⚠️ 编码：绝大多数 feed 是 UTF-8；GBK 的会在下面被检出并如实标记，而不是产出乱码
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return { ok: true, status: res.status, text };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
    return { ok: false, error: aborted ? `超时（>${timeoutMs}ms）` : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一轮抓取。
 *
 * @param {object} opts
 * @param {string} opts.dbFile          数据库路径
 * @param {'schedule'|'manual'|'catchup'} [opts.trigger]
 * @param {boolean} [opts.ensureSources] 是否在库里没有源时写入预置源包
 * @param {(msg:string)=>void} [opts.log]
 * @param {typeof fetchText} [opts.fetcher] 便于测试注入（默认真抓）
 */
export async function runIngest(opts) {
  const {
    dbFile,
    trigger = 'manual',
    ensureSources = true,
    log = () => {},
    fetcher = fetchText,
  } = opts;

  const nowIso = new Date().toISOString();
  // ⚠️ openDb 是异步的（node:sqlite 延迟加载，见 store/db-setup.js 的说明）
  const db = await openDb(dbFile);
  const summary = { sources: 0, ok: 0, failed: 0, newItems: 0, duplicates: 0, skippedNoKey: 0, perSource: [] };

  try {
    if (ensureSources) {
      const sync = upsertSources(db, DEFAULT_SOURCES, nowIso);
      if (sync.added) log(`首次运行：写入 ${sync.added} 个预置源`);
      /* ★ 从清单里删掉的源要停用，否则它们会一直失败、一直挂在"源异常"里。
         真机日志逼出来的：代码换掉了 5 个源，用户机器上那 5 条还在被反复抓。 */
      if (sync.retired.length) {
        log(`以下 ${sync.retired.length} 个源已从预置清单移除，本次停用：${sync.retired.join(' / ')}`);
      }
      // 预置类别（用户之后可增删改）
      DEFAULT_CATEGORIES.forEach((name, i) => upsertCategory(db, name, i, nowIso));
    }

    const sources = listSources(db, true);
    summary.sources = sources.length;
    if (!sources.length) {
      log('没有任何启用的源 —— 什么都不做（不是错误，但界面应当提示去添加源）');
      return { ...summary, health: sourceHealth(db) };
    }

    const runId = startRun(db, trigger, nowIso);
    const catIds = new Map();
    for (const c of DEFAULT_CATEGORIES) {
      catIds.set(c, upsertCategory(db, c, DEFAULT_CATEGORIES.indexOf(c), nowIso));
    }

    for (const src of sources) {
      const one = { name: src.name, feedUrl: src.feed_url, status: 'unknown', items: 0, newItems: 0 };
      try {
        let res = await fetcher(src.feed_url);
        let parsed = null;
        if (res.ok) {
          for (let attempt = 0; ; attempt += 1) {
            parsed = parseFeed(res.text, { sourceId: src.id, sourceName: src.name });
            if (parsed.ok) break;
            /* ⚠️ **只对"人机验证页"重试**，不要对普通 HTML 重试。
               真机日志抓到的过度重试：品玩 / cnBeta / 财新网 返回的都是**普通网页**
               （栏目页或跳转页），重试一次仍然是同一个网页，只是白白多花一次请求，
               还把日志写得像"被反爬拦了"——**诊断指向了错误的原因**。
               判据收紧成 sniffContentKind 给出的那一档。 */
            const looksBlocked = /反爬|人机验证/.test(String(parsed.contentKind || ''));
            if (!looksBlocked || attempt >= RETRY_NOT_FEED) break;
            log(`${src.name}：拿到的是「${parsed.contentKind}」，重试一次`);
            await sleep(500 + Math.floor(Math.random() * 700));
            res = await fetcher(src.feed_url);
            if (!res.ok) break;
          }
        }
        if (!res.ok) {
          one.status = res.status ? 'http_error' : 'network_error';
          one.error = res.error;
        } else if (!parsed || !parsed.ok) {
          one.status = 'parse_error';
          one.error = (parsed && parsed.warnings.join(' / ')) || '解析后没有任何条目';
          // ★ 把"实际拿到的是什么"一并带出来 —— 报错要指向下一步
          if (parsed && parsed.contentKind) one.contentKind = parsed.contentKind;
        } else {
          one.status = 'ok';
          one.items = parsed.items.length;
          for (const it of parsed.items) {
            const r = insertItem(db, { ...it, sourceId: src.id, sourceName: src.name }, runId, nowIso);
            if (!r) {
              summary.skippedNoKey += 1;
              continue;
            }
            if (r.isNew) {
              summary.newItems += 1;
              one.newItems += 1;
              // 按源类别打初始标签（阶段 2 会叠加用户自定义规则）
              const wanted = (DEFAULT_SOURCES.find((d) => d.feedUrl === src.feed_url) || {}).categories || [];
              const ids = wanted.map((n) => catIds.get(n)).filter((x) => x != null);
              if (ids.length) tagItem(db, r.id, ids);
            } else {
              summary.duplicates += 1;
            }
          }
        }
      } catch (err) {
        one.status = 'parse_error';
        one.error = `未预期的异常：${err && err.message ? err.message : String(err)}`;
      }

      const ok = one.status === 'ok';
      if (ok) summary.ok += 1;
      else summary.failed += 1;
      recordSourceResult(
        db,
        src.id,
        { ok, status: one.status, error: one.error, itemCount: one.items },
        nowIso,
      );
      summary.perSource.push(one);
      log(
        `${ok ? '✓' : '✗'} ${src.name.padEnd(14)} ` +
          (ok
            ? `${one.items} 条（新增 ${one.newItems}）`
            : `${one.status} —— ${one.error}`),
      );
    }

    /* ⚠️ 两个键的分工**必须**分清（这里原来只有一个，见下面那段说明）：
     *   · `last_ingest_at`  = 上次**尝试**抓取 —— 无论成败
     *   · `last_success_at` = 上次**成功**抓取 —— 至少有一个源拿到了条目
     *   定时调度只认后者。 */
    const finishedIso = new Date().toISOString();
    finishRun(
      db,
      runId,
      { okCount: summary.ok, failCount: summary.failed, newItems: summary.newItems, detail: JSON.stringify(summary.perSource) },
      finishedIso,
    );
    setMeta(db, 'last_ingest_at', finishedIso);
    setMeta(db, 'last_ingest_trigger', trigger);
    /* ★ `last_success_at` 原来**从来没有被写过** —— 而读取端拿它当"上次成功"用。
     *   于是"断网那天启动一次"会变成：全部源失败 → `last_ingest_at` 照样更新
     *   → 调度认为今天已经抓过 → **之后一整天都不再重试**，卡片空一天。
     *   ⇒ 只有真的有源成功（summary.ok > 0）才记这一笔。
     *     全部失败时**故意不写**，于是下一次启动仍然判定为"该补抓"。 */
    if (summary.ok > 0) setMeta(db, 'last_success_at', finishedIso);

    return { ...summary, health: sourceHealth(db) };
  } finally {
    db.close();
  }
}

/**
 * 从上次抓取到现在**隔了多久**，用于决定要不要"补跑"。
 *
 * 为什么需要它：常驻程序会被关机、休眠、崩溃打断。
 * "每天抓一次"在真实世界里意味着"**每天至少抓一次**，错过就补"。
 *
 * @param {string|null} lastIso
 * @param {number} everyMs
 * @param {number} [nowMs]
 * @returns {{due:boolean, missedMs:number, reason:string}}
 */
export function shouldRunNow(lastIso, everyMs, nowMs = Date.now()) {
  if (!lastIso) return { due: true, missedMs: 0, reason: '从未抓取过' };
  const t = Date.parse(lastIso);
  if (!Number.isFinite(t)) return { due: true, missedMs: 0, reason: '上次抓取时间不可解析（当作从未抓过）' };
  const elapsed = nowMs - t;
  if (elapsed >= everyMs) {
    return { due: true, missedMs: elapsed - everyMs, reason: `距上次抓取 ${Math.round(elapsed / 60000)} 分钟，已到期` };
  }
  return { due: false, missedMs: 0, reason: `距上次抓取仅 ${Math.round(elapsed / 60000)} 分钟` };
}
