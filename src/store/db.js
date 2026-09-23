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
 *   · **需求 4 UI** → 与数据无关，但 `brief` 表给"默认精选 10 条"留了位置
 *
 * ### 一条刻意的设计：去重键与展示 URL 分开存
 *   `dedupe_key` 是归一化后的指纹（用于 UNIQUE）；`url` 是原文链接（用于跳转）。
 *   混用会出现"点开源站打不开"（因为归一化把跟踪参数去掉了，而有些站**依赖**它们）。
 * =====================================================================
 */

import path from 'node:path';
import fs from 'node:fs';
import { canonicalizeUrl, dedupeKey } from '../ingest/urls.js';

/** schema 版本。改结构时 +1，并在 migrate() 里加一段 —— 否则老库会静默少字段 */
export const SCHEMA_VERSION = 1;

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
  kind        TEXT    NOT NULL DEFAULT 'rss',      -- rss | atom | api
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL
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
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS item_category (
  item_id     INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_itemcat_cat ON item_category (category_id);

-- 每天一份简报：默认精选 N 条，其余作为"当日存档"可展开
CREATE TABLE IF NOT EXISTS brief (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brief_date  TEXT NOT NULL UNIQUE,     -- YYYY-MM-DD（本地日）
  created_at  TEXT NOT NULL,
  curated_ids TEXT,                     -- JSON 数组：默认呈现的那 N 条
  headline    TEXT                      -- 总览句（阶段 3 由 AI 生成）
);
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
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec(DDL);

  const cur = getMeta(db, 'schema_version');
  if (cur === null) {
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  } else if (Number(cur) !== SCHEMA_VERSION) {
    /* ⚠️ 这里**不自动迁移**，而是明确报错 —— 静默迁移是"数据悄悄变形"的温床。
       真实迁移要写在 migrate() 里逐版推进；M1 阶段 schema 还在动，
       宁可让用户看到一句"库版本不匹配"也不要让数据半新半旧。 */
    throw new Error(
      `数据库 schema 版本不匹配：文件是 ${cur}，代码要求 ${SCHEMA_VERSION}。` +
        `请删除该库文件后重新抓取（M1 阶段 schema 仍在变动）。`,
    );
  }
  return db;
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
    `INSERT INTO source (name, feed_url, kind, enabled, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(feed_url) DO UPDATE SET
       name    = excluded.name,
       kind    = excluded.kind,
       enabled = excluded.enabled`,
  );
  let added = 0;
  for (const s of sources) {
    const before = db.prepare('SELECT id FROM source WHERE feed_url = ?').get(s.feedUrl);
    // 未显式声明就是启用（绝大多数源如此）
    const enabled = s.enabled === false ? 0 : 1;
    ins.run(s.name, s.feedUrl, s.kind || 'rss', enabled, nowIso);
    if (!before) added += 1;
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
   *     这与"注释说改了、代码没改"是同一类病：**改动没有真正落地**。
   *
   * 处置：清单是**唯一**的源真相（这一阶段没有"用户自己加源"的入口），
   *     所以不在清单里的源一律停用。**不删行** —— 删了会连带删掉它的抓取历史
   *     （source_state、以及将来可能用到的 per-source 统计），而停用是可逆的。
   *
   * @returns {{added:number, retired:string[]}}
   */
  const wanted = new Set(sources.map((s) => s.feedUrl));
  const retired = [];
  for (const row of db.prepare('SELECT id, name, feed_url, enabled FROM source').all()) {
    if (wanted.has(row.feed_url)) continue;
    if (!row.enabled) continue; // 已经停用，不用再报一次
    db.prepare('UPDATE source SET enabled = 0 WHERE id = ?').run(row.id);
    retired.push(row.name);
  }
  return { added, retired };
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
