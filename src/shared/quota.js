/**
 * src/shared/quota.js —— 「少放但不能没有」的**配额**选择（纯函数、零依赖）
 * =====================================================================
 * ### 为什么这个文件存在（而不是把逻辑写在 main/index.js 里）
 *
 * 项目铁律：**碰 electron 的模块不能放判决逻辑** —— 离线考裁判是纯 Node 跑的，
 * `src/main/index.js` 加载不了它，写在那儿等于这段逻辑**永远没有断言**。
 * 而"少放但不能没有"恰恰是最容易写成摆设的一条：只做降权排序的话，
 * 精选 15 条里可能一条都不剩 —— 而"一条都不剩"与"少放几条"在用户眼里
 * 是两件完全不同的事（前者等于偷偷把用户说的"不喜欢"升级成了"不要"）。
 *
 * ### 语义（用户定死的三条，别改）
 *
 *   · **喜欢**（pref = 1）  → 多放。不设上限。
 *   · **中性**（pref = 0）  → 正常参与。
 *   · **不喜欢**（pref = -1）→ **少放，但不能没有**。
 *        少放 = 精选里最多占 K 条（K 见 quotaOf）
 *        不能没有 = 只要这个类里有内容，精选里**必须至少出现 1 条**
 *
 * ⚠️ 注意"不设上限"是真的不设上限，不是"按比例多给"：
 *    喜欢的类是用户明确说想多看的，给它一个上限就等于在用户背后
 *    替他做配比。这里**只压不喜欢的**，不抬不压其它两档。
 *
 * ### 为什么是"轮转选取"而不是"先排序再截断"
 *
 * 「不能没有」是个**集合性质**，不是排序性质 —— 排序无论怎么排都保证不了它：
 * 只要喜欢/中性的候选足够填满 15 条，不喜欢的那条就会被挤到第 16 位以后。
 * 所以必须在**选取**这一步保证：每一轮从喜欢的、中性的、不喜欢的三类里
 * **各取一条**（各自还有余量的话）。
 *   ⇒ 只要不喜欢那一类非空、且总额还有位置，第 1 轮就会取到它。
 *   ⇒ 同时天然满足"少放"：轮转一轮只放一条，所以 K 条上限不会被冲破。
 *
 * ### 分类口径（一个条目可能同时属于多类，必须有确定的归属）
 *
 *   喜欢 > 不喜欢 > 中性。理由：
 *     · 用户同时把 A 标成喜欢、B 标成不喜欢时，**喜欢优先** ——
 *       "喜欢"是用户主动想多看的，压它比放它更容易让用户觉得"我的设置没生效"。
 *     · 没有任何已登记类别归属的条目 = 中性（不编造偏好）。
 * =====================================================================
 */

/** 偏好档位（与 `category.pref` 列同口径：1 喜欢 / 0 中性 / -1 不喜欢） */
export const PREF = { like: 1, neutral: 0, dislike: -1 };

/**
 * 「不喜欢」在精选里最多占几条。
 *
 * ⚠️ 取整用 `Math.round` 而不是 `Math.floor`：CURATED=15 → 3。
 *    下限**必须**是 1 —— 否则小 CURATED（比如 3）会算出 0，
 *    于是"少放"直接退化成"不放"，把用户说的"不喜欢"偷偷升级成"不要"。
 *
 * @param {number} curated 精选总条数
 * @param {number} [ratio=0.2]
 */
export function quotaOf(curated, ratio = 0.2) {
  const n = Number(curated);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.round(n * ratio));
}

/**
 * 在**某一个筛选范围内**，配额应该是多少。
 *
 * ### 为什么不能直接用 `quotaOf(limit)`
 *
 * 「不喜欢 = 少放但不能没有」是一条**配比**（用户定死的三条语义之一），
 * 而配比是相对的：不能拿"整份精选的 20%"去卡一个**已经被缩小的范围**。
 *
 * 具体到真机上会看到什么（我在真实库上演练时发现的，不是假想）：
 *   · 「全部」+ 某类型设为不喜欢 → 精选 15 条里最多 3 条来自它 —— 正确；
 *   · 点进**这个类型本身**（列表里全是它）→ 若还用 3 条去卡，
 *     界面会显示 **3 条**，而这一类有几百条。用户点的是"我要看这个类型"，
 *     得到的却是"这个类型被砍到 3 条" —— 与"配比不是过滤"直接矛盾。
 *
 * ### 口径：把"整份简报里的占比"原样搬到当前范围
 *
 *   「全部」下：不喜欢的内容占全部条目的 P，而精选里允许它占 `want × P`
 *              条 —— 这正是 `quotaOf(want) = want × 0.2` 那条规则的来处。
 *   当前范围 ：`tagged / poolSize` 就是**这个范围里不喜欢内容占多少**，
 *              所以允许的条数 = `want × tagged / poolSize`。
 *
 *   ⇒ 范围全是它（`tagged === poolSize`）时得到 `want`，即**不设限** ——
 *     因为此时"范围内占比 = 100%"，与「全部」下那个类型占 100% 是一回事。
 *   ⇒ 范围很大时 `tagged / poolSize` 很小 ⇒ 退回基础配额，"少放"一分不松。
 *
 * ⚠️ `tagged`（范围内属于"不喜欢"的条目数）与 `poolSize`（范围内总数）
 *    **必须来自同一套筛选口径**，否则这个比例没有意义。
 * ⚠️ 我第一版的分母用的是"本次取的候选页大小"，那是个**摆设**：
 *    候选页永远是固定上限（200/60），点进类型时它不变 ⇒ 缩放算出来还是 3 条。
 *    真机演练当场把这个错抓出来了（"点进去还是 3 条"）。
 *
 * @param {object} opts
 * @param {number} opts.limit    本次要选多少条
 * @param {number} opts.poolSize 范围内**一共**有多少条
 * @param {number} opts.tagged   范围内**属于不喜欢那些类型**的有多少条
 * @returns {number}
 */
export function scopedQuota({ limit, poolSize, tagged } = {}) {
  const want = Math.max(1, Math.floor(Number(limit) || 0));
  const base = quotaOf(want);
  const pool = Math.floor(Number(poolSize) || 0);
  const hit = Math.floor(Number(tagged) || 0);
  if (pool <= 0 || hit <= 0) return base;
  const scaled = Math.ceil((want * hit) / pool);
  return Math.max(base, Math.min(want, scaled));
}

/** 把偏好值规整成三档之一（不认识的一律中性，不编造偏好） */
export function normalizePref(v) {
  const n = Number(v);
  if (n === 1) return PREF.like;
  if (n === -1) return PREF.dislike;
  return PREF.neutral;
}

/**
 * 一个条目属于哪一档。
 *
 * @param {{categories?: Array<number|string>}} item 待分类的候选
 * @param {Map<string, number>|object} prefByCategory 类别 id → 偏好
 * @returns {1|0|-1}
 */
export function classOf(item, prefByCategory) {
  const ids = (item && item.categories) || [];
  const get = (id) => {
    if (prefByCategory instanceof Map) return prefByCategory.get(String(id));
    if (prefByCategory && typeof prefByCategory === 'object') return prefByCategory[String(id)];
    return undefined;
  };
  let sawDislike = false;
  for (let i = 0; i < ids.length; i += 1) {
    const p = normalizePref(get(ids[i]));
    if (p === PREF.like) return PREF.like; // ★ 喜欢优先，立刻返回
    if (p === PREF.dislike) sawDislike = true;
  }
  return sawDislike ? PREF.dislike : PREF.neutral;
}

/** 候选的稳定身份（用于去重；没有 id 就退回下标，绝不合并两条不同的条目） */
function keyOf(it, index) {
  if (it && it.key != null) return 'k:' + String(it.key);
  if (it && it.id != null) return 'i:' + String(it.id);
  return 'x:' + String(index);
}

/**
 * 按配额选出最终呈现的那 N 条。
 *
 * @param {object} opts
 * @param {Array<object>} opts.items      候选（必须**已按期望顺序**排好，选取保持这个相对顺序）
 * @param {number} opts.limit             要选多少条
 * @param {Map<string, number>|object} [opts.prefByCategory] 类别 id → 偏好
 * @param {number} [opts.quota]           不喜欢的上限，缺省用 quotaOf(limit)
 * @returns {{picked: Array<object>, counts: {like:number, neutral:number, dislike:number}, quota:number, guaranteed:boolean}}
 *   · `guaranteed` = 这次选取里"不喜欢有内容却一条没选上"**是否没有发生过**
 *     （false 就是那一类内容非空但精选里没有它 —— 真出现的话是缺陷，
 *      断言直接咬这个字段，而不是咬"条数看起来对不对"）
 */
export function selectByQuota({ items, limit, prefByCategory, quota } = {}) {
  const all = Array.isArray(items) ? items.filter((x) => x && typeof x === 'object') : [];
  const want = Math.max(0, Math.floor(Number(limit)));
  const cap = Math.max(1, Number.isFinite(Number(quota)) ? Math.floor(Number(quota)) : quotaOf(limit || 0));

  /* 分类：三档各起一条队，**保持传入顺序**（调用方已经按时间排好，
     这里不许再排一次 —— 排序口径只能有一处）。 */
  const buckets = { [PREF.like]: [], [PREF.neutral]: [], [PREF.dislike]: [] };
  const seen = new Set();
  for (let i = 0; i < all.length; i += 1) {
    const k = keyOf(all[i], i);
    if (seen.has(k)) continue; // 同一份候选里出现两次只算一条
    seen.add(k);
    buckets[classOf(all[i], prefByCategory)].push(all[i]);
  }

  const picked = [];
  const cursor = { [PREF.like]: 0, [PREF.neutral]: 0, [PREF.dislike]: 0 };
  const counts = { like: 0, neutral: 0, dislike: 0 };

  const take = (cls) => {
    const b = buckets[cls];
    if (cursor[cls] >= b.length) return false;
    /* ★ 这一道闸门就是"少放"：不喜欢的上限**只在这里**判一次，
       两个阶段（轮转 + 补齐）都靠它，所以不存在"补齐阶段偷偷超配额"。
       ⚠️ "上限"是**整个精选**的硬上限，不是"只压轮转那一段"：
          否则"少放"会随候选分布漂移（喜欢/中性少的时候不喜欢反而更多）。 */
    if (cls === PREF.dislike && counts.dislike >= cap) return false;
    const it = b[cursor[cls]];
    cursor[cls] += 1;
    picked.push(it);
    if (cls === PREF.like) counts.like += 1;
    else if (cls === PREF.neutral) counts.neutral += 1;
    else counts.dislike += 1;
    return true;
  };

  /* —— 阶段 1：轮转（保证「不喜欢」有位置就一定入选）——
   *
   * 形状是一个**显式的轮转指针**：`rot` 指着"下一轮先看哪一档"，
   * 每取到一条就把指针往前挪一格。
   *
   * ⚠️⚠️ 别把它"简化"成下面这种写法，它看起来等价，**实际不等价**：
   *        for (;;) { if (take(like)) {...} if (take(neutral)) {...} ... }
   *    问题在于每一档的 `take` 都会成功（桶还没空），于是一个循环里
   *    连取三条喜欢 —— 不喜欢的那条永远轮不到，
   *    **「不能没有」当场失效**，而"总条数"看起来完全正常（15 条一条不少）。
   *    我第一版就是这么写的，写了两遍才改对：
   *    这类 bug 靠读代码看不出来，靠"条数对不对"的断言也抓不住。
   *
   * ⚠️ 轮转指针而不是"每轮从头扫一遍"：后者在某一档抽干之后
   *    （比如"喜欢"只有 1 条）会让后面的档位**多拿**，
   *    三档之间的比例随候选分布漂移 —— 而"喜欢就多放"的配比正是用户要的。
   *    指针式的轮转给每一档**稳定的一份**，这才是"配比"。 */
  const ring = [PREF.like, PREF.neutral, PREF.dislike];
  let rot = 0;
  for (;;) {
    if (picked.length >= want) break;
    let advanced = false;
    for (let k = 0; k < ring.length; k += 1) {
      const cls = ring[(rot + k) % ring.length];
      if (take(cls)) {
        rot = (rot + k + 1) % ring.length; // 下一轮从它的下一个档位开始
        advanced = true;
        break;
      }
    }
    if (!advanced) break; // 三类都空了，或者只剩超配额的不喜欢
  }

  /* —— 阶段 2：补齐 ——
     候选不总是三类都够（比如某一类只有 2 条），轮转会把位置留空。
     这里按 喜欢 → 中性 → 不喜欢 的顺序补，**仍然受同一个配额闸门约束**。 */
  for (const cls of [PREF.like, PREF.neutral, PREF.dislike]) {
    while (picked.length < want && take(cls)) {
      /* take 自己会因配额或队列耗尽而返回 false */
    }
  }

  const dislikeAvailable = buckets[PREF.dislike].length > 0;
  return {
    picked,
    counts,
    quota: cap,
    /* 「不能没有」的判据：这一类**有内容**，而精选里一条都没有 = 违约 */
    guaranteed: !(dislikeAvailable && counts.dislike === 0),
  };
}
