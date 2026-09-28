/**
 * src/ingest/feed-discover.js —— **Feed 自动发现**（纯函数、零依赖，可离线穷举）
 * =====================================================================
 * 为什么需要它（2026-09-28，用户要「让每个人都能用到更多资讯途径」）：
 *   「添加源」现在要求用户**粘贴一个 feed 地址** —— 而绝大多数人手上只有
 *   **网站首页**（比如 `https://www.example.com/`），于是最常见的结局是：
 *   粘进去 → 一句「这个地址不是可解析的 feed」→ 用户放弃。
 *   而很多站点其实**自己声明了** feed 地址，就藏在 HTML 的
 *   `<link rel="alternate" type="application/rss+xml" href="…">` 里
 *   （浏览器地址栏/RSS 阅读器就是靠它自动发现的，这是 Web 标准做法）。
 *
 * ⚠️ 与口径①「不抓 HTML 页面」的关系（必须写清楚，否则下一个人会以为违规）：
 *   口径①禁的是**把网页正文当内容源**（反爬与合规风险的入口）。
 *   这里只读**一条声明**：`<link rel="alternate">` 的 href，
 *   不解析正文、不跟随页面里的 <a>、不做任何对抗性抓取。
 *   ⇒ 正文照旧只来自 feed 本身。
 *
 * ⚠️ 抽成纯函数而不是写在 index.js 里：index.js 顶层 import electron，
 *    离线考裁判加载不了 —— 写在那里等于**永远没有断言**（本项目的既定分工）。
 *
 * ⚠️ **别把它当成万能钥匙**（2026-09-28 实测命中率，如实记下来）：
 *    拿 7 个中文站点首页跑了一遍，**只有 1 个**真的在 `<link rel="alternate">` 里
 *    声明了 feed（Solidot → `/index.rss`，17 条；另外 5 个页面压根没声明，
 *    geekpark 直接 403）。原因是现在多数站点是 JS 渲染的，feed 只挂在 JS 里。
 *    ⇒ 它的价值是"**本来完全加不进来**的那些站点，现在能一把加进来"，
 *      而不是"大部分网站都能自动加"。失败时的文案也照实说
 *      「页面上也没有声明 feed 地址」，而不是含糊的"添加失败"。
 */

/** 认得的 feed MIME 类型（按优先级排序；JSON Feed 的规范类型是 application/feed+json）。 */
export const FEED_MIME_TYPES = Object.freeze([
  'application/rss+xml',
  'application/atom+xml',
  'application/rdf+xml',
  'application/feed+json',
  /* ⚠️ 泛型的 application/json **排在最后**：很多站点把无关的 JSON 也声明成它，
     但它确实是部分 JSON Feed 的实现写法 —— 所以"认，但排在最后"。 */
  'application/json',
]);

/** 一次最多返回几个候选（多了会变成"替用户猜"；按页面声明的顺序取前几个）。 */
export const DEFAULT_LIMIT = 5;

/** 扫描上限：只在前 512KB 里找 —— 声明都在 <head>，扫全文只是白花时间。 */
const SCAN_LIMIT = 512 * 1024;

/* 属性解析：`rel="alternate"` / `rel='alternate'` / `rel=alternate` 三种写法都要认。
   ⚠️ 不用 DOMParser：这里是零依赖的纯 Node 模块（渲染层那套 DOM 在考裁判里不存在）。 */
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** 把 `<link …>` 的属性串解析成小写键的字典（无值属性给空串）。 */
function parseAttrs(raw) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) {
    const key = m[1].toLowerCase();
    if (out[key] === undefined) out[key] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '';
  }
  /* 无值属性（如 `rel=alternate` 之外还有 `<link alternate>` 这种极少数写法）：
     单独扫一遍裸 token，只为 `alternate` 这一个词的兼容。 */
  if (out.rel === undefined && /(^|\s)alternate(\s|$)/i.test(raw)) out.rel = 'alternate';
  return out;
}

/**
 * 从一个 HTML 页面里找出它**自己声明**的 feed 地址。
 *
 * @param {string} html 页面正文（可以是任意大小；只在前面一段里扫）
 * @param {string} baseUrl 页面地址 —— 相对 href（很常见：`href="/feed"`）靠它解析成绝对地址
 *   ⚠️ baseUrl 解析不了时**一律返回空数组**（连绝对地址也不返回）：
 *      Node 的 URL 构造器在 base 不合法时对绝对地址同样抛错，
 *      而纯函数的取舍是「宁可返回空，也不返回一个猜出来的地址」。
 *      调用方传的是刚校验过的地址，所以这条在实际路径上不会发生。
 * @param {{limit?:number}} [opts]
 * @returns {string[]} 绝对地址，按页面声明顺序、已去重；解析不了的一律丢掉
 */
export function discoverFeedLinks(html, baseUrl, { limit = DEFAULT_LIMIT } = {}) {
  const text = String(html == null ? '' : html).slice(0, SCAN_LIMIT);
  if (!text) return [];
  const out = [];
  const seen = new Set();
  const linkRe = /<link\b([^>]*)>/gi;
  let m;
  while ((m = linkRe.exec(text))) {
    const attrs = parseAttrs(m[1]);
    /* ① 必须是 alternate（rel 可以是 "alternate feed" 这种多值） */
    if (!attrs.rel || !/(^|\s)alternate(\s|$)/i.test(attrs.rel)) continue;
    /* ② type 必须是认得的 feed 类型；没写 type 的**不认**（宁缺勿滥：
           `<link rel="alternate" hreflang="en" href="…">` 是语言版本，不是 feed） */
    const type = String(attrs.type || '').trim().toLowerCase().split(';')[0].trim();
    if (!FEED_MIME_TYPES.includes(type)) continue;
    const href = String(attrs.href || '').trim();
    if (!href) continue;

    let abs;
    try {
      /* ⚠️ HTML 里 `&amp;` 是转义写法，必须解回来，
         否则带参数的 feed 地址（`?a=1&amp;b=2`）会存成一个打不开的地址。 */
      const decoded = href.replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&');
      const u = new URL(decoded, baseUrl);
      /* ③ 只认 http(s)：`javascript:` / `data:` 之类一律丢（安全边界） */
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      u.hash = '';   // 片段对 feed 没意义，留着会让"同一个地址"变成两个
      abs = u.href;
    } catch {
      continue;      // 相对地址 + baseUrl 也解析不了 ⇒ 丢掉，不猜
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= limit) break;
  }
  return out;
}
