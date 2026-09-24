/**
 * src/ingest/parse-toutiao.js —— 今日头条热榜的**原生 JSON 适配器**（零依赖 · 纯函数）
 * =====================================================================
 * 一句话：**把头条热榜接口的 JSON 文本，变成与 parseFeed 同构的一组条目。**
 *
 * ---------------------------------------------------------------------
 * 为什么给它写原生适配器，而不是走 RSSHub
 * ---------------------------------------------------------------------
 * 阶段 B0 在本机自建实例上把两条路都跑通了（不是"只能这样"）：
 *
 *   · RSSHub /toutiao/channel/news_hot   200 · 15 条 · 最新 2026-09-24T10:16Z
 *   · 头条自己的 /hot-event/hot-board/   200 · 50 条 · 0.27s · 结构化 JSON
 *
 * 差别在**依赖方向**：走 RSSHub 就要求用户本机先跑起一个外部服务
 * （阶段 B2 那一组源就是这个代价），而直接打头条自己的公开接口
 * **一个依赖都不多**。而且它是头条自己的官方接口，比第三方镜像更不容易被限流
 * —— 这正是交接文档 3.3 那件事的教训（公共镜像的 429/503 不能当证据）。
 *
 * ---------------------------------------------------------------------
 * 代价要说清楚：这条路**只对「热榜」有效**
 * ---------------------------------------------------------------------
 *   · **没有时间字段**（见下面"不编造时间"那一段）
 *   · 没有摘要 / 正文，只有标题 + 热度值
 *   · 里面**可能混进直播链接**（实测踩到过，见 isLiveLink）
 *   · Url 里塞着一段每次请求都变的埋点参数（见 cleanLink）
 * ⇒ 所以它对应的预置源**默认关闭**（见 sources.js 里的说明）：
 *    热榜不是资讯流，默认打开会让用户的晨报里混进一堆"没有时间"的条目。
 * =====================================================================
 */

import { cleanText, collapseWhitespace, stripHtml } from './entities.js';
import { sniffContentKind, previewOf } from './feed-parse.js';

/** 头条热榜接口（公开、无需登录、无需 token） */
export const TOUTIAO_HOT_API = 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc';

/** 热榜自己的名字（接口不返回频道标题，这是如实给一个固定的） */
export const TOUTIAO_HOT_TITLE = '今日头条 · 热榜';

/**
 * 标题长度上限。
 *
 * ⚠️ 为什么必须有：热榜标题正常都在 30 字以内，而**一旦接口改版返回了别的东西**
 *    （错误页、把 HTML 塞进 Title），一个几万字的"标题"会直接把卡片撑坏。
 *    这里**截断而不是丢弃** —— 丢一条真实存在的热榜，比截短一条更糟。
 */
export const MAX_TITLE_LEN = 200;

/**
 * 直播间域名。头条热榜里会混进抖音直播（实测交接文档记过一次：
 * 第一条的 Url 指向 webcast-open.douyin.com/open/media_live/...）。
 * 那不是资讯：点开是一个直播间，塞进晨报只会让用户莫名其妙。
 */
const LIVE_HOSTS = new Set(['webcast-open.douyin.com', 'live.douyin.com', 'webcast.amemv.com']);

/**
 * 这个链接是不是**直播**（而不是一条资讯）。
 *
 * ⚠️ 判据只认两类硬证据，不做"看着像直播"的猜测：
 *   ① 主机名就是已知的直播域名；
 *   ② 抖音域名 + 路径里出现 /media_live/ 或 /webcast/。
 *     **不做"路径里有 live 就算"** —— 那会误伤 /alive/、/deliver/ 这类正常路径，
 *     而误杀的条目用户永远看不到（比放过一条直播更糟）。
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLiveLink(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (LIVE_HOSTS.has(host)) return true;
  if (host === 'douyin.com' || host.endsWith('.douyin.com')) {
    return /\/media_live\/|\/webcast\//i.test(u.pathname);
  }
  return false;
}

/**
 * 热度值 -> 人看得懂的一行。
 * 接口给的是字符串数字（例如 "45099814"）。不认识的值**原样返回**，
 * 而不是编一个数字出来。
 */
export function formatHotValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(Math.round(n));
}

/**
 * 把热榜条目里的链接收干净（**这一步是去重能不能成立的前提**）。
 *
 * ⚠️⚠️ 实测依据（2026-09-24，同一台机器间隔 1.5 秒抓两次）：
 *    · 两次返回**同样 50 条、同样的 ClusterId 顺序**
 *    · 但同一条的 Url **两次不一样**（长度 838，里面带 hot_board_impr_id，
 *      每次请求都会变）
 *    · 去掉 query 之后**两次完全相同**，而且 path 里本来就含 ClusterId
 *      （/trending/7688885007091351602/）
 *
 * ⇒ 如果原样存那个 838 字的 URL，去重键每次都变：
 *   **每刷新一次就多 50 条"新"条目**，而它们其实是同一批。
 *
 * ⚠️ 只对**认得出的**热点页去 query（toutiao.com/trending/数字）。
 *    别的链接原样保留 —— 本项目已经定过一条口径：
 *    url 是"原文链接"，有些站**依赖** query 才能打开，
 *    一律砍 query 会点出 404（那比多存几个字符糟得多）。
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function cleanLink(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null; // 解析不了 ⇒ 当作没有链接（不猜、不拼）
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const isToutiao = host === 'toutiao.com' || host.endsWith('.toutiao.com');
  if (isToutiao && /^\/trending\/\d+\/?$/.test(u.pathname)) return u.origin + u.pathname;
  return s;
}

/** 一行摘要：这一条在榜上排第几、热度多少（这两件事接口给的是真的） */
function summaryOf(rank, hotValue) {
  const hot = formatHotValue(hotValue);
  return '热榜第 ' + rank + ' 位' + (hot ? ' · 热度 ' + hot : '');
}

/** 这条热榜的身份：ClusterId 优先，没有就退回标题 */
function identityOf(row, title) {
  const a = row && row.ClusterIdStr != null ? String(row.ClusterIdStr).trim() : '';
  if (a) return a;
  const b = row && row.ClusterId != null ? String(row.ClusterId).trim() : '';
  if (b) return b;
  return title;
}

/**
 * 解析热榜接口的响应体。
 *
 * @param {string} jsonText
 * @param {{sourceId?: string, sourceName?: string}} [ctx]
 * @returns {{ok:boolean, format:string, title:string, items:Array<object>, warnings:string[],
 *            rawBlockCount:number, contentKind:string|null, preview:string|null}}
 *   与 `parseFeed` 的返回**同构** —— 抓取层不需要知道这条源走的是哪条路。
 */
export function parseToutiaoHot(jsonText, ctx = {}) {
  const out = {
    ok: false,
    format: 'json',
    title: TOUTIAO_HOT_TITLE,
    items: [],
    warnings: [],
    rawBlockCount: 0,
    contentKind: null,
    preview: null,
  };

  if (typeof jsonText !== 'string' || jsonText.trim() === '') {
    out.warnings.push('接口内容为空');
    return out;
  }

  let data;
  try {
    data = JSON.parse(jsonText.replace(/^\uFEFF/, ''));
  } catch {
    /* ★ 报错必须指向下一步（与 parseFeed 同一条口径）：
       说清"它看起来是什么"，而不是只说"解析失败"。 */
    out.contentKind = sniffContentKind(jsonText);
    out.preview = previewOf(jsonText);
    out.warnings.push(
      '不是可解析的 JSON —— 实际拿到的是【' + out.contentKind + '】。开头：' + out.preview,
    );
    return out;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    out.preview = previewOf(jsonText);
    out.warnings.push('JSON 的顶层不是一个对象 —— 接口形状变了（这个适配器需要跟着改）');
    return out;
  }
  const rows = Array.isArray(data.data) ? data.data : null;
  if (!rows) {
    out.preview = previewOf(jsonText);
    out.warnings.push(
      'JSON 里没有 data 数组 —— 接口可能改版了。顶层字段：' + Object.keys(data).join('/'),
    );
    return out;
  }

  out.rawBlockCount = rows.length;
  if (!rows.length) {
    /* ⚠️ 与"接口坏了"分开说：空数组是**合法**的（热榜真的空了），
       而"没有 data 数组"是接口变样了。混成一句，用户不知道该重试还是该改代码。 */
    out.warnings.push('接口返回的 data 是空数组（热榜这会儿是空的）');
    return out;
  }

  const seen = new Set();
  let noTitle = 0;
  let dup = 0;
  let live = 0;
  let badUrl = 0;
  let longTitle = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') {
      noTitle += 1;
      continue;
    }
    const rawTitle = typeof row.Title === 'string' ? row.Title : '';
    let title = collapseWhitespace(stripHtml(cleanText(rawTitle)));
    if (!title) {
      noTitle += 1; // 没有标题就丢掉：**不编造标题**（与 parseFeed 逐字同一口径）
      continue;
    }
    if (title.length > MAX_TITLE_LEN) {
      title = title.slice(0, MAX_TITLE_LEN);
      longTitle += 1;
    }

    const url = cleanLink(row.Url);
    if (url && isLiveLink(url)) {
      live += 1;
      continue;
    }
    if (!url && row.Url) badUrl += 1;

    const key = identityOf(row, title);
    if (seen.has(key)) {
      dup += 1; // 同一件事在榜上出现两次：只留第一次（榜内的名次更靠前）
      continue;
    }
    seen.add(key);

    out.items.push({
      title,
      url,
      summary: summaryOf(i + 1, row.HotValue),
      author: null,
      /* ★★ 不编造时间（本项目的铁律，见 fetch-feeds.js 顶部第 ③ 条）。
         这个接口**根本不返回时间字段**：50 条数据的字段是
         ClusterId/Title/LabelUrl/Label/Url/HotValue/Schema/LabelUri/
         ClusterIdStr/ClusterType/QueryWord/Image/LabelDesc —— 只有热度，没有时间。
         ⇒ 时间是 null。**绝不用"抓取时刻"冒充** ——
            那会让"源没给时间"和"这条就是现在发的"混成一样，
            而且 50 条会是同一个时间戳，翻页与排序都会变得没有意义。 */
      publishedAt: null,
      sourceId: ctx.sourceId || null,
      sourceName: ctx.sourceName || null,
      format: 'json',
    });
  }

  if (noTitle) out.warnings.push('有 ' + noTitle + ' 条没有标题 —— 丢掉了（不编造标题）');
  if (dup) out.warnings.push('有 ' + dup + ' 条 ClusterId 重复 —— 只保留第一次出现的');
  if (live) out.warnings.push('有 ' + live + ' 条链接指向直播 —— 那不是资讯，丢掉了');
  if (badUrl) out.warnings.push('有 ' + badUrl + ' 条的链接解析不了 —— 如实存成"没有链接"');
  if (longTitle) out.warnings.push('有 ' + longTitle + ' 条标题超过 ' + MAX_TITLE_LEN + ' 字，已截断（没有丢条目）');
  out.warnings.push(
    '头条热榜接口不提供时间字段 —— 这些条目**没有发布时间**（存 NULL，不用抓取时刻冒充）',
  );

  out.ok = out.items.length > 0;
  if (!out.ok) out.warnings.push('接口返回了 ' + rows.length + ' 条，但没有一条能变成条目');
  return out;
}
