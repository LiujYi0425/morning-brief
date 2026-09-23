/**
 * src/ingest/entities.js —— XML 实体解码 + CDATA 处理（零依赖 · 纯函数）
 * =====================================================================
 * 为什么单独一个文件：**RSS 里的文本几乎全是转义过的**，而解码错了不会报错，
 * 只会让条目看起来"怪"。典型：
 *
 *   <title>AI 芯片 &amp; 国产替代 &lt;下&gt;</title>   → AI 芯片 & 国产替代 <下>
 *   <title><![CDATA[为什么 V8 的 GC 这么快]]></title> → 为什么 V8 的 GC 这么快
 *   <description>5 &lt; 10 &amp;&amp; 3 &gt; 1</description> → 5 < 10 && 3 > 1
 *
 * ⚠️ 为什么不用 `xml2js` / `fast-xml-parser`：
 *   装包在**无网环境下会失败**，而抓取层恰恰是最需要能离线跑测试的部分。
 *   这几个函数就是自带的"最小够用"解析，且**可被穷举断言**。
 *
 * ⚠️ 解码顺序是**硬性**的：`&amp;` 必须**最后**解。
 *   若先解 `&amp;`，那么 `&amp;lt;` 会被两次解码成 `<` ——
 *   而它在原文里的正确含义是字面量 `&lt;`。**这是 XML 解析的经典陷阱。**
 * =====================================================================
 */

/**
 * 解码 XML / HTML 命名实体与数字实体。
 *
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (typeof s !== 'string' || s === '') return '';

  // ---- 第一遍：数字实体（它们不可能再产生 & ，放前面安全）----
  let out = s.replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
    const cp = parseInt(hex, 16);
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? safeFromCodePoint(cp) : m;
  });
  out = out.replace(/&#(\d+);/g, (m, dec) => {
    const cp = parseInt(dec, 10);
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? safeFromCodePoint(cp) : m;
  });

  // ---- 第二遍：命名实体 ----
  // ⚠️ 只收"喂 RSS 时真的会见到"的那些。刻意不做全表 ——
  //    全表会引入 2000 行没人看的映射，而没人看的东西就会腐烂。
  const NAMED = {
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
    ndash: '\u2013',
    mdash: '\u2014',
    hellip: '\u2026',
    lsquo: '\u2018',
    rsquo: '\u2019',
    ldquo: '\u201c',
    rdquo: '\u201d',
    middot: '\u00b7',
    laquo: '\u00ab',
    raquo: '\u00bb',
  };
  out = out.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
    const hit = NAMED[name];
    return hit === undefined ? m : hit;
  });

  // ---- 第三遍：`&amp;` **最后**解（见文件头说明）----
  out = out.replace(/&amp;/g, '&');

  return out;
}

/** 从一个码点安全地取字符（挡掉代理区，避免产出半个字符） */
function safeFromCodePoint(cp) {
  if (cp >= 0xd800 && cp <= 0xdfff) return '\ufffd';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '\ufffd';
  }
}

/**
 * 取出 CDATA 的**内容**；不是 CDATA 就原样返回。
 *
 * 为什么单独处理：CDATA 里的内容**已经是不转义的原文**，
 * 再跑一次 `decodeEntities` 会把原文里合法的 `&amp;` 变成 `&` —— 那是错的。
 *
 * @param {string} s
 * @returns {{ text: string, wasCdata: boolean }}
 */
export function unwrapCdata(s) {
  if (typeof s !== 'string') return { text: '', wasCdata: false };
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (m) return { text: m[1], wasCdata: true };
  return { text: s, wasCdata: false };
}

/**
 * 把一段"可能是 CDATA、也可能含实体"的原文洗干净。
 *
 * 口径：**CDATA 原样取，非 CDATA 才解码** —— 这正是上面那个"不要二次解码"的落地。
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanText(raw) {
  const { text, wasCdata } = unwrapCdata(raw);
  return wasCdata ? text : decodeEntities(text);
}

/**
 * 压掉无用空白：折叠连续空白 → 单空格，并 trim。
 * 中文文本里换行与缩进是噪音，会让"去重比对"和"界面换行"都变难看。
 *
 * @param {string} s
 * @returns {string}
 */
export function collapseWhitespace(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\s\u00a0]+/g, ' ').trim();
}

/**
 * 去掉 HTML 标签（description 里常常整段是 HTML）。
 *
 * ⚠️ 这是**粗粒度**清理，不是 HTML 解析器。目标是"给摘要素材"，
 *    不是"还原页面"。所以：
 *      · `<script>` / `<style>` 整块丢掉（它们的**内容**不是正文）
 *      · 其余标签只去标签、留文字
 *      · 顺手把 `<br>` / `</p>` 变成空格，避免两个词黏在一起
 *
 * @param {string} s
 * @returns {string}
 */
export function stripHtml(s) {
  if (typeof s !== 'string' || s === '') return '';
  let out = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return collapseWhitespace(out);
}
