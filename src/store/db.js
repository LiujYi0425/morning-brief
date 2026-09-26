/**
 * src/store/db.js —— 数据层（node:sqlite，零依赖）
 * =====================================================================
 * ### 为什么是 `node:sqlite` 而不是 `better-sqlite3`
 *
 * 已**实测**（`m0-probe/_probe-sqlite.mjs`）：`electron 44.4.2` 内嵌 `node 24.21.0`，
 * 自带 `node:sqlite`，建表 / 插入 / 查询 / **分页（LIMIT-OFFSET）** / **LIKE** 全通。
 * ⇒ **零依赖、零编译**。原生模块（node-gyp）每个 Electron ABI 都要重装一次，
 *   对"朋友拿到就能用"这个目标是纯负担。
 *
 * ### 为什么 schema 长这样（对着四条需求逐条落地）
 *
 *   · **需求 1 定时抓取** → `fetch_run` 记每次抓取的起止与结果；
 *     `item` 存条目；`source_state` 存每个源的健康度（连续失败几次 → 界面要能明示）
 *   · **需求 2 筛选** → `category`（用户自定义固定类别）＋ `item_category` 多对多
 *   · **需求 2 翻页** → `item` 上的 `(published_at DESC, id DESC)` 复合索引；
 *     分页用**游标**（`WHERE (published_at, id) < (?, ?)`）而不是 OFFSET ——
 *     OFFSET 在抓取插入新行后会**漏条/重复**，这正是"完整覆盖"最怕的事
 *   · **需求 3 点击跳转** → `item.url` 是**原始 URL**（归一化只用于去重，不覆盖它）
 *   · **需求 4 UI** → 与数据无关，但 `brief` 表给"默认精选 N 条"留了位置
 *     （N 的**唯一口径**在 `src/main/index.js` 的 `CURATED`，可用 `MB_CURATED` 覆盖。
 *      这里原本写死"10 条"，而代码是 15 —— 注释里的数字必然腐烂，别再写具体数）
 *
 * ### 一条刻意的设计：去重键与展示 URL 分开存
 *   `dedupe_key` 是归一化后的指纹（用于 UNIQUE）；`url` 是原文链接（用于跳转）。
 *   混用会出现"点开源站打不开"（因为归一化把跟踪参数去掉了，而有些站**依赖**它们）。
 * =====================================================================
 */

import path from 'node:path';
import fs from 'node:fs';
import { canonicalizeUrl, dedupeKey } from '../ingest/urls.js';
/* ⚠️ 又是那个"看着别扭但刻意"的方向（store → main）：feed-url.js 是**零依赖叶子模块**，
   而"本机 / 内网地址"的**唯一口径**在那里。在 store 里再抄一份 isPrivateHost
   就是第二份口径 —— 本项目在别处已经为此栽过四次。 */
import { isPrivateHost } from '../main/feed-url.js';
/* ★★ 「源 ↔ 类型」的**预置清单**只在这里被读一次，用来**播种**（见 migrate 的说明）。
 *
 * ⚠️ 播种之后**以 DB 为准**，代码里的这份清单不再参与任何决策。
 *    不这么做的话，用户改完映射、下次启动就被代码里的预置清单覆盖回去 ——
 *    又是一处"两份口径"，而本项目已经反复栽在这个模式上
 *    （CARD_SIZE / --win-pad / createLogSink / 数据目录口径，四处都是）。
 *
 * ⚠️ 方向是 db → ingest（而不是反过来）：ingest 不许反向依赖 db 的判断，
 *    否则"谁说了算"又要靠约定维持，而约定会腐烂。 */
import { DEFAULT_SOURCES, DEFAULT_CATEGORIES, isLocalOnlyCategory } from '../ingest/sources.js';

/** schema 版本。改结构时 +1，并在 migrate() 里加一段 —— 否则老库会静默少字段 */
export const SCHEMA_VERSION = 5;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  feed_url    TEXT    NOT NULL UNIQUE,
  kind        TEXT    NOT NULL DEFAULT 'rss',      -- rss | atom | json
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  -- ★ v3：这个源是谁放进来的。
  --   'preset' = 代码里的预置清单（src/ingest/sources.js）
  --   'custom' = 用户自己加的（粘贴一个 feed 地址）
  --   ⚠️ 这一列是 v3 才加的，它解决的是一处会**真丢用户数据**的口径问题：
  --      upsertSources 原先会把"不在预置清单里的源"一律停用 ——
  --      那是给"我从代码里删掉一个源"设计的，但它对**用户自己加的源**
  --      一视同仁 ⇒ 用户今天加一个源，下次抓取就被静默关掉。
  --      现在退役只针对 origin='preset' 的源。
  --   ⚠️ 默认值给 'custom' 而不是 'preset'：漏标的行宁可**不动它**
  --      （少停用一个源是小事，把用户加的源关掉是丢数据）。
  origin      TEXT    NOT NULL DEFAULT 'custom'
);

CREATE TABLE IF NOT EXISTS source_state (
  source_id       INTEGER PRIMARY KEY REFERENCES source(id) ON DELETE CASCADE,
  last_fetch_at   TEXT,
  last_ok_at      TEXT,
  last_status     TEXT,          -- ok | http_error | parse_error | network_error | empty
  last_error      TEXT,
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  total_items     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fetch_run (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  trigger       TEXT NOT NULL,   -- schedule | manual | catchup
  ok_count      INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  new_items     INTEGER NOT NULL DEFAULT 0,
  detail        TEXT
);

CREATE TABLE IF NOT EXISTS item (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  url           TEXT,                                   -- ★ 原始 URL，用于跳转
  url_canonical TEXT,                                   -- 仅用于比对/展示兜底
  summary       TEXT,
  author        TEXT,
  source_id     INTEGER REFERENCES source(id) ON DELETE SET NULL,
  source_name   TEXT,
  published_at  TEXT,                                   -- ISO；源没给就是 NULL
  fetched_at    TEXT NOT NULL,
  first_run_id  INTEGER REFERENCES fetch_run(id) ON DELETE SET NULL,
  -- 需求 3 的两种形态：能跳转就跳转；跳不动时退化为"展示已存的摘要"
  read_state    TEXT NOT NULL DEFAULT 'unread'          -- unread | opened
);

-- 分页游标索引：按时间倒序、id 兜底（同一秒多条时顺序才稳定）
CREATE INDEX IF NOT EXISTS idx_item_time   ON item (published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_item_source ON item (source_id);
CREATE INDEX IF NOT EXISTS idx_item_fetch  ON item (fetched_at DESC);

CREATE TABLE IF NOT EXISTS category (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  -- ★ 偏好（需求 2 的"配比"）：1 喜欢 / 0 中性 / -1 不喜欢
  --   ⚠️ 语义是**配比**不是过滤：不喜欢 = 少放但**不能没有**（配额见 shared/quota.js）
  pref       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS item_category (
  item_id     INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_itemcat_cat ON item_category (category_id);

/* ★★ 用户可编辑的「源 ↔ 类型」映射（本次功能的核心）。
 *
 * 为什么必须单独一张表：在这之前，"源属于哪个类型"**硬编码在
 * src/ingest/sources.js 里**（每个源带一个 categories 数组）。
 * 硬编码的清单没法被用户编辑 —— 改完下次启动就被代码覆盖，
 * 那正是本项目反复栽过的"两份口径"。
 * ⇒ 代码里的清单降级为**一次性播种源**，此后 DB 是唯一真相。
 *
 * ⚠️ 这张表是**绑定**，不是"条目的标签"：条目的标签仍然是 item_category
 *    （抓取那一刻按当时的映射打上，历史事实、不回溯改写）。
 *    两者的分工：source_category 决定**以后**抓来的条目进哪个类型，
 *    item_category 决定**已经抓到的**条目在筛选里出不出现。
 *    混成一张表的后果是"改一下映射，历史条目全部换类" —— 那等于伪造历史。
 */
CREATE TABLE IF NOT EXISTS source_category (
  source_id   INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_srccat_cat ON source_category (category_id);

-- 每天一份简报：默认精选 N 条，其余作为"当日存档"可展开
CREATE TABLE IF NOT EXISTS brief (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_date  TEXT NOT NULL UNIQUE,     -- YYYY-MM-DD（本地日）
  created_at  TEXT NOT NULL,
  curated_ids TEXT,                     -- JSON 数组：默认呈现的那 N 条
  headline    TEXT,                     -- 总览句（由 AI 生成）
  -- ↓ 阶段 M1「AI 摘要」补齐的列（此前只有上面五列，表是提前建好的）
  status      TEXT NOT NULL DEFAULT 'none',  -- ok | partial | fallback | failed | none
  model       TEXT,                     -- 这一份是哪个模型生成的（换模型要能看出来）
  input_hash  TEXT,                     -- 输入指纹：同一天同一批候选 + 同模型 ⇒ 不再花第二次钱
  token_used  INTEGER,                  -- 真实用量；拿不到就是 NULL，不拿估算冒充
  raw_count   INTEGER,                  -- 当天候选多少条（压缩率的分母）
  kept_count  INTEGER,                  -- 精挑多少条（压缩率的分子）
  pool_count  INTEGER,                  -- **真正送进模型的**有多少条（≤ MAX_RANK_POOL）
                                        -- ⚠️ 它与 raw_count 不是一回事：条目太多时只送最新的 300 条，
                                        --    两个数都要留着，否则「为什么我订阅的源更新了却没进简报」无法回答
  detail      TEXT                      -- 失败/降级原因，**中文、直接可显示**
);

/* 简报与条目的关联。
 * ⚠️ 为什么不把摘要塞进 brief 的一坨 JSON：
 *   「这一条为什么被选中」必须能被逐条查到（rank 就是排序），
 *   而塞进 JSON 之后，任何按条目反查简报的问题都要在应用层重写一遍。 */
CREATE TABLE IF NOT EXISTS brief_item (
  brief_id   INTEGER NOT NULL REFERENCES brief(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL DEFAULT 0,
  section    TEXT,                      -- 分组名
  ai_summary TEXT,                      -- 这一条的摘要（≤2 行）
  PRIMARY KEY (brief_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_briefitem_item ON brief_item (item_id);
`;

/**
 * 打开（并按需初始化）数据库。
 *
 * ⚠️ **本函数是异步的，而且 `node:sqlite` 用 `await import()` 延迟加载。**
 *    原因见 `db-setup.js` 顶部：**在 Electron 主进程顶层静态 import 它会原生崩溃**
 *    （0xC0000005，无 JS 报错、`whenReady` 永不触发）。真机踩过。
 *
 *    在纯 Node（测试 / `npm run ingest`）里没有这个问题，但**统一口径**更重要 ——
 *    两条路径用同一份代码，才不会出现"测试能跑、应用崩"的分裂。
 *
 * @param {string} file 路径；`:memory:` 用于测试
 * @returns {Promise<object>} 数据库连接
 */
export async function openDb(file) {
  let isNewFile = false;
  if (file !== ':memory:') {
    isNewFile = !fs.existsSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(DDL);

  const cur = getMeta(db, 'schema_version');
  if (cur === null) {
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  } else if (Number(cur) !== SCHEMA_VERSION) {
    migrate(db, Number(cur));
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  }
  /* ★★ 无论版本号如何，都再走一遍**结构性补齐**（幂等）。
   *
   * ⚠️ 为什么要多这一步（这是被一条"造老库"的断言逼出来的）：
   *    `migrate` 只在**版本号不匹配**时才跑，而"列缺失但版本号对/没有版本号"
   *    是真实存在的状态 —— 最典型的一种是**版本号那一行丢了**
   *    （手改过库、或者上一次写入被中断）。那种库会被当成"全新库"，
   *    于是 `CREATE TABLE IF NOT EXISTS` 因为表已存在而跳过、
   *    迁移也不跑 ⇒ 表里**永远少一列**，之后每一次查询都报
   *    "no such column" —— 而错误信息完全指不到"少了哪一步"。
   *    ⇒ 补齐是按"列在不在"判断的，重跑无害（见 migrate 的说明）。 */
  ensureColumns(db);
  /* ⚠️⚠️ 这里**不再播种**（原来是有的，本次删掉）。
   *
   *    原因是它必然会违反"用户改过的不被覆盖"：`openDb` 拿不到"哪些源是新加进来的"
   *    这个信息，只能按整个预置清单播一遍 ⇒ 用户把某个源从**所有**类型里取消
   *    （映射表里一行都不剩）之后，下一次打开库它又被绑回来。
   *    实测：老库升级那条断言里，用户整组取消的 7 个源全部复活。
   *
   *    ⇒ 播种改由 `runIngest` 在**登记新源的那一刻**精确执行
   *      （它手上有 `upsertSources` 返回的新增名单）。
   *      新库、老库、新加的预置源三条路径都在那里被覆盖到。 */
  return db;
}

/**
 * 结构性补齐：把"当前 schema 该有的列"逐条确认一遍（幂等）。
 *
 * ⚠️ 与 `migrate` 的分工：`migrate` 负责**逐版推进时的一次性动作**
 *    （比如"把历史条目的标签回填一次"），用版本号判断该不该做；
 *    本函数只做**幂等的列补齐**，不看版本号 —— 因为"表少一列"这件事
 *    与版本号没有必然联系。
 * ⚠️ 新增列时**两处都要加**：DDL 里给新库、这里给老库
 *    （漏了这里，老库就会在第一次查询时报 "no such column"）。
 */
function ensureColumns(db) {
  const hasColumn = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

  if (!hasColumn('category', 'pref')) {
    db.exec('ALTER TABLE category ADD COLUMN pref INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn('source', 'origin')) {
    /* ⚠️ 默认值给 'custom'（保守），紧接着**必须**把既有行标成 'preset' ——
       这个库里现存的行全是预置源。少写这一步的后果见 migrate 里的说明。 */
    db.exec("ALTER TABLE source ADD COLUMN origin TEXT NOT NULL DEFAULT 'custom'");
    const n = db.prepare("UPDATE source SET origin = 'preset' WHERE origin IS NULL OR origin = 'custom'").run();
    console.log(`[db] 已补上 source.origin 列，并把 ${n.changes} 个既有源标记为「预置」`);
  }
}

/**
 * 逐版推进的结构迁移。
 *
 * ⚠️⚠️ 这里**不再抛错让用户删库**（初版是那样的，理由是"M1 阶段 schema 还在动"）。
 *    现在不能那么干了：库里已经有**真实的用户数据**（近千条条目、
 *    几十个源的抓取历史），而"请删除该库文件后重新抓取"等于让用户
 *    亲手扔一次数据 —— 一个功能升级不该有这种代价。
 *
 * ⚠️ 迁移的每一步都必须**幂等**：迁移完才写 schema_version，中途崩掉的话
 *    下次启动会从同一个版本重来。用"列在不在"判断而不是"版本号是多少"，
 *    这样重跑不会炸（`ALTER TABLE ADD COLUMN` 重复执行会报 duplicate column）。
 *
 * @param {object} db 连接
 * @param {number} from 文件里的版本号
 */
function migrate(db, from) {
  const hasColumn = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

  /* ---- v1 → v2：类型偏好 + 用户可编辑的「源 ↔ 类型」----
   * DDL 用的是 `CREATE TABLE IF NOT EXISTS`，所以新表上面已经建好了；
   * 这里只需要补老表上**新增的列**，以及把历史条目的标签补上。 */
  if (from < 2) {
    if (!hasColumn('category', 'pref')) {
      db.exec('ALTER TABLE category ADD COLUMN pref INTEGER NOT NULL DEFAULT 0');
    }
    /* ★ 历史条目的标签回填（**只有这一次**，用 meta 标记记住）。
     *
     * 为什么需要：在本次改动之前，一个条目标着哪些类型，取决于抓它那一刻
     * `sources.js` 里那个源的 `categories` 数组。现在映射搬进了 DB，
     * 若不对历史条目做一次回填，用户在"安全与隐私"里会**看不到任何已有条目**
     * —— 他甚至会以为筛选坏了，而这只是"标签还没跟过来"。
     *
     * ⚠️ 只跑一次（而不是每次启动都同步）：用户改映射之后，历史条目的标签
     *    不该跟着改 —— 标签是"抓取那一刻的事实"，跟着映射漂移就等于伪造历史。
     *    这一次回填只是把**迁移前那套硬编码映射**（与播种进 DB 的映射逐字相同）
     *    落到历史条目上，不引入任何新的判断。 */
    if (getMeta(db, 'source_category_backfill') !== '1') {
      const n = db
        .prepare(
          `INSERT OR IGNORE INTO item_category (item_id, category_id)
           SELECT i.id, sc.category_id FROM item i JOIN source_category sc ON sc.source_id = i.source_id`,
        )
        .run();
      setMeta(db, 'source_category_backfill', '1');
      if (Number(n.changes) > 0) {
        console.log(`[db] 已把「源 ↔ 类型」映射回填到 ${n.changes} 条历史标签上（只做这一次）`);
      }
    }
  }

  /* ---- v2 → v3：源要能区分"预置"与"用户自己加的" ----
   *
   * ⚠️ 这一列解决一处**真会丢用户数据**的口径问题：`upsertSources` 原先
   *    把"不在预置清单里的源"一律停用 —— 那是为"我从代码里删掉一个源"设计的，
   *    但它对用户自己加的源一视同仁 ⇒ 用户今天加、下次抓取就被静默关掉。
   *
   * ⚠️ 迁移把**所有现存行**标成 'preset'：这次升级之前，库里不可能有
   *    用户自己加的源（那时候根本没有"加源"这个入口），所以这个判断是确定的。
   *    不这么写的话（比如用列默认值 'custom'），老库里的预置源会全部
   *    被当成用户源 ⇒ 代码里删源的那条退役逻辑**永久失效**。 */
  if (from < 3) {
    if (!hasColumn('source', 'origin')) {
      db.exec("ALTER TABLE source ADD COLUMN origin TEXT NOT NULL DEFAULT 'custom'");
    }
    const n = db.prepare("UPDATE source SET origin = 'preset' WHERE origin IS NULL OR origin = 'custom'").run();
    console.log(`[db] 已把 ${n.changes} 个既有源标记为「预置」（升级前不存在用户自加的源）`);
  }
  /* ---- v3 → v4：AI 简报（M1 交付物里的最后一项）----
   *
   * ⚠️ `brief` 表在阶段 1 就建好了，但当时只有「日期 / 头图 / 精选 id / 总览句」四列，
   *    而 AI 摘要真正跑起来之后，**至少还要能回答三个问题**：
   *      ① 这一份是怎么来的（`status` + `model` + `detail`）；
   *      ② 今天花了多少钱（`token_used`，北极星辅助指标要求它可见）；
   *      ③ 压缩率是多少（`raw_count` / `kept_count` —— 没有这两个数就只能靠猜）；
   *    `input_hash` 则是**花钱的闸门**：同一批候选不许调第二次。
   *
   * ⚠️ 老库必须靠 ALTER 补列（`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作），
   *    这就是 `hasColumn` 存在的理由 —— 重复执行不会炸。
   * 已有的 `brief` 行（如果用户在阶段 1 存过）保持原样：status 默认 'none'，
   * 意思是「这一份不是 AI 生成的」，这是**如实描述**，不是把旧数据当成失败。 */
  if (from < 4) {
    const addCol = (col, ddl) => { if (!hasColumn('brief', col)) db.exec('ALTER TABLE brief ADD COLUMN ' + ddl); };
    addCol('status', "status TEXT NOT NULL DEFAULT 'none'");
    addCol('model', 'model TEXT');
    addCol('input_hash', 'input_hash TEXT');
    addCol('token_used', 'token_used INTEGER');
    addCol('raw_count', 'raw_count INTEGER');
    addCol('kept_count', 'kept_count INTEGER');
    addCol('detail', 'detail TEXT');
    console.log('[db] brief 表已补齐 AI 简报所需的列（老数据保持原样，不会被当成失败）');
  }

  /* ---- v4 → v5：把「送进模型多少条」也记下来 ----
   *
   * ⚠️ 起因是一个用户视角的问题：一天抓到 800 条时，只把**最新的 300 条**送进模型
   *    （见 shared/ai/plan.js 的 MAX_RANK_POOL），而界面原来只显示「候选 800 条」——
   *    用户看到的是「我订阅的源明明更新了，简报里却没有」，且没有任何地方解释。
   * ⇒ 把 pool_count 单独记一列：raw_count 是「今天有多少条」，它是「模型看了多少条」。
   *    两个数一起显示，截断就是**看得见**的事实，而不是一个沉默的猜测。 */
  if (from < 5) {
    if (!hasColumn('brief', 'pool_count')) db.exec('ALTER TABLE brief ADD COLUMN pool_count INTEGER');
    console.log('[db] brief 表已加上 pool_count（送进模型的条数）');
  }

  console.log(`[db] schema ${from} → ${SCHEMA_VERSION} 迁移完成（数据未删除）`);
}

/**
 * 登记预置类别（幂等）。
 *
 * @param {boolean} includeLocalOnly 要不要连「只有本机源撑得起来」的那几个也建出来。
 *   ⚠️ 缺省 **false** —— 建了就是给全新用户一个点进去永远是空的 chip
 *      （见 sources.js 的 LOCAL_ONLY_CATEGORIES 说明）。
 * @returns {number} 这次**新登记**了几个（已存在的不算）
 */
export function ensurePresetCategories(db, nowIso, includeLocalOnly = false) {
  let created = 0;
  DEFAULT_CATEGORIES.forEach((name, i) => {
    if (!includeLocalOnly && isLocalOnlyCategory(name)) return;
    const existed = db.prepare('SELECT 1 FROM category WHERE name = ?').get(name) != null;
    upsertCategory(db, name, i, nowIso);
    if (!existed) created += 1;
  });
  return created;
}

/**
 * 「这一批源里，有没有**启用着的**源撑着本机专属类别」。
 *
 * 判据刻意是**库里的启用状态**，而不是「清单里有没有」：
 * 类别是给用户点的，一个默认关闭的源不会给它带来任何内容
 * （见 LOCAL_ONLY_CATEGORIES 说明）。
 */
export function localOnlyCategoriesWanted(db, pool) {
  const byUrl = new Map(listSources(db).map((s) => [String(s.feed_url), s]));
  for (const s of pool || []) {
    const row = byUrl.get(String(s.feedUrl));
    if (!row || !row.enabled) continue;
    for (const c of s.categories || []) if (isLocalOnlyCategory(c)) return true;
  }
  return false;
}

/**
 * ★★ 把「本机专属类别」按需登记出来，并绑给**已经启用**的那些本机源。
 *
 * 由 setLocalSourcesEnabled(db, true) 调用 —— 也就是用户明确说
 * 「我要用本机 RSSHub 了」的那一刻。在此之前这些类别根本不存在，
 * 所以全新用户不会看到那几个永远空的 chip。
 *
 * 三条纪律（与播种 / 迁移完全一致，破坏任何一条都会变成「两份口径」）：
 *   ① **只加不删** —— 关闭本机源不删类别、不删绑定（用户可能只是临时关掉）；
 *   ② **跳过用户主动摘干净的源**（unbound_by_user: 记号）；
 *   ③ **幂等** —— 反复开关不会重复建、不会重复绑。
 *
 * @returns {{created:number, added:number}}
 */
export function ensureLocalCategories(db, nowIso) {
  const byUrl = new Map(listSources(db).map((s) => [String(s.feed_url), s]));
  const removedByUser = new Set(
    db
      .prepare("SELECT key FROM meta WHERE key LIKE 'unbound_by_user:%'")
      .all()
      .map((r) => Number(String(r.key).slice('unbound_by_user:'.length)))
      .filter((n) => Number.isFinite(n)),
  );
  /* 要建哪几个类别、各绑给谁 —— 只认**启用着的**源 */
  const want = new Map();
  for (const s of DEFAULT_SOURCES) {
    const row = byUrl.get(String(s.feedUrl));
    if (!row || !row.enabled) continue;
    const id = Number(row.id);
    if (removedByUser.has(id)) continue;
    for (const name of s.categories || []) {
      if (!isLocalOnlyCategory(name)) continue;
      if (!want.has(name)) want.set(name, new Set());
      want.get(name).add(id);
    }
  }
  const catId = new Map(listCategories(db).map((c) => [String(c.name), Number(c.id)]));
  const ins = db.prepare('INSERT OR IGNORE INTO source_category (source_id, category_id) VALUES (?, ?)');
  let created = 0;
  let added = 0;
  for (const [name, ids] of want) {
    let cid = catId.get(name);
    if (cid == null) {
      const i = DEFAULT_CATEGORIES.indexOf(name);
      cid = Number(upsertCategory(db, name, i < 0 ? 99 : i, nowIso));
      catId.set(name, cid);
      created += 1;
    }
    for (const id of ids) added += Number(ins.run(id, cid).changes || 0);
  }
  return { created, added };
}

/**
 * 用代码里的预置清单**播种**「源 ↔ 类型」映射。
 *
 * ⚠️⚠️ 三条口径，缺一条这个功能就会变成"改了不生效"或"改了被覆盖"：
 *
 *   ① **播种只发生一次**（`meta.source_category_seeded`）。
 *      用户从某个类型里摘掉的源，绝不能在下次启动时被代码里的清单加回来 ——
 *      那正是"两份口径"最典型的形态，也正是本项目反复栽过的模式。
 *      ⇒ 首次播种之后，`sources.js` 里那份 `categories` 数组就只是**初始值**，
 *        任何决策（抓取时打标签、界面上勾选）都读 DB。
 *
 *      ⚠️ 我第一版写的是"只加不减"（`INSERT OR IGNORE`），以为那就够了 ——
 *        **不够**：`INSERT OR IGNORE` 只保护"已经存在的行"，而用户删掉的那一行
 *        恰恰**不存在**，于是它每次启动都被重新插回来。用户侧看到的是
 *        "我取消勾选的那个源，重启之后自己又勾上了"。
 *        （这条是被 test-all 里那条"重开一次库"的断言当场咬住的。）
 *
 *   ② **新库第一次打开就播种**：类别表、源表这时可能还是空的 ⇒ 播不下去。
 *      没关系，第一次抓取会把预置源与预置类别登记进来，那时**同一个进程里**
 *      还会再播一次（`fresh` 为真时允许），于是新库的初始映射是完整的。
 *
 *   ③ **只读不写**：播种永远不删、不覆盖任何已有行。
 *
 *   ④ ★★ **该不该播，由调用方用"新增名单"说清楚**（`opts.only`）。
 *
 *      这里有一段我连错三次的历史，写下来免得下一个人再走一遍。
 *      要守的性质有两条，而且**互相拉扯**：
 *        ① 代码里**新加**一个预置源 ⇒ 它得按清单拿到类型绑定（否则条目
 *           一条都不打标签、按类型筛选完全看不到，而日志里一切正常）
 *        ② 用户把某个源从所有类型里**全取消**之后 ⇒ 绝不能在下次抓取时加回来
 *      麻烦在于这两种状态在库里**长得一模一样**：源存在、映射表里没有它的行。
 *      试过的三种判据：
 *        · "映射表里没有它的行就播" ⇒ 违反②（实测：用户整组取消的 7 个源全被绑回来）
 *        · "有 source_state 行就不播" ⇒ 违反①（`upsertSources` 先建 state 行、
 *          播种在后 ⇒ 新库一个源都不播，筛选栏空荡荡）
 *        · **只播"这次新增的"** ⇒ 两条都对，而且判据是**显式**的
 *      ⇒ 所以 `runIngest` 把 `upsertSources` 返回的 `newFeedUrls` 传进来；
 *        本函数只保留"已经有绑定的源绝不碰"这一道兜底。
 *
 * @param {object} db
 * @param {string} nowIso
 * @param {object} [opts]
 * @param {Array<object>} [opts.only] 只播这几个源（按 feedUrl 匹配）。
 *   缺省 = 按整个预置清单播一遍（`openDb` 的自举路径用）。
 */
export function seedSourceCategories(db, nowIso, opts = {}) {
  /* ⚠️⚠️ `only` **必填**（空数组也算"不播"）。这里不提供"缺省播全部"的路径 ——
   *    那正是原来 `openDb` 那条自举播种的做法，而它必然会把用户取消掉的源加回来
   *    （`openDb` 不知道哪些源是新加进来的，只能整份清单重播一遍）。
   *    ⇒ 播种的**唯一**入口是 `runIngest` 里"登记了新源"那一次。 */
  const pool = Array.isArray(opts.only) ? opts.only : [];
  if (!pool.length) return { seeded: 0, skipped: 'no-targets' };

  const cats = new Map();
  for (const c of listCategories(db)) cats.set(c.name, c.id);

  /* 预置类别也一并登记（新库第一次打开时类别表是空的，
     而映射的种子依赖类别名 → id；不先建类别，种子会全部落空）。 */
  ensurePresetCategories(db, nowIso, localOnlyCategoriesWanted(db, pool));
  for (const c of listCategories(db)) cats.set(String(c.name), Number(c.id));

  const srcIds = new Map();
  for (const s of listSources(db)) srcIds.set(s.feed_url, s.id);

  /* ★ 已经有绑定的源 id：那份映射就是"用户当前的态度"，一行都不许动。 */
  const hasBinding = new Set(
    db.prepare('SELECT DISTINCT source_id FROM source_category').all().map((r) => Number(r.source_id)),
  );
  /* ★★ 用户**主动摘干净**过的源（`setCategorySources` 写下记号的那些）。
   *
   * ⚠️ 为什么需要它：播种要区分"从没被播过"（该播）与"用户摘干净了"（别加回来），
   *    而这两种状态在数据里长得一模一样。记号是唯一能把它们分开的东西 ——
   *    没有它，代码里新加的源与升级留下的孤儿就永远播不上
   *    （真机上撞到过：新加的「澎湃新闻」20 条条目一条标签都没打）。 */
  const removedByUser = new Set(
    db
      .prepare("SELECT key FROM meta WHERE key LIKE 'unbound_by_user:%'")
      .all()
      .map((r) => Number(String(r.key).slice('unbound_by_user:'.length)))
      .filter((n) => Number.isFinite(n)),
  );

  const ins = db.prepare('INSERT OR IGNORE INTO source_category (source_id, category_id) VALUES (?, ?)');
  let seededCount = 0;
  let everythingResolvable = true;
  for (const s of pool) {
    const sid = srcIds.get(s.feedUrl);
    if (sid == null) { everythingResolvable = false; continue; } // 这个源还没登记，下次再播
    if (hasBinding.has(sid)) continue; // ★ 已经有绑定：用户的态度，绝不动
    if (removedByUser.has(sid)) continue; // ★ 用户把它摘干净过：绝不加回来
    let allCatsKnown = true;
    for (const name of s.categories || []) {
      const cid = cats.get(name);
      if (cid == null) { allCatsKnown = false; everythingResolvable = false; continue; }
      seededCount += Number(ins.run(sid, cid).changes);
    }
    /* 类别名解析不出来时**不记** —— 否则它会带着"半套绑定"被当成已完成，
       剩下的再也补不上。 */
    if (allCatsKnown) hasBinding.add(sid);
  }
  setMeta(db, 'source_category_seeded', '1');
  return { seeded: seededCount, complete: everythingResolvable };
}


export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

/* ------------------------------------------------------------------ */
/* 源                                                                  */
/* ------------------------------------------------------------------ */

/**
 * 登记一批源（幂等）。
 *
 * ⚠️ **`enabled` 以代码里的预置清单为准**（每次启动都同步）。
 *    为什么这样定：那些 `enabled: false` 的源不是"用户主动关掉的"，
 *    而是**代码里判定为"本机不可达 / 地址待确认"**。
 *    若不覆盖，老库里它们会一直开着 ⇒ 界面永远显示"5 个源异常"，
 *    而那是环境事实、不是缺陷，会把真正的异常淹掉。
 *
 *    代价说清楚：用户手动关某个源，下次启动会被代码里的 true 覆盖回来。
 *    ⇒ 阶段 2 会引入"用户覆盖层"（单独一张表记用户的选择）；
 *      在那之前**只有预置源**，所以这个口径不会丢用户数据。
 *
 * @returns {number} 新增条数
 */
export function upsertSources(db, sources, nowIso) {
  const ins = db.prepare(
    `INSERT INTO source (name, feed_url, kind, enabled, created_at, origin) VALUES (?, ?, ?, ?, ?, 'preset')
     ON CONFLICT(feed_url) DO UPDATE SET
       name    = excluded.name,
       kind    = excluded.kind,
       /* ★★ 「enabled」**刻意不在这里更新**（阶段 C 的修复，2026-09-25）。
        *
        * ⚠️ 原来这一行是「enabled = excluded.enabled」，后果是两件事，而且都很严重：
        *   ① 预置清单里的 enabled:false 会**每次抓取都写回库里** ——
        *      于是那个源**永远打不开**（用户就算有办法改，下次抓取也被抹掉）；
        *   ② 而全项目**没有任何地方**能让用户启用一个预置源
        *      （界面里那个勾选框管的是"绑到哪个类型"，不是"抓不抓"）。
        *   ⇒ 两者合起来 = 标了 enabled:false 的预置源是**死源**：
        *     注释里写着"有代理的机器可以把它们打开"，而实际上打不开。
        *
        * ⇒ 现在的口径与**类型映射**那条完全一致（见本文件 source_category 的说明）：
        *     代码里的清单是**首次登记时的默认值**，此后 **DB 是唯一真相**。
        *   · 新源 INSERT  ⇒ 用清单里的默认值；
        *   · 已有源      ⇒ 保持库里的值（用户 / 一次性命令改过就算数）；
        *   · 清单里**删掉**的源仍然由下面的退役逻辑停用（那条路是显式的）。
        *
        * ⚠️ 别再改回去：那会让"启用一个预置源"这件事在物理上不可能，
        *    而它的失败形态是"这个功能看起来做了、其实没有"。
        *
        * ⚠️⚠️ 这段注释住在**模板字符串里**（它就是这条 SQL 的一部分），
        *    所以这里**一个反引号都不能有** —— 有的话会提前闭合模板字符串，
        *    报 SyntaxError: missing ) after argument list，而且位置指得很远。
        *    （交接文档里记过这个坑，本次又踩了一次。） */
       /* ★ 一个源只要出现在预置清单里，它就是预置源。
          这条 UPDATE 顺手修掉一种历史遗留：老库里可能有行是
          origin='custom'（v3 迁移前的默认值），而它其实来自预置清单。 */
       origin  = 'preset'`,
  );
  let added = 0;
  /** ★ 这次**新登记**的源（按 feedUrl）。调用方拿它决定"给谁播类型映射" ——
   *  这是"新加的源"与"用户改动过的老源"之间**唯一可靠**的区分方式
   *  （两者在库里长得一模一样，见 fetch-feeds.js 里那段说明）。 */
  const newFeedUrls = [];
  for (const s of sources) {
    const before = db.prepare('SELECT id FROM source WHERE feed_url = ?').get(s.feedUrl);
    // 未显式声明就是启用（绝大多数源如此）
    const enabled = s.enabled === false ? 0 : 1;
    ins.run(s.name, s.feedUrl, s.kind || 'rss', enabled, nowIso);
    if (!before) {
      added += 1;
      newFeedUrls.push(s.feedUrl);
    }
    const row = db.prepare('SELECT id FROM source WHERE feed_url = ?').get(s.feedUrl);
    db.prepare('INSERT INTO source_state (source_id) VALUES (?) ON CONFLICT(source_id) DO NOTHING').run(row.id);
  }

  /* ★★ 从清单里**删掉**的源要停用（真机日志逼出来的）。
   *
   * 症状：我在代码里把 虎嗅 / 品玩 / cnBeta / 财新网 / 阮一峰周刊(feedburner) 换掉之后，
   *     用户机器上这几条**还在被反复抓**，每一轮都超时或返回 HTML，
   *     界面顶部因此长期挂着"5 个源异常"。
   * 根因：`upsertSources` 只做"加了什么"，从来不处理"去掉了什么" ——
   *     老库里的行原样留着、`enabled` 仍是 1，于是代码改了等于没改。
   *
   * ⚠️⚠️ **只管预置源**（v3 的修正，这一条是真会丢用户数据的边界）：
   *    退役逻辑是给"我从代码里删掉一个源"设计的，而用户自己加的源
   *    **天生就不在预置清单里** —— 一视同仁的话，
   *    用户今天粘一个 feed 地址进来、下次抓取就被静默关掉。
   *    用户侧的观感是"我加的源过一天自己没了"，而且**没有任何提示**。
   *    ⇒ 判据从"不在清单里"改成"不在清单里 **且** origin='preset'"。
   *
   * **不删行** —— 删了会连带删掉它的抓取历史（source_state），而停用是可逆的。
   *
   * @returns {{added:number, retired:string[]}}
   */
  const wanted = new Set(sources.map((s) => s.feedUrl));
  const retired = [];
  for (const row of db.prepare('SELECT id, name, feed_url, enabled, origin FROM source').all()) {
    if (wanted.has(row.feed_url)) continue;
    if (row.origin !== 'preset') continue; // ★ 用户自己加的源，永不因为清单而停用
    if (!row.enabled) continue; // 已经停用，不用再报一次
    db.prepare('UPDATE source SET enabled = 0 WHERE id = ?').run(row.id);
    retired.push(row.name);
  }
  return { added, retired, newFeedUrls };
}

/**
 * 加一个**用户自己的**源（origin='custom'）。
 *
 * ⚠️ 与 `upsertSources` 分开写是刻意的，理由有两条且都很实际：
 *   ① 它**不参与**"不在清单里就停用"那套口径（见上面的说明）；
 *   ② 它不该覆盖同 URL 的预置源。用户把一个预置源地址粘进"添加源"时，
 *      正确的行为是告诉他"库里已经有了"，而不是把它改写成 custom
 *      —— 那样这个源从此就脱离了预置清单的管理（代码里以后删它也不生效了）。
 *
 * @returns {{ok:boolean, id?:number, existed?:object, reason?:string}}
 */
export function addCustomSource(db, { name, feedUrl, kind }, nowIso) {
  const url = String(feedUrl || '').trim();
  const cleanName = String(name || '').trim().slice(0, 24);
  if (!url) return { ok: false, reason: 'feed 地址不能为空' };
  if (!cleanName) return { ok: false, reason: '源名称不能为空' };

  const existing = db.prepare('SELECT id, name, feed_url, origin FROM source WHERE feed_url = ?').get(url);
  if (existing) {
    return {
      ok: false,
      existed: { id: Number(existing.id), name: existing.name, origin: existing.origin },
      reason: `这个地址已经在库里了（${existing.name}${existing.origin === 'preset' ? '，是预置源' : ''}）`,
    };
  }

  const r = db
    .prepare("INSERT INTO source (name, feed_url, kind, enabled, created_at, origin) VALUES (?, ?, ?, 1, ?, 'custom')")
    .run(cleanName, url, kind || 'rss', nowIso);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO source_state (source_id) VALUES (?) ON CONFLICT(source_id) DO NOTHING').run(id);
  return { ok: true, id };
}

/** 删掉一个**用户自己的**源（预置源不许删 —— 删了下次抓取又被清单加回来，制造"删不掉"的假象） */
export function deleteCustomSource(db, sourceId) {
  const id = Number(sourceId);
  if (!Number.isFinite(id)) return { ok: false, reason: '源 id 不是数字' };
  const row = db.prepare('SELECT id, name, origin FROM source WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: '这个源不存在' };
  if (row.origin !== 'custom') {
    return { ok: false, reason: `「${row.name}」是预置源，不能删（在预置清单里改）` };
  }
  db.prepare('DELETE FROM source WHERE id = ?').run(id);
  return { ok: true, name: row.name };
}

/**
 * 分类体系的版本。**改动 DEFAULT_CATEGORIES 的结构时 +1**，
 * 迁移据此决定"这一轮要不要把已有源补进新体系"。
 */
export const TAXONOMY_VERSION = 3;

/**
 * 一次性把**已经在库里的预置源**补进新的分类体系（阶段 C）。
 *
 * ---------------------------------------------------------------------
 * 为什么需要它（不写这一步，新加的类别会**永远是空的**）
 * ---------------------------------------------------------------------
 * 一个类别有没有内容，只取决于**有没有源绑给它**（见 source_category 的说明）。
 * 而播种那条路的判据是"**已经有绑定的源，一行都不许动**"（阶段 A 连错五次定下来的，
 * 为的是不把用户取消掉的源加回来）。升级上来的库里，源**早就都有绑定**了
 * ⇒ 光是把新类别写进 DEFAULT_CATEGORIES，什么也不会发生。
 *
 * ⇒ 这里做一次**显式的、带版本号的一次性迁移**：给每个预置源**追加**它在新体系里的
 *   绑定。三条纪律，一条都不能破：
 *     ① **只加不删** —— 不碰任何已有的 source_category 行，也不碰 item_category
 *        （条目上的标签是抓取那一刻的历史事实，见那两张表的说明）；
 *     ② **跳过用户主动摘干净的源**（unbound_by_user: 记号）——
 *        与播种同一条判据，否则"我把它摘干净了，升级之后又自己回来了"；
 *     ③ **带版本号、只跑一次** —— 否则用户在新体系里取消勾选的源会被反复加回来。
 *
 * @param {object} db
 * @param {string} nowIso
 * @returns {{ok:boolean, version:number, added:number, skippedByUser:number, skippedUnbound:number, backfilled:number, skipped?:string}}
 */
export function migrateTaxonomy(db, nowIso) {
  const cur = Number(getMeta(db, 'taxonomy_version') || 0);
  if (Number.isFinite(cur) && cur >= TAXONOMY_VERSION) {
    return { ok: true, version: cur, added: 0, skippedByUser: 0, skippedUnbound: 0, backfilled: 0, skipped: 'already' };
  }

  // ① 先把新类登记进 category 表（排序按清单顺序 —— 那决定了 chips 与滑块的次序）
  ensurePresetCategories(db, nowIso, localOnlyCategoriesWanted(db, DEFAULT_SOURCES));
  const catId = new Map(listCategories(db).map((c) => [String(c.name), Number(c.id)]));

  // ② 用户在界面上**主动摘干净**过的源：一行都不许加回来
  const removedByUser = new Set(
    db
      .prepare("SELECT key FROM meta WHERE key LIKE 'unbound_by_user:%'")
      .all()
      .map((r) => Number(String(r.key).slice('unbound_by_user:'.length)))
      .filter((n) => Number.isFinite(n)),
  );

  /* ★★ 只补**已经有绑定**的源 —— 这一条是职责分工，不是优化。
   *
   * ⚠️ 为什么必须区分（真机上是**变异测试**把它逼出来的）：这个函数和
   *    seedSourceCategories 都会往 source_category 里写行。若不区分，迁移会把
   *    **全新库**里所有源一并绑上 —— 于是"播种"那条路**做了什么都看不出来**，
   *    连"不播种"这种坏实现都抓不住（变异体当场漏网，本轮真实发生过）。
   * ⇒ 分工：
   *      · 迁移 = 源**早就播过**了，只是那时只有旧维度的标签（升级路径）
   *      · 播种 = 源**一条绑定都没有**（新登记的源、升级留下的孤儿）
   *    判据就是"有没有绑定"，与播种那边"已经有绑定的源一行都不许动"正好互补。 */
  const boundNow = new Set(
    db.prepare('SELECT DISTINCT source_id FROM source_category').all().map((r) => Number(r.source_id)),
  );
  const srcIdByUrl = new Map(listSources(db).map((s) => [String(s.feed_url), Number(s.id)]));
  const ins = db.prepare('INSERT OR IGNORE INTO source_category (source_id, category_id) VALUES (?, ?)');
  let added = 0;
  let skippedByUser = 0;
  let skippedUnbound = 0;
  for (const s of DEFAULT_SOURCES) {
    const id = srcIdByUrl.get(String(s.feedUrl));
    if (id == null) continue; // 这个源还没登记进库（第一次抓取时才登记）—— 不归这一轮管
    if (!boundNow.has(id)) {
      skippedUnbound += 1; // 交给播种那条路（它才是"从零开始绑"的地方）
      continue;
    }
    if (removedByUser.has(id)) {
      skippedByUser += 1;
      continue;
    }
    for (const name of s.categories || []) {
      const cid = catId.get(String(name));
      if (cid == null) continue;
      added += Number(ins.run(id, cid).changes || 0);
    }
  }

  /* ★★ v3：把新维度的标签**回填到历史条目**上。
   *
   * ⚠️⚠️ 这一段是**真机上被用户骂出来的**：v2 只回填了「源 ↔ 类别」（source_category），
   *    没回填「条目 ↔ 类别」（item_category）。后果是升级之后：
   *      · 新体系里几乎空着（只有升级后新抓的那几条）
   *      · 而旧的「行业动态」留着**全部历史条目**（真机上 906 条 vs 新类别最多 143）
   *    用户看到的就是"除了行业动态，别的都特别少甚至没有"。
   *
   *    v2 里我写的是"item_category 是历史事实，不许回溯改写" —— **守过头了**。
   *    项目自己在 v1→v2 那一步就做过一次性回填（见上面 source_category_backfill 那段），
   *    口径是：**结构迁移那一次可以回填，平时的用户改动绝不回填**。
   *    这两件事必须分清，否则"重构分类"这个动作本身就是做不到的。
   *
   * ⚠️ 三条边界，一条都不能越：
   *   ① **只增不改不删** —— 一条已有的 item_category 行都不动；
   *   ② 只回填**一条新维度标签都没有**的条目（已经打过的绝不重复打，也不会被改写）；
   *   ③ 只回填**新维度**的类别（带「·」前缀的那些），旧的 8 个类别不再往条目上加。 */
  let backfilled = 0;
  if (cur < 3) {
    const newIds = listCategories(db)
      .filter((c) => String(c.name).includes('·'))
      .map((c) => Number(c.id));
    if (newIds.length) {
      const ph = newIds.map(() => '?').join(',');
      const pairs = db
        .prepare(
          'SELECT i.id AS item_id, sc.category_id AS category_id ' +
            'FROM item i JOIN source_category sc ON sc.source_id = i.source_id ' +
            'WHERE sc.category_id IN (' + ph + ')',
        )
        .all(...newIds);
      const hasNew = new Set(
        db
          .prepare('SELECT DISTINCT item_id FROM item_category WHERE category_id IN (' + ph + ')')
          .all(...newIds)
          .map((r) => Number(r.item_id)),
      );
      const insTag = db.prepare('INSERT OR IGNORE INTO item_category (item_id, category_id) VALUES (?, ?)');
      db.exec('BEGIN');
      try {
        for (const p of pairs) {
          if (hasNew.has(Number(p.item_id))) continue;
          backfilled += Number(insTag.run(Number(p.item_id), Number(p.category_id)).changes || 0);
        }
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* 已经回滚过了 */
        }
        throw err;
      }
    }
  }

  setMeta(db, 'taxonomy_version', String(TAXONOMY_VERSION));
  return { ok: true, version: TAXONOMY_VERSION, added, skippedByUser, skippedUnbound, backfilled };
}

/**
 * 把所有**本机地址**的预置源一次性开 / 关（阶段 C）。
 *
 * ⚠️ 为什么需要它：那组源（自建 RSSHub）**刻意不做进界面**（理由见 feed-url.js：
 *    能让程序去打本机端口的开关，应当由"明确知道自己开了什么服务"的用户来打开）。
 *    而 enabled 在阶段 C 之前是**改不了的**（见 upsertSources 里那段说明）——
 *    ⇒ 光有清单里的 enabled:false、却没有一条"打开"的路径，
 *      那组源就是死的，它们撑着的那些类别也就永远是空的。
 *
 * ⇒ 给一条**命令行**的口子：npm run ingest -- --enable-local
 *   与 MB_ALLOW_LOCAL_FEEDS 同一个哲学：这件事由明确知道自己在开什么的人来做。
 *
 * @param {object} db
 * @param {boolean} enabled
 * @param {string} [nowIso]
 * @returns {{changed:number, total:number, categoriesCreated:number, categoriesBound:number}}
 */
export function setLocalSourcesEnabled(db, enabled, nowIso = new Date().toISOString()) {
  const want = enabled ? 1 : 0;
  const urls = DEFAULT_SOURCES.filter((s) => isPrivateHost(hostOf(s.feedUrl))).map((s) => String(s.feedUrl));
  const st = db.prepare('UPDATE source SET enabled = ? WHERE feed_url = ? AND enabled <> ?');
  let changed = 0;
  for (const u of urls) changed += Number(st.run(want, u, want).changes || 0);
  /* ★★ 打开了本机源 ⇒ **现在**才登记「本机专属类别」并把源绑上去。
     ⚠️ 这一步不能省：全新库里那几个类别根本不存在（见 ensureLocalCategories），
        少了它，用户开了本机源、抓回来一堆条目，筛选栏里却**连类别都没有**。 */
  const cats = enabled ? ensureLocalCategories(db, nowIso) : { created: 0, added: 0 };
  return { changed, total: urls.length, categoriesCreated: cats.created, categoriesBound: cats.added };
}

/** 取 hostname（解析不了就返回空串 ⇒ 不会被当成"本机地址"） */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return '';
  }
}

export function listSources(db, onlyEnabled = false) {
  const sql =
    'SELECT s.*, st.last_fetch_at, st.last_ok_at, st.last_status, st.last_error, st.consecutive_fail, st.total_items ' +
    'FROM source s LEFT JOIN source_state st ON st.source_id = s.id ' +
    (onlyEnabled ? 'WHERE s.enabled = 1 ' : '') +
    'ORDER BY s.id';
  return db.prepare(sql).all();
}

export function recordSourceResult(db, sourceId, result, nowIso) {
  const ok = result.ok ? 1 : 0;
  /* consecutive_fail 的语义：**成功清零、失败累加**。
     界面靠它显示"这个源已经连挂 3 次" —— 这是"抓取失败必须可见"的落地。 */
  const prev = db.prepare('SELECT consecutive_fail FROM source_state WHERE source_id = ?').get(sourceId);
  const nextFail = ok ? 0 : (prev ? prev.consecutive_fail : 0) + 1;

  db.prepare(
    `INSERT INTO source_state (source_id, last_fetch_at, last_ok_at, last_status, last_error, consecutive_fail, total_items)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       last_fetch_at    = excluded.last_fetch_at,
       last_ok_at       = COALESCE(excluded.last_ok_at, source_state.last_ok_at),
       last_status      = excluded.last_status,
       last_error       = excluded.last_error,
       consecutive_fail = excluded.consecutive_fail,
       total_items      = source_state.total_items + excluded.total_items`,
  ).run(
    sourceId,
    nowIso,
    ok ? nowIso : null,
    result.status || (ok ? 'ok' : 'unknown'),
    result.error || null,
    nextFail,
    result.itemCount || 0,
  );
}

/* ------------------------------------------------------------------ */
/* 条目                                                                */
/* ------------------------------------------------------------------ */

export function startRun(db, trigger, nowIso) {
  const r = db.prepare('INSERT INTO fetch_run (started_at, trigger) VALUES (?, ?)').run(nowIso, trigger);
  return Number(r.lastInsertRowid);
}

export function finishRun(db, runId, stats, nowIso) {
  db.prepare(
    'UPDATE fetch_run SET finished_at = ?, ok_count = ?, fail_count = ?, new_items = ?, detail = ? WHERE id = ?',
  ).run(nowIso, stats.okCount || 0, stats.failCount || 0, stats.newItems || 0, stats.detail || null, runId);
}

/**
 * 插入一条条目。**已存在（去重键相同）就返回 null** —— 调用方据此统计"新增几条"。
 *
 * @returns {{id:number, isNew:boolean}|null}
 */
export function insertItem(db, it, runId, nowIso) {
  const key = dedupeKey(it);
  if (!key) return null; // 无 URL 也无标题指纹 ⇒ 无法去重，调用方应记一笔而不是硬塞

  const existing = db.prepare('SELECT id FROM item WHERE dedupe_key = ?').get(key);
  if (existing) return { id: existing.id, isNew: false };

  const r = db
    .prepare(
      `INSERT INTO item (dedupe_key, title, url, url_canonical, summary, author, source_id, source_name,
                         published_at, fetched_at, first_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      key,
      it.title,
      it.url || null,
      canonicalizeUrl(it.url || ''),
      it.summary || null,
      it.author || null,
      it.sourceId ?? null,
      it.sourceName || null,
      it.publishedAt || null,
      nowIso,
      runId ?? null,
    );
  return { id: Number(r.lastInsertRowid), isNew: true };
}

/**
 * 分页查询（**游标式**，不是 OFFSET）。
 *
 * 为什么必须游标：`OFFSET n` 在"翻页期间后台又抓了一批新条"时会
 * **漏掉或重复**条目 —— 而"完整覆盖"正是需求 2 的目标，漏条直接违背它。
 * 游标用 `(published_at, id)` 严格小于上一页末条，**新增数据不会打乱已翻过的页**。
 *
 * 排序口径：`published_at DESC, id DESC`。**`published_at` 为 NULL 的排最后**
 * （有些源不给时间；把它们混进"最新"里会误导）。
 *
 * @param {object} opts
 * @param {number} [opts.limit]
 * @param {{publishedAt:string|null, id:number}} [opts.cursor] 上一页最后一条
 * @param {number[]} [opts.categoryIds] 筛选：命中任一类别即可
 * @param {number[]} [opts.sourceIds]
 * @param {number[]} [opts.skipIds] 明确排除的条目 id（见下面"配额翻页"的说明）
 * @returns {{rows: Array<object>, nextCursor: object|null, hasMore: boolean}}
 */
export function queryItems(db, opts = {}) {
  /* ⚠️ 这里必须用 `??` 而不是 `||`（真机之外、被测试抓到的一个真 bug）。
   *
   * `opts.limit || 10` 的语义是错的：**`0` 是 falsy**，于是调用方明确传 0 时
   * 会被当成"没传"→ 回退到默认 10 → **一次返回 10 条**。
   * 实测：`queryItems(db, {limit: 0})` 在 5 条数据上返回了 **5 条**（而不是夹到 1 条）。
   *
   * 分页场景里这类错误很危险：某个上游把 limit 算成 0（比如"剩余条数"算错）时，
   * 界面会**突然显示一整页**，而不是明确地"什么都没有"。
   * ⇒ `??` 只对 `undefined` / `null` 生效，数字 0 会被如实传下去再由夹取处理。 */
  const rawLimit = opts.limit ?? 10;
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 10));
  const where = [];
  const params = [];

  if (opts.categoryIds && opts.categoryIds.length) {
    where.push(
      `id IN (SELECT item_id FROM item_category WHERE category_id IN (${opts.categoryIds.map(() => '?').join(',')}))`,
    );
    params.push(...opts.categoryIds);
  }
  if (opts.sourceIds && opts.sourceIds.length) {
    where.push(`source_id IN (${opts.sourceIds.map(() => '?').join(',')})`);
    params.push(...opts.sourceIds);
  }
  if (opts.cursor && opts.cursor.id != null) {
    /* ⚠️ 游标要覆盖**三段**排序，漏一段就会丢条目（这里踩过一次）。
     *
     * 排序是：`(published_at IS NULL) ASC, published_at DESC, id DESC`
     *   ⇒ 第一段：有时间、按时间倒序
     *   ⇒ 第二段：**没有时间**（NULL）、按 id 倒序
     *
     * 最初的游标只写 `published_at < ? OR (published_at = ? AND id < ?)`。
     * 而 SQL 里 `NULL < '任何值'` 的结果是 **NULL（假）** ——
     * 于是**所有没有时间的条目在第一页之后就再也取不到了**。
     * 测试当场抓住（33 条只翻出 30 条）。
     *
     * ⇒ 修法：游标里带上"已经翻到 NULL 段了吗"（`pendingNull`），
     *   并用 `published_at IS NULL` 作为进入 NULL 段的判据。 */
    if (opts.cursor.pendingNull) {
      // 已经在 NULL 段：只在 NULL 段里按 id 继续往前
      where.push('(published_at IS NULL AND id < ?)');
      params.push(opts.cursor.id);
    } else {
      // 还在有时间段：要么时间更早；要么**已经进入 NULL 段**（必须放行，否则丢条目）
      where.push('(published_at < ? OR (published_at = ? AND id < ?) OR published_at IS NULL)');
      params.push(opts.cursor.publishedAt, opts.cursor.publishedAt, opts.cursor.id);
    }
  }
  if (opts.excludeNullDate) {
    where.push('published_at IS NOT NULL');
  }
  /* ★ 配额翻页的"跳过"（本次改动）。
     有偏好时，首页取的是一个**比页大的候选池**、再按配额挑出 N 条 ——
     于是游标指向"最后一条选中项"，而池子里被跳过的那些条目
     会在下一页被重新取到（同一条出现两次）。
     ⇒ 由 buildBrief 把"本页已经在池子里见过的 id"放进游标带回来，
        这里显式排除。**这是有据可查的跳过，不是 UI 层的顺手去重** ——
        后者会把口径问题藏进界面，日志里彻底消失。 */
  if (opts.skipIds && opts.skipIds.length) {
    const ids = opts.skipIds.map(Number).filter((n) => Number.isFinite(n));
    if (ids.length) {
      where.push(`id NOT IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
  }
  /* 「看今天全部」模式：把结果**真的**限制在今天之内。
     ⚠️ 为什么需要它：按钮上写着"看今天全部（N）"，而 N 是**当日**总数；
        如果查询不按日期收口，点下去会翻出一堆前几天的条目 ——
        文案与实际结果不符，用户会认为"筛选/翻页是坏的"。
        口径与 `countItems({sinceIso})` **必须逐字一致**（含 fetched_at 兜底），
        否则"共 N 条"和"实际能翻出多少条"对不上。 */
  if (opts.todayOnly && opts.sinceIso) {
    where.push('(published_at >= ? OR (published_at IS NULL AND fetched_at >= ?))');
    params.push(opts.sinceIso, opts.sinceIso);
  }

  const sql =
    'SELECT id, dedupe_key, title, url, summary, author, source_id, source_name, published_at, fetched_at, read_state ' +
    'FROM item ' +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY (published_at IS NULL), published_at DESC, id DESC LIMIT ?';
  const rows = db.prepare(sql).all(...params, limit + 1); // 多取 1 条用于判断 hasMore

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    rows: page,
    hasMore,
    /* 游标带上 pendingNull：告诉下一页"该进 NULL 段了"。
       少了这个字段，NULL 段的条目会被跳过（见上面那段说明）。 */
    nextCursor:
      hasMore && last
        ? { publishedAt: last.published_at, id: last.id, pendingNull: last.published_at === null }
        : null,
  };
}

/** 当日条目总数（用于"完整覆盖"的进度显示与翻页上限） */
export function countItems(db, opts = {}) {
  const where = [];
  const params = [];
  if (opts.sinceIso) {
    // 含 fetched_at 兜底：源没给 published_at 的条目也要能算进"今天抓到的"
    where.push('(published_at >= ? OR (published_at IS NULL AND fetched_at >= ?))');
    params.push(opts.sinceIso, opts.sinceIso);
  }
  if (opts.categoryIds && opts.categoryIds.length) {
    where.push(
      `id IN (SELECT item_id FROM item_category WHERE category_id IN (${opts.categoryIds.map(() => '?').join(',')}))`,
    );
    params.push(...opts.categoryIds);
  }
  if (opts.sourceIds && opts.sourceIds.length) {
    where.push(`source_id IN (${opts.sourceIds.map(() => '?').join(',')})`);
    params.push(...opts.sourceIds);
  }
  const sql = 'SELECT COUNT(*) AS n FROM item ' + (where.length ? 'WHERE ' + where.join(' AND ') : '');
  return db.prepare(sql).get(...params).n;
}

/** 源健康度汇总 —— 界面顶部要显示"几个源正常 / 几个挂了" */
export function sourceHealth(db) {
  return db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN st.last_status = 'ok' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN st.last_status IS NOT NULL AND st.last_status <> 'ok' THEN 1 ELSE 0 END) AS bad,
         SUM(CASE WHEN st.last_status IS NULL THEN 1 ELSE 0 END) AS never
       FROM source s LEFT JOIN source_state st ON st.source_id = s.id
       WHERE s.enabled = 1`,
    )
    .get();
}

/* ------------------------------------------------------------------ */
/* 类别（需求 2 的筛选）                                                */
/* ------------------------------------------------------------------ */

/**
 * 登记/更新一个类别（幂等）。
 *
 * ⚠️ `ON CONFLICT` 分支里**刻意不碰 `pref`**（本次改动的要点之一）：
 *    首次抓取会用预置清单把 8 个类别的名字再登记一遍，
 *    若这里顺手把 pref 写成默认值，用户设的"喜欢/不喜欢"会被
 *    **每次抓取**清掉 —— 用户侧看到的是"配比设了没用"，
 *    而原因埋在一句看起来无害的 upsert 里。
 */
export function upsertCategory(db, name, sortOrder, nowIso) {
  db.prepare(
    'INSERT INTO category (name, sort_order, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET sort_order = excluded.sort_order',
  ).run(name, sortOrder, nowIso);
  return db.prepare('SELECT id FROM category WHERE name = ?').get(name).id;
}

export function listCategories(db) {
  return db.prepare('SELECT * FROM category ORDER BY sort_order, id').all();
}

export function tagItem(db, itemId, categoryIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO item_category (item_id, category_id) VALUES (?, ?)');
  for (const cid of categoryIds) ins.run(itemId, cid);
}

/**
 * 删除一个类别。
 *
 * ★★ **只删分类与绑定，绝不删 item**（这是本次改动里最要紧的一条边界）。
 *    条目是"抓来的事实"：它属于哪个类型是个**视图**，而条目本身不是。
 *    把分类操作做成"连带删条目"的话，用户整理一下类型就会永久丢数据，
 *    而且丢得毫无提示 —— 这类错误在桌面应用里是不可挽回的。
 *
 * ⚠️ 三张表要清干净，缺一张就会留下悬挂引用：
 *      item_category  —— 条目的标签（不删的话，删掉的类别仍会把条目筛出来）
 *      source_category—— 源 ↔ 类型绑定（不删的话，下次抓取又会 tagItem，
 *                        于是"已删除的类型"悄悄复活成一个没有任何 UI 入口的孤儿）
 *      category       —— 分类本身
 *
 * @returns {{ok:boolean, removed?:object, reason?:string}}
 */
export function deleteCategory(db, categoryId) {
  const id = Number(categoryId);
  if (!Number.isFinite(id)) return { ok: false, reason: '类别 id 不是数字' };
  const row = db.prepare('SELECT id, name FROM category WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: '这个类别不存在' };

  /* ⚠️ 计数必须在删除**之前**取：删完再 count 永远是 0，
     调用方（与日志）就拿不到"影响面"这个唯一的反馈。 */
  const tagged = db.prepare('SELECT COUNT(*) AS n FROM item_category WHERE category_id = ?').get(id).n;
  const bound = db.prepare('SELECT COUNT(*) AS n FROM source_category WHERE category_id = ?').get(id).n;
  const itemsBefore = db.prepare('SELECT COUNT(*) AS n FROM item').get().n;

  db.prepare('DELETE FROM item_category WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM source_category WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM category WHERE id = ?').run(id);

  const itemsAfter = db.prepare('SELECT COUNT(*) AS n FROM item').get().n;
  /* ★ 这一条是**自证**：如果哪天有人把外键改成级联删条目，这里当场就报出来，
     而不是等到用户发现条目少了。返回给上层的数字不会说谎。 */
  if (itemsAfter !== itemsBefore) {
    return { ok: false, reason: `删除类别时条目数从 ${itemsBefore} 变成了 ${itemsAfter}（这是缺陷，已中止）` };
  }
  return { ok: true, removed: { id, name: row.name, tags: tagged, bindings: bound }, itemsKept: itemsAfter };
}

/**
 * 某个**类别**绑定了哪些源 id（用户可编辑的那份映射）。
 *
 * ⚠️ 名字故意长：第一版叫 `getCategorySources(db, categoryId)`，
 *    我在一条断言里把**源 id** 传了进去，得到的是一句无声的 `[]` ——
 *    排查花了很久（数据明明在库里、裸 SQL 也查得到）。
 *    ⇒ 名字里写清"入参是类别、出参是源 id"，这种错就没法悄悄发生。
 */
export function listSourceIdsOfCategory(db, categoryId) {
  const id = Number(categoryId);
  if (!Number.isFinite(id)) return [];
  return db
    .prepare('SELECT source_id FROM source_category WHERE category_id = ? ORDER BY source_id')
    .all(id)
    .map((r) => Number(r.source_id));
}

/** 某个**源**绑定了哪些类别 id（上面那个函数的反方向；名字写清方向，别再传错） */
export function listCategoryIdsOfSource(db, sourceId) {
  const sid = Number(sourceId);
  if (!Number.isFinite(sid)) return [];
  return db
    .prepare('SELECT category_id FROM source_category WHERE source_id = ? ORDER BY category_id')
    .all(sid)
    .map((r) => Number(r.category_id));
}

/**
 * 给一个源**已有的条目**补上类型标签（按它当前的映射关系）。
 *
 * ---------------------------------------------------------------------
 * 为什么需要它，以及它为什么**不能**做成"每次抓取都跑"
 * ---------------------------------------------------------------------
 * 标签（`item_category`）是**抓取那一刻**按当时的映射写下的 —— 那是有意的：
 * 它是"当时的事实"，跟着映射漂移就等于伪造历史。
 * 但代码升级会留下一种**孤儿**：某个源被旧版本登记过、却从来没被播过映射
 * （本次真机上的「澎湃新闻」就是），于是它已有的条目**一条标签都没有** ——
 * 按类型筛选时完全看不到（用户侧就是"这个源的内容不见了"，
 * 而"全部"里明明有它）。⇒ 绑定刚补上的那一次，要把已有条目也补上标签。
 *
 * ⚠️⚠️ 必须带 `meta` 记号（调用方传 key），**只做一次**：
 *    否则用户手动把某个源从类型里摘掉之后，下一次抓取又被补回来 ——
 *    那正是"用户改过的被覆盖"。
 * ⚠️ 只**新增**标签（`INSERT OR IGNORE`），绝不删任何已有标签。
 *
 * @returns {{tagged:number}} 本次写入的标签行数
 */
export function tagExistingItemsOfSource(db, sourceId, markerKey) {
  const sid = Number(sourceId);
  if (!Number.isFinite(sid)) return { tagged: 0 };
  if (markerKey && getMeta(db, markerKey) === '1') return { tagged: 0 };
  const cats = listCategoryIdsOfSource(db, sid);
  let tagged = 0;
  if (cats.length) {
    /* ⚠️ 判据是"这个源的条目**一条标签都没有**" —— 只有那种情况才补。
       已经有一部分标签的源不碰：那说明标签是按当时自己的映射写的，
       而用户可能**故意**去掉了某几条的标签（界面上的取消勾选），
       一律重打就等于把用户的改动盖掉。 */
    const orphan = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM item i WHERE i.source_id = ?
           AND NOT EXISTS (SELECT 1 FROM item_category ic WHERE ic.item_id = i.id)`,
        )
        .get(sid).n,
    );
    if (orphan === 0) {
      if (markerKey) setMeta(db, markerKey, '1'); // 没有需要补的 ⇒ 也记账，别每次都查
      return { tagged: 0 };
    }
    const r = db
      .prepare(
        `INSERT OR IGNORE INTO item_category (item_id, category_id)
         SELECT i.id, sc.category_id FROM item i
         JOIN source_category sc ON sc.source_id = i.source_id
         WHERE i.source_id = ?`,
      )
      .run(sid);
    tagged = Number(r.changes);
  }
  if (markerKey) setMeta(db, markerKey, '1');
  return { tagged };
}

/**
 * 覆盖式设置某个类别绑定了哪些源。
 *
 * ★ 用"先清后写"而不是"只增不减"：界面上是一组勾选框，用户**取消勾选**
 *   必须真的解绑 —— 只增不减的写法会让"取消勾选"变成一个静默的空操作，
 *   而用户以为已经改好了（这与 `upsertSources` 那个"只加不减"的坑同源，
 *   区别是那里要保留用户选择，这里正是用户在表达选择）。
 *
 * ⚠️ 全过程在一个事务里：中途失败留下"清了一半"的映射，
 *    表现是随机几个源莫名不再抓取 —— 最难查的那种。
 *
 * @returns {{ok:boolean, categoryId:number, sourceIds:number[], reason?:string}}
 */
export function setCategorySources(db, categoryId, sourceIds) {
  const id = Number(categoryId);
  if (!Number.isFinite(id)) return { ok: false, reason: '类别 id 不是数字' };
  if (!db.prepare('SELECT id FROM category WHERE id = ?').get(id)) {
    return { ok: false, reason: '这个类别不存在' };
  }
  const list = Array.isArray(sourceIds) ? sourceIds : [];
  const known = new Set(listSources(db).map((s) => Number(s.id)));
  /* 只接受库里真实存在的源 id：界面上传错一个 id 不该变成一行悬挂绑定 */
  const clean = [...new Set(list.map(Number).filter((n) => Number.isFinite(n) && known.has(n)))];
  /* 改动**之前**这个类型绑了谁 —— 用来判断"有没有源被摘干净了" */
  const beforeBound = db
    .prepare('SELECT source_id FROM source_category WHERE category_id = ?')
    .all(id)
    .map((r) => Number(r.source_id));

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM source_category WHERE category_id = ?').run(id);
    const ins = db.prepare('INSERT OR IGNORE INTO source_category (source_id, category_id) VALUES (?, ?)');
    for (const sid of clean) ins.run(sid, id);
    /* ★★ 被摘掉的源里，哪些**从此一个类型都不属于**了 ⇒ 给它留个记号。
     *
     * ⚠️⚠️ 这一条是"两份口径"交界处的关键：播种必须能区分
     *    · "这个源从来没被播过"（该播：代码里新加的源、升级留下的孤儿）
     *    · "用户主动把它摘干净了"（绝不加回来）
     *    而这两种状态在数据里**长得一模一样**（源存在、映射表里没有它的行）。
     * ⇒ 用这个记号把后者钉住。记号一旦写下**不再抹掉**：
     *    用户以后重新勾上也无害（那时它有绑定了，播种本来就不碰它）。 */
    for (const sid of beforeBound) {
      if (clean.includes(sid)) continue;
      const stillBound = Number(
        db.prepare('SELECT COUNT(*) AS n FROM source_category WHERE source_id = ?').get(sid).n,
      );
      if (stillBound === 0) setMeta(db, `unbound_by_user:${sid}`, '1');
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已经回滚过了 */
    }
    return { ok: false, reason: `写入映射失败：${err && err.message}` };
  }
  return { ok: true, categoryId: id, sourceIds: clean };
}

/**
 * 设置类别的偏好档位（1 喜欢 / 0 中性 / -1 不喜欢）。
 * 语义见 `src/shared/quota.js`：喜欢多放、中性正常、**不喜欢少放但不能没有**。
 */
export function setCategoryPref(db, categoryId, pref) {
  const id = Number(categoryId);
  if (!Number.isFinite(id)) return { ok: false, reason: '类别 id 不是数字' };
  const row = db.prepare('SELECT id, name FROM category WHERE id = ?').get(id);
  if (!row) return { ok: false, reason: '这个类别不存在' };
  const n = Number(pref);
  /* 只认三档，别的一律拒绝（而不是夹取）：
     夹取会把一个拼错的参数悄悄变成"中性"，用户以为设置生效了。 */
  if (n !== 1 && n !== 0 && n !== -1) return { ok: false, reason: `偏好只能是 1 / 0 / -1，收到 ${pref}` };
  db.prepare('UPDATE category SET pref = ? WHERE id = ?').run(n, id);
  return { ok: true, categoryId: id, pref: n, name: row.name };
}

/** 类别 id → 偏好。配额选取（shared/quota.js）要的就是这一份。 */
export function prefByCategory(db) {
  const m = new Map();
  for (const c of listCategories(db)) m.set(String(c.id), Number(c.pref) || 0);
  return m;
}

/** 某个类别绑定的源（**已启用**的那些）—— 刷新时"只抓这个类型的源"靠它 */
export function listEnabledSourcesOfCategories(db, categoryIds) {
  const ids = (Array.isArray(categoryIds) ? categoryIds : [])
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (!ids.length) return listSources(db, true);
  const sql =
    'SELECT DISTINCT s.* FROM source s ' +
    'JOIN source_category sc ON sc.source_id = s.id ' +
    `WHERE s.enabled = 1 AND sc.category_id IN (${ids.map(() => '?').join(',')}) ` +
    'ORDER BY s.id';
  return db.prepare(sql).all(...ids);
}


/* ------------------------------------------------------------------ */
/* AI 简报（M1 交付物的最后一项）                                       */
/* ------------------------------------------------------------------ */

/**
 * 取「某一天该进简报」的候选条目。
 *
 * ★★ 这里的「今天」必须与 `queryItems({todayOnly, sinceIso})` / `countItems({sinceIso})`
 *    **逐字一致** —— 否则卡片会同时展示两个互不相同的"今天"：
 *    简报说 12 条，点「看今天全部（N）」却翻出另一个数字，而两边单看都是对的。
 *    ⇒ 判据（含 fetched_at 兜底）：`published_at >= ? OR (published_at IS NULL AND fetched_at >= ?)`。
 *    ⚠️ 我第一版写的是 `fetched_at >= ?` —— 那是**另一个口径**（"今天抓到的"），
 *       它会和「看今天全部」对不上。真机上的表现是"简报里的条目在全部列表里找不到"。
 */
export function itemsForBrief(db, opts = {}) {
  const since = String(opts.sinceIso || '');
  const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 400));
  const rows = db
    .prepare(
      'SELECT id, title, url, summary, source_name, published_at, fetched_at FROM item ' +
        'WHERE (published_at >= ? OR (published_at IS NULL AND fetched_at >= ?)) ' +
        'ORDER BY (published_at IS NULL) ASC, published_at DESC, id DESC LIMIT ?',
    )
    .all(since, since, limit);
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    url: r.url,
    summary: r.summary,
    sourceName: r.source_name,
    publishedAt: r.published_at,
    fetchedAt: r.fetched_at,
  }));
}

/** 把一份简报连同它的条目一起写进去（同一天覆盖 —— 一天只有一份） */
export function saveBrief(db, brief, nowIso) {
  const b = brief || {};
  const date = String(b.date || '').trim();
  if (!date) return { ok: false, reason: '简报日期不能为空' };
  const now = nowIso || new Date().toISOString();
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

  db.prepare(
    'INSERT INTO brief (brief_date, created_at, curated_ids, headline, status, model, input_hash, token_used, raw_count, kept_count, pool_count, detail) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(brief_date) DO UPDATE SET ' +
      'created_at = excluded.created_at, curated_ids = excluded.curated_ids, headline = excluded.headline, ' +
      'status = excluded.status, model = excluded.model, input_hash = excluded.input_hash, ' +
      'token_used = excluded.token_used, raw_count = excluded.raw_count, kept_count = excluded.kept_count, ' +
      'detail = excluded.detail',
  ).run(
    date,
    now,
    JSON.stringify((b.curatedIds || []).map(Number)),
    String(b.headline || ''),
    String(b.status || 'ok'),
    b.model ? String(b.model) : null,
    b.inputHash ? String(b.inputHash) : null,
    num(b.tokenUsed),
    num(b.rawCount),
    num(b.keptCount),
    num(b.poolCount),
    b.detail ? String(b.detail) : null,
  );

  const bid = Number(db.prepare('SELECT id FROM brief WHERE brief_date = ?').get(date).id);
  db.prepare('DELETE FROM brief_item WHERE brief_id = ?').run(bid);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO brief_item (brief_id, item_id, rank, section, ai_summary) VALUES (?, ?, ?, ?, ?)',
  );
  let rank = 0;
  for (const g of b.groups || []) {
    for (const it of g.items || []) {
      rank += 1;
      ins.run(bid, Number(it.id), rank, String(g.name || ''), String(it.digest || ''));
    }
  }
  return { ok: true, id: bid, date, items: rank };
}

function safeJsonArray(text) {
  try {
    const v = JSON.parse(String(text || '[]'));
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

/**
 * 读一份简报（不给日期就取最近的一份）。
 * 返回的结构就是渲染层要认识的全部 —— 它不需要知道任何采集/模型细节（架构文档 D1）。
 */
export function getBrief(db, date) {
  const row = date
    ? db.prepare('SELECT * FROM brief WHERE brief_date = ?').get(String(date))
    : db.prepare('SELECT * FROM brief ORDER BY brief_date DESC LIMIT 1').get();
  if (!row) return null;

  const rows = db
    .prepare(
      'SELECT bi.item_id, bi.rank, bi.section, bi.ai_summary, i.title, i.url, i.source_name, i.published_at ' +
        'FROM brief_item bi JOIN item i ON i.id = bi.item_id WHERE bi.brief_id = ? ORDER BY bi.rank',
    )
    .all(Number(row.id));

  /* 从 brief_item 还原分组：**按 rank 的顺序**，而不是按 section 第一次出现的顺序 ——
     否则"最重要的那组"会因为组名的字典序被排到后面去。 */
  const order = [];
  const bySection = new Map();
  for (const it of rows) {
    const name = it.section || '要点';
    if (!bySection.has(name)) { bySection.set(name, []); order.push(name); }
    bySection.get(name).push({
      id: Number(it.item_id),
      title: it.title,
      url: it.url,
      source: it.source_name,
      digest: it.ai_summary || '',
      publishedAt: it.published_at,
    });
  }
  return {
    id: Number(row.id),
    date: row.brief_date,
    headline: row.headline || '',
    groups: order.map((name) => {
      const items = bySection.get(name);
      return { name, count: items.length, items };
    }),
    status: row.status || 'none',
    detail: row.detail || '',
    model: row.model || '',
    tokenUsed: row.token_used == null ? null : Number(row.token_used),
    rawCount: row.raw_count == null ? null : Number(row.raw_count),
    keptCount: row.kept_count == null ? null : Number(row.kept_count),
    poolCount: row.pool_count == null ? null : Number(row.pool_count),
    curatedIds: safeJsonArray(row.curated_ids),
    inputHash: row.input_hash || '',
    createdAt: row.created_at,
  };
}

/**
 * 今天（含往前若干天）一共花了多少 token —— 北极星辅助指标写着「必须可见」。
 * ⚠️ 只统计**有真实用量**的那些行；拿不到用量的（老数据 / 端点不回 usage）不计入 0，
 *    而是单独报一个 `unknown` 计数 —— 把"不知道"混进"0"就是在编数字。
 */
/**
 * 今天还有多少条**没点开过**（P1：未读计数）。
 *
 * ⚠️ 「今天」的口径与 queryItems / countItems **逐字一致**（含 fetched_at 兜底），
 *    否则会出现「显示 12 条、其中 15 条没读」这种自相矛盾的界面。
 * ⚠️ 只算 unread：点过的条目是 `opened`，它会变暗（.item[data-read=opened]），
 *    但原来**没有任何地方汇总** —— 用户没法回答「今天还有几条没看」。
 */
export function countUnreadToday(db, sinceIso) {
  const r = db
    .prepare(
      "SELECT COUNT(*) AS n FROM item WHERE read_state = 'unread' " +
        'AND (published_at >= ? OR (published_at IS NULL AND fetched_at >= ?))',
    )
    .get(String(sinceIso || ''), String(sinceIso || ''));
  return Number(r && r.n) || 0;
}

export function briefTokenUsage(db, sinceDate) {
  const r = db
    .prepare(
      'SELECT COALESCE(SUM(token_used), 0) AS total, COUNT(token_used) AS known, ' +
        'SUM(CASE WHEN token_used IS NULL THEN 1 ELSE 0 END) AS unknown, COUNT(*) AS briefs ' +
        'FROM brief WHERE brief_date >= ?',
    )
    .get(String(sinceDate || '0000-00-00'));
  return {
    total: Number(r.total) || 0,
    knownBriefs: Number(r.known) || 0,
    unknownBriefs: Number(r.unknown) || 0,
    briefs: Number(r.briefs) || 0,
  };
}
