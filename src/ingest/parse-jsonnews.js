/**
 * src/ingest/parse-jsonnews.js —— 「公开 JSON 快讯接口」的原生适配器（零依赖 · 纯函数）
 * =====================================================================
 * 一句话：把三个**财经快讯接口**的 JSON 文本，变成与 `parseFeed` 同构的一组条目。
 *
 * ---------------------------------------------------------------------
 * 为什么要有这个文件（2026-09-29）
 * ---------------------------------------------------------------------
 * 上一轮补源时反复撞到同一堵墙，最后被一句话点破：
 *   **「站点自己的公开 JSON 接口」这条路当时必然判 0 条** ——
 *   `parseFeed` 只认 RSS/Atom/RDF/JSON Feed（顶层要有 items 数组），
 *   而全项目唯一的私有适配器是 `toutiao-hot`。
 * 也就是说：这些接口**是通的、是官方公开的、有时间有链接**，只是没人认。
 * ⇒ 这个文件补上其中三个（都已逐个实测，见下面的字段说明）。
 *
 * ⚠️ 为什么每个都写"窄判据 + 失败时给下一步"：
 *   · 判据窄（见 adapters.js 的 matches）：接口形状是**站点私有**的，
 *     拿一个站的解析器去解另一个站的 JSON 只会得到垃圾；
 *   · 失败信息必须说清"实际拿到的是什么"（HTML？换形状了？），
 *     否则用户看到的只是"源异常"，而不知道是接口改版了。
 *
 * ⚠️ 三条与项目铁律对齐的取舍：
 *   ① **不编造时间**：只解析接口真的给的时间字段；解析不了就是 null；
 *   ② **不编造标题**：没有可用的标题/正文就丢掉那条（宁可少一条）；
 *   ③ **不编造链接**：链接必须是接口给的 http(s) 地址，相对地址一律丢掉。
 * =====================================================================
 */

import { cleanText, collapseWhitespace, stripHtml } from './entities.js';
import { sniffContentKind, previewOf } from './feed-parse.js';

/** 标题长度上限（与 parse-toutiao 同一口径：接口改版塞进几万字也不会撑坏卡片） */
export const MAX_TITLE_LEN = 200;
/** 快讯正文当标题时的截断长度（快讯的"标题"本来就是正文第一句） */
export const FLASH_TITLE_LEN = 60;

/** 统一的空结果骨架（与 parseFeed / parseToutiaoHot 同构） */
function emptyResult(ctx, extra = {}) {
  return {
    ok: false,
    format: 'json',
    title: ctx && ctx.sourceName ? String(ctx.sourceName) : null,
    items: [],
    warnings: [],
    rawBlockCount: 0,
    contentKind: null,
    preview: null,
    ...extra,
  };
}

/** 解析文本 → JSON 对象；失败时把"实际是什么"写进 warnings（指向下一步） */
function parseJson(text, out) {
  if (typeof text !== 'string' || text.trim() === '') {
    out.warnings.push('接口内容为空');
    return null;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    out.contentKind = sniffContentKind(text);
    out.preview = previewOf(text);
    out.warnings.push(
      '不是可解析的 JSON —— 实际拿到的是【' + out.contentKind + '】。开头：' + out.preview,
    );
    return null;
  }
}

/**
 * unix **秒**转 ISO。
 * ⚠️ 有些接口给的是毫秒（13 位）：这里**按位数判断**而不是"看起来很怪就乘 1000"，
 *    并且对 0 / 负数 / 非数字一律返回 null —— 时间是排队与"今天"的依据，宁缺勿错。
 */
export function unixSecondsToIso(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;   // 13 位当毫秒，其余当秒
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * `YYYY-MM-DD HH:mm:ss` → ISO，**按北京时间（+08:00）**解释。
 *
 * ⚠️ 为什么不按本机时区：东财是中国站点，它给的是北京时间。
 *    按本机时区解，会让一个在 UTC 机器上跑的用户把"今天 13:54"读成 13:54Z ——
 *    条目因此掉出"今天"那一屏，而界面上看不出任何异常。
 */
export function beijingTimeToIso(s) {
  const m = String(s == null ? '' : s).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+08:00`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 链接：只认接口给的 http(s) 绝对地址（相对地址一律丢掉，不猜） */
function cleanUrl(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}

/** 从正文里取"第一句"当标题（快讯接口的 title 常常是空的，正文本身就是那条消息） */
export function flashTitleFrom(text) {
  const s = collapseWhitespace(stripHtml(cleanText(String(text == null ? '' : text))));
  if (!s) return '';
  /* 优先在中文句读处断开；没有再硬截断 —— 两者都是**截断真实内容**，不编造 */
  const m = s.match(/^[^。！？!?；;]{4,}?[。！？!?；;]/);
  const head = m ? m[0] : s;
  return head.length > FLASH_TITLE_LEN ? head.slice(0, FLASH_TITLE_LEN) + '…' : head;
}

/** 共用：把一行记录变成条目（标题、链接、时间三者都按铁律处理） */
function makeItem(rec, ctx, { title, url, time, summary }) {
  let t = collapseWhitespace(stripHtml(cleanText(String(title == null ? '' : title))));
  if (!t) return null;                                  // 不编造标题：没有就丢掉
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN);
  return {
    title: t,
    url: cleanUrl(url),
    summary: collapseWhitespace(stripHtml(cleanText(String(summary == null ? '' : summary)))),
    author: null,
    publishedAt: time,
    sourceId: (ctx && ctx.sourceId) || null,
    sourceName: (ctx && ctx.sourceName) || null,
    format: 'json',
  };
}

/** 共用的收尾：去重、warnings、ok 判定 */
function finish(out, items, seenKeys, stats) {
  if (stats.noTitle) out.warnings.push('有 ' + stats.noTitle + ' 条没有可用的标题/正文 —— 丢掉了（不编造标题）');
  if (stats.dup) out.warnings.push('有 ' + stats.dup + ' 条重复 —— 只保留第一次出现的');
  if (stats.noUrl) out.warnings.push('有 ' + stats.noUrl + ' 条没有可用的原文链接 —— 如实存成"没有链接"');
  if (stats.noTime) out.warnings.push('有 ' + stats.noTime + ' 条的时间解析不了 —— 如实存成"没有时间"');
  out.items = items;
  out.ok = items.length > 0;
  if (!out.ok) out.warnings.push('接口返回了 ' + out.rawBlockCount + ' 条，但没有一条能变成条目');
  return out;
}

/* ───────────────────────── 1. 华尔街见闻 · 7×24 快讯 ─────────────────────────
 * 实测（2026-09-29）：`GET api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&client=pc&limit=20`
 *   → 200 · 24KB · `{code, message, data:{items:[…]}}`
 * 字段：`uri`（原文页，如 https://wallstreetcn.com/livenews/3171938）、
 *       `display_time`（unix 秒）、`title`（**快讯常常是空串**）、`content_text`（正文）。
 * ⚠️ 正因为 title 常常为空，才需要"正文当标题"这条兜底 —— 否则这个源会一条都进不来。
 */
export function parseWscnLive(text, ctx = {}) {
  const out = emptyResult(ctx);
  const data = parseJson(text, out);
  if (!data) return out;
  const rows = data && data.data && Array.isArray(data.data.items) ? data.data.items : null;
  if (!rows) {
    out.preview = previewOf(text);
    out.warnings.push('JSON 里没有 data.items 数组 —— 接口可能改版了。顶层字段：' + Object.keys(data || {}).join('/'));
    return out;
  }
  out.rawBlockCount = rows.length;
  const items = [];
  const seen = new Set();
  const stats = { noTitle: 0, dup: 0, noUrl: 0, noTime: 0 };
  for (const row of rows) {
    if (!row || typeof row !== 'object') { stats.noTitle += 1; continue }
    const body = row.content_text || row.content || '';
    const title = row.title && String(row.title).trim() ? row.title : flashTitleFrom(body);
    const time = unixSecondsToIso(row.display_time);
    const it = makeItem(row, ctx, { title, url: row.uri, time, summary: body });
    if (!it) { stats.noTitle += 1; continue }
    const key = String(row.id || '') || it.title;
    if (seen.has(key)) { stats.dup += 1; continue }
    seen.add(key);
    if (!it.url) stats.noUrl += 1;
    if (!it.publishedAt) stats.noTime += 1;
    items.push(it);
  }
  return finish(out, items, seen, stats);
}

/* ───────────────────────── 2. 同花顺 · 7×24 快讯 ─────────────────────────
 * 实测（2026-09-29）：`GET news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=20`
 *   → 200 · 18KB · `{code, msg, time, data:{list:[…]}}`
 * 字段：`title`、`digest`（摘要）、`url`（**绝对地址，直接可用**）、
 *       `ctime`/`rtime`（unix 秒，字符串）。字段齐全，是三家里最省事的。
 * ⚠️ 需要带 Referer 吗？实测**不需要**（带与不带都是 200、内容一致）——
 *    这一条留着，免得下一个人凭空加一个"必须 Referer"的结论。
 */
export function parseThsFlash(text, ctx = {}) {
  const out = emptyResult(ctx);
  const data = parseJson(text, out);
  if (!data) return out;
  const rows = data && data.data && Array.isArray(data.data.list) ? data.data.list : null;
  if (!rows) {
    out.preview = previewOf(text);
    out.warnings.push('JSON 里没有 data.list 数组 —— 接口可能改版了。顶层字段：' + Object.keys(data || {}).join('/'));
    return out;
  }
  out.rawBlockCount = rows.length;
  const items = [];
  const seen = new Set();
  const stats = { noTitle: 0, dup: 0, noUrl: 0, noTime: 0 };
  for (const row of rows) {
    if (!row || typeof row !== 'object') { stats.noTitle += 1; continue }
    const title = row.title && String(row.title).trim() ? row.title : flashTitleFrom(row.digest);
    const time = unixSecondsToIso(row.ctime || row.rtime);
    const it = makeItem(row, ctx, { title, url: row.url, time, summary: row.digest });
    if (!it) { stats.noTitle += 1; continue }
    const key = String(row.id || '') || it.title;
    if (seen.has(key)) { stats.dup += 1; continue }
    seen.add(key);
    if (!it.url) stats.noUrl += 1;
    if (!it.publishedAt) stats.noTime += 1;
    items.push(it);
  }
  return finish(out, items, seen, stats);
}

/* ───────────────────────── 3. 东方财富 · 快讯 ─────────────────────────
 * 实测（2026-09-29）：`GET newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`
 *   → 200 · 43KB · **不是纯 JSON**：`var ajaxResult={…};`（JSONP 风格，但没有回调函数）
 * 字段：`LivesList[]`，每条有 `title`、`digest`、`url_w`/`url_unique`（http 原文页）、
 *       `showtime`/`ordertime`（**"YYYY-MM-DD HH:mm:ss"，北京时间**）。
 * ⚠️ 首尾那层包装必须剥掉：`parseJson` 直接喂会失败，而失败信息会说"不是 JSON" ——
 *    那是对的（它确实不是），但**对用户没有用**：这个接口本来就不是纯 JSON。
 */
export const EASTMONEY_FLASH_API =
  'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html';

/** 剥掉 `var ajaxResult=` 前缀与结尾分号（只认这一种包装，别的一律原样返回） */
export function unwrapJsonp(text) {
  const s = String(text == null ? '' : text).trim();
  const m = s.match(/^var\s+ajaxResult\s*=\s*([\s\S]*?);?\s*$/);
  return m ? m[1] : s;
}

export function parseEastmoneyFlash(text, ctx = {}) {
  const out = emptyResult(ctx);
  const data = parseJson(unwrapJsonp(text), out);
  if (!data) return out;
  const rows = Array.isArray(data.LivesList) ? data.LivesList : null;
  if (!rows) {
    out.preview = previewOf(text);
    out.warnings.push('JSON 里没有 LivesList 数组 —— 接口可能改版了。顶层字段：' + Object.keys(data || {}).join('/'));
    return out;
  }
  out.rawBlockCount = rows.length;
  const items = [];
  const seen = new Set();
  const stats = { noTitle: 0, dup: 0, noUrl: 0, noTime: 0 };
  for (const row of rows) {
    if (!row || typeof row !== 'object') { stats.noTitle += 1; continue }
    const title = row.title && String(row.title).trim() ? row.title : flashTitleFrom(row.digest);
    const time = beijingTimeToIso(row.showtime || row.ordertime);
    const it = makeItem(row, ctx, {
      title,
      url: row.url_unique || row.url_w || row.url_m,
      time,
      summary: row.digest || row.simdigest,
    });
    if (!it) { stats.noTitle += 1; continue }
    const key = String(row.newsid || row.id || '') || it.title;
    if (seen.has(key)) { stats.dup += 1; continue }
    seen.add(key);
    if (!it.url) stats.noUrl += 1;
    if (!it.publishedAt) stats.noTime += 1;
    items.push(it);
  }
  return finish(out, items, seen, stats);
}
