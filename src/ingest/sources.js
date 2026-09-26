/**
 * src/ingest/sources.js —— 预置源包（可增删）
 * =====================================================================
 * 选源的四条口径：
 *   ① **只要机器能直接读的结构化内容**：RSS / Atom / RDF / JSON Feed，
 *      或者站点自己的**公开 JSON 接口**（阶段 B 加的，见 ingest/adapters.js）。
 *      **不抓 HTML 页面** —— 那是反爬与合规风险的入口，
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

/* 头条热榜的接口地址来自解析器模块 —— **只有一份**。
   在这里再抄一遍字符串就是第二份口径：改了适配器而没改这里，
   表现是"源还在抓，但抓到的东西解析不了"，而两边单看都是对的。 */
import { TOUTIAO_HOT_API } from './parse-toutiao.js';

/** 预置类别（需求 2：用户自定义固定类别 —— 这是初始值，之后可增删改） */
export const DEFAULT_CATEGORIES = [
  '领域·时政',
  '领域·财经',
  '领域·科技',
  '领域·文娱',
  '领域·体育',
  '领域·民生',
  '领域·国际',
  '领域·军事',
  '领域·教育',
  '领域·医疗健康',
  '领域·汽车',
  '领域·美食',
  '领域·旅游',
  '性质·快讯',
  '性质·深度',
  '性质·观点',
  '性质·数据',
  '性质·实用',
  '性质·核查',
  '形态·音频',
  '时效·硬新闻',
  '时效·软新闻',
  '时效·专题',
  '主体·官方',
  '主体·主流媒体',
  '主体·垂直媒体',
  '主体·通讯社',
  '主体·UGC',
];

/**
 * ★★ 只有「本机 RSSHub」的源撑得起来的类别 —— **新用户不建它们**（用户拍板的做法）。
 *
 * ---------------------------------------------------------------------
 * 为什么单独拎出来（这一段是「能不能发给别人用」逼出来的）
 * ---------------------------------------------------------------------
 * 撑这 6 个类别的源**全部**在本机 RSSHub 上（默认关闭，见下面 D / E 两组）。
 * 而「一个类别有没有内容，只取决于有没有源绑给它」（见 db.js 的 source_category 说明）
 * ⇒ 全新用户装完晨报机，会看到 6 个点进去**永远是空**的 chip，
 *   而那正是本项目最警戒的「看起来像 bug」。
 *
 * ⇒ 做法：**公网源撑得起来的类别照建；这 6 个等本机源真的被启用时再登记**
 *   （ensureLocalCategories，由 --enable-local 触发）。
 *   老库里早就有的这 6 个类别一行都不动 —— 登记与迁移都是**只加不删**。
 *
 * ⚠️ 这 6 个不是「懒得找」，是**实测结论**：试过约 90 个候选 ——
 *    新华网各频道 300 条但**零时间字段**、人民网整站 RSS 已馊（最新 2025-06）、
 *    汽车之家 / 懂球帝 / 马蜂窝 / 下厨房 / 中国军网 / 央广军事等垂直站都没有对外 RSS。
 *    逐个候选的结论见 HANDOFF-阶段B.md 的「阶段 D」一节。
 *    ⇒ **别再照着这个名单重试一遍**，除非你要动的是「换别的源」。
 */
export const LOCAL_ONLY_CATEGORIES = Object.freeze([
  '领域·军事',
  '领域·汽车',
  '领域·旅游',
  '性质·核查',
  '形态·音频',
  '时效·专题',
]);

/** 这个类别是不是「只有本机源撑得起来」的那一类（见上面那段） */
export function isLocalOnlyCategory(name) {
  return LOCAL_ONLY_CATEGORIES.indexOf(String(name)) >= 0;
}

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
  { name: '量子位', feedUrl: 'https://www.qbitai.com/feed', kind: 'rss', categories: ['领域·科技', '性质·快讯', '时效·硬新闻', '主体·垂直媒体'] },
  { name: 'InfoQ 中文', feedUrl: 'https://www.infoq.cn/feed', kind: 'rss', categories: ['领域·科技', '性质·深度', '时效·硬新闻', '主体·垂直媒体'] },
  { name: 'Solidot', feedUrl: 'https://www.solidot.org/index.rss', kind: 'rss', categories: ['领域·科技', '性质·快讯', '主体·UGC'] },
  { name: '少数派', feedUrl: 'https://sspai.com/feed', kind: 'rss', categories: ['领域·科技', '性质·实用', '时效·软新闻', '主体·垂直媒体'] },
  { name: 'IT之家', feedUrl: 'https://www.ithome.com/rss/', kind: 'rss', categories: ['领域·科技', '性质·快讯', '时效·硬新闻', '主体·垂直媒体'] },
  { name: '中新网即时', feedUrl: 'https://www.chinanews.com.cn/rss/scroll-news.xml', kind: 'rss', categories: ['领域·时政', '领域·民生', '领域·国际', '性质·快讯', '时效·硬新闻', '主体·通讯社'] },
  { name: '钛媒体', feedUrl: 'https://www.tmtpost.com/rss.xml', kind: 'rss', categories: ['领域·财经', '领域·科技', '性质·深度', '主体·垂直媒体'] },
  { name: '华尔街见闻', feedUrl: 'https://dedicated.wallstreetcn.com/rss.xml', kind: 'rss', categories: ['领域·财经', '性质·快讯', '时效·硬新闻', '主体·垂直媒体'] },
  { name: '雪球', feedUrl: 'https://xueqiu.com/hots/topic/rss', kind: 'rss', categories: ['领域·财经', '性质·数据', '主体·UGC'] },
  { name: 'FreeBuf', feedUrl: 'https://www.freebuf.com/feed', kind: 'rss', categories: ['领域·科技', '性质·深度', '主体·垂直媒体'] },
  { name: '安全客', feedUrl: 'https://api.anquanke.com/data/v1/rss', kind: 'rss', categories: ['领域·科技', '性质·深度', '主体·垂直媒体'] },
  { name: '游研社', feedUrl: 'https://www.yystv.cn/rss/feed', kind: 'rss', categories: ['领域·文娱', '性质·深度', '时效·软新闻', '主体·垂直媒体'] },
  { name: '机核', feedUrl: 'https://www.gcores.com/rss', kind: 'rss', categories: ['领域·文娱', '性质·深度', '时效·软新闻', '主体·垂直媒体'] },
  { name: '触乐', feedUrl: 'https://www.chuapp.com/feed', kind: 'rss', categories: ['领域·文娱', '性质·深度', '时效·软新闻', '主体·垂直媒体'] },
  { name: '掘金', feedUrl: 'https://juejin.cn/rss', kind: 'rss', categories: ['领域·科技', '性质·实用', '主体·UGC'] },
  { name: '博客园', feedUrl: 'https://feed.cnblogs.com/blog/sitehome/rss', kind: 'atom', categories: ['领域·科技', '性质·实用', '主体·UGC'] },
  { name: '阮一峰的网络日志', feedUrl: 'https://www.ruanyifeng.com/blog/atom.xml', kind: 'atom', categories: ['领域·科技', '性质·观点', '时效·软新闻', '主体·UGC'] },
  { name: '美团技术团队', feedUrl: 'https://tech.meituan.com/feed', kind: 'rss', categories: ['领域·科技', '性质·深度', '主体·官方'] },
  { name: 'GitHub Blog', feedUrl: 'https://github.blog/feed/', kind: 'rss', categories: ['领域·科技', '性质·快讯', '主体·官方'] },

  // ==================================================================
  // B. 曾经写错地址 / 已改成付费或半死 —— **默认关闭**，但写进库让用户看得见
  // ==================================================================
  /* ⚠️ 机器之心：`https://www.jiqizhixin.com/rss` 返回 200 后 **302 跳到 /data-service**，
     页面上写着"机器之心数据服务已上线"并留了商务邮箱 ——
     即**官方已经把公开 RSS 撤成了付费/合作制数据服务**，免费 feed 不存在了。
     这不是 URL 写错，是产品决策。⇒ 默认关闭，AI 类内容由量子位承担。 */
  { name: '机器之心', feedUrl: 'https://www.jiqizhixin.com/rss', kind: 'rss', categories: ['领域·科技', '性质·深度', '主体·垂直媒体'], enabled: false },

  /* ⚠️ 36氪原来在这里（B 组，`enabled: false`）。2026-09-24 挪到下面的 C 组并
     **默认开启** —— 它的地址是对的，返回的是间歇性的反爬页，
     而抓取层已经为"人机验证页"写了重试一次（见 fetch-feeds.js 的 RETRY_NOT_FEED）。
     放在 B 组（"地址写错/半死"）与事实不符，会误导下一个人别再试。 */

  // 境外源：本机实测 `fetch failed`（DNS/TCP 层不可达）。**有代理就打开。**
  { name: 'Hacker News', feedUrl: 'https://hnrss.org/frontpage', kind: 'rss', categories: ['领域·科技', '性质·快讯', '主体·UGC'], enabled: false },
  { name: 'Ars Technica', feedUrl: 'https://feeds.arstechnica.com/arstechnica/index', kind: 'rss', categories: ['领域·科技', '性质·深度', '主体·垂直媒体'], enabled: false },
  { name: 'BBC World', feedUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml', kind: 'rss', categories: ['领域·国际', '性质·快讯', '时效·硬新闻', '主体·主流媒体'], enabled: false },
  { name: 'BBC 中文', feedUrl: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', kind: 'rss', categories: ['领域·国际', '性质·快讯', '时效·硬新闻', '主体·主流媒体'], enabled: false },

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
    categories: ['领域·时政', '领域·国际', '性质·深度', '时效·硬新闻', '主体·主流媒体'],
  },

  /* ★ 36氪：官方地址是对的，但**本机实测 4 次全部返回反爬页**（HTTP 200 + HTML）。
     抓取层已经为它写了"人机验证页重试一次"（见 fetch-feeds.js 的 RETRY_NOT_FEED），
     所以留着并**默认开启**：别的网络/别的时段可能就通了，
     而失败了也只是界面上多一个"源异常"，不会污染数据。
     ⚠️ 实测记录：`<!DOCTY...` —— 与 sources.js 里那条历史结论一致（间歇性、非地址错误）。 */
  /* ⚠️ 2026-09-25 改为**默认关闭**（原来是默认开启）。
     理由来自用户视角：上面那段「别的网络/别的时段可能就通了」的推测**没有兑现** ——
     2026-09-25 又实测 3 次，3/3 都是同一个 17501 字节的反爬页。
     而代价是**每个新用户界面上永久挂着「1 个源异常」**，他会一直以为是自己的网络问题。
     ⇒ 与虎嗅、机器之心同一个口径：**实测通不过的源不许默认打开**。
     想留着的用户可以在界面里自己打开（预置源的 enabled 现在改得动了）。 */
  { name: '36氪', feedUrl: 'https://36kr.com/feed', kind: 'rss', categories: ['领域·财经', '领域·科技', '性质·深度', '主体·垂直媒体'], enabled: false },

  /* ★ 虎嗅：官网有一个**自己的** RSS（`/rss/0.xml`），是全网少数还活着的官方 feed。
     但**本机 4 次全部超时**（与 2026-09-22 那次实测一致）。
     ⇒ 默认 false：按本项目的既定口径，"实测通不过的源不许默认打开"
       （默认开着但永远失败，界面会长期挂一个"源异常"，用户会以为是 bug）。
       有代理/换网络的用户可以自己把它打开。 */
  {
    name: '虎嗅',
    feedUrl: 'https://www.huxiu.com/rss/0.xml',
    kind: 'rss',
    categories: ['领域·财经', '领域·科技', '性质·深度', '性质·观点', '主体·垂直媒体'],
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

  /* ==================================================================
   * D. 阶段 B（2026-09-24）：**没有官方 feed** 的站点
   *
   * 用户点名要的那批站点里，有官方 feed 的已经在 A/C 组了；剩下这些
   * 靠两条路接进来。**下面每一个地址 / 路由都是本机实测过的**
   * （先在本机把 RSSHub 起起来、用它的路由表逐个真抓 ——
   *  公共镜像返回的 404/429/503 **不能**用来判断路由存不存在，
   *  详见 HANDOFF-阶段B.md 第 3 节；完整的 B0 实测表也在那里）。
   *
   *   ① **本机自建 RSSHub**：地址形如 http://127.0.0.1:1200/<路由>
   *   ② **原生 JSON 适配器**：见 ingest/adapters.js + parse-toutiao.js
   *
   * ⚠️ ①这一组**全部 enabled: false**，理由不是"它们不好用"（实测全通），
   *    而是**它们依赖用户本机跑着 RSSHub**：
   *      · 不是每个人本机都有 RSSHub，默认开着会让所有人的"源异常"长期变红
   *        ——那正是口径⑤要避免的（默认开着但永远失败 = 看起来像 bug）；
   *      · 失败文案里会写明"是本机那个服务没起来"（见 fetch-feeds.js 的
   *        explainFetchFailure），否则用户看到"网络错误"根本想不到这一层。
   * ⚠️ 这一组还受 **MB_ALLOW_LOCAL_FEEDS=1** 那道闸管（见 feed-url.js）：
   *    没开开关时**抓取层根本不发请求**，直接如实报"本机地址没放行"。
   *    想用它们，三件事缺一不可：
   *      ① 本机把 RSSHub 跑起来（默认端口 1200）
   *      ② 用 MB_ALLOW_LOCAL_FEEDS=1 启动晨报机
   *      ③ 在「筛选栏 → 编辑」里把它们勾上（默认是关的）
   * ================================================================== */

  /* —— ② 原生适配器：今日头条**热榜**（不依赖 RSSHub）——
     实测 2026-09-24：GET /hot-event/hot-board/ → 200 · 117KB · 0.27s · data 50 条。
     ⚠️ 默认关闭，理由是**这个接口给不出资讯流**，不是它不通：
        · **没有时间字段**（只有 HotValue 热度）⇒ 条目 published_at 全是 NULL
        · 没有摘要 / 正文
        · Url 里会混进抖音直播（解析器会丢掉那些，见 isLiveLink）
        想要热榜就自己勾上；但按既定排序（没有时间的排最后），
        它不会挤进精选 —— 它本来就不是"今天有什么新闻"。 */
  {
    name: '今日头条热榜',
    feedUrl: TOUTIAO_HOT_API,
    kind: 'json',
    categories: ['领域·民生', '性质·快讯', '时效·硬新闻', '主体·UGC'],
    enabled: false,
  },

  /* —— ① 本机自建 RSSHub（实测数字都记在每条后面）—— */
  { name: '今日头条热点（本机）', feedUrl: 'http://127.0.0.1:1200/toutiao/channel/news_hot', kind: 'rss', categories: ['领域·时政', '领域·民生', '领域·国际', '性质·快讯', '时效·硬新闻', '主体·UGC'], enabled: false },
  { name: '网易新闻今日关注（本机）', feedUrl: 'http://127.0.0.1:1200/163/today', kind: 'rss', categories: ['领域·时政', '领域·国际', '性质·快讯', '主体·主流媒体'], enabled: false },
  { name: '财联社电报（本机）', feedUrl: 'http://127.0.0.1:1200/cls/telegraph', kind: 'rss', categories: ['领域·财经', '性质·快讯', '时效·硬新闻', '主体·垂直媒体'], enabled: false },
  { name: '新浪财经滚动（本机）', feedUrl: 'http://127.0.0.1:1200/sina/finance/rollnews', kind: 'rss', categories: ['领域·财经', '性质·快讯', '时效·硬新闻', '主体·主流媒体'], enabled: false },
  { name: '人民日报电子版（本机）', feedUrl: 'http://127.0.0.1:1200/people/paper', kind: 'rss', categories: ['领域·时政', '领域·国际', '性质·深度', '时效·硬新闻', '主体·官方'], enabled: false },
  { name: '36氪快讯（本机）', feedUrl: 'http://127.0.0.1:1200/36kr/newsflashes', kind: 'rss', categories: ['领域·财经', '领域·科技', '性质·快讯', '时效·硬新闻', '主体·垂直媒体'], enabled: false },
  { name: '虎嗅资讯（本机）', feedUrl: 'http://127.0.0.1:1200/huxiu/article', kind: 'rss', categories: ['领域·财经', '领域·科技', '性质·深度', '主体·垂直媒体'], enabled: false },
  { name: 'ZAKER 精读（本机）', feedUrl: 'http://127.0.0.1:1200/zaker/focusread', kind: 'rss', categories: ['领域·时政', '领域·民生', '性质·深度', '时效·软新闻', '主体·主流媒体'], enabled: false },

  /* ==================================================================
   * E. 阶段 C（2026-09-25）：**按内容领域补齐空档**
   *
   * 上一轮把类别扩到 28 个（五维度）之后，"哪些类别**点进去是空的**"变成了
   * 一个必须回答的问题：一个类别有没有内容，只取决于**有没有源绑给它**。
   * 当时算下来有 7 个领域一个源都没有（体育/教育/医疗健康/汽车/房产/美食/旅游）。
   * 这一组就是去补它们 —— 逐个在本机自建 RSSHub 上**实测过**（下表是实测数字）。
   *
   * ⚠️ 全部是**本机地址**（http://127.0.0.1:1200/…），因此：
   *    ① 需要本机跑着 RSSHub（见 HANDOFF-阶段B.md 第 3.7 节）；
   *    ② 受 MB_ALLOW_LOCAL_FEEDS=1 那道闸管，没开开关时抓取层**根本不发请求**；
   *    ③ 默认 enabled:false —— 与 D 组同一个理由（不是每个人本机都有 RSSHub）。
   *
   * 实测（2026-09-25，本机自建实例，逐个路由真抓）：
   *   懂球帝头条       200 · 15 条 · 最新当天        虎扑 NBA      200 · 35 条 · 当天
   *   中华网军事       200 · 100 条 · 最新 09-23     中华网时事    200 · 100 条 · 当天
   *   观察者网头条     200 · 20 条 · 当天            人民网首页    200 · 16 条 · 当天
   *   凤凰网资讯       200 · 20 条 · 当天            江苏教育考试院 200 · 20 条 · 09-23
   *   北京教育考试院   200 · 30 条 · 09-07           健康界        200 · 50 条 · 当天
   *   电动邦           200 · 25 条 · 09-24           FoodTalks     200 · 15 条 · 09-24
   *   马蜂窝游记热榜   200 · 10 条 · **没有时间**    澎湃明查      200 · 16 条 · 09-16
   *   澎湃美数课       200 · 24 条 · **没有时间**    财联社话题    200 · 20 条 · 当天
   *   观察者网话题     200 · 21 条 · 当天            雪球财经播客  200 · 30 条 · 当天
   *
   * ⚠️ 实测**没通过**、因此**没有**加进来的（别浪费时间再试一遍）：
   *   · /ke/researchResults（贝壳研究院·房产）        503
   *   · /sina/sports（新浪体育）                      503
   *   · /hupu/news/:team、/m4/mil（四月网军事）       503
   *   · /zhibo8/more/nba（直播吧）                    200 但 **23.7 秒**（超过 15 秒抓取超时）
   *   · /cctv/world（央视新闻）                       200 但 **18.9 秒**（同上）
   *   · /yicai/feed/669（第一财经）                   200 但最新一条是 **2026-01**（馊的）
   *   · /caixin/blog/*（财新博客）                    200 但最新一条是 **2024-01**（馊的）
   *   · /radio/:id（云听）、/apple/podcast（播客）    503
   *   · /qingting/podcast/293411（蜻蜓FM）            200 但最新是 **2019**（馊的）
   * ⇒ **房产**因此仍然没有源，所以"领域·房产"这个类别**没有建**（建了就是永远空的）。
   *   短视频 / 直播 / 交互式三种形态同理：没有可用源，不建。
   * ================================================================== */
  { name: '懂球帝头条（本机）', feedUrl: 'http://127.0.0.1:1200/dongqiudi/top_news/1', kind: 'rss', categories: ['领域·体育', '性质·快讯', '时效·硬新闻', '主体·垂直媒体'], enabled: false },
  { name: '虎扑 NBA（本机）', feedUrl: 'http://127.0.0.1:1200/hupu/nba', kind: 'rss', categories: ['领域·体育', '性质·快讯', '时效·硬新闻', '主体·垂直媒体'], enabled: false },
  { name: '中华网军事（本机）', feedUrl: 'http://127.0.0.1:1200/china/news/military', kind: 'rss', categories: ['领域·军事', '领域·国际', '性质·快讯', '时效·硬新闻', '主体·主流媒体'], enabled: false },
  { name: '中华网时事（本机）', feedUrl: 'http://127.0.0.1:1200/china/news', kind: 'rss', categories: ['领域·时政', '性质·快讯', '时效·硬新闻', '主体·主流媒体'], enabled: false },
  { name: '观察者网头条（本机）', feedUrl: 'http://127.0.0.1:1200/guancha/headline', kind: 'rss', categories: ['领域·时政', '领域·国际', '性质·观点', '时效·硬新闻', '主体·主流媒体'], enabled: false },
  { name: '人民网头条（本机）', feedUrl: 'http://127.0.0.1:1200/people', kind: 'rss', categories: ['领域·时政', '领域·民生', '性质·快讯', '时效·硬新闻', '主体·官方'], enabled: false },
  { name: '凤凰网资讯（本机）', feedUrl: 'http://127.0.0.1:1200/ifeng/news', kind: 'rss', categories: ['领域·时政', '领域·国际', '性质·快讯', '时效·硬新闻', '主体·主流媒体'], enabled: false },
  { name: '江苏教育考试院（本机）', feedUrl: 'http://127.0.0.1:1200/jseea/news/zkyw', kind: 'rss', categories: ['领域·教育', '性质·实用', '主体·官方'], enabled: false },
  { name: '北京教育考试院（本机）', feedUrl: 'http://127.0.0.1:1200/bjeea/bjeeagg', kind: 'rss', categories: ['领域·教育', '性质·实用', '主体·官方'], enabled: false },
  { name: '健康界（本机）', feedUrl: 'http://127.0.0.1:1200/cn-healthcare/index', kind: 'rss', categories: ['领域·医疗健康', '性质·深度', '主体·垂直媒体'], enabled: false },
  { name: '电动邦（本机）', feedUrl: 'http://127.0.0.1:1200/diandong/news', kind: 'rss', categories: ['领域·汽车', '性质·快讯', '主体·垂直媒体'], enabled: false },
  { name: 'FoodTalks（本机）', feedUrl: 'http://127.0.0.1:1200/foodtalks', kind: 'rss', categories: ['领域·美食', '性质·快讯', '主体·垂直媒体'], enabled: false },
  { name: '马蜂窝游记热榜（本机）', feedUrl: 'http://127.0.0.1:1200/mafengwo/note/hot', kind: 'rss', categories: ['领域·旅游', '性质·实用', '时效·软新闻', '主体·UGC'], enabled: false },
  { name: '澎湃明查（本机）', feedUrl: 'http://127.0.0.1:1200/thepaper/factpaper', kind: 'rss', categories: ['性质·核查', '领域·时政', '时效·硬新闻', '主体·主流媒体'], enabled: false },
  { name: '澎湃美数课（本机）', feedUrl: 'http://127.0.0.1:1200/thepaper/839studio', kind: 'rss', categories: ['性质·数据', '领域·时政', '主体·主流媒体'], enabled: false },
  { name: '财联社话题（本机）', feedUrl: 'http://127.0.0.1:1200/cls/subject/1103', kind: 'rss', categories: ['时效·专题', '领域·财经', '主体·垂直媒体'], enabled: false },
  { name: '观察者网话题（本机）', feedUrl: 'http://127.0.0.1:1200/guancha/topic/110/1', kind: 'rss', categories: ['时效·专题', '领域·国际', '主体·主流媒体'], enabled: false },
  { name: '雪球财经播客（本机）', feedUrl: 'http://127.0.0.1:1200/ximalaya/album/299146', kind: 'rss', categories: ['形态·音频', '领域·财经', '时效·软新闻', '主体·UGC'], enabled: false },

  /* ==================================================================
   * 阶段 B0 的实测表（本机自建实例，2026-09-24）——把结论钉在这里，
   * 免得下一个会话再把那些探针重跑一遍。
   *
   * 站点            路由                                 结果
   * 今日头条        /toutiao/hot                        **404 路由不存在**
   * 今日头条        /toutiao/channel/news_hot            200 · 15 条 · 最新当天
   * 网易新闻        /netease/...                         **404 命名空间不存在**
   * 网易新闻        /163/today                           200 ·  8 条 · 最新当天
   * 网易新闻        /163/news/special/1                  200 · 20 条 · 最新当天
   * 网易新闻        /163/news/rank/whole/click/day       200 但数据停在 **2021-07**（别用）
   * 腾讯新闻        /tencent/news/author/:mid            200 · 20 条（**只有按作者**，没有通用流）
   * 财联社          /cls/telegraph                       200 · 20 条 · 最新当天
   * 新浪财经        /sina/finance/rollnews                200 · 50 条 · 最新当天
   * 新浪财经        /sina/finance/china                  200 · 50 条 · 最新当天
   * 人民日报        /people/paper                        200 · 30 条（电子版，时间是当日 0 点）
   * 澎湃新闻        /thepaper/featured                   200 · 18 条
   * 36氪           /36kr/newsflashes                     200 · 20 条
   * 虎嗅            /huxiu/article                       200 · 20 条
   * ZAKER          /zaker/focusread                      200 · 46 条
   *
   * ⚠️ 三条被推翻/确认的旧结论（接手的人**不用再查**）：
   *   · 「腾讯新闻首页是 JS 壳」属实，但**不影响** RSSHub 那条作者路由；
   *   · 「ZAKER 早已停止对外 RSS 输出」是**推断、且推错了**——
   *     ZAKER 有两条能用的路由（上面那张表）；
   *   · 「网易要闻 = /netease/news/special/0001」这个地址**从来不存在**：
   *     RSSHub 的网易命名空间叫 **163**，不叫 netease。
   *   · Flipboard：RSSHub 里**没有**这个命名空间（确认无解）。
   *   · 财新：付费墙，不做（绕过它是违规的）。
   * ================================================================== */


  /* ==================================================================
   * F. 阶段 C 续（2026-09-25 深夜）：给「只有本机源」的类别补**公网**源
   *
   * 起因：把类别扩到 28 个之后，**一个全新用户**看到的是 10 个点进去永远空的 chip
   *       （因为撑它们的那 18 条源全在本机 RSSHub 上、默认关闭）。
   *       对「发给别人用」来说，那正是本项目最警戒的「看起来像 bug」。
   *
   * ⚠️ 这一组**逐个实测过**（2026-09-25 深夜，各 1 次真抓，走项目自己的 fetchText + parseFeed）：
   *     中新网·体育   30 条 · 最新当天 11:27 · 30 条有时间 · 30 条有链接
   *     中新网·教育   30 条 · 最新 09-24 15:10
   *     中新网·健康   30 条 · 最新当天 10:35
   *     中新网·文化   30 条 · 最新当天 11:20
   *     中新网·社会   30 条 · 最新当天 11:09
   *     中新网·生活    9 条 · 最新 09-24 15:04
   *     中新网·时政   30 条 · 最新当天 10:50
   *     食品伙伴网     50 条 · 最新当天 01:43
   *   ⇒ 全部**有时间、有链接**，所以可以默认启用
   *     （口径⑤只禁止「实测通不过的源默认打开」，没说通过的不能开）。
   *
   * ⚠️ 试过、**确认不可用**的（别浪费时间再试一遍）：
   *   · 新华网 军事/教育/健康/汽车/房产/食品/旅游：各 **300 条，却一个时间字段都没有**，
   *     而且房产/食品/旅游连 link 都缺（0~1 条有链接）
   *     ⇒ 塞进来就是「300 条排在列表最后、点开是死的」。
   *   · 人民网 体育/军事/汽车/房产/旅游/健康/教育/文化/社会/时政/财经/IT/娱乐：
   *     **整站 RSS 已馊**（教育停在 2016-04、汽车 2021-12、健康/社会/时政/国际 2025-06）。
   *   · 汽车之家 / 懂球帝 / 马蜂窝 / 下厨房 / 盖世汽车 / 中国房地产网 / 环球旅讯 /
   *     环球网军事 / 中国军网 / 新华网体育 / 央广军事：**都没有对外 RSS**（404 / 403 / 返回网页）。
   *   · 播客 RSS（形态·音频那一类）：试的源取不到。
   *
   * ⇒ 结果：10 个空类别里补上 4 个（体育 / 教育 / 医疗健康 / 美食），
   *   剩下 **军事 / 汽车 / 旅游 / 性质·核查 / 形态·音频 / 时效·专题** 六个
   *   在公网上确实找不到可用源 —— 它们仍然只有本机 RSSHub 那组撑着。
   *   测试里有一条断言把这六个**钉成已知例外**：以后再新增一个
   *   「新用户填不满」的类别，当场红。
   * ================================================================== */
  { name: '中新网·时政', feedUrl: 'https://www.chinanews.com.cn/rss/china.xml', kind: 'rss', categories: ['领域·时政', '性质·快讯', '时效·硬新闻', '主体·通讯社'] },
  { name: '中新网·社会', feedUrl: 'https://www.chinanews.com.cn/rss/society.xml', kind: 'rss', categories: ['领域·民生', '性质·快讯', '时效·硬新闻', '主体·通讯社'] },
  { name: '中新网·生活', feedUrl: 'https://www.chinanews.com.cn/rss/life.xml', kind: 'rss', categories: ['领域·民生', '性质·实用', '时效·软新闻', '主体·通讯社'] },
  { name: '中新网·文化', feedUrl: 'https://www.chinanews.com.cn/rss/culture.xml', kind: 'rss', categories: ['领域·文娱', '性质·快讯', '时效·软新闻', '主体·通讯社'] },
  { name: '中新网·体育', feedUrl: 'https://www.chinanews.com.cn/rss/sports.xml', kind: 'rss', categories: ['领域·体育', '性质·快讯', '时效·硬新闻', '主体·通讯社'] },
  { name: '中新网·教育', feedUrl: 'https://www.chinanews.com.cn/rss/edu.xml', kind: 'rss', categories: ['领域·教育', '性质·快讯', '时效·硬新闻', '主体·通讯社'] },
  { name: '中新网·健康', feedUrl: 'https://www.chinanews.com.cn/rss/health.xml', kind: 'rss', categories: ['领域·医疗健康', '性质·实用', '时效·软新闻', '主体·通讯社'] },
  { name: '食品伙伴网', feedUrl: 'http://news.foodmate.net/rss.php', kind: 'rss', categories: ['领域·美食', '性质·快讯', '主体·垂直媒体'] },

  // 实测已死 / 抓不到内容（留档，别浪费时间再试）
  { name: '果壳', feedUrl: 'https://www.guokr.com/rss/', kind: 'rss', categories: ['领域·科技', '性质·实用', '时效·软新闻', '主体·垂直媒体'], enabled: false },
  { name: '知乎日报', feedUrl: 'https://www.zhihu.com/rss', kind: 'rss', categories: ['领域·民生', '性质·实用', '时效·软新闻', '主体·UGC'], enabled: false },
  { name: 'V2EX 最热', feedUrl: 'https://www.v2ex.com/index.xml', kind: 'atom', categories: ['领域·科技', '性质·实用', '主体·UGC'], enabled: false },
];


/**
 * 选源的六条口径（第三轮返工后补全）
 * =====================================================================
 *   ① **只要 RSS / Atom / RDF / JSON Feed，或站点自己的公开 JSON 接口**。
 *      不抓 HTML 页面 —— 那是反爬与合规风险的入口，
 *      而这个项目明确不做需要登录态或对抗性抓取的内容。
 *
 *      ⚠️ 阶段 A 记下来的一处"文档与代码不符"就在这里：口径写着 JSON Feed，
 *         而 `feed-parse.js` **根本没有 JSON 分支**，拿到 JSON Feed 会一路
 *         走到"JSON（不是 feed）"。**阶段 B 把那一条分支补上了**
 *         （见 feed-parse.js 的 parseJsonFeed），文档与代码现在一致。
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
