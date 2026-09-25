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
/* ★ 「这条源其实是个 JSON 接口」的登记处在 adapters.js（阶段 B）。
   抓取层只问一句"该用哪个解析器"，不掺和"哪个域名用什么解析器"——
   那段判断放进这个文件就等于跟着 electron 一起变得不可断言。 */
import { adapterFor } from './adapters.js';
/* ⚠️ 这个 import 的方向看着别扭（ingest → main），但它是**刻意的**：
   `feed-url.js` 是一个**零依赖的叶子模块**（它自己不 import 任何东西，
   尤其不 import electron），而"本机 / 内网地址"这件事的**唯一口径**就在那里。
   在这里再抄一份 isPrivateHost 等于造第二份口径 —— 本项目已经反复栽在
   这个模式上（CARD_SIZE / --win-pad / 数据目录口径，前后四处）。 */
import { feedUrlGateReason, localServiceHint } from '../main/feed-url.js';
import {
  openDb,
  upsertSources,
  listSources,
  listEnabledSourcesOfCategories,
  listCategories,
  listSourceIdsOfCategory,
  listCategoryIdsOfSource,
  tagExistingItemsOfSource,
  seedSourceCategories,
  recordSourceResult,
  startRun,
  finishRun,
  insertItem,
  upsertCategory,
  tagItem,
  sourceHealth,
  setMeta,
  /* ★ 阶段 C：分类体系的一次性迁移（见 db.js 里那段说明）——
     不写这一步，新加的类别会永远是空的。 */
  migrateTaxonomy,
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
 * 抓取失败的**可读原因**（纯函数，可离线穷举）。
 *
 * ★ 为什么要单独一个函数（阶段 B2 的验收条件）：
 *   阶段 B 引入的源地址是本机的（`http://127.0.0.1:1200/…`）。
 *   用户忘了先启动 RSSHub 时，原始错误是 `fetch failed` / `ECONNREFUSED` ——
 *   那是**网络错误**的措辞，人会往"网断了""被墙了"的方向排查，
 *   而真相是"你自己那台服务没开"。**诊断指错方向比没有诊断更糟。**
 *   ⇒ 本机地址的失败理由里必须把这件事写出来。
 *
 * @param {string} feedUrl
 * @param {{error?:string}} res
 * @returns {string}
 */
export function explainFetchFailure(feedUrl, res) {
  const base = (res && res.error) || '抓取失败';
  const hint = localServiceHint(feedUrl);
  return hint ? base + '　—— ' + hint : base;
}

/**
 * 跑一轮抓取。
 *
 * @param {object} opts
 * @param {string} opts.dbFile          数据库路径
 * @param {'schedule'|'manual'|'catchup'} [opts.trigger]
 * @param {boolean} [opts.ensureSources] 是否在库里没有源时写入预置源包
 * @param {number[]} [opts.categoryIds]  只抓这些类型**绑定的源并集**（缺省 = 全部启用源）
 * @param {(msg:string)=>void} [opts.log]
 * @param {typeof fetchText} [opts.fetcher] 便于测试注入（默认真抓）
 * @param {object} [opts.env] 读"本机地址放行开关"用的环境（默认 process.env；
 *   测试里注入，免得跑测试的那台机器上恰好设了这个变量而改变结果）
 */
export async function runIngest(opts) {
  const {
    dbFile,
    trigger = 'manual',
    ensureSources = true,
    categoryIds = null,
    log = () => {},
    fetcher = fetchText,
    env = process.env,
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
      /* ★★ 给两类源播映射。这一段是"预置清单与用户编辑两份口径"的交界处，
       *    我在这里连错四次，每次都换一种失败方式，所以把结论写死在这里。
       *
       *   要守的性质有两条，而且它们**互相拉扯**：
       *     ① 代码里**新加**一个预置源 ⇒ 它得按清单拿到类型绑定，
       *        否则它的条目一条都不打标签、按类型筛选完全看不到
       *        （而日志里一切正常，只有查库才发现）。
       *     ② 用户把某个源从某个类型里摘掉之后 ⇒ 绝不能自己加回来。
       *
       *   ⇒ 播的名单 = **这次新登记的源** ∪ **一条绑定都没有的预置源**。
       *
       *   为什么必须有第二项（真机实测撞到的）：升级路径上会留下"孤儿"——
       *     某个源由**旧版本**登记过（所以不是"新增"），却从来没被播过
       *     （所以没有任何绑定）。本次的「澎湃新闻」就是这样：
       *     它先被一个临时版本登记进库，再升级上来，于是它的 20 条条目
       *     一条标签都没打、按类型筛选时完全看不到。
       *
       *   而"有绑定就绝不碰"那条兜底（在 `seedSourceCategories` 里）保证了②：
       *     被用户摘掉一个类型的源仍然绑在别的类型上 ⇒ 不属于"一条绑定都没有"。
       *
       *   ⚠️ 试过并否掉的判据（都因为破坏其中一条而作废）：
       *     · "有映射表行就不播" ⇒ 违反②（用户整组取消的源会被绑回来）
       *     · "有 source_state 行就不播" ⇒ 违反①（新库一个源都不播）
       *     · "只播新增名单" ⇒ 违反①的升级变体（就是上面那个孤儿） */
      const boundIds = new Set(
        db.prepare('SELECT DISTINCT source_id FROM source_category').all().map((r) => Number(r.source_id)),
      );
      const srcIdsNow = new Map(listSources(db).map((s) => [s.feed_url, Number(s.id)]));
      const newUrls = new Set(sync.newFeedUrls || []);
      const toSeed = DEFAULT_SOURCES.filter((s) => {
        if (newUrls.has(s.feedUrl)) return true;
        const id = srcIdsNow.get(s.feedUrl);
        return id != null && !boundIds.has(id); // 升级留下的孤儿：登记过、却一条绑定都没有
      });
      if (toSeed.length) {
        const seed = seedSourceCategories(db, nowIso, { only: toSeed });
        if (seed.seeded) {
          log(`按预置清单写入 ${seed.seeded} 条「源 ↔ 类型」映射（涉及 ${toSeed.length} 个源，其中新登记 ${newUrls.size} 个）`);
        }
      }
      // 预置类别（用户之后可增删改）
      DEFAULT_CATEGORIES.forEach((name, i) => upsertCategory(db, name, i, nowIso));
      /* ★★ 阶段 C：把**已经在库里**的预置源补进新的分类体系。
       *
       * ⚠️ 少了这一步，扩出来的类别会**永远是空的**：升级上来的库里源早就都有绑定，
       *    而播种那条路"已经有绑定的源一行都不许动"（阶段 A 连错五次定下来的）。
       *    迁移是**显式的一次性动作**：带版本号、只加不删、跳过被用户摘干净的源。 */
      try {
        const tx = migrateTaxonomy(db, nowIso);
        if (!tx.skipped && tx.added) {
          log(
            '分类体系升到 v' + tx.version + '：补了 ' + tx.added + ' 条「源 ↔ 类型」绑定' +
              (tx.skippedByUser ? '（跳过 ' + tx.skippedByUser + ' 个被用户摘干净的源）' : ''),
          );
        }
      } catch (err) {
        /* 迁移失败**不许拖垮抓取** —— 它只是把标签补齐，抓取本身照常。 */
        log('⚠️ 分类体系迁移失败（不影响本次抓取）：' + (err && err.message ? err.message : String(err)));
      }

      /* ★★ 给"标签缺了"的预置源补一次标签（每个源只做一次）。
       *
       * ⚠️ 为什么需要：标签（`item_category`）是**抓取那一刻**按当时的映射写下的
       *    （那是有意的 —— 它是当时的事实，跟着映射漂移就等于伪造历史）。
       *    于是这些情况下条目会**一条标签都没有**，按类型筛选时完全看不到
       *    （用户侧是"这个源的内容不见了"，而「全部」里明明有）：
       *      · 升级留下的孤儿：源由旧版本登记过、却从来没被播过映射
       *        （真机实测：本次的「澎湃新闻」，29 条老条目全都没有标签）
       *      · 用户先抓了内容、之后才把这个源勾进某个类型
       *
       * ⚠️⚠️ 判据是"**一条标签都没有**"（而不是"刚播过映射"）——
       *    后者漏掉"绑定早就补上了、标签还没补"的那种中间状态，
       *    而那正是真机上「澎湃新闻」的实际处境（我第一版就漏了它）。
       * ⚠️ 每个源只补一次（`meta.backfill_tags:<源id>`）：否则用户手动把某个源
       *    从所有类型里摘掉之后，下次抓取又会被补回来 —— 那正是"用户改过的被覆盖"。 */
      for (const s of DEFAULT_SOURCES) {
        const sid = srcIdsNow.get(s.feedUrl);
        if (sid == null) continue;
        const r = tagExistingItemsOfSource(db, sid, `backfill_tags:${sid}`);
        if (r.tagged) log(`给「${s.name}」已有的条目补上 ${r.tagged} 条类型标签（只补这一次）`);
      }
    }

    /* ⚠️ 选源的口径（本次改动）：**用户选了什么类型，就抓那个类型绑定的源并集**。
     *
     * 在这之前这里写死 `listSources(db, true)`（抓全部启用源），于是
     * "我只想看安全类"这个意图与"刷新"这个动作之间没有任何联系 ——
     * 用户点刷新，程序照样把 36 个源全打一遍，其中大多数与当前类型无关。
     *
     * ⚠️ `categoryIds` 为空 = 「全部」⇒ 仍然抓全部启用源（这是默认行为，不许变）。
     * ⚠️ 映射来自 **DB**（`source_category`），不是代码里的预置清单 ——
     *    用户编辑完就必须生效，否则这个功能等于没做。 */
    const wantCats = Array.isArray(categoryIds)
      ? categoryIds.map(Number).filter((n) => Number.isFinite(n))
      : [];
    const sources = wantCats.length ? listEnabledSourcesOfCategories(db, wantCats) : listSources(db, true);
    summary.sources = sources.length;
    summary.scope = wantCats.length ? { categoryIds: wantCats } : { all: true };
    if (wantCats.length) {
      log(`本次只抓类型 ${wantCats.join('/')} 绑定的源，共 ${sources.length} 个`);
    }
    if (!sources.length) {
      /* ★ 两种"没有源"要分开说，别混成一句：
       *   ① 一个源都没启用 —— 界面该提示去添加源
       *   ② 这个类型**一个源都没绑**（用户把勾全取消了）—— 界面该提示去勾选
       *   混成一句的话，用户看到"没有任何启用的源"会去翻源配置，
       *   而他真正要做的只是给这个类型勾上一个源。 */
      if (wantCats.length) {
        log(`类型 ${wantCats.join('/')} 没有绑定任何启用的源 —— 什么都不做（去「筛选栏」给它勾上源）`);
        return { ...summary, scopedEmpty: true, health: sourceHealth(db) };
      }
      log('没有任何启用的源 —— 什么都不做（不是错误，但界面应当提示去添加源）');
      return { ...summary, health: sourceHealth(db) };
    }

    const runId = startRun(db, trigger, nowIso);

    /* ★★ 打标签的口径：**读 DB 里的「源 ↔ 类型」映射**，不再读代码里的预置清单。
     *
     * ⚠️⚠️ 这一行就是本次功能的关键落点。改之前是：
     *       const wanted = (DEFAULT_SOURCES.find(d => d.feedUrl === src.feed_url) || {}).categories || [];
     *     它意味着：**用户在界面上勾的东西完全不参与抓取** ——
     *     用户把"安全客"勾进「AI 与算力」之后，新抓来的条目仍然按硬编码清单
     *     进「安全与隐私」。用户侧看到的是"我改了，但一点也不生效"，
     *     而代码里每一行看起来都是对的。这正是"两份口径"最典型的形态。
     *
     * 现在：DB 说这个源属于哪些类型，条目就进哪些类型。
     *      映射为空（用户全取消勾选）⇒ 条目**不打任何标签**，这是如实反映。
     * ⚠️ 每次抓取前读一次，而不是循环里现读：一轮抓取期间用户改映射的话，
     *    同一轮里有的条目按新映射、有的按旧映射，那是"半新半旧"的状态。 */
    const catOfSource = new Map();
    const catIdByName = new Map();
    for (const c of listCategories(db)) {
      catIdByName.set(c.name, c.id);
      for (const sid of listSourceIdsOfCategory(db, c.id)) {
        if (!catOfSource.has(sid)) catOfSource.set(sid, []);
        catOfSource.get(sid).push(c.id);
      }
    }

    for (const src of sources) {
      const one = { name: src.name, feedUrl: src.feed_url, status: 'unknown', items: 0, newItems: 0 };
      try {
        /* ★★ 本机地址那道闸的**第二端**（阶段 B；第一端在 feed-url.js 的
         *    validateNewSource 里，管"用户粘进来的地址"）。
         *
         *   ⚠️⚠️ 为什么必须有它：阶段 B2 往预置清单里加了一组**本机地址**
         *      （http://127.0.0.1:1200/…），而预置源是**直接写进库**的、
         *      根本不经过 validateNewSource —— 用户只要在面板上把那条源勾上，
         *      程序就会去打 127.0.0.1。
         *      那样一来 MB_ALLOW_LOCAL_FEEDS 就不再是"唯一入口"了，
         *      那条安全边界会从**侧门**漏掉。
         *   ⚠️ 判据必须在**发请求之前** —— 放到请求之后就等于"已经打过了"。 */
        const gate = feedUrlGateReason(src.feed_url, env);
        if (gate) {
          one.status = 'blocked_local';
          one.error = gate;
        }
        let res = gate ? null : await fetcher(src.feed_url);
        let parsed = null;
        /* ★ 这条源是不是"某个站点自己的 JSON 接口"（见 adapters.js）。
           是的话解析器换成它，否则走通用的 RSS/Atom/RDF/JSON Feed 解析。
           ⚠️ 两个解析器的返回**同构**（ok/format/items/warnings/contentKind），
              所以下面那些分支一行都不用改。 */
        const adapter = gate ? null : adapterFor(src.feed_url);
        if (res && res.ok) {
          for (let attempt = 0; ; attempt += 1) {
            parsed = adapter
              ? adapter.parse(res.text, { sourceId: src.id, sourceName: src.name })
              : parseFeed(res.text, { sourceId: src.id, sourceName: src.name });
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
        /* ⚠️ 下面三个分支都带 `!gate`：本机地址没放行时**一个都不走** ——
           原因（one.error / one.status）在上面就写好了，这里再覆盖一次
           只会把"你没打开那个开关"淹没成"网络错误"。 */
        if (!gate && !res.ok) {
          one.status = res.status ? 'http_error' : 'network_error';
          one.error = explainFetchFailure(src.feed_url, res);
        } else if (!gate && (!parsed || !parsed.ok)) {
          one.status = 'parse_error';
          one.error = (parsed && parsed.warnings.join(' / ')) || '解析后没有任何条目';
          // ★ 把"实际拿到的是什么"一并带出来 —— 报错要指向下一步
          if (parsed && parsed.contentKind) one.contentKind = parsed.contentKind;
        } else if (!gate) {
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
              // 按**用户编辑过的**「源 ↔ 类型」映射打初始标签（见 catOfSource 的说明）
              const ids = catOfSource.get(src.id) || [];
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
