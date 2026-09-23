/**
 * src/ingest/urls.js —— URL 归一化 + 去重指纹（零依赖 · 纯函数）
 * =====================================================================
 * 一句话：**判断"这两条是不是同一条资讯"，靠的是这里的指纹。**
 *
 * ---------------------------------------------------------------------
 * 为什么归一化必须做（不做就会满屏重复）
 * ---------------------------------------------------------------------
 * 同一个页面在不同源、不同天会出现成这些形态：
 *
 *   https://example.com/post/1
 *   https://example.com/post/1?utm_source=rss&utm_medium=feed
 *   http://Example.COM/post/1/
 *   https://www.example.com/post/1#comments
 *
 * 它们**是同一条**。若直接拿原始 URL 比对，会把同一条新闻展示 4 次 ——
 * 而"去重"是这个产品能不能看的第一道门槛。
 *
 * ⚠️ 但**去掉什么**要非常克制：只去**公认的跟踪参数**，
 *    绝不去掉 `?id=123` / `?p=456` 这类**确实是内容标识**的参数。
 *    去多了会把不同文章合并成一条（比重复更糟：**静默丢内容**）。
 * =====================================================================
 */

/** 公认的跟踪/营销参数（只去这些，见文件头"克制"那段） */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'spm',
  'scm',
  'from',
  'from_source',
  'share_source',
  'share_medium',
  'share_plat',
  'share_token',
  'share_session_id',
  'ref',
  'referrer',
  'fbclid',
  'gclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'hmsr',
  'hmpl',
  'hmcu',
  'hmkw',
  'hmci',
  '__twitter_impression',
]);

/**
 * 归一化 URL，用于**比对**（不用于展示、不用于请求）。
 *
 * 做四件事：
 *   ① 协议统一为 https（http→https 视作同一资源）
 *   ② host 小写、去掉开头的 `www.`
 *   ③ 去掉 fragment（`#...`）与跟踪参数
 *   ④ 去掉末尾斜杠（根路径除外）
 *
 * ⚠️ **解析失败时返回"原样的小写去空白"**，而不是空串 ——
 *    返回空串会让所有坏 URL 变成同一条，那是**静默合并**。
 *    宁可让坏的看起来不一样（重复一次），也不要让它们看起来一样（丢内容）。
 *
 * @param {string} raw
 * @returns {string}
 */
export function canonicalizeUrl(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (s === '') return '';

  let u;
  try {
    u = new URL(s);
  } catch {
    return s.toLowerCase();
  }

  // ① 协议：只对 http/https 统一，其它（mailto / magnet…）原样
  let protocol = u.protocol;
  if (protocol === 'http:' || protocol === 'https:') protocol = 'https:';

  // ② host
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const port =
    u.port && !((protocol === 'https:' && u.port === '443') || (protocol === 'http:' && u.port === '80'))
      ? ':' + u.port
      : '';

  // ③ 查询串：逐项过滤跟踪参数，并**按 key 排序**（参数顺序不同不该算不同）
  const pairs = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    pairs.push([k, v]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = pairs.length
    ? '?' + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  // ④ path：去末尾斜杠（根路径 `/` 除外）
  let pathname = u.pathname || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.replace(/\/+$/, '');

  // fragment 直接丢（`#comments` 与正文是同一页）
  return `${protocol}//${host}${port}${pathname}${query}`;
}

/**
 * 32 位 FNV-1a 哈希，输出 8 位十六进制。
 *
 * ⚠️ 刻意**不用** `crypto.createHash`：这里只需要"够用的指纹"，
 *    而且要能在任何环境（含渲染进程）同步算。FNV-1a 的实现只有 6 行，
 *    而"引一个加密库来做去重"是明显的过度工程。
 *
 * @param {string} s
 * @returns {string}
 */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  const str = typeof s === 'string' ? s : String(s ?? '');
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    // 乘 16777619（FNV prime），用移位避免 32 位溢出
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 标题指纹：**去掉一切非字母数字与汉字之后**再哈希。
 *
 * 为什么要这么狠地归一：同一个源在不同天会把同一标题加上
 * `【早报】` / `[译]` / 尾部 ` - 机器之心` / 全角与半角混用 等前缀后缀。
 * 只做 trim + 小写是抓不住这些的。
 *
 * @param {string} title
 * @returns {string}
 */
export function titleFingerprint(title) {
  const t = typeof title === 'string' ? title : '';
  // 只留：中日韩统一表意文字、字母、数字。其余（空白/标点/emoji）全丢
  const core = t
    .replace(/[\u3000-\u303f\uff00-\uffef]/g, '') // 中文标点与全角
    .replace(/[^\u4e00-\u9fff\u3400-\u4dbfa-zA-Z0-9]/g, '')
    .toLowerCase();
  if (core === '') return '';
  return fnv1a(core);
}

/**
 * 一条资讯的去重键。
 *
 * 优先级：**URL 优先，标题兜底**。
 *   · 有 URL → 用 URL 指纹（最可靠：同一条新闻转发到多个源，URL 往往相同）
 *   · 没 URL → 退回标题指纹（有些源的 item 不给 link）
 *   · 两个都没有 → 返回空串，调用方应视作"无法去重"并**如实登记**，
 *     而不是塞同一个键把它们合并掉（那会静默丢内容）
 *
 * @param {{url?: string, title?: string}} item
 * @returns {string}
 */
export function dedupeKey(item) {
  const canon = canonicalizeUrl(item && item.url ? item.url : '');
  if (canon) return 'u:' + fnv1a(canon);
  const tf = titleFingerprint(item && item.title ? item.title : '');
  if (tf) return 't:' + tf;
  return '';
}
