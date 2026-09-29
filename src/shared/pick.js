/**
 * src/shared/pick.js —— 「这个领域今天最值得看的几条」怎么挑（纯函数 · 可离线穷举）
 * =====================================================================
 * 一句话：**给一批候选条目，按"时间新 + 源不重复"挑出至多 N 条。**
 *
 * ---------------------------------------------------------------------
 * 为什么需要它（用户 2026-09-29 的需求：每个领域一个「精选」按钮）
 * ---------------------------------------------------------------------
 * 现在的两种视图都**不是**"某个领域的精选"：
 *   · 「全部」那一屏 = 全天的 AI 精选（美团的是一整天的十几条，不是某个领域的）；
 *   · 点某个领域 chip = 该领域的**时间流水**（按时间倒序，前 15 条）。
 * 流水的问题不是少，而是**不均衡**：实测那天「财经」219 条来自 8 个源，
 * 时间倒序的前 15 条里可能 9 条来自同一个高频源（快讯类源一小时能刷十几条），
 * 用户看到的是"某一家媒体的刷屏"，而不是"这个领域今天有什么"。
 * ⇒ 精选要做的事只有两件：**每个源别抢占**、**新的优先**。
 *
 * ---------------------------------------------------------------------
 * 为什么是 8 条（这个数是量出来的，不是拍的）
 * ---------------------------------------------------------------------
 * 2026-09-29 在真实库上量了 14 个领域（单次全量抓取，67 个源）：
 *   财经 219 · 科技 186 · 国际 157 · 民生 102 · 时政 86 · 美食 55 · 文娱 32 ·
 *   房产 19 · 体育 14 · 医疗健康 8 · 旅游 6 · 军事 4 · 汽车 4 · 教育 0
 * 中位数 32 条。取值的三条理由：
 *   ① **够读完**：8 条 ≈ 两三分钟，与"晨报"这个仪式匹配；
 *      （对比：一天的全量精选是 15 条，那是**所有**领域加起来的总量。）
 *   ② **够轮转**：8 条能让 8 个源各出 1 条 —— 源多的领域（科技 16 个源）也不会被一家占满；
 *   ③ **不会经常落空**：单源领域（房产/体育/医疗…）靠轮转的"第二轮"照样能填满 8 条
 *      （见下面 fill 那一步），所以"最多 8 条"在稀疏领域也基本能给足。
 * ⚠️ 它是**上限**：领域里今天就 4 条，那就给 4 条 —— 绝不为了凑数放宽来源口径。
 *
 * ---------------------------------------------------------------------
 * 三条纪律
 * ---------------------------------------------------------------------
 *   ① **不编造**：只排序与筛选，不生成任何字段；条目原样返回（同一个对象引用）；
 *   ② **不丢信息**：被跳过的原因（源重复 / 不喜欢沉底 / 候选不够）都在 stats 里，
 *      界面要能如实说出来（"从今天 219 条里挑了 8 条，来自 8 个源"）；
 *   ③ **确定**：同样的输入永远同样的输出（排序有稳定的兜底键）——
 *      否则用户每点一次看到的东西都不一样，那是"随机"不是"精选"。
 * =====================================================================
 */

/** 一个领域的精选上限（理由见文件头，实测数据在注释里） */
export const DOMAIN_PICK = 8;

/** 夹取：上限再放宽也不该超过 50 —— 再多就不叫精选了 */
const MAX_PICK = 50;

/** 条目的时间：published_at 优先，缺了用 fetched_at（与列表排序口径一致）。
 *  ⚠️ 返回值带 `hasPub`：列表的排序是 `(published_at IS NULL) ASC, published_at DESC`
 *     —— **有发布时间的排在前面**，没有的沉到后面（它们通常是热榜、或解析不到时间的源）。
 *     精选的展示顺序必须与列表**逐字同口径**，否则用户在两种视图里看到
 *     同一批条目的先后不一致，会以为其中一个是坏的。 */
function timeOf(it) {
  const raw = it && it.published_at ? Date.parse(it.published_at) : NaN;
  if (Number.isFinite(raw)) return { hasPub: true, t: raw };
  const f = it && it.fetched_at ? Date.parse(it.fetched_at) : NaN;
  return { hasPub: false, t: Number.isFinite(f) ? f : null };
}

/** 归属的源（拿不到 source_id 就退回 source_name —— 轮转的键不能是空串，否则全挤在一组） */
function sourceKeyOf(it) {
  const id = it && it.source_id != null ? String(it.source_id) : '';
  if (id) return id;
  const name = it && it.source_name ? String(it.source_name) : '';
  return name ? 'n:' + name : 'unknown';
}

/**
 * 挑出一批「面面俱到」的条目。
 *
 * @param {Array<object>} items 候选（queryItems 的行：id/title/source_id/published_at/…）
 * @param {{limit?:number, isDisliked?:(it:object)=>boolean}} [opts]
 *   `isDisliked` 用来把"用户标了不喜欢的那类内容"**沉到最后**：
 *   注意是沉底不是排除 —— 与 `shared/quota.js` 那条"少放但不会没有"同一口径。
 * @returns {{items:Array<object>, stats:{pool:number,limit:number,picked:number,sources:number,
 *            bySource:Record<string,number>,dislikedPicked:number,short:boolean}}}
 */
export function pickDiverse(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const rawLimit = Number(opts.limit == null ? DOMAIN_PICK : opts.limit);
  const limit = Math.max(
    1,
    Math.min(MAX_PICK, Number.isFinite(rawLimit) ? Math.round(rawLimit) : DOMAIN_PICK),
  );
  const isDisliked = typeof opts.isDisliked === 'function' ? opts.isDisliked : null;

  /* ① 排序：不喜欢的**沉底**（不是丢掉），然后**有发布时间的在前**、各自按时间倒序。
     ⚠️ 兜底键用原始下标：没有时间的条目与时间相同的条目
        都必须有确定的先后，否则同一份输入会挑出不同的结果。 */
  const marked = list.map((it, i) => {
    const tt = timeOf(it);
    return { it, i, hasPub: tt.hasPub, t: tt.t, dis: isDisliked ? !!isDisliked(it) : false };
  });
  const byTime = (a, b) => {
    if (a.dis !== b.dis) return a.dis ? 1 : -1;          // 不喜欢的沉底
    if (a.hasPub !== b.hasPub) return a.hasPub ? -1 : 1; // 有发布时间的在前（与列表同口径）
    const at = a.t == null ? -Infinity : a.t;
    const bt = b.t == null ? -Infinity : b.t;
    if (at !== bt) return bt - at;                        // 新的在前
    return a.i - b.i;                                     // 稳定兜底
  };
  marked.sort(byTime);

  /* ② 按源分组（组内保持"新的在前"），③ 轮转取 —— 这一条就是"源别抢占"的全部实现。
     用轮转而不是"每个源硬上限"：上限在**单源领域**会把列表砍到上限以内
     （房产 19 条只有 1 个源 ⇒ 上限 3 就只能给 3 条），而轮转是"人人有份"，
     取完一轮再来一轮，稀疏领域照样能填满。 */
  const groups = new Map();
  for (const m of marked) {
    const k = sourceKeyOf(m.it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const order = [...groups.keys()];
  const picked = [];
  for (let round = 0; picked.length < limit; round += 1) {
    let took = 0;
    for (const k of order) {
      const g = groups.get(k);
      if (round >= g.length) continue;
      picked.push(g[round]);
      took += 1;
      if (picked.length >= limit) break;
    }
    if (took === 0) break;                               // 所有组都取完了
  }

  /* ④ 展示顺序 = **与列表同一套口径**：有发布时间的在前（时间倒序），
     没有发布时间的沉到后面（按 fetched_at）。
     ⚠️ 选取顺序 ≠ 展示顺序是**刻意**的：选取要的是"雨露均沾"，
        展示要的是"像一份简报、而且与别处看到的一样"。 */
  picked.sort(byTime);

  const out = picked.map((m) => m.it);
  const bySource = {};
  for (const m of picked) {
    const k = sourceKeyOf(m.it);
    bySource[k] = (bySource[k] || 0) + 1;
  }
  return {
    items: out,
    stats: {
      pool: list.length,
      limit,
      picked: out.length,
      sources: Object.keys(bySource).length,
      bySource,
      dislikedPicked: picked.filter((m) => m.dis).length,
      /* 候选不够（不足 limit）：界面该如实说"今天就这么多"，
         而不是让用户以为精选被截断了 */
      short: out.length < limit,
    },
  };
}
