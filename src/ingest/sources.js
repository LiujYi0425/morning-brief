/**
 * src/ingest/sources.js —— 预置源包（可增删）
 * =====================================================================
 * 选源的四条口径：
 *   ① **只要 RSS / Atom**。不抓 HTML 页面 —— 那是反爬与合规风险的入口，
 *      而这个项目明确不做需要登录态或对抗性抓取的内容。
 *   ② **中文科技/新闻优先**（用户是中文读者），配少量英文技术源做补充。
 *   ③ **按类别预打标签**（需求 2 的筛选需要初始分类，否则一上来是空的）。
 *   ④ **每个源都要能被单独关掉** —— 源挂了是常态，不能让一个源拖垮整份简报。
 *
 * ⚠️ 源地址会失效、会改版、会被墙。所以：
 *   · `enabled` 可以关；
 *   · 抓取失败**必须留痕并在界面可见**（`source_state.consecutive_fail`）；
 *   · 这份清单是**起点不是契约** —— 你随时可以增删，界面会读库里的 source 表。
 *
 * ⚠️ 这份清单里我**没有逐个实测过可用性**（本会话出网被拦，见下）。
 *    所以第一次跑 `npm run ingest` 时请留意每个源的结果 ——
 *    失败的会在 `source_state` 里留下 `last_status` / `last_error`。
 * =====================================================================
 */

/** 预置类别（需求 2：用户自定义固定类别 —— 这是初始值，之后可增删改） */
export const DEFAULT_CATEGORIES = [
  'AI 与算力',
  '开源与工程',
  '行业动态',
  '产品与设计',
  '国际要闻',
  '安全与隐私',
  '科学新知',
  '游戏与娱乐',
];

/**
 * 预置源。`categories` 用于新条目**自动打初始标签**（阶段 2 会加上用户自定义的
 * 关键词规则，届时这里是兜底）。
 *
 * ---------------------------------------------------------------------
 * ⚠️ 2026-09-22 真机首次抓取的实测结果（**源清单据此调整过**）
 * ---------------------------------------------------------------------
 *   成功：量子位 / InfoQ 中文 / Solidot / 少数派 / GitHub Blog
 *   失败 A（`fetch failed`）：Hacker News / Ars Technica / BBC World
 *     ⇒ **全部是国外站**。规律很清楚：这不是代码问题，是**网络可达性**。
 *        失败的三个已**默认关闭**（见下方 `enabled: false`）——
 *        留着它们只会让界面一直显示"3 个源异常"，而那是环境事实、不是缺陷。
 *        **有代理的机器可以把它们打开。**
 *   失败 B（"认不出是 feed"）：机器之心 / 36氪
 *     ⇒ 地址本身不对（返回的不是 feed）。见下方说明。
 *
 * ⚠️ 这份清单**不保证每个地址长期有效** —— feed 会改版、会关停。
 *    所以：① 每个源都能单独关闭；② 抓取失败会记进 `source_state` 并在界面显示；
 *    ③ `npm run ingest -- --dry` 可以只测连通性、不入库。
 * =====================================================================
 */

/**
 * 预置源。
 *
 * `enabled: false` 的条目**会写进库但默认不抓** —— 这样用户能在设置里看到
 * "有这个源、只是关着"，而不是根本不知道它存在。
 */
export const DEFAULT_SOURCES = [
  // ==================================================================
  // A. **实测确认为真 feed**（R2 逐个抓取响应体，看到的是 XML/JSON 本身）
  //    —— 这一组是默认启用的主力，覆盖 6 个类别。
  // ==================================================================
  { name: '量子位', feedUrl: 'https://www.qbitai.com/feed', kind: 'rss', categories: ['AI 与算力'] },
  { name: 'InfoQ 中文', feedUrl: 'https://www.infoq.cn/feed', kind: 'rss', categories: ['开源与工程'] },
  { name: 'Solidot', feedUrl: 'https://www.solidot.org/index.rss', kind: 'rss', categories: ['开源与工程', '科学新知'] },
  { name: '少数派', feedUrl: 'https://sspai.com/feed', kind: 'rss', categories: ['产品与设计'] },
  { name: 'IT之家', feedUrl: 'https://www.ithome.com/rss/', kind: 'rss', categories: ['行业动态'] },
  { name: '中新网即时', feedUrl: 'https://www.chinanews.com.cn/rss/scroll-news.xml', kind: 'rss', categories: ['行业动态'] },
  { name: '钛媒体', feedUrl: 'https://www.tmtpost.com/rss.xml', kind: 'rss', categories: ['行业动态', '产品与设计'] },
  { name: '华尔街见闻', feedUrl: 'https://dedicated.wallstreetcn.com/rss.xml', kind: 'rss', categories: ['行业动态'] },
  { name: '雪球', feedUrl: 'https://xueqiu.com/hots/topic/rss', kind: 'rss', categories: ['行业动态'] },
  { name: 'FreeBuf', feedUrl: 'https://www.freebuf.com/feed', kind: 'rss', categories: ['安全与隐私'] },
  { name: '安全客', feedUrl: 'https://api.anquanke.com/data/v1/rss', kind: 'rss', categories: ['安全与隐私'] },
  { name: '游研社', feedUrl: 'https://www.yystv.cn/rss/feed', kind: 'rss', categories: ['游戏与娱乐'] },
  { name: '机核', feedUrl: 'https://www.gcores.com/rss', kind: 'rss', categories: ['游戏与娱乐'] },
  { name: '触乐', feedUrl: 'https://www.chuapp.com/feed', kind: 'rss', categories: ['游戏与娱乐'] },
  { name: '掘金', feedUrl: 'https://juejin.cn/rss', kind: 'rss', categories: ['开源与工程'] },
  { name: '博客园', feedUrl: 'https://feed.cnblogs.com/blog/sitehome/rss', kind: 'atom', categories: ['开源与工程'] },
  { name: '阮一峰的网络日志', feedUrl: 'https://www.ruanyifeng.com/blog/atom.xml', kind: 'atom', categories: ['开源与工程'] },
  { name: '美团技术团队', feedUrl: 'https://tech.meituan.com/feed', kind: 'rss', categories: ['开源与工程'] },
  { name: 'GitHub Blog', feedUrl: 'https://github.blog/feed/', kind: 'rss', categories: ['开源与工程'] },

  // ==================================================================
  // B. 曾经写错地址 / 已改成付费或半死 —— **默认关闭**，但写进库让用户看得见
  // ==================================================================
  /* ⚠️ 机器之心：`https://www.jiqizhixin.com/rss` 返回 200 后 **302 跳到 /data-service**，
     页面上写着"机器之心数据服务已上线"并留了商务邮箱 ——
     即**官方已经把公开 RSS 撤成了付费/合作制数据服务**，免费 feed 不存在了。
     这不是 URL 写错，是产品决策。⇒ 默认关闭，AI 类内容由量子位承担。 */
  { name: '机器之心', feedUrl: 'https://www.jiqizhixin.com/rss', kind: 'rss', categories: ['AI 与算力'], enabled: false },

  /* ⚠️ 36氪原来在这里（B 组，`enabled: false`）。2026-09-24 挪到下面的 C 组并
     **默认开启** —— 它的地址是对的，返回的是间歇性的反爬页，
     而抓取层已经为"人机验证页"写了重试一次（见 fetch-feeds.js 的 RETRY_NOT_FEED）。
     放在 B 组（"地址写错/半死"）与事实不符，会误导下一个人别再试。 */

  // 境外源：本机实测 `fetch failed`（DNS/TCP 层不可达）。**有代理就打开。**
  { name: 'Hacker News', feedUrl: 'https://hnrss.org/frontpage', kind: 'rss', categories: ['开源与工程'], enabled: false },
  { name: 'Ars Technica', feedUrl: 'https://feeds.arstechnica.com/arstechnica/index', kind: 'rss', categories: ['行业动态'], enabled: false },
  { name: 'BBC World', feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml', kind: 'rss', categories: ['国际要闻'], enabled: false },
  { name: 'BBC 中文', feedUrl: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', kind: 'rss', categories: ['国际要闻'], enabled: false },

  /* ==================================================================
   * C. 2026-09-24 实测补入（本轮）：官方 / 可用 feed
   *
   * ⚠️ 这一组**每一个地址都是我当场用项目自己的 fetchText + parseFeed 验过的**，
   *    不是抄来的。结论写在每个源下面 —— 包括"验不过的"为什么还留着。
   * ================================================================== */

  /* ★ 澎湃新闻：官方**没有** RSS。能抓到的是 RSSHub 的公共镜像。
     实测（同一地址连测 4 次）：rsshub.rssforever.com 3 次成功、19 条真新闻；
     feedx.net 与 rsshub.app **4 次全部失败**（本机不可达）。
     ⇒ 镜像可用，但要如实告诉用户："这是第三方代抓，不保证长期可用"。
     放在 enabled:true：本机实测能抓到，而且它是用户要的来源之一。 */
  {
    name: '澎湃新闻',
    feedUrl: 'https://rsshub.rssforever.com/thepaper/featured',
    kind: 'rss',
    categories: ['行业动态', '国际要闻'],
  },

  /* ★ 36氪：官方地址是对的，但**本机实测 4 次全部返回反爬页**（HTTP 200 + HTML）。
     抓取层已经为它写了"人机验证页重试一次"（见 fetch-feeds.js 的 RETRY_NOT_FEED），
     所以留着并**默认开启**：别的网络/别的时段可能就通了，
     而失败了也只是界面上多一个"源异常"，不会污染数据。
     ⚠️ 实测记录：`<!DOCTY...` —— 与 sources.js 里那条历史结论一致（间歇性、非地址错误）。 */
  { name: '36氪', feedUrl: 'https://36kr.com/feed', kind: 'rss', categories: ['行业动态'] },

  /* ★ 虎嗅：官网有一个**自己的** RSS（`/rss/0.xml`），是全网少数还活着的官方 feed。
     但**本机 4 次全部超时**（与 2026-09-22 那次实测一致）。
     ⇒ 默认 false：按本项目的既定口径，"实测通不过的源不许默认打开"
       （默认开着但永远失败，界面会长期挂一个"源异常"，用户会以为是 bug）。
       有代理/换网络的用户可以自己把它打开。 */
  {
    name: '虎嗅',
    feedUrl: 'https://www.huxiu.com/rss/0.xml',
    kind: 'rss',
    categories: ['行业动态', '产品与设计'],
    enabled: false,
  },

  /* ⚠️ 新浪财经：**查过，但没有可加的地址** —— 记在这里省得以后再查一遍。
     实测（2026-09-24）：
       · rss.sina.com.cn/roll/finance/hot_roll.xml  合法 XML，**0 条**
       · rss.sina.com.cn/finance/macro.xml          合法 XML，**0 条**
       · rss.sina.com.cn/finance/stock/company.xml  HTTP 404
       · rss.sina.com.cn/news/marquee/ddt.xml       1 条，且**没有时间**
       · rss.sina.com.cn/tech/rollnews.xml          15 条，最新 **2018-09-23**
       · rss.sina.com.cn/news/china/focus15.xml     15 条，最新 **2018-09-23**
     最后两条是关键：**新浪的 RSS 在 2018 年就停更了**（距今 7 万小时）。
     ⇒ 加进来只会让用户看到一个"最新的新闻是 2018 年"的源。
       要接新浪财经，正路是走 RSSHub（阶段 B），不是这些死 feed。 */

  // 实测已死 / 抓不到内容（留档，别浪费时间再试）
  { name: '果壳', feedUrl: 'https://www.guokr.com/rss/', kind: 'rss', categories: ['科学新知'], enabled: false },
  { name: '知乎日报', feedUrl: 'https://www.zhihu.com/rss', kind: 'rss', categories: ['行业动态'], enabled: false },
  { name: 'V2EX 最热', feedUrl: 'https://www.v2ex.com/index.xml', kind: 'atom', categories: ['开源与工程'], enabled: false },
];


/**
 * 选源的六条口径（第三轮返工后补全）
 * =====================================================================
 *   ① **只要 RSS / Atom / JSON Feed**。不抓 HTML 页面 —— 那是反爬与合规风险
 *      的入口，而这个项目明确不做需要登录态或对抗性抓取的内容。
 *   ② **中文优先**，配少量英文技术源。
 *   ③ **按类别预打标签**（需求 2 的筛选需要初始分类，否则一上来是空的）。
 *   ④ **每个源都要能被单独关掉** —— 源挂了是常态，不能让一个源拖垮整份简报。
 *   ⑤ **"实测通不过的源不许默认打开"**。默认开着但永远失败，只会让界面一直
 *      显示"3 个源异常"，而那是**环境事实、不是缺陷** —— 用户会以为是 bug。
 *   ⑥ **`enabled: false` 的条目仍然写进库**：用户能在设置里看到"有这个源、
 *      只是关着"，而不是根本不知道它存在。
 *
 * 置信度口径（这条要写下来，否则以后没法解释"为什么这个源被关了"）：
 *   R2 的沙箱网络 ≠ 用户机器（它那边 github.com 解析被拦，而用户机器上
 *   GitHub Blog 是通的）。所以 **"我这边 fetch failed" 不能推断为"国内不可达"**；
 *   只有 **"200 + HTML 反爬页"** 或 **"302 跳首页/付费页"** 才是硬证据。
 *   上面的 A 组是"抓到的响应体本身就是 XML"这一级别的证据。
 * =====================================================================
 */

/**
 * 取默认源（可选按类别过滤）。
 * @param {string[]} [onlyCategories]
 */
export function defaultSources(onlyCategories) {
  if (!onlyCategories || !onlyCategories.length) return DEFAULT_SOURCES.slice();
  return DEFAULT_SOURCES.filter((s) => (s.categories || []).some((c) => onlyCategories.includes(c)));
}
