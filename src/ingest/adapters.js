/**
 * src/ingest/adapters.js —— 「这条源不是 feed，是某个站点的 JSON 接口」的登记处
 * =====================================================================
 * 一句话：**给一个源地址，回答"该用哪个解析器"。**
 *
 * ---------------------------------------------------------------------
 * 为什么需要一个登记处，而不是在抓取层写 if
 * ---------------------------------------------------------------------
 * 抓取层（fetch-feeds.js）只该做三件事：取、解析、入库。
 * 一旦把"这个域名要用那个解析器"写进抓取流程，每加一个站点就要动一次核心循环，
 * 而且那段判断会**跟着 ipc/electron 一起变得不可断言**。
 * ⇒ 拆成这个零依赖文件：一个纯函数（地址 -> 适配器），
 *   可以离线穷举"认得哪些、不误伤哪些"。
 *
 * ⚠️ 与 feed-parse.js 里那条 **JSON Feed 分支**不是一回事，别合并：
 *   · JSON Feed（jsonfeed.org）是**一种通用格式**，任何站点都可能给，
 *     所以它住在 feed-parse.js 里，按"内容长什么样"判定；
 *   · 本文件里的适配器是**某个站点私有的接口形状**，
 *     必须按"地址是谁"判定 —— 拿头条的解析器去解别的 JSON 只会得到垃圾。
 * =====================================================================
 */

import { parseToutiaoHot } from './parse-toutiao.js';

/** 去掉开头的 www.，统一小写 —— 与 urls.js 的归一化口径一致 */
function bareHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

/**
 * 原生适配器表。
 *
 * 每一项：
 *   · id       —— 日志与断言里用的稳定名字
 *   · site     —— 给人看的站点名
 *   · matches  —— 纯判定：这个地址归它管吗
 *   · parse    —— 与 parseFeed **同构**的解析函数
 */
export const ADAPTERS = [
  {
    id: 'toutiao-hot',
    site: '今日头条',
    /* ⚠️ 判据要**窄**：只认头条站内 /hot-event/ 下面的接口。
       按整站认（只要是 toutiao.com 就交给它）会误伤两种真实情况：
         · 用户在别处找到的头条 feed 地址（拿到 HTML/XML，会被这个解析器报成"不是 JSON"）
         · 以后头条真的出了 feed，而它永远不会被认出来
       窄判据的失败方式是"没认出来，走通用解析器"——那是**安全**的那一侧。 */
    matches(feedUrl) {
      let u;
      try {
        u = new URL(String(feedUrl || ''));
      } catch {
        return false;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const host = bareHost(u.hostname);
      if (host !== 'toutiao.com' && !host.endsWith('.toutiao.com')) return false;
      return /^\/hot-event\//.test(u.pathname);
    },
    parse: parseToutiaoHot,
  },
];

/**
 * 这个地址该用哪个原生适配器？没有就返回 null（走通用 feed 解析）。
 *
 * @param {string} feedUrl
 * @returns {{id:string, site:string, matches:Function, parse:Function}|null}
 */
export function adapterFor(feedUrl) {
  const s = String(feedUrl || '');
  if (!s) return null;
  for (const a of ADAPTERS) {
    try {
      if (a.matches(s)) return a;
    } catch {
      /* 判定自己出错时**当作不匹配** —— 绝不让一个适配器的判定把整轮抓取带崩 */
    }
  }
  return null;
}
