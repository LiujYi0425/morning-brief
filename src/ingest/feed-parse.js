/**
 * src/ingest/feed-parse.js —— RSS / Atom / RDF 解析（零依赖 · 纯函数）
 * =====================================================================
 * 一句话：**把一段 feed 的 XML 文本，变成一组结构化条目。**
 *
 * ---------------------------------------------------------------------
 * 为什么自己写而不用现成的解析库
 * ---------------------------------------------------------------------
 * `xml2js` / `fast-xml-parser` 都要 `npm i`，而**装包在无网环境下会失败** ——
 * 抓取层恰恰是最需要能离线跑测试的部分。而这三种格式的**实际形状非常固定**，
 * 固定到"够用的正则解析 + 充分的用例"比"完整 XML 解析器"更划算：
 *
 *   · 我们只要 `<item>` / `<entry>` 里的**几个字段**
 *   · feed 里**不会有**深层嵌套（这不是任意 XML，是约定俗成的三种格式）
 *   · 正则实现能让每一条口径都被**离线穷举断言**（见 tools/test-all.mjs）
 *
 * ⚠️ **代价要说清楚**：这不处理"命名空间前缀变体"以外的一切 XML 复杂度
 *    （实体定义、DTD、混合内容里的嵌套同名标签）。真实 feed 里这些不出现；
 *    一旦出现，解析会**少字段**而不是报错 —— 所以 `parseFeed` 会如实报告
 *    自己识别到几条、以及有没有"看起来像条目但没解析出来"的迹象。
 *
 * ---------------------------------------------------------------------
 * 支持的三种格式（覆盖绝大多数真实源）
 * ---------------------------------------------------------------------
 *   RSS 2.0  <rss><channel><item><title/><link/><pubDate/><description/>
 *   Atom     <feed><entry><title/><link href=""/><updated/><summary/>
 *   RDF/RSS1 <rdf:RDF><item rdf:about=""><title/><link/><dc:date/>
 * =====================================================================
 */

import { cleanText, collapseWhitespace, stripHtml } from './entities.js';

/**
 * 取一对标签之间的原文（第一个匹配）。
 *
 * ⚠️ 标签名要容忍**命名空间前缀**（`dc:date` / `content:encoded`），
 *    所以模式是 `(?:\w+:)?name`，否则 `content:encoded` 会被漏掉。
 *
 * @param {string} xml
 * @param {string} tag
 * @returns {string|null}
 */
function pick(xml, tag) {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}\\s*>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** 取一个自闭合/带属性的标签上的某个属性值 */
function pickAttr(xml, tag, attr) {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']*)["'][^>]*>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

/**
 * 把 feed 里的时间字符串变成 ISO 8601。
 *
 * RSS 用 RFC 822（`Tue, 22 Sep 2026 10:00:00 +0800`），
 * Atom 用 RFC 3339（`2026-09-22T10:00:00+08:00`）。
 * `new Date()` 对**两者都能解析**，所以这里主要是兜底：
 * 解析不出来时返回 `null`，由调用方决定（**不编造当前时间** —— 那会让
 * "源没给时间"和"这条就是现在发的"混成一样）。
 *
 * @param {string|null} s
 * @returns {string|null} ISO 字符串
 */
export function parseDate(s) {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const t = Date.parse(s.trim());
  if (!Number.isFinite(t)) return null;
  // 明显的脏数据（1970 / 2100 之后）当作没给 —— 有些源会给 '0000-00-00'
  const d = new Date(t);
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2100) return null;
  return d.toISOString();
}

/** 从一段 XML 里按优先级取第一个非空字段 */
function firstOf(xml, tags) {
  for (const t of tags) {
    const raw = pick(xml, t);
    if (raw !== null && raw.trim() !== '') return raw;
  }
  return null;
}

/**
 * 猜一段内容到底是什么。
 *
 * ⚠️ 为什么需要它（真机实测的教训）：第一版对"认不出"只报
 *    「认不出这是 RSS / Atom / RDF —— 既没有 <item> 也没有 <entry>」。
 *    而用户拿到这条**完全不知道该做什么** —— 是要换地址？还是这个源挂了？
 *    还是被墙了？**报错不指向下一步，就等于没报。**
 *
 * ⇒ 这里给出可操作的判断：它像一个网页？一段 JSON？还是被拦截页？
 *
 * @param {string} body
 * @returns {string}
 */
export function sniffContentKind(body) {
  const head = body.slice(0, 4000);
  if (!head.trim()) return '空内容';
  if (/^\s*[[{]/.test(head)) return 'JSON（不是 feed）';
  /* ⚠️ 反爬页必须在 HTML 判定**之前**判（这里原来顺序反了，那条分支是死代码）。
     真机取证（R2 实测）：36氪 `/feed` 会间歇性返回 HTTP 200 + 一张 JS 安全挑战页，
     正文是 HTML ⇒ 老顺序一律报成"HTML 网页（不是 feed）"，
     用户看到的结论是"这个源地址不对"，而真相是"被拦了、重试可能就好了"。
     **诊断文案指错方向比没有诊断更糟。** */
  if (/验证码|安全验证|请稍候|正在进行安全检测|Just a moment|cf-browser-verification|Checking your browser/i.test(head)) {
    return '疑似反爬 / 人机验证页（不是 feed）';
  }
  if (/<(html|!doctype\s+html)\b/i.test(head)) return 'HTML 网页（不是 feed）';
  /* ⚠️ 不能靠"必须以 <?xml 开头"判断是不是 feed：InfoQ 中文的 feed
     **没有 XML 声明**，正文直接以 `<rss` 开头（R2 实测）。 */
  if (/<(rss|feed|rdf:RDF)\b/i.test(head)) return 'XML 但它没有条目（源可能是空的）';
  if (/^\s*<\?xml/.test(head)) return 'XML（根元素不是 rss/feed/rdf:RDF）';
  return '无法识别的内容类型';
}

/** 取一小段预览，供日志定位（压掉换行、限长） */
export function previewOf(body, n = 120) {
  return String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

/**
 * 解析一段 feed。
 *
 * @param {string} xml
 * @param {{sourceId?: string, sourceName?: string, feedUrl?: string}} [ctx]
 * @returns {{ok: boolean, format: string|null, title: string|null, items: Array<object>, warnings: string[], rawBlockCount: number}}
 */
export function parseFeed(xml, ctx = {}) {
  const out = {
    ok: false,
    format: null,
    title: null,
    items: [],
    warnings: [],
    rawBlockCount: 0,
    /** 认不出时填：内容看起来是什么（JSON / HTML / 反爬页…） */
    contentKind: null,
    /** 认不出时填：开头预览，供定位 */
    preview: null,
  };

  if (typeof xml !== 'string' || xml.trim() === '') {
    out.warnings.push('feed 内容为空');
    return out;
  }

  // 去掉 BOM 与 XML 声明（声明里的 encoding 对已经解码成字符串的输入没有意义）
  let body = xml.replace(/^\uFEFF/, '').replace(/<\?xml[\s\S]*?\?>/i, '');
  // 注释整块丢掉 —— 有些源用注释包住历史条目
  body = body.replace(/<!--[\s\S]*?-->/g, '');

  /* ---- 判定格式 + 切出条目块 ----
   *
   * ⚠️ 判定顺序与模式都不能想当然（这里踩过一次）：
   *   最初写成 `/<(?:rdf:)?item\b.../` 并把 RDF 排在 RSS 前面 ——
   *   于是**普通 RSS 也被认成 RDF**，因为那个 `rdf:` 前缀是可选的、
   *   任何 `<item>` 都会命中。后果是 `format` 字段说谎（测试当场抓住）。
   *
   * ⇒ 正确做法：**按根元素判格式，再按该格式切条目**。
   *   根元素是唯一的、不会被前缀可选性搞混。 */
  const rootIsAtom = /<feed\b[^>]*xmlns\s*=\s*["'][^"']*Atom/i.test(body) || /<feed\b/i.test(body);
  const rootIsRdf = /<rdf:RDF\b/i.test(body);
  const rootIsRss = /<rss\b/i.test(body);

  let blocks = [];
  if (rootIsAtom) {
    out.format = 'atom';
    blocks = body.match(/<entry\b[\s\S]*?<\/entry\s*>/gi) || [];
  } else if (rootIsRdf) {
    out.format = 'rdf';
    blocks = body.match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
  } else if (rootIsRss) {
    out.format = 'rss';
    blocks = body.match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
  } else {
    // 没有已知根元素：最后再试着按"有没有 entry / item"兜一次，并**如实标注**
    const entries = body.match(/<entry\b[\s\S]*?<\/entry\s*>/gi) || [];
    const items = body.match(/<item\b[\s\S]*?<\/item\s*>/gi) || [];
    if (entries.length) {
      out.format = 'atom';
      blocks = entries;
      out.warnings.push('没有 <feed> 根元素，但发现 <entry> —— 按 Atom 尝试解析（格式为推断）');
    } else if (items.length) {
      out.format = 'rss';
      blocks = items;
      out.warnings.push('没有 <rss>/<rdf:RDF> 根元素，但发现 <item> —— 按 RSS 尝试解析（格式为推断）');
    }
  }

  if (!blocks.length) {
    // 认不出条目：可能是空 feed（合法）、也可能格式不认识（问题）
    const looksLikeFeed = /<(rss|feed|rdf:RDF)\b/i.test(body);
    if (looksLikeFeed) {
      out.warnings.push('feed 合法但没有任何条目（源可能是空的）');
    } else {
      /* ★ 报错必须**指向下一步**（真机实测的教训）。
         只说"认不出"用户不知道该换地址、还是源挂了。所以要说清：
         它看起来是什么、以及开头长什么样。 */
      out.contentKind = sniffContentKind(body);
      out.preview = previewOf(body);
      out.warnings.push(
        `不是可解析的 feed —— 实际拿到的是【${out.contentKind}】。` +
          `开头：${out.preview}`,
      );
    }
    return out;
  }

  out.rawBlockCount = blocks.length;

  // 频道标题（Atom 是 <feed><title>，RSS 是 <channel><title>）
  const chanTitle = pick(body, 'title');
  out.title = chanTitle ? collapseWhitespace(cleanText(chanTitle)) || null : null;

  /* ---- 逐条解析 ---- */
  for (const block of blocks) {
    const item = parseItem(block, out.format, ctx);
    if (item) out.items.push(item);
  }

  /* ---- 一致性检查：不该"识别到 N 块、却只解析出很少" ---- */
  if (out.rawBlockCount > 0 && out.items.length < out.rawBlockCount) {
    out.warnings.push(
      `识别到 ${out.rawBlockCount} 个条目块，但只有 ${out.items.length} 条有标题 —— ` +
        `缺标题的条目被丢弃（不编造标题）`,
    );
  }

  out.ok = out.items.length > 0;
  return out;
}

/**
 * 解析单个条目块。**没有标题就返回 null**（不编造）。
 * @param {string} block
 * @param {string} format
 * @param {{sourceId?: string, sourceName?: string}} ctx
 */
function parseItem(block, format, ctx) {
  // 标题：Atom 有 type="html" 的可能带标签；RSS 常见 CDATA
  const rawTitle = firstOf(block, ['title']);
  const title = rawTitle === null ? '' : collapseWhitespace(stripHtml(cleanText(rawTitle)));
  if (title === '') return null;

  /* ---- 链接 ----
     RSS/RDF：<link>https://…</link>
     Atom   ：<link href="https://…"/>（可能多个，rel="alternate" 才是正文页） */
  let url = null;
  const rssLink = pick(block, 'link');
  if (rssLink && rssLink.trim() && !rssLink.includes('<')) {
    url = collapseWhitespace(cleanText(rssLink));
  }
  if (!url) {
    // Atom：优先 rel="alternate"，其次第一个带 href 的 link
    const alt = block.match(/<link\b[^>]*\brel\s*=\s*["']alternate["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i);
    const any = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i);
    const href = (alt && alt[1]) || (any && any[1]) || null;
    if (href) url = collapseWhitespace(cleanText(href));
  }
  // RDF 的 rdf:about 也可以当链接兜底
  if (!url) {
    const about = pickAttr(block, 'item', 'rdf:about');
    if (about) url = collapseWhitespace(about);
  }
  /* ★ `<guid>` 兜底（真机取证：R2 实测「安全客」的 item **完全没有 `<link>`**，
     正文地址只存在于 `<guid>` 里）。少了这一条，那个源的所有条目都会被存成
     "没有原文链接" —— 用户点上去只会得到一句"这条没有链接"，
     而链接其实就在同一段 XML 里。
     ⚠️ 只接受看起来像 URL 的 guid：很多源的 guid 是 `tag:xxx,2020:1` 或纯数字，
        把那种东西当链接会产出一堆打不开的地址（比没有链接更糟）。 */
  if (!url) {
    const guid = pick(block, 'guid');
    const g = guid ? collapseWhitespace(cleanText(guid)) : '';
    if (/^https?:\/\//i.test(g)) url = g;
  }

  /* ---- 时间：按覆盖度排序尝试 ---- */
  const rawDate = firstOf(block, ['pubDate', 'published', 'updated', 'dc:date', 'date']);
  const publishedAt = parseDate(rawDate ? collapseWhitespace(cleanText(rawDate)) : null);

  /* ---- 正文/摘要 ---- */
  const rawDesc = firstOf(block, ['content:encoded', 'content', 'summary', 'description']);
  const summaryRaw = rawDesc === null ? '' : stripHtml(cleanText(rawDesc));
  // 摘要与标题一样长时没信息量，丢掉（有些源把标题复制进 description）
  const summary = summaryRaw && summaryRaw !== title ? summaryRaw : '';

  /* ---- 作者 ---- */
  const rawAuthor = firstOf(block, ['dc:creator', 'author', 'name']);
  const author = rawAuthor ? collapseWhitespace(stripHtml(cleanText(rawAuthor))) || null : null;

  return {
    title,
    url,
    summary,
    author,
    publishedAt,
    sourceId: ctx.sourceId || null,
    sourceName: ctx.sourceName || null,
    format,
  };
}
