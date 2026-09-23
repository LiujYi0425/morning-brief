/**
 * tools/test-interaction.mjs —— 交互一致性的离线考裁判（纯 Node，零依赖）
 * =====================================================================
 * ### 为什么需要单独一个考裁判
 *
 * 真机连续三轮的反馈都落在同一类问题上："筛选/按钮的交互逻辑仍有问题，
 * 不同点击路径会触发不同的逻辑漏洞，行为不统一。" 这类 bug 有个共同特征：
 * **单看任何一个处理器都是对的**，错在它们之间的相互作用与顺序。
 * 靠"读代码 + 手点几下"是抓不住的（我已经连错两轮）。
 *
 * ⇒ 把交互逻辑抽成纯函数（`src/renderer/view-model.js`），然后在离线侧穷举它。
 *   这个文件考的就是那四条不变量：
 *     I1 自持性   —— 开关一旦被激活，必须永远还能被撤销
 *     I2 非自指   —— 按钮可见性不许由它自己的效果决定
 *     I3 正交     —— 窗口 / 口径 / 类别 三条轴互不改写
 *     I4 全函数   —— 未知动作 = 无操作，任何序列都不会把状态带进非法形态
 *
 * ### 三层考法（对抗"测试看着很多其实没咬住"）
 *   第一层 **不变量**：在上面四条上逐条断言，并在**每一个可达状态**上都断言。
 *   第二层 **顺序无关**：同一组动作的**全部排列**必须收敛到同一个界面。
 *   第三层 **变异测试**：故意把 view-model.js 改坏 8 处，
 *          断言考裁判**每一条都抓得住** —— 抓不住说明那条断言是摆设。
 *
 * ⚠️ 加载方式与真机**完全一致**：用 `node:vm` 当经典脚本跑。
 *    这条是拿真机日志换来的 —— 上一版 interaction.js 写成 ESM，
 *    离线用 `import` 加载全绿、真机经典 `<script>` 加载**整个文件不执行**。
 *    ⇒ 考裁判必须同时断言"这个文件不含 ESM 语法"且"挂上了出口"。
 *
 * 退出码：0 = 全过；1 = 有断言不成立，或有变异体存活。
 * =====================================================================
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
/* 真管线装置（把 card.js 装进 vm）。放在单独文件里，因为它也是
   "本轮 blocker 只在管线里现形"这件事的**工具化**载体。 */
import { bootedRig, firstPayload } from './card-rig.mjs';

/**
 * 一笔 more 载荷的"自洽"判据：cursor 的出处必须与它声明的筛选一致。
 * ⚠️ 这条**抓的是 payload 本身**，不是结果 —— 本轮 blocker 的正是一份
 *    "从诞生那一刻就自相矛盾"的 payload，而它在返回之前没有任何异常。
 */
function sameCat(opts, catId) {
  const ids = opts && opts.categoryIds;
  if (!ids || !ids.length) return true; // 没声明筛选 = 语境本来就是"全部"
  return ids.map(String).join(',') === String(catId);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VM_PATH = path.resolve(HERE, '..', 'src', 'renderer', 'view-model.js');
const SRC = fs.readFileSync(VM_PATH, 'utf8');

/* ================================================================== */
/* 加载：与真机同一种方式（经典脚本 + globalThis）                       */
/* ================================================================== */
function loadVM(src) {
  const sandbox = {};
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'view-model.js' }).runInContext(sandbox);
  return sandbox.MB_VIEW;
}

const VM = loadVM(SRC);

/* ================================================================== */
/* 测试用的固定数据集                                                   */
/* ================================================================== */
const CATS = [
  { id: 1, name: 'AI 与算力' },
  { id: 2, name: '开源与工程' },
  { id: 3, name: '行业动态' },
  { id: 4, name: '产品与设计' },
];

/** 造一个"数据已经到位"的状态：45 条今日条目，精选 15 条 */
function seeded(VMx, patch) {
  let v = VMx.createView();
  v = VMx.reduce(v, {
    type: 'data',
    seq: 1,
    payload: {
      items: Array.from({ length: 15 }, (_, i) => ({ id: i + 1, title: 't' + i })),
      hasMore: true,
      nextCursor: { publishedAt: '2026-09-22T00:00:00Z', id: 15, pendingNull: false },
      categories: CATS,
      todayTotal: 45,
      filteredTotal: 45,
      curated: 15,
      health: { total: 20, ok: 18, bad: 2, never: 0 },
      lastIngestAt: '2026-09-22T06:00:00.000Z',
      sinceIso: '2026-09-21T16:00:00.000Z',
    },
  });
  if (patch) for (const k of Object.keys(patch)) v = { ...v, [k]: patch[k] };
  return v;
}

/** 可用的动作集合（都带**显式**值，不用"翻转当前值"的写法） */
const ACTIONS = [
  { type: 'expand', on: true },
  { type: 'expand', on: false },
  { type: 'toggleAll' },
  { type: 'setCategory', id: 1 },
  { type: 'setCategory', id: 2 },
  { type: 'setCategory', id: null },
  { type: 'setCategoryIndex', index: 0 },
  { type: 'setCategoryIndex', index: 2 },
  { type: 'invalidate' },
];

const runSeq = (VMx, v0, seq) => seq.reduce((v, a) => VMx.reduce(v, a), v0);

/** 朴素模型（"显然正确"的那份），当作 oracle */
function model(seq, cats) {
  let expanded = false;
  let showingAll = false;
  let category = null;
  for (const a of seq) {
    if (a.type === 'expand') expanded = !!a.on;
    else if (a.type === 'toggleAll') showingAll = !showingAll;
    else if (a.type === 'setCategory') category = a.id == null ? null : String(a.id);
    else if (a.type === 'setCategoryIndex') {
      const idx = Math.max(0, Math.round(Number(a.index) || 0));
      if (idx === 0) category = null;
      else if (cats[idx - 1]) category = String(cats[idx - 1].id);
    }
  }
  return { expanded, showingAll, category };
}

/* ================================================================== */
/* 检查套件：给定一个 MB_VIEW 实现，返回所有被违反的不变量               */
/* （这个函数同时服务于"考真实实现"与"杀变异体"两件事）                  */
/* ================================================================== */
function checkAll(VMx) {
  const bad = [];
  const fail = (id, msg) => bad.push(id + ' ' + msg);

  /* ---------- 0. 出口形状（真机踩过的"离线绿、真机废"） ---------- */
  if (!VMx) return ['E0 没有挂上 globalThis.MB_VIEW（经典脚本加载后取不到出口）'];
  for (const fn of ['createView', 'reduce', 'derive', 'fetchKey', 'moreKey', 'normalize']) {
    if (typeof VMx[fn] !== 'function') fail('E0', 'MB_VIEW.' + fn + ' 不是函数');
  }
  if (bad.length) return bad;

  const V0 = seeded(VMx);

  /* ---------- I1 自持性 ---------- */
  {
    // 进入"看今天全部"之后，无论数据变成什么样，按钮都必须还在
    let v = VMx.reduce(V0, { type: 'toggleAll' });
    for (const patch of [
      {},
      { items: [] },
      { filteredTotal: 0, todayTotal: 0 },
      { items: [], filteredTotal: 0, todayTotal: 0, hasMore: false },
      { filteredTotal: 1 },
      { items: Array.from({ length: 45 }, (_, i) => ({ id: i })), filteredTotal: 45, hasMore: false },
    ]) {
      const d = VMx.derive({ ...v, ...patch });
      if (!d.buttons.all.visible) fail('I1', '已在"全部"模式但按钮不可见 patch=' + JSON.stringify(Object.keys(patch)));
      if (!d.buttons.all.enabled) fail('I1', '已在"全部"模式但按钮不可点');
      if (!d.buttons.refresh.visible) fail('I1', '刷新按钮消失了');
    }
    // 反向：从未进入过"全部"模式、且今日没有更多时，按钮就该不在（别把 I1 做成"永远显示"）
    const d0 = VMx.derive({ ...V0, showingAll: false, filteredTotal: 3, todayTotal: 3, hasMore: false });
    if (d0.buttons.all.visible) fail('I1-反向', '没有更多可看时"看今天全部"不该出现');
  }

  /* ---------- I2 非自指：可见性不许取决于"已经显示了多少条" ---------- */
  {
    const base = { ...V0, filteredTotal: 45, todayTotal: 45, hasMore: true };
    for (const n of [0, 1, 15, 44, 45, 120]) {
      const d = VMx.derive({ ...base, items: Array.from({ length: n }, (_, i) => ({ id: i })) });
      if (!d.buttons.all.visible) fail('I2', '已显示 ' + n + ' 条时"看今天全部"消失了（可见性被自己的效果影响）');
      if (!d.buttons.more.visible) fail('I2', '已显示 ' + n + ' 条时"展开更多"消失了');
    }
    // 加载完之后：展开更多应当**变灰**而不是消失
    const done = VMx.derive({ ...base, hasMore: false, items: Array.from({ length: 45 }, (_, i) => ({ id: i })) });
    if (!done.buttons.more.visible) fail('I2', '全部加载完之后"展开更多"整个消失了（应改为 disabled + 已全部展开）');
    if (done.buttons.more.enabled) fail('I2', '没有下一页了但按钮仍可点');
    if (!/已全部展开/.test(done.buttons.more.label)) fail('I2', '没有下一页了但文案不是"已全部展开"：' + done.buttons.more.label);
  }

  /* ---------- I3 正交：三条轴互不改写 ---------- */
  {
    // expand 不许动 showingAll / activeCategory
    for (const on of [true, false]) {
      for (const sa of [true, false]) {
        for (const cat of [null, 1]) {
          const before = { ...V0, showingAll: sa, activeCategory: cat };
          const after = VMx.reduce(before, { type: 'expand', on });
          if (after.showingAll !== sa) fail('I3', 'expand 改写了 showingAll');
          if (String(after.activeCategory) !== String(cat)) fail('I3', 'expand 改写了 activeCategory');
          if (after.expanded !== on) fail('I3', 'expand 没生效');
        }
      }
    }
    // toggleAll 不许动 expanded / activeCategory
    for (const ex of [true, false]) {
      const after = VMx.reduce({ ...V0, expanded: ex, activeCategory: 2 }, { type: 'toggleAll' });
      if (after.expanded !== ex) fail('I3', 'toggleAll 改写了 expanded');
      if (String(after.activeCategory) !== '2') fail('I3', 'toggleAll 改写了 activeCategory');
    }
    // setCategory 不许动 expanded / showingAll
    for (const sa of [true, false]) {
      const after = VMx.reduce({ ...V0, expanded: true, showingAll: sa }, { type: 'setCategory', id: 3 });
      if (after.expanded !== true) fail('I3', 'setCategory 改写了 expanded');
      if (after.showingAll !== sa) fail('I3', 'setCategory 改写了 showingAll（筛选顺手把模式清了）');
    }
  }

  /* ---------- 幂等：同一个目标选两次 = 选一次 ---------- */
  {
    for (const id of [null, 1, 2, 3]) {
      const once = VMx.reduce(V0, { type: 'setCategory', id });
      const twice = VMx.reduce(once, { type: 'setCategory', id });
      if (String(once.activeCategory) !== String(twice.activeCategory)) {
        fail('幂等', 'setCategory 点两次与点一次结果不同（id=' + id + '）—— 用户无法预期');
      }
    }
    for (const index of [0, 1, 2, 3, 4]) {
      const once = VMx.reduce(V0, { type: 'setCategoryIndex', index });
      const twice = VMx.reduce(once, { type: 'setCategoryIndex', index });
      if (String(once.activeCategory) !== String(twice.activeCategory)) fail('幂等', 'setCategoryIndex 不幂等 index=' + index);
    }
  }

  /* ---------- I4 全函数 ---------- */
  {
    for (const junk of [null, undefined, {}, { type: 123 }, { type: 'nope' }, { type: 'data' }, { type: 'data', payload: null }]) {
      try {
        const r = VMx.reduce(V0, junk);
        const d = VMx.derive(r);
        if (!Array.isArray(d.chips) || !d.chips.length) fail('I4', '垃圾动作 ' + JSON.stringify(junk) + ' 之后 chips 空了');
      } catch (err) {
        fail('I4', 'reduce 对 ' + JSON.stringify(junk) + ' 抛错：' + err.message);
      }
    }
    try {
      VMx.derive(null);
      VMx.derive(undefined);
      VMx.reduce(undefined, { type: 'toggleAll' });
    } catch (err) {
      fail('I4', '对空状态抛错：' + err.message);
    }
  }

  /* ---------- 派生层是只读的（derive 不许有副作用） ---------- */
  {
    const frozen = Object.freeze({ ...V0, items: Object.freeze(V0.items.slice()) });
    try {
      VMx.derive(frozen);
    } catch (err) {
      fail('纯度', 'derive 试图写它读到的状态（在冻结对象上抛错）：' + err.message);
    }
    const snapshot = JSON.stringify(V0);
    VMx.derive(V0);
    if (JSON.stringify(V0) !== snapshot) fail('纯度', 'derive 改了状态');
  }

  /* ---------- 顺序无关：同一组动作的全部排列必须收敛到同一个界面 ---------- */
  {
    // 三个动作落在三条**不同的轴**上 ⇒ 它们互相可交换 ⇒ 任意排列结果必须逐字相同
    const perms = permute([{ type: 'expand', on: true }, { type: 'toggleAll' }, { type: 'setCategory', id: 2 }]);
    const sigs = new Set(perms.map((p) => sig(VMx.derive(runSeq(VMx, V0, p)))));
    if (sigs.size !== 1) fail('顺序无关', '三条正交轴上的动作，排列结果不一致（出现 ' + sigs.size + ' 种）');

    // 加上"点两次同一个 chip"与"点全部"之后仍应一致
    const perms2 = permute([
      { type: 'expand', on: false },
      { type: 'toggleAll' },
      { type: 'setCategory', id: 3 },
      { type: 'setCategory', id: 3 },
      { type: 'invalidate' },
    ]);
    const sigs2 = new Set(perms2.map((p) => sig(VMx.derive(runSeq(VMx, V0, p)))));
    if (sigs2.size !== 1) fail('顺序无关', '含重复动作时排列结果不一致（出现 ' + sigs2.size + ' 种）');
  }

  /* ---------- 模型等价（带种子的随机序列） ---------- */
  {
    const rnd = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 600; trial += 1) {
      const n = 1 + Math.floor(rnd() * 7);
      const seq = Array.from({ length: n }, () => ACTIONS[Math.floor(rnd() * ACTIONS.length)]);
      const v = runSeq(VMx, V0, seq);
      const m = model(seq, CATS);
      if (v.expanded !== m.expanded) fail('模型', 'expanded 与朴素模型不符 @' + JSON.stringify(seq));
      if (v.showingAll !== m.showingAll) fail('模型', 'showingAll 与朴素模型不符 @' + JSON.stringify(seq));
      if (String(v.activeCategory) !== String(m.category)) {
        fail('模型', 'activeCategory 期望 ' + m.category + ' 实得 ' + v.activeCategory + ' @' + JSON.stringify(seq));
      }
      bad.push(...stateProblems(VMx, v, 'model#' + trial));
      if (bad.length > 12) return bad;
    }
  }

  /* ---------- BFS 可达闭包：没有死状态、没有非法形态 ---------- */
  {
    const seen = new Set();
    const queue = [V0];
    seen.add(JSON.stringify(key(vOf(V0))));
    let guard = 0;
    while (queue.length && guard < 4000) {
      guard += 1;
      const s = queue.shift();
      bad.push(...stateProblems(VMx, s, 'bfs'));
      if (bad.length > 12) return bad;
      for (const a of ACTIONS) {
        let n;
        try {
          n = VMx.reduce(s, a);
        } catch (err) {
          fail('可达', '在可达状态上动作 ' + a.type + ' 抛错：' + err.message);
          continue;
        }
        const k = JSON.stringify(key(vOf(n)));
        if (!seen.has(k)) {
          seen.add(k);
          queue.push(n);
        }
      }
    }
    if (seen.size < 8) fail('可达', '可达状态只有 ' + seen.size + ' 个，状态空间可能被压没了');
  }

  /* ---------- 乱序保护：晚到的旧响应不许覆盖新响应 ----------
   * ⚠️ 这一段是"变异体 M12 存活"逼出来的。原来那套不变量全都只看**最终形态**，
   *    而乱序保护只在"两次 data 一前一后到达"时才起作用 ⇒ 没有任何断言覆盖它。
   *    这就是变异测试的价值：它指出的是**考裁判的盲区**，不是代码的缺陷。 */
  {
    const fresh = { items: [{ id: 'new-1' }, { id: 'new-2' }], hasMore: true, categories: CATS, todayTotal: 45, filteredTotal: 45 };
    const staleData = { items: [{ id: 'old-1' }], hasMore: false, categories: CATS, todayTotal: 1, filteredTotal: 1 };

    const v5 = VMx.reduce(V0, { type: 'data', seq: 5, payload: fresh });
    if (v5.dataSeq !== 5) fail('乱序', 'dataSeq 没有跟上 seq（' + v5.dataSeq + '）');
    const d5 = VMx.derive(v5);
    if (d5.shown !== 2) fail('乱序', '新数据没被应用');

    const late = VMx.reduce(v5, { type: 'data', seq: 3, payload: staleData });
    if (late.dataSeq !== 5) fail('乱序', '旧响应把 dataSeq 拉回去了（' + late.dataSeq + '）');
    if (VMx.derive(late).shown !== 2) fail('乱序', '晚到的旧响应覆盖了新数据（条数 ' + VMx.derive(late).shown + '）');
    if (late.filteredTotal !== 45) fail('乱序', '晚到的旧响应改写了统计口径');

    // 反过来：更新的 seq 必须能覆盖（否则保护就变成了"只认第一次"）
    const v6 = VMx.reduce(v5, { type: 'data', seq: 6, payload: staleData });
    if (VMx.derive(v6).shown !== 1) fail('乱序', '更新的响应被错误地丢弃了（保护写反了）');
    if (v6.filteredTotal !== 1) fail('乱序', '更新的响应没有更新统计口径');

    // seq 缺省（老调用方）时不许把数据吞掉
    const noSeq = VMx.reduce(VMx.reduce(V0, { type: 'data', seq: 9, payload: fresh }), { type: 'data', payload: staleData });
    if (VMx.derive(noSeq).shown !== 1) fail('乱序', 'seq 缺省时数据被吞掉了（应当照常应用）');
  }

  /* ---------- fetchKey：窗口大小不许引发取数 ---------- */
  {
    const a = VMx.fetchKey({ ...V0, expanded: false });
    const b = VMx.fetchKey({ ...V0, expanded: true });
    if (a !== b) fail('取数', 'expand 改变了 fetchKey ⇒ 收起/展开会白白发一次请求');
    if (VMx.fetchKey({ ...V0, activeCategory: 1 }) === VMx.fetchKey(V0)) fail('取数', '换类别没有改变 fetchKey');
    if (VMx.fetchKey({ ...V0, showingAll: true }) === VMx.fetchKey(V0)) fail('取数', '切换"看今天全部"没有改变 fetchKey');
    if (VMx.fetchKey({ ...V0, forceToken: V0.forceToken + 1 }) === VMx.fetchKey(V0)) fail('取数', 'invalidate 没有改变 fetchKey ⇒ 刷新按钮会静默失效');

    // ★ 真机 bug 的回归：curated 是**服务端口径常量**，不是"本次请求的 limit"
    const echoed = VMx.reduce(V0, {
      type: 'data',
      seq: 2,
      payload: { items: [], hasMore: false, categories: CATS, todayTotal: 45, filteredTotal: 45, curated: 120, limitUsed: 120 },
    });
    if (echoed.curated > VMx.CURATED_MAX) {
      fail('回归', '服务端回显大 limit 时 curated 没有被夹到上限 ⇒ 会重现"按钮把自己藏了"');
    }
  }

  /* ---------- chips / 滑动条：永远存在、序号一致 ---------- */
  {
    for (const sa of [true, false]) {
      for (const cat of [null, 1, 4]) {
        for (const items of [[], V0.items]) {
          const d = VMx.derive({ ...V0, showingAll: sa, activeCategory: cat, items });
          if (!d.chips.length) fail('chips', 'chips 为空（收起后类型选项消失的病根）');
          if (d.chips[0].id !== null) fail('chips', '第一项不是「全部」');
          if (d.slider.max !== d.chips.length - 1) fail('chips', '滑动条 max 与 chips 数量不一致');
          if (d.slider.value !== d.activeIndex) fail('chips', '滑动条 value 与选中项不一致');
          if (!d.chips[d.activeIndex] || !d.chips[d.activeIndex].on) fail('chips', 'activeIndex 没指向被选中的那一项');
          const onCount = d.chips.filter((c) => c.on).length;
          if (onCount !== 1) fail('chips', '选中的项有 ' + onCount + ' 个（应恰好 1 个）');
        }
      }
    }
  }

  /* ---------- 翻页键：口径/类别/日期边界变了就让翻页上下文失效 ---------- */
  {
    if (VMx.moreKey(V0) === VMx.moreKey({ ...V0, activeCategory: 1 })) fail('翻页', '换类别后 moreKey 没变 ⇒ 会把别的类别翻进来');
    if (VMx.moreKey(V0) === VMx.moreKey({ ...V0, showingAll: true })) fail('翻页', '切口径后 moreKey 没变');
    if (VMx.moreKey(V0) === VMx.moreKey({ ...V0, sinceIso: '2020-01-01T00:00:00.000Z' })) fail('翻页', '跨日期边界后 moreKey 没变');
    if (VMx.moreKey({ ...V0, cursor: { id: 1 } }) !== VMx.moreKey({ ...V0, cursor: { id: 2 } })) {
      fail('翻页', 'moreKey 随 cursor 变动 ⇒ 每翻一页都会把结果当成过期丢掉');
    }
  }

  /* ==================================================================
   * ★★ 第四轮返工新增：数据面的**出处**（本轮 blocker 的修法）
   * ==================================================================
   * 病：状态里没有任何字段记录 items/cursor/hasMore 是**哪一次查询**的产物，
   *     于是"换类别后在新数据回来之前点展开更多"会发出
   *     `{ cursor: <旧查询的>, categoryIds: ['2'] }` —— payload 从诞生那一刻
   *     就自相矛盾，服务端照单全收，moreKey 守卫（在语境切走**之后**才采样）
   *     两次采样必然相等，抓不住 ⇒ 脏数据被合法采纳。
   * 修法：`dataKey`（items 的出处）+ `cursorKey`（cursor 的出处）+ `derive.cursorValid`。
   * ------------------------------------------------------------------ */
  {
    /* ⚠️ 夹具必须**带 forKey**，否则 dataKey/cursorKey 是 null，
       "语境没变时游标有效"这条根本无从谈起（那正是本轮新增字段的意义）。
       ⚠️ forKey 还必须**等于该状态的 fetchKey** —— 这就是真机里的不变量
       （card.js 发请求前捕获 d.fetchKey，回程原样带回），
       随手编一个 'K-A' 会让 cursorValid 永远为假。 */
    const home = (cat, allMode) => {
      let v = VMx.reduce(V0, { type: 'setCategory', id: cat });
      if (allMode) v = VMx.reduce(v, { type: 'toggleAll' });
      v = VMx.reduce(v, {
        type: 'data', seq: 7, forKey: VMx.fetchKey(v),
        payload: { items: [{ id: 1 }, { id: 2 }], hasMore: true, nextCursor: { publishedAt: 'p', id: 2, pendingNull: false }, categories: CATS, todayTotal: 45, filteredTotal: 45 },
      });
      return v;
    };
    const vA = home(null, false);          // 无筛选首页
    const vB = home(3, false);             // 「行业」那一份（不同语境）
    const keyA = VMx.fetchKey(vA);
    if (keyA === VMx.fetchKey(vB)) fail('出处', '装置前提不成立：两个夹具的 fetchKey 竟然相同');
    /* (a) data 必须记下"这份数据是谁取的" */
    if (vA.dataKey !== keyA) fail('出处', 'data 没有把 forKey 记成 dataKey（实得 ' + vA.dataKey + '）');
    if (vB.dataKey !== VMx.fetchKey(vB)) fail('出处', 'data 没有把 forKey 记成 dataKey（实得 ' + vB.dataKey + '）');
    if (vA.cursorKey !== keyA) fail('出处', 'data 没有把 forKey 记成 cursorKey（实得 ' + vA.cursorKey + '）');
    if (!VMx.derive(vA).cursorValid) fail('出处', '语境没变时 cursorValid 竟然是假 ⇒ 正常翻页会被误杀');

    /* (b) 换类别 ⇒ 游标立刻失去语境（就是 blocker 的触发点） */
    const vCat = VMx.reduce(vA, { type: 'setCategory', id: 2 });
    if (VMx.derive(vCat).cursorValid) fail('出处', '换类别之后 cursorValid 仍为真 ⇒ blocker 会重现："展开更多"照样把旧游标配新类别发出去');
    if (VMx.derive(vCat).buttons.more.enabled) fail('出处', '换类别之后"展开更多"仍可点 ⇒ 用户点得到那次脏请求');
    if (VMx.derive(VMx.reduce(vA, { type: 'toggleAll' })).cursorValid) fail('出处', '切口径之后 cursorValid 仍为真');
    if (VMx.derive(VMx.reduce(vA, { type: 'invalidate' })).cursorValid) fail('出处', 'invalidate 之后 cursorValid 仍为真 ⇒ 刷新后还能拿旧游标翻页');

    /* (c) 跨语境的追加必须被拒 —— 两道闸各拦一类，分开断言 */
    const revAtSend = vA.cursorRev;
    const before = VMx.derive(vCat).shown;
    /* ① 语境换掉、代次没变（在途期间用户切走，状态还是旧的）⇒ 必须被拒 */
    const byKey = VMx.reduce(vA, { type: 'moreData', payload: { items: [{ id: '★脏A★' }], hasMore: true, nextCursor: { id: 9 } }, forKey: VMx.fetchKey(vCat), forRev: revAtSend });
    if (VMx.derive(byKey).shown !== VMx.derive(vA).shown) {
      fail('出处', '请求声明的语境已不是当前 items 的出处，追加仍被放行（items 从 ' + VMx.derive(vA).shown + ' 变成 ' + VMx.derive(byKey).shown + '）');
    }
    if (byKey.items.some((it) => it.id === '★脏A★')) fail('出处', '错类别/错位置的条目进入了 items');
    /* ② 语境切回来、游标代次已变（游标被换过）⇒ 也必须被拒
       ⚠️ 这一条只有在代次真的参与判断时才成立；把判据写成"比当前 fetchKey"
          会让它永远为真 —— 那样两条断言都会失败。
       ⚠️ forKey 必须填**当时**的语境（keyA），否则①会先把它拒掉，
          这条断言就变成在考①了 —— 变异体 M13b 正是靠这一点存活的。 */
    const byRev = VMx.reduce(vCat, { type: 'moreData', payload: { items: [{ id: '★脏B★' }], hasMore: true, nextCursor: { id: 9 } }, forKey: keyA, forRev: revAtSend - 1 });
    if (VMx.derive(byRev).shown !== before) {
      fail('出处', '游标代次不符，过期的 moreData 仍被追加进了列表（items 从 ' + before + ' 变成 ' + VMx.derive(byRev).shown + '）');
    }
    if (byRev.items.some((it) => it.id === '★脏B★')) fail('出处', '过期游标的条目进入了 items');

    /* (d) 同源的追加必须放行（别把闸门做成"永远关着"） */
    const good = VMx.reduce(vA, { type: 'moreData', payload: { items: [{ id: 3 }], hasMore: true, nextCursor: { id: 3 } }, forKey: keyA, forRev: revAtSend });
    if (VMx.derive(good).shown !== VMx.derive(vA).shown + 1) fail('出处', '同源的 moreData 被拒绝了 ⇒ 翻页整个失效');
    if (good.cursorRev === revAtSend) fail('出处', '追加之后游标代次没有前进 ⇒ 第二次翻页会被误判成过期');
    if (!VMx.derive(good).cursorValid) fail('出处', '追加之后 cursorValid 变假 ⇒ 翻第二页就翻不动了');
    /* 第二次翻页：拿新代次去追加，必须放行 */
    const second = VMx.reduce(good, { type: 'moreData', payload: { items: [{ id: 4 }], hasMore: true, nextCursor: { id: 4 } }, forKey: keyA, forRev: good.cursorRev });
    if (VMx.derive(second).shown !== VMx.derive(good).shown + 1) fail('出处', '第二页被拒绝了 ⇒ 只能翻一页');

    /* (e) 老的调用方（不带 forKey）不许被误杀：兼容旧行为 */
    const legacy = VMx.reduce(V0, { type: 'moreData', payload: { items: [{ id: 'x' }], hasMore: true, nextCursor: { id: 1 } } });
    if (!VMx.derive(legacy).shown) fail('出处', '不带 forKey 的 moreData 被拒绝了 ⇒ 兼容性回退');

    /* (f) 取数失败时"展示中的内容"必须与当前语境同源，否则清掉
       —— 否则 chip 高亮是新类别、列表还是旧类别那批、总览句还拿新类别名标注它 */
    const stale = VMx.reduce(vA, { type: 'error', message: 'boom', forKey: VMx.fetchKey(vB) });
    if (VMx.derive(stale).shown !== 0) {
      fail('出处', '换了语境后取数失败，旧列表还在（' + VMx.derive(stale).shown + ' 条）却被贴上「' + VMx.derive(stale).activeChip.name + '」的标签 —— 界面自相矛盾');
    }
    if (VMx.derive(stale).phase !== 'error') fail('出处', '失败之后 phase 不是 error');
    if (!/读取失败/.test(VMx.derive(stale).headline.text)) fail('出处', '失败之后总览句没给出失败提示：' + VMx.derive(stale).headline.text);
    /* 同源（例如"刷新"失败）时内容仍然代表当前口径 ⇒ 如实保留 */
    const sameSrc = VMx.reduce(vA, { type: 'error', message: 'boom', forKey: keyA });
    if (VMx.derive(sameSrc).shown !== VMx.derive(vA).shown) fail('出处', '同源失败时把仍然有效的内容也清了 ⇒ 白白闪一下');
    /* 失败之后游标代次必须前进（否则在途的翻页结果会被错误采纳） */
    if (sameSrc.cursorRev <= vA.cursorRev) fail('出处', '同源失败没有推进游标代次 ⇒ 在途的翻页结果会被错误采纳');

    /* (g) 出处字段的类型必须是"字符串或 null"，代次必须是非负整数 */
    for (const a of [{ type: 'data', seq: 9, payload: { items: [], hasMore: true, nextCursor: { id: 1 }, categories: CATS, todayTotal: 1, filteredTotal: 1 }, forKey: 'K-Z' },
      { type: 'error', message: 'x', forKey: 'K-Z' }]) {
      const v = VMx.reduce(V0, a);
      if (typeof v.dataKey !== 'string' && v.dataKey !== null) fail('出处', a.type + ' 之后 dataKey 类型不对：' + typeof v.dataKey);
      if (typeof v.cursorKey !== 'string' && v.cursorKey !== null) fail('出处', a.type + ' 之后 cursorKey 类型不对：' + typeof v.cursorKey);
      if (!Number.isInteger(v.cursorRev) || v.cursorRev < 0) fail('出处', a.type + ' 之后 cursorRev 不是非负整数：' + v.cursorRev);
    }
  }

  return bad;
}

/* --------------------------- 小工具 --------------------------- */
function vOf(v) { return v; }
function key(v) {
  return [v.expanded, v.showingAll, String(v.activeCategory), v.forceToken, v.phase, v.items.length];
}
function sig(d) {
  return JSON.stringify([
    d.expanded, d.allMode, String(d.activeChip.id), d.shown, d.chips.map((c) => c.name),
    d.buttons.more.visible, d.buttons.more.enabled, d.buttons.more.label,
    d.buttons.all.visible, d.buttons.all.label,
    d.buttons.collapse.visible, d.slider.max, d.slider.value, d.headline.text,
  ]);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function permute(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permute(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

/** 每个可达状态都必须满足的"形态合法性" */
function stateProblems(VMx, s, where) {
  const bad = [];
  let d;
  try {
    d = VMx.derive(s);
  } catch (err) {
    return ['可达 ' + where + ' derive 抛错：' + err.message];
  }
  if (!d.chips.length) bad.push('可达 ' + where + ' chips 为空');
  if (d.slider.max !== d.chips.length - 1) bad.push('可达 ' + where + ' 滑动条 max 不对');
  if (!d.chips[d.activeIndex] || !d.chips[d.activeIndex].on) bad.push('可达 ' + where + ' activeIndex 无效');
  if (d.buttons.all.visible && !d.buttons.all.label) bad.push('可达 ' + where + '"看今天全部"可见但没有文案');
  if (d.buttons.more.visible && d.buttons.more.enabled && !d.buttons.more.label) bad.push('可达 ' + where + '"展开更多"可点但没有文案');
  if (typeof d.headline.text !== 'string' || !d.headline.text.length) bad.push('可达 ' + where + ' 总览句为空');
  if (d.curatedLimit < VMx.CURATED_MIN || d.curatedLimit > VMx.CURATED_MAX) bad.push('可达 ' + where + ' curatedLimit 越界');
  return bad;
}

/* ================================================================== */
/* 变异体：故意改坏 view-model.js，看考裁判抓不抓得住                     */
/* ================================================================== */
const MUTANTS = [
  [
    'M1 按钮自指：把"看今天全部"的可见性改成取决于"已显示多少条"（复现真机 bug）',
    (s) => s.replace('var allVisible = canShowAll || allMode;', 'var allVisible = canShowAll && shown < curatedLimit;'),
  ],
  [
    'M2 丢掉自持性：进入全部模式后按钮不再恒可见',
    (s) => s.replace('var allVisible = canShowAll || allMode;', 'var allVisible = canShowAll;'),
  ],
  [
    'M3 正交破坏：expand 顺手清掉 showingAll',
    (s) => s.replace("expand: function (v, a) {\n      return copy(v, { expanded: !!a.on });\n    },", "expand: function (v, a) {\n      return copy(v, { expanded: !!a.on, showingAll: false });\n    },"),
  ],
  [
    'M4 正交破坏：setCategory 顺手清掉 showingAll（旧代码就是这样）',
    (s) => s.replace('return copy(v, { activeCategory: a.id == null ? null : String(a.id) });', 'return copy(v, { activeCategory: a.id == null ? null : String(a.id), showingAll: false });'),
  ],
  [
    'M5 去掉幂等：setCategory 变回 toggle',
    (s) => s.replace('return copy(v, { activeCategory: a.id == null ? null : String(a.id) });', 'var id = a.id == null ? null : String(a.id);\n      return copy(v, { activeCategory: v.activeCategory === id ? null : id });'),
  ],
  [
    'M6 取数被窗口大小污染：fetchKey 掺进 expanded',
    (s) => s.replace('      num(n.forceToken)\n    );', "      num(n.forceToken) + '|' + (n.expanded ? 'e' : 'c')\n    );"),
  ],
  [
    'M7 窗口大小影响查询口径：fetch.limit 在收起时强行变小',
    (s) => s.replace('limit: allMode ? ALL_LIMIT : n.curated,', 'limit: Math.floor((allMode ? ALL_LIMIT : n.curated) * (n.expanded ? 1 : 0.5)),'),
  ],
  [
    'M8 不夹取 curated：服务端回显多少就用多少（复现"按钮把自己藏了"的根因）',
    (s) => s.replace('function clampCurated(n) {\n    var v = Math.round(num(n, CURATED_DEFAULT));', 'function clampCurated(n) {\n    var v = Math.round(num(n, CURATED_DEFAULT));\n    if (true) return Math.max(1, v);'),
  ],
  [
    'M9 展开更多在加载完之后整个消失（而不是变灰）',
    (s) => s.replace('var moreVisible = v.hasMore || filteredTotal > curatedLimit;', 'var moreVisible = v.hasMore;'),
  ],
  [
    'M10 chips 可能为空：类别表为空时连「全部」都不给',
    (s) => s.replace("var chips = [{ id: null, name: '全部', on: v.activeCategory == null, custom: false }];", 'var chips = [];'),
  ],
  [
    'M11 滑动条序号与选中项脱钩',
    (s) => s.replace('value: activeIndex,', 'value: 0,'),
  ],
  [
    'M12 乱序保护失效：晚到的旧响应可以覆盖新响应',
    (s) => s.replace('if (a.seq != null && num(a.seq) < v.dataSeq) return v;', 'if (false) return v;'),
  ],
  [
    'M13 跨语境的翻页追加没有被拒（本轮 blocker 的 reducer 侧闸门被拆）',
    (s) => s.replace("if (a.forKey != null && !sameKey(a.forKey, v.dataKey)) return v; // ① 语境已换", 'if (false) return v;'),
  ],
  [
    'M13b 过期游标的追加没有被拒（只留了"语境"那把锁）',
    (s) => s.replace('if (a.forRev != null && Math.round(num(a.forRev)) !== v.cursorRev) return v; // ② 游标已被换掉', 'if (false) return v;'),
  ],
  [
    'M14 换类别后游标仍然"有效"（blocker 的根因：出处失配没被发现）',
    (s) => s.replace('var cursorValid = !!v.cursor && !!v.cursorKey && sameKey(v.cursorKey, fetchKeyOf(v));', 'var cursorValid = !!v.cursor;'),
  ],
  [
    'M15 失败时不清旧内容（chip 高亮是新类别、列表还是旧类别那批）',
    (s) => s.replace('if (!sameKey(v.dataKey, a && a.forKey != null ? String(a.forKey) : null)) {', 'if (false) {'),
  ],
  [
    'M16 data 不记出处（dataKey/cursorKey 永远是空 ⇒ 闸门失效）',
    (s) => s.replace('dataKey: forKey,\n        cursorKey: forKey,\n        cursorRev: v.cursorRev + 1,', 'dataKey: null,\n        cursorKey: null,\n        cursorRev: 0,'),
  ],
];

/* ================================================================== */
/* 跑                                                                    */
/* ================================================================== */
const lines = [];
const say = (s = '') => { lines.push(s); console.log(s); };
let failed = 0;
let passed = 0;

function ok(name, fn) {
  try {
    fn();
    passed += 1;
    say('  ✔ ' + name);
  } catch (err) {
    failed += 1;
    say('  ✘ ' + name);
    /* ⚠️ 失败信息要**整段**打出来。只打第一行会丢掉"违反项："后面的清单 ——
       而那正是唯一有用的部分（这个截断让第一次跑的时候我什么都没看到）。 */
    const all = String(err.message).split('\n');
    for (const ln of all.slice(0, 16)) say('      ' + ln);
    if (all.length > 16) say('      …（还有 ' + (all.length - 16) + ' 行）');
  }
}

say('┌─ 晨报机 · 交互一致性离线考裁判 ─────────────────────────');
say('│ 纯 Node：不联网、不需要 Electron');
say('└────────────────────────────────────────────────────────');

say('');
say('【第一层】加载方式与真机一致');
ok('view-model.js 是经典脚本（不含 import/export）', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/^\s*import\s/m.test(code), '出现了 import');
  assert.ok(!/^\s*export\s/m.test(code), '出现了 export');
  assert.ok(!/\bexport\s+(default|const|function|\{)/.test(code), '出现了 export');
});
ok('经典脚本加载后 globalThis.MB_VIEW 有全部出口', () => {
  const fresh = loadVM(SRC);
  assert.equal(typeof fresh.createView, 'function');
  assert.equal(typeof fresh.reduce, 'function');
  assert.equal(typeof fresh.derive, 'function');
});
ok('文件是 LF 且无 BOM（仓库硬要求）', () => {
  const buf = fs.readFileSync(VM_PATH);
  assert.notEqual(buf[0], 0xef, '文件带 UTF-8 BOM');
  assert.ok(!buf.includes(Buffer.from('\r\n')), '文件含 CRLF');
});

/* ------------------------------------------------------------------
 * 第一层之二 · 样式与窗口尺寸的**跨文件一致性**
 * ------------------------------------------------------------------
 * ⚠️ 这一组是"一行代码换来的"：窗口为了给外投影留画布，做成了
 *    内容尺寸 + 2×WIN_PAD，卡片改用 position:absolute; inset:var(--win-pad)；
 *    而 surface.css 里旧形态的 `width:100%; height:100%` 忘了删。
 *    绝对定位元素上 left+right+width 三者非 auto 是**过约束**，
 *    CSS 2.1 §10.3.7 规定 ltr 下忽略 right（§10.6.4 忽略 bottom）⇒
 *    卡片右沿与下沿各顶穿视口 WIN_PAD 像素 —— **正好把刚留出来的画布吃干净**，
 *    结果是"只有左上两条边有投影"。
 *
 * 而且这段代码的注释里当时写着"可被离线断言（见 tools/test-interaction.mjs 里
 * 读 CSS 与这里比对的那条）" —— **那条断言并不存在**。
 * ⇒ 现在把它真的写出来。注释里声明"已被断言守住"而实际没有，比没有注释更糟：
 *    下一个人会因此不去检查。
 *
 * 教训（值得留在这里）：跨文件的双份数值（CSS 变量 ↔ JS 常量）必须有一条
 * 机器判据，否则"两边同时改"就只是一句口号。
 * ------------------------------------------------------------------ */
const CSS_DIR = path.resolve(HERE, '..', 'src', 'renderer', 'styles');
const readCss = (f) => fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
const readFileRel = (rel) => fs.readFileSync(path.resolve(HERE, '..', rel), 'utf8');

/** 取出某个选择器的声明块（只取第一块，够用且不引 CSS 解析器） */
function declBlock(css, selector) {
  const re = new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
  const m = css.match(re);
  return m ? m[2] : null;
}

say('');
say('【第一层之二】样式与窗口尺寸的跨文件一致性（防"注释说改了、代码没改"）');

ok('★ .card 不许同时有 inset 与 width/height（过约束会把投影画布吃掉）', () => {
  const cardCss = readCss('card.css');
  const surfaceCss = readCss('surface.css');
  const inCard = declBlock(cardCss, '.card');
  assert.ok(inCard, 'card.css 里找不到 .card 的声明块');
  assert.ok(/inset\s*:\s*var\(--win-pad\)/.test(inCard), '.card 没有用 inset: var(--win-pad) 定位');

  /* 两份 CSS 都会作用于 .card（card.css 后加载、优先），所以要**一起**看：
     任何一处写了 width/height 都会被绝对定位的过约束规则放大成"位移 + 溢出"。 */
  for (const [name, css] of [['card.css', cardCss], ['surface.css', surfaceCss]]) {
    const blk = declBlock(css, '.card');
    if (!blk) continue;
    for (const prop of ['width', 'height']) {
      const m = blk.match(new RegExp('(^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'm'));
      if (m && !/^\s*(auto|100%\s*\/\s*\*.*)?$/.test(m[2]) && m[2].trim() !== 'auto') {
        assert.fail(
          name + ' 的 .card 声明了 ' + prop + ': ' + m[2].trim() + ' —— 它与 inset 过约束，' +
            '会让卡片右/下各溢出 --win-pad 像素，外投影在这两个方向一个像素都到不了屏幕。' +
            '（要么删掉它，要么把定位方式一并改回 .card = 视口）',
        );
      }
    }
  }
});

ok('★ --win-pad、window.js 的 WIN_PAD、CARD_SIZE 三者必须自洽', () => {
  const token = readCss('tokens.css');
  const m = token.match(/--win-pad\s*:\s*(\d+(?:\.\d+)?)px/);
  assert.ok(m, 'tokens.css 里找不到 --win-pad');
  const cssPad = Number(m[1]);

  const winJs = readFileRel('src/main/window.js');
  const jm = winJs.match(/export const WIN_PAD\s*=\s*(\d+(?:\.\d+)?)/);
  assert.ok(jm, 'window.js 里找不到 WIN_PAD');
  const jsPad = Number(jm[1]);
  assert.equal(cssPad, jsPad, 'CSS 的 --win-pad 与 JS 的 WIN_PAD 不一致：两边不一致时不是卡片被裁就是四周多出空白');

  /* CARD_SIZE = 内容尺寸 + 2×WIN_PAD。内容尺寸是 A3 那套垂直/水平算术的输入，
     所以这里只断言"关系"，不锁死具体数值（改形态时不用改两处）。 */
  const sizes = [...winJs.matchAll(/(collapsed|expanded):\s*\{\s*w:\s*(\d+),\s*h:\s*(\d+)\s*\}/g)];
  assert.equal(sizes.length, 2, 'window.js 里应当恰好有 collapsed / expanded 两个尺寸');
  for (const s of sizes) {
    const w = Number(s[2]);
    const h = Number(s[3]);
    assert.ok(w > 2 * jsPad && h > 2 * jsPad, s[1] + ' 的窗口尺寸比两倍 WIN_PAD 还小，内容尺寸会是负数');
    assert.equal((w - 2 * jsPad) % 2, 0, s[1] + ' 的窗口宽减去两倍 WIN_PAD 之后不是偶数：' +
      '内容宽度会落在半像素上，150% 缩放下 1px 发丝线会发虚');
    assert.equal((h - 2 * jsPad) % 2, 0, s[1] + ' 的窗口高减去两倍 WIN_PAD 之后不是偶数（同上）');
  }
  /* 展开态必须**严格大于**收起态：反过来的话收起时列表反而更高，
     用户点「收起」会看到内容变多 —— 那不是收起。 */
  const map = Object.fromEntries(sizes.map((s) => [s[1], { w: Number(s[2]), h: Number(s[3]) }]));
  assert.ok(map.expanded.h > map.collapsed.h, '展开态不比收起态高');
  assert.equal(map.expanded.w, map.collapsed.w, '两个状态的宽度应当一致（宽度变化会让文字重排、看起来像闪）');
});

ok('★ 任何 CSS 都不许用 data-state 把 .filters / .catbar / .foot 藏起来', () => {
  for (const f of ['card.css', 'surface.css', 'tokens.css']) {
    const css = readCss(f).replace(/\/\*[\s\S]*?\*\//g, ''); // 去掉注释，避免注释里的字样造成假阳/假阴
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
    for (const r of rules) {
      const sel = r[1].trim();
      if (!/data-state/.test(sel)) continue;
      if (!/\.(filters|catbar|foot)\b/.test(sel)) continue;
      const body = r[2];
      assert.ok(
        !/display\s*:\s*none/.test(body) && !/visibility\s*:\s*hidden/.test(body),
        f + ' 里有一条以 data-state 为条件把筛选区藏掉的规则：' + sel + ' { ' + body.trim() + ' } —— ' +
          '这正是"展开后收起，类型选项就消失"的病根。收起态只许压缩间距，不许改存在性。',
      );
    }
  }
  /* 顺带确认这两块自己还在（防止有人把元素删了、断言却依然通过） */
  const html = readFileRel('src/renderer/card.html');
  for (const id of ['filters', 'catbar', 'foot', 'list', 'catSlider', 'btnAll', 'btnMore', 'btnCollapse', 'btnAddCat']) {
    assert.ok(new RegExp('id="' + id + '"').test(html), 'card.html 里缺少 #' + id);
  }
});

/* ------------------------------------------------------------------
 * 诊断通道自身的正确性
 * ------------------------------------------------------------------
 * 真机日志（用户贴回来的那一份）里，每一行 verdict 都写着
 *     ❌ 类型导轨不存在（渲染逻辑没跑到）
 *     ❌ 底栏不存在
 * 而**同一行 JSON 里**明明写着
 *     "filters":{"display":"flex","visible":true,"w":399,"h":30,...}
 * 也就是**诊断在自己骗自己**。两个根因，都是"缺省值站错了边"：
 *   ① `box()` 只在找不到元素时返回 `{exists:false}`，找到时那个字段**根本不写**
 *      ⇒ `!f.exists` 对存在的元素也成立。
 *   ② `footClipped` 拿子元素的**视口 bottom** 去减卡片的**高度** ——
 *      卡片 inset 了 20px，于是每份自检都凭空多报 19px 的"被挤出"。
 *
 * 这两条为什么值得单独立断言：这是我在离线侧**唯一**的反馈通道。
 * 它撒谎的代价不是"少一条日志"，而是"把我引去改本来完全正确的渲染逻辑"——
 * 前两轮返工打不中靶子，一半原因就在这类诊断失真上。
 * ------------------------------------------------------------------ */
say('');
say('【第一层之三】诊断通道自身必须可信（它撒谎比没有更糟）');

ok('★ box() 两个分支都必须给 exists（缺省值要站在"存在"那边）', () => {
  const card = readFileRel('src/renderer/card.js');
  const m = card.match(/function box\(sel\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, '找不到 box() 的实现');
  const body = m[0];
  assert.ok(/if\s*\(!n\)\s*return\s*\{\s*exists:\s*false\s*\}/.test(body), 'box() 的"找不到"分支没有 exists:false');
  assert.ok(/exists:\s*true/.test(body), 'box() 的"找到了"分支没有写 exists:true —— 这会让 `!f.exists` 对存在的元素也成立');
  /* 用它的判据也必须写成 `=== false`，不能写 `!x.exists`（后者对 undefined 为真） */
  assert.ok(
    !/if\s*\(\s*!f\.exists\s*\)/.test(card) && !/if\s*\(\s*!foot\.exists\s*\)/.test(card),
    'verdict 里用了 `!x.exists` —— 一旦字段缺失就会误报"元素不存在"。应当写 `x.exists === false`',
  );
});

ok('★ footClipped / 导轨越界必须拿卡片**下沿**比，不能拿卡片高度比', () => {
  const card = readFileRel('src/renderer/card.js');
  assert.ok(
    /getBoundingClientRect\(\)\.bottom\s*-\s*cardBottom/.test(card),
    'footClipped 没有以卡片下沿（cardBottom）为基准 —— 卡片 inset 之后会凭空多报 offset 那么多像素',
  );
  assert.ok(!/\.bottom\s*-\s*viewH/.test(card), '还有地方拿"子元素视口 bottom − 卡片高度"当判据');
  assert.ok(/var\s+cardBottom\s*=/.test(card), '没有定义 cardBottom');
});

ok('★ 不许再用 window.prompt（Electron 渲染进程里它不存在，且是被拒的 Promise）', () => {
  const card = readFileRel('src/renderer/card.js');
  assert.ok(
    !/window\.prompt|(?<![.\w])prompt\s*\(/.test(card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    '代码里又出现了 prompt() —— Electron 渲染进程不支持它，抛的是**被拒的 Promise**，' +
      'try/catch 一个字都接不住，用户看到的是"点了没反应"',
  );
});

say('');
say('【第二层】四条不变量 + 顺序无关 + 模型等价 + 可达闭包');
ok('checkAll(真实实现) 应当零违反', () => {
  const bad = checkAll(VM);
  assert.deepEqual(bad, [], '违反项：\n      ' + bad.join('\n      '));
});

say('');
say('【第三层】变异测试 —— 每个变异体都必须被抓死');
for (const [name, mutate] of MUTANTS) {
  ok('抓死 ' + name, () => {
    const mutated = mutate(SRC);
    assert.notEqual(mutated, SRC, '变异算子对当前源码无效（源码已改？）—— 这条断言本身就是防"变异体是个空操作"');
    let mVM = null;
    try {
      mVM = loadVM(mutated);
    } catch (err) {
      return; // 语法都过不去的变异体等于已被杀死
    }
    if (!mVM) return;
    const bad = checkAll(mVM);
    assert.ok(bad.length > 0, '变异体存活（考裁判有盲区）：改坏了但一条断言都没抓到');
  });
}

/* ==================================================================
 * 第四层：真管线 —— 把 card.js 装进 node:vm，重放"不同点击路径"
 * ==================================================================
 * 前三层考的都是 reducer（纯函数）。但本轮的 blocker 住在 reducer 与 IPC
 * **之间那段顺序**里：单看 loadMore 是对的、单看 moreKey 守卫也是对的，
 * 错在它们之间 —— 只有把整条管线跑起来、由测试决定每笔请求何时返回，
 * 才复现得出来。这一层就是那件事。
 * ⚠️ 装置本身的三条纪律（结算要等 boot、要取最新那笔、第二页要接续游标）
 *    写在 tools/card-rig.mjs 顶部，它们是"装置不骗人"的前提。
 * ================================================================== */
say('');
say('【第四层】真管线：card.js 装进 vm，重放不同点击路径');
/* ⚠️ 这一段是异步的（要等 IPC 的假桥结算），所以包一层；
   `ok()` 本身是同步的 —— 断言体里不许再 await，需要等待就先在外面 await 完。 */
await (async () => {
{
  const r = await bootedRig();
  ok('启动后只发出一次有效取数，且首页到位', () => {
    assert.equal(r.calls.filter((c) => c.kind === 'get').length, 2, '启动应当恰好两次 get（第一次被紧随的 invalidate 作废）');
    assert.equal(r.view.items.length, 15);
    assert.equal(r.chips().length, 4, 'chips 应当有「全部」+ 3 个类别');
    assert.equal(r.more().disabled, false);
  });
}

{
  const r = await bootedRig();
  ok('blocker 复现路径：点 chip → **立刻**点「展开更多」→ 那笔脏请求不许发出去', async () => {
    r.clickChip(2);                       // 「开源」
    await r.sleep(20);
    const n = r.calls.length;
    assert.equal(r.more().disabled, true, '换类别后"展开更多"应当立刻变灰（游标已失去语境）');
    r.click('btnMore');
    await r.sleep(20);
    assert.equal(r.calls.length, n, '变灰期间点它不许再发任何请求');
    assert.ok(!r.has('more'), '不许发出 more 请求');
    /* 而且：不许出现"游标来自旧查询、筛选项来自新查询"的 payload */
    for (const c of r.calls) {
      if (c.kind !== 'more') continue;
      assert.ok(c.opts.categoryIds === undefined || sameCat(c.opts, '2'), 'more 的 cursor 与 categoryIds 必须同源');
    }
  });
}

{
  const r = await bootedRig();
  ok('换类别后取数失败：列表与 chip 高亮不许各说各话', async () => {
    const before = r.view.items.length;
    r.clickChip(1);                        // 「AI」
    await r.sleep(20);
    await r.fail('get', '主进程 buildBrief 抛错');
    assert.equal(r.view.phase, 'error');
    assert.equal(r.view.items.length, 0, '失败后不许再展示上一批（那是无筛选首页的 ' + before + ' 条）');
    assert.ok(/读取失败/.test(r.headline()), '总览句应当给出失败提示，实得：' + r.headline());
    assert.ok(!/（AI）/.test(r.headline()), '不许拿新类别名去标注旧列表：' + r.headline());
    assert.equal(r.chips().filter((c) => c.on).map((c) => c.name).join(), 'AI', 'chip 高亮仍应停在用户选的那一项（自持性）');
  });
}

{
  const r = await bootedRig();
  ok('翻页在途时换类别：过期结果不许被追加进列表', async () => {
    r.click('btnMore');
    await r.sleep(20);
    const mreq = r.calls[r.calls.length - 1];
    assert.equal(mreq.kind, 'more');
    r.clickChip(1);                        // 「AI」
    await r.sleep(20);
    await r.ok('get', firstPayload(r, 'AI', { items: r.items('AI', 4), hasMore: false, nextCursor: null, filteredTotal: 4 }));
    assert.equal(r.view.activeCategory, '1');
    const n = r.view.items.length;
    await r.ok('more', {
      items: r.olderItems('P2', 2, mreq.opts.cursor), hasMore: true,
      nextCursor: { publishedAt: mreq.opts.cursor.publishedAt, id: mreq.opts.cursor.id - 2, pendingNull: false },
    });
    assert.equal(r.view.items.length, n, '过期的翻页结果被追加进了列表（' + n + ' → ' + r.view.items.length + '）');
    assert.ok(!r.rowTitles().some((t) => t.includes('P2')), '错类别的条目被渲染到了列表里');
  });
}

{
  const r = await bootedRig();
  ok('正常翻页仍然工作（闸门不许做成"永远关着"）', async () => {
    const before = r.view.items.length;
    r.click('btnMore');
    await r.sleep(20);
    const req = r.calls[r.calls.length - 1];
    await r.ok('more', {
      items: r.olderItems('P2', 3, req.opts.cursor), hasMore: true,
      nextCursor: { publishedAt: req.opts.cursor.publishedAt, id: req.opts.cursor.id - 3, pendingNull: false },
    });
    assert.equal(r.view.items.length, before + 3, '合法的第二页必须被追加');
    assert.ok(r.rowTitles().some((t) => t.includes('P2')), '第二页没有渲染出来');
    assert.equal(r.more().disabled, false, '还有下一页时按钮必须还能点');
  });
}

{
  const r = await bootedRig();
  ok('任务点名的交错序列：chip → 看今天全部 → 展开更多，最终只满足最后一个意图且载荷自洽', async () => {
    r.clickChip(2);
    await r.sleep(20);
    r.click('btnAll');
    await r.sleep(20);
    r.click('btnMore');
    await r.sleep(20);
    const before = r.calls.length;
    await r.ok('get', firstPayload(r, 'AB', { hasMore: true, filteredTotal: 12,
      nextCursor: { publishedAt: '2026-09-22T00:00:00Z', id: 60, pendingNull: false } }));
    await r.sleep(40);
    /* 收敛：不变量是"最终状态可预期"，不是"只发一次请求" */
    assert.equal(r.view.activeCategory, '2');
    assert.equal(r.view.showingAll, true);
    assert.equal(r.chips().filter((c) => c.on).map((c) => c.name).join(), '开源');
    assert.equal(r.allBtn().text, '只看精选', '"看今天全部"必须保持可见可点（I1 自持性）');
    /* 真正的不变量：**没有任何一笔请求的载荷是自相矛盾的**。
       旧实现在这里发出过 `more {cursor: <旧查询>, categoryIds:['2'], todayOnly:true}`。 */
    for (const c of r.calls.slice(before)) {
      if (c.kind !== 'more') continue;
      assert.ok(sameCat(c.opts, '2'), 'more 载荷的筛选与 cursor 必须同源：' + JSON.stringify(c.opts));
    }
    /* 最后一个意图必须被满足（合并循环永不丢弃） */
    const last = r.calls[r.calls.length - 1];
    assert.equal(last.opts.todayOnly, true, '最后一个意图（今天全部）必须真的被发出去');
    assert.equal(last.opts.limit, 120);
  });
}
})();

say('');
say('────────────────────────────────────────────────────────');
say('断言 ' + passed + ' 通过 / ' + failed + ' 失败；变异体 ' + MUTANTS.length + ' 个');
if (failed) {
  say('结论：不通过 ✘');
  process.exit(1);
}
say('结论：全部通过 ✔');
