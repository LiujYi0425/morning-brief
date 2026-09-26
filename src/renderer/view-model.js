/**
 * src/renderer/view-model.js —— 界面状态的**唯一**真相 + 唯一合法的转移函数
 * =====================================================================
 * ⚠️⚠️ **本文件是经典脚本，不是 ES 模块。不许出现 `import` / `export`。**
 *    理由与 interaction.js 同源（那里用真机日志换来过一次教训）：
 *    CSP 是 `default-src 'none'`，模块脚本的获取走 connect-src ⇒ 会被拦；
 *    而写成 `export` 又被经典 <script> 加载 ⇒ 浏览器抛 SyntaxError、
 *    **整个文件一个字都不执行**，同时离线测试（用 import）全绿。
 *    ⇒ IIFE + 一条无条件 `globalThis.MB_VIEW = {...}`。
 *    离线考裁判用 `node:vm`（内置、零依赖）以**完全相同的方式**加载它。
 *
 * ---------------------------------------------------------------------
 * 为什么要有这个文件（第三轮返工的根因）
 * ---------------------------------------------------------------------
 * 真机反馈的三个症状：① 收起后类型选项消失 ② 点过之后按钮就没了
 * ③ 不同点击顺序结果不一致。查下去是**三个独立的病**，且都不是 CSS 问题：
 *
 *   病 1 · 按钮可见性**取决于它自己的效果**（自指）
 *     `renderFoot` 用 `state.curated` 判断「看今天全部」该不该在，
 *     而 `state.curated` 又被 `buildBrief` 回显成"本次请求的 limit" ——
 *     于是点了「看今天全部」（limit 60）之后 `curated` 变成 60，
 *     按钮判定 `todayTotal > 60` 为假 ⇒ **它把自己藏起来了**，
 *     而且这个值会一直错下去（收起、刷新都救不回来）。
 *     ⇒ 修法见下方不变量 I1/I2。
 *
 *   病 2 · 忙碌时**静默丢弃**请求
 *     `refresh()` 开头 `if (state.busy) return`。它挡住了并发重入，
 *     也把"忙碌期间用户发出的意图"整条丢掉 —— 于是 `showingAll` 已经翻了、
 *     界面却还是旧的，看起来就是"点了没反应 / 按钮状态不对"。
 *     ⇒ 修法：`fetchKey` + 合并循环（见 card.js 的 syncFetch）。**永不丢弃最后意图**。
 *
 *   病 3 · 两条独立的轴被搅在一起
 *     「数据口径（精选/全部）」「类别筛选」「窗口大小（收起/展开）」
 *     本来是三个正交字段，旧代码却让它们互相改写：
 *       · 点 chip 会 `showingAll = false`（筛选顺手把模式清了）
 *       · 点「看今天全部」会**顺便展开窗口**（模式顺手改了窗口）
 *       · 展开时重新取数（窗口大小居然影响了查询）
 *     ⇒ 三个字段各管各的，`derive()` 只读不写。这才可能做到**顺序无关**。
 *
 * ---------------------------------------------------------------------
 * 四条不变量（可被离线测试逐条断言，也是本文件存在的意义）
 * ---------------------------------------------------------------------
 *   I1 **自持性**：一个"模式开关"按钮，一旦被激活过，就**永远保持可见/可点**，
 *      否则用户无法撤销自己刚做的操作。（「看今天全部」↔「只看精选」）
 *   I2 **非自指**：按钮的可见性**只**由 (今日总数, 精选条数, 当前类别) 决定，
 *      **绝不**由"当前已经显示了多少条"决定 —— 后者正是病 1 的形态。
 *   I3 **正交**：expand / showingAll / activeCategory 三个字段互不改写，
 *      只有 `normalize` 按**数据**（而非动作顺序）做一致性收敛。
 *   I4 **全函数**：未知动作 = 无操作；任何字段缺省都有合法默认值。
 *      ⇒ 任意动作序列都不会把状态带进非法形态。
 *
 * 顺序无关性的判据（离线测试直接跑排列）：
 *   对任意两个动作 a、b：`derive(reduce(reduce(v,a),b)) ≡ derive(reduce(reduce(v,b),a))`
 *   其例外只允许是"同一开关被按了奇偶次"的差异，而那种差异本身是**可预期**的。
 * =====================================================================
 */
(function attachViewModel(global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 常量：**唯一**的数值口径来源                                         */
  /* ------------------------------------------------------------------ */

  /** 默认精选条数（服务端 `buildBrief` 用的也是这个量级，但两边各自持有，不回显） */
  var CURATED_DEFAULT = 15;
  var CURATED_MIN = 3;
  var CURATED_MAX = 40;

  /** "看今天全部"模式下一次取多少条（上限 200 见 db.queryItems 的夹取） */
  var ALL_LIMIT = 120;

  /** 翻页每页条数 */
  var PAGE_LIMIT = 15;

  var PHASES = { init: 1, loading: 1, ready: 1, error: 1 };

  /* ------------------------------------------------------------------ */
  /* 小工具（全部纯函数）                                                 */
  /* ------------------------------------------------------------------ */
  function num(v, dflt) {
    var n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : (dflt || 0);
  }

  function clampCurated(n) {
    var v = Math.round(num(n, CURATED_DEFAULT));
    if (v < CURATED_MIN) v = CURATED_MIN;
    if (v > CURATED_MAX) v = CURATED_MAX;
    return v;
  }

  /**
   * 「不喜欢」在精选里最多占几条。
   *
   * ⚠️ 这个算式与 `src/shared/quota.js` 的 `quotaOf` **必须逐字一致**。
   *    为什么在这里又写一遍而不是 import：本文件是经典脚本（不能有 import/export，
   *    见文件顶部的说明），而那个模块是 ESM。
   *    ⇒ 只允许**这一处**重复，且两边的断言都由离线考裁判盯着
   *      （test-all.mjs 里有一条把两个结果并排比 —— 它们漂移就红）。
   *    ⚠️ 下限必须是 1：0 会把"少放"变成"不放"。
   */
  function quotaOf(curated) {
    var n = num(curated, CURATED_DEFAULT);
    var q = Math.round(n * 0.2);
    return q < 1 ? 1 : q;
  }

  function copy(v, patch) {
    var out = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = v[k];
    for (var j in patch) if (Object.prototype.hasOwnProperty.call(patch, j)) out[j] = patch[j];
    return out;
  }

  function arr(v) {
    return Array.isArray(v) ? v : [];
  }

  /** ⚠️ 取数身份比较必须**两边都归一成字符串**：`undefined` 与 `null` 都是"没有身份"。
   *  用 `!==` 直接比会在"老调用方没带 key"时把一次合法的追加误判成过期。 */
  function sameKey(a, b) {
    if (a == null || b == null) return a == null && b == null;
    return String(a) === String(b);
  }

  /* ------------------------------------------------------------------ */
  /* 初始状态                                                             */
  /* ------------------------------------------------------------------ */
  function createView() {
    return {
      /* —— 数据面（由 fetch 结果写入） —— */
      items: [],
      cursor: null,
      hasMore: false,
      /* ★★ 数据面的**出处**（第三轮返工的第二个根因）。
       *
       * 为什么必须记它：`items` / `cursor` / `hasMore` 不是"状态"，而是
       * **某一次查询的产物**。状态里若不写"这是哪一次查询的产物"，就会出现
       * 两个各自独立、都无法自证的错：
       *
       *   ① 换类别后在新数据回来之前点「展开更多」——
       *      发出去的 payload 是 `{ cursor: <旧查询的游标>, categoryIds: ['2'] }`。
       *      服务端照单全收，**返回一批不属于该类别、位置也不接续的条目**，
       *      而 card.js 的 moreKey 守卫是在"语境已经切到新类别之后"才采样的，
       *      两边相等 ⇒ 这份脏数据被**合法采纳**。列表里混进错类别条目、
       *      hasMore 被错值覆盖、按钮文案与实际可分页能力脱节。
       *   ② 换类别后取数失败 —— 列表还是上一批（无筛选的）条目，
       *      而 chip 高亮与总览句已经用了**新**类别名（见 headlineOf）：
       *      界面同时给出三个互相矛盾的信号，用户无法自证"筛选到底坏没坏"。
       *
       * ⇒ 三个字段把"内容"与"产出内容的身份"绑死：
       *   `dataKey`   当前 items 是哪个 fetchKey 的产物（`error` 靠它判断
       *               "展示中的内容与当前语境是否同源"，不同源就必须清掉）
       *   `cursorKey` 当前 cursor 是哪个 fetchKey 的产物（`derive.cursorValid`
       *               靠它判断"这个游标还能不能用来翻页"）
       *   `cursorRev` 游标的**代次**（`moreData` 靠它判断"这次追加是不是还落在
       *               我发出的那个游标上"）
       *
       * ⚠️ 为什么需要代次，而不只比 `cursorKey` 与 `a.forKey`：
       *    `forKey` 是请求**声明**的语境，而 `cursorKey` 是游标的**实际**出处 ——
       *    两者在"游标被换过、但语境又切回来了"时可能相等，那正是要拦住的情况。
       *    代次是**单调变化**的，所以它真的能区分"同一个游标"与"被换掉的游标"。
       * ⚠️ 三个字段都必须由**动作携带/递增**，不能在这里现算 ——
       *    reducer 一旦去算身份就变成了"读当前值"，那正是要修的病。
       *    （第一版把 `moreData` 的守卫写成"比当前 fetchKey"，那等于拿一个值和
       *      它自己比 —— 永远为真、一条断言都咬不住，离线考裁判当场指出来了。）
       * ⚠️ 它们进 `derive` 的唯一形式是 `cursorValid`（布尔），
       *    所以顺序无关性（derive 的逐字相等）不受影响。 */
      dataKey: null,
      cursorKey: null,
      cursorRev: 0,
      todayTotal: 0,
      /** 当前口径下的今日总数（有类别筛选时就是该类别的今日数） */
      filteredTotal: 0,
      categories: [],
      activeCategory: null,
      curated: CURATED_DEFAULT,
      health: null,
      lastIngestAt: null,
      /** 上次**成功**抓取（有源成功才算）—— 与调度器同一口径 */
      lastSuccessAt: null,
      /** 今天成功抓到过没有。
       *  ❗`false` 且列表非空 = "你看到的其实是旧闻" —— 这种状态**必须让用户知道**，
       *    否则界面一切正常、只是内容不是今天的，那是最误导人的一种坏法。 */
      fetchedToday: true,
      /** 服务端算出的"今天 00:00"（本地日）。翻页时**原样带回去**，
       *  否则跨过午夜之后第 2 页会换一个日期边界、与第 1 页接不上。 */
      sinceIso: null,
      ai: null,          // AI 简报状态（Key 配没配 / 端点 / 用量 / 今天那一份）
      briefView: false,  // 列表现在显示的是不是简报（**由主进程算**，界面不自己推）
      unreadToday: 0,    // 今天还没点开过的条数（主进程算好给过来）
      aiPanelOpen: false, // AI 设置面板开着没有
      aiBusy: '',         // 面板里正在忙什么（save / test / config / generate）
      aiMsg: null,        // 上一次操作的结果（{ok, text}）—— 失败必须说出来

      /* —— 筛选栏编辑面板（本次功能） ——
       *
       * 面板回答两个问题：「这个类型**包含哪些源**」与「我对它是什么态度」。
       * ⚠️ 全部由这里的状态决定（而不是 card.js 里的临时变量）——
       *    理由与整个文件同源：界面上的每一处都必须能从状态推出来，
       *    否则"点了没反应/点了两次结果不同"又会以新的形式回来。
       *    放进状态机还带来一件事：它可以被离线考裁判**穷举**。 */
      /** 面板是否展开（false = 收起，界面与改动前逐字一致） */
      editorOpen: false,
      /** 面板正在编辑哪个类型（null = 就是当前选中的那个） */
      editorCategory: null,
      /** 该类型绑定的源 id（**字符串**，与 activeCategory 同口径，避免 1 !== "1"） */
      editorSelected: [],
      /** 面板里的偏好档位。
       *  ⚠️ 它与 `categories[i].pref` 是**两份**数据，必须一起写 ——
       *     只写 categories 的话，`categories` 那条 action（新增类型/保存映射
       *     之后主进程会回一份新的类别表）会把界面上的档位打回服务端的旧值，
       *     而服务端的这次响应本来就不含刚刚那次偏好写入。
       *     归一化时用它覆盖 categories 里的 pref（见 normalize）。 */
      editorPref: null,
      /** 可勾选的源清单（来自主进程；空 = 还没读到） */
      editorSources: [],
      /** 保存中：期间不许再改，否则两次写会互相覆盖（后写的赢，用户看到的却相反） */
      editorSaving: false,
      /** 删除的二次确认：只有一个类型会处于"等你再点一次"的状态 */
      pendingDelete: null,
      /** 「＋ 添加源」那一行是否展开（阶段 A）。
       *  ⚠️ 它遵守同一条规矩：**界面上的每一处都由状态决定**。
       *    输入框里**不回读用户的字**（DOM 是渲染的产物，不是输入源），
       *    所以这里只存"开没开"和"正在验没验"。 */
      addSourceOpen: false,
      /** 正在验证（主进程要先抓一次 feed）——期间禁用整块，避免连点发出多次试抓 */
      addSourceBusy: false,

      /* —— 模式面（用户意图） —— */
      /** 数据口径：false = 只看精选，true = 看今天全部 */
      showingAll: false,

      /* —— 视图面（窗口） —— */
      /** ⚠️ 这一项**只影响布局**，绝不影响查询口径（病 3 的修法） */
      expanded: false,

      /* —— 生命周期 —— */
      phase: 'init',
      error: null,

      /** `invalidate` 递增它 ⇒ fetchKey 变化 ⇒ 强制重取（刷新用） */
      forceToken: 0,
      /** 已应用的数据版本号，用于丢弃乱序响应 */
      dataSeq: 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 归一化：**按数据收敛**，与动作顺序无关                                */
  /* ------------------------------------------------------------------ */
  function normalize(v) {
    var out = copy(v, {});

    out.items = arr(out.items);
    out.categories = arr(out.categories).filter(function (c) {
      return c && typeof c === 'object' && c.id != null;
    });
    out.curated = clampCurated(out.curated);
    out.todayTotal = Math.max(0, Math.round(num(out.todayTotal)));
    out.filteredTotal = Math.max(0, Math.round(num(out.filteredTotal)));
    out.forceToken = Math.max(0, Math.round(num(out.forceToken)));
    out.dataSeq = Math.max(0, Math.round(num(out.dataSeq)));
    out.hasMore = !!out.hasMore;
    out.showingAll = !!out.showingAll;
    out.expanded = !!out.expanded;
    if (!PHASES[out.phase]) out.phase = 'init';

    /* 类别收敛：只有当**类别表已知**、而当前选中项不在表里时才清掉。
       ⚠️ 类别表为空时**不动**它 —— 启动瞬间 categories 还是空的，
          这时若清掉用户刚点的类别，就变成"点了又自己弹回去"。
       ⚠️ 比较必须**两边都归一成字符串**。这一条是离线模型测试当场抓出来的真 bug：
          SQLite 给的 `category.id` 是**数字**，而这个字段每次归一化后是**字符串**，
          于是 `1 === "1"` 为假 ⇒ 判定"该类别不存在" ⇒ 清成 null。
          用户侧看到的是：**第一次点 chip 有效，第二次点就自己弹回「全部」**。
          这正是"不同点击路径行为不一致"最典型的一个来源。
       ⚠️ 这里**不碰 showingAll**：那是 I1/I3 的规矩。
          「没有更多了」这件事由 derive() 表达成按钮文案，而不是偷偷改用户意图。 */
    if (out.categories.length && out.activeCategory != null) {
      var want = String(out.activeCategory);
      var found = false;
      for (var i = 0; i < out.categories.length; i += 1) {
        if (String(out.categories[i].id) === want) { found = true; break; }
      }
      if (!found) out.activeCategory = null;
    }
    if (out.activeCategory != null) out.activeCategory = String(out.activeCategory);

    /* 没有下一页就没有游标 —— 免得拿着过期游标再翻一次 */
    if (!out.hasMore) out.cursor = null;
    /* 身份与游标代次（见 createView 里的说明） */
    out.dataKey = out.dataKey == null ? null : String(out.dataKey);
    out.cursorKey = out.cursorKey == null ? null : String(out.cursorKey);
    out.cursorRev = Math.max(0, Math.round(num(out.cursorRev)));

    /* —— 筛选栏面板的收敛 ——
       ⚠️ `editorCategory` 与「当前选中的类别」是**两个不同的东西**：
          前者是"面板在为哪个类型编辑"，后者是"列表在筛哪个类型"。
          面板只该为**当前选中的**那个类型编辑（否则用户会在 A 的高亮下
          改到 B 的源，而界面上没有任何东西提示这件事）。
       ⇒ 一旦当前类别变了，面板要么跟着走、要么关掉。这里选**关掉**：
          跟着走会让用户"点了另一个类型，面板里的勾突然换了一批"，
          看起来像勾选丢了。关掉是唯一不会骗人的处置。 */
    out.editorOpen = !!out.editorOpen;
    out.editorSaving = !!out.editorSaving;
    /* ⚠️ 面板的偏好档位覆盖 `categories` 里的那一份（见 createView 的说明）：
       两者都是"这个类型的态度"，而面板那份更新（用户刚点的就是这个）。 */
    if (out.editorOpen && out.editorPref != null) {
      var prefWant = num(out.editorPref);
      out.categories = out.categories.map(function (c) {
        if (c && String(c.id) === String(out.activeCategory) && num(c.pref) !== prefWant) {
          var nc = {};
          for (var kk in c) if (Object.prototype.hasOwnProperty.call(c, kk)) nc[kk] = c[kk];
          nc.pref = prefWant;
          return nc;
        }
        return c;
      });
    }
    out.editorSources = arr(out.editorSources).filter(function (s) {
      return s && typeof s === 'object' && s.id != null;
    });
    out.editorSelected = arr(out.editorSelected).map(String);
    if (out.editorCategory != null) out.editorCategory = String(out.editorCategory);
    /* 面板开着一个**已经不存在**的类别（被删掉了）⇒ 关掉它。
       ⚠️ 判据用"类别表非空"（与上面 activeCategory 的收敛同一口径）：
          启动瞬间类别表还是空的，这时关掉用户刚开的面板就是"点了又自己关"。
       ⚠️ "全部"（activeCategory = null）**没有**可编辑的东西（它不是一个真类别）
          ⇒ 面板跟着关掉，而 card.js 里的入口按钮在那个状态下本来也不显示。 */
    if (out.categories.length && out.editorOpen) {
      if (out.activeCategory == null) out.editorOpen = false;
      else if (out.editorCategory != null && out.editorCategory !== String(out.activeCategory)) {
        out.editorOpen = false;
      }
      if (out.editorOpen) {
        var stillThere = false;
        for (var ci = 0; ci < out.categories.length; ci += 1) {
          if (String(out.categories[ci].id) === String(out.activeCategory)) { stillThere = true; break; }
        }
        if (!stillThere) out.editorOpen = false;
      }
    }
    /* ⚠️ 关面板也要把「添加源」那一行收起来：下次打开时
           一个空输入框留在那里，用户会以为"上次没加成功"。 */
    if (!out.editorOpen) { out.addSourceOpen = false; out.addSourceBusy = false; }
    out.addSourceOpen = !!out.addSourceOpen;
    out.addSourceBusy = !!out.addSourceBusy;
    if (out.pendingDelete != null) out.pendingDelete = String(out.pendingDelete);

    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 转移表：每个动作**只写自己那一格字段**                                */
  /* ------------------------------------------------------------------ */
  var REDUCERS = {
    /** 生命周期：进入/离开加载中 */
    loading: function (v, a) {
      var on = !!a.on;
      if (on) return copy(v, { phase: 'loading', error: null });
      return copy(v, { phase: v.phase === 'error' ? 'error' : 'ready' });
    },

    /** 取数成功 —— **一次写入整份数据面**，不做增量猜测 */
    data: function (v, a) {
      var p = a.payload || {};
      /* 乱序保护：晚到的旧响应不许覆盖新响应 */
      if (a.seq != null && num(a.seq) < v.dataSeq) return v;
      /* ★ 身份：调用方（card.js）在发请求前捕获的 fetchKey。
         缺省不写 ⇒ 见 sameKey 的说明。 */
      var forKey = a.forKey == null ? null : String(a.forKey);
      return copy(v, {
        items: arr(p.items),
        cursor: p.nextCursor == null ? null : p.nextCursor,
        hasMore: !!p.hasMore,
        /* ★★ items 与 cursor **同时**换主人：这一份数据整体属于 `forKey`。
           代次 +1 ⇒ 任何还在途的翻页请求（带着旧代次回来）都会被拒。 */
        dataKey: forKey,
        cursorKey: forKey,
        cursorRev: v.cursorRev + 1,
        categories: arr(p.categories).length ? p.categories : v.categories,
        todayTotal: p.todayTotal != null ? p.todayTotal : v.todayTotal,
        filteredTotal: p.filteredTotal != null ? p.filteredTotal : v.filteredTotal,
        /* ⚠️ `curated` 只认服务端**独立**给出的口径值。
           旧代码把它写成"本次请求的 limit"，于是按钮把自己藏了起来（病 1）。
           现在：服务端不再回显 limit，渲染层也不再拿它当结果。 */
        curated: p.curated != null ? p.curated : v.curated,
        health: p.health === undefined ? v.health : p.health,
        lastIngestAt: p.lastIngestAt === undefined ? v.lastIngestAt : p.lastIngestAt,
        lastSuccessAt: p.lastSuccessAt === undefined ? v.lastSuccessAt : p.lastSuccessAt,
        fetchedToday: p.fetchedToday === undefined ? v.fetchedToday : !!p.fetchedToday,
        sinceIso: p.sinceIso === undefined ? v.sinceIso : p.sinceIso,
      ai: p.ai === undefined ? v.ai : p.ai,
      briefView: p.briefView === undefined ? v.briefView : p.briefView,
      unreadToday: p.unreadToday === undefined ? v.unreadToday : (Number(p.unreadToday) || 0),
        /* 服务端若知道"用户上次选的类别"而本地还没选，采纳它；否则尊重本地 */
        activeCategory: v.activeCategory == null ? (p.activeCategory == null ? null : p.activeCategory) : v.activeCategory,
        /* 取数回来 ⇒ 撤销"等你再点一次删除"（用户不点就等于放弃，别让一个
           危险按钮在那里等着，几秒后回来点一下就删了）。 */
        pendingDelete: null,
        phase: 'ready',
        error: null,
        dataSeq: a.seq != null ? Math.max(v.dataSeq, num(a.seq)) : v.dataSeq,
      });
    },

    /**
     * 取数失败。
     *
     * ★★ 一致性收敛（第三轮返工的第二个根因）。
     * 光写 `{phase:'error'}` 是不够的：`items` / `cursor` / `hasMore` /
     * `filteredTotal` 全都留着上一次查询的值，于是**内容轴与筛选轴各自独立地变**：
     *   点了「AI」→ 取数失败 → chip 高亮是 AI、总览句写着「显示 15 条（AI）」、
     *   而列表里那 15 条其实是**无筛选**的首页那批。
     *   三个信号互相矛盾，用户无法自证；刷新也救不回来（refresh 只换 forceToken，
     *   失败会再次走到同一分支）。
     *
     * ⇒ 判据只有一条：**展示中的内容与当前请求身份是否同源**（`dataKey === forKey`）。
     *   · 不同源 ⇒ 这份内容已经不能代表界面上的口径了，**必须清掉**，
     *     让 `d.empty` 变真、由 card.js 的 error 分支给出"读取失败 + 重试"提示。
     *     （那条分支早就写好了，只是从来没有状态能走到它。）
     *   · 同源（例如"刷新"失败）⇒ 内容仍然对应当前口径，如实保留 ——
     *     总览句用 `d.activeChip.name` 标注它才是**正确**的。
     *   「两者选一，不能都要」：这里选的是"不同源就清"，因为错误态下
     *   保留一批不能代表当前口径的数据，比空着更容易骗人。
     */
    error: function (v, a) {
      var patch = { phase: 'error', error: String((a && a.message) || '未知错误'), cursorRev: v.cursorRev + 1 };
      if (!sameKey(v.dataKey, a && a.forKey != null ? String(a.forKey) : null)) {
        patch.items = [];
        patch.cursor = null;
        patch.hasMore = false;
        patch.todayTotal = 0;
        patch.filteredTotal = 0;
        patch.dataKey = null;
        patch.cursorKey = null;
      }
      return copy(v, patch);
    },

    /**
     * 翻页成功：**追加**（唯一允许追加的地方）。
     *
     * ★★ 两道准入条件，各拦一类脏追加（少一道就会漏掉一整类）：
     *
     *   ① `a.forKey === v.dataKey` —— 请求**声明的语境**必须还是当前 items 的出处。
     *      这是本轮 blocker 的直接形态：`cursor` 来自 fetchKey `15|*|all|1`、
     *      而请求声明的是 `15|2|all|1`；在途期间用户又点了「开源」，
     *      等结果回来时 `v.dataKey` 已经是 `15|2|all|1` —— 与 `a.forKey` 相同，
     *      所以①**放行**。⇒ 必须有②。
     *   ② `a.forRev === v.cursorRev` —— 这次追加必须**还落在发起它的那个游标上**。
     *      语境切换、刷新、失败都会推进代次，于是带着旧代次回来的追加一律被拒。
     *
     * ⚠️ 为什么不能只留②：像"换类别又切回同一类别、期间恰好有一次同 key 的取数"
     *    这类交错，代次可能刚好又对上了 —— 那时只有①能拦住。
     * ⚠️ 为什么不能只留①：①比的是"当前值 vs 声明值"，而游标是**另一份状态**：
     *    语境切回来之后①两边相等，脏游标就进来了。
     * ⚠️ 也**不许**把①写成"比当前 fetchKey" —— 那等于拿一个值和它自己比，
     *    永远为真、一条断言都咬不住（第一版就是这么写的，离线考裁判当场指出来了）。
     * ⚠️ 兼容：老的调用方不带 forKey/forRev ⇒ 按旧行为放行。
     */
    moreData: function (v, a) {
      var p = a.payload || {};
      if (a.forKey != null && !sameKey(a.forKey, v.dataKey)) return v; // ① 语境已换
      if (a.forRev != null && Math.round(num(a.forRev)) !== v.cursorRev) return v; // ② 游标已被换掉
      return copy(v, {
        items: v.items.concat(arr(p.items)),
        cursor: p.nextCursor == null ? null : p.nextCursor,
        hasMore: !!p.hasMore,
        /* 新游标是本次追加的产物 ⇒ 代次再 +1（下一次翻页要落在它上面） */
        cursorRev: v.cursorRev + 1,
      });
    },

    /** 窗口展开/收起 —— 只改这一个字段（不影响查询口径） */
    expand: function (v, a) {
      return copy(v, { expanded: !!a.on });
    },

    /** 数据口径开关 —— 只改这一个字段（不影响窗口、不影响类别） */
    toggleAll: function (v) {
      return copy(v, { showingAll: !v.showingAll });
    },

    /** 显式设定口径（测试与快捷键用） */
    setShowingAll: function (v, a) {
      return copy(v, { showingAll: !!a.on });
    },

    /** 选类别（**幂等**：点已选中的那一项不会取消它）。
     *
     * ⚠️ 这一条是"顺序无关"的关键修正之一。旧版是 toggle：
     *    点同一个 chip 第二次会取消选择 —— 于是"点 AI → 点全部 → 点 AI"
     *    与"点 AI → 点 AI → 点全部"结果不同，用户无法预测。
     *    改成幂等之后，chip 的语义就是**纯粹的选择**：
     *    同一目标点几次结果都一样（`f(f(x)) = f(x)`）。
     *    "取消筛选"由第一项「全部」显式承担 —— 它永远在导轨最左边。 */
    setCategory: function (v, a) {
      return copy(v, { activeCategory: a.id == null ? null : String(a.id) });
    },

    /** 按序号选类别（滑动条用）—— 语义与 setCategory 不同：**不取消** */
    setCategoryIndex: function (v, a) {
      var idx = Math.max(0, Math.round(num(a.index)));
      if (idx === 0) return copy(v, { activeCategory: null });
      var c = v.categories[idx - 1];
      return copy(v, { activeCategory: c ? String(c.id) : v.activeCategory });
    },

    /** 新增类别成功后并入（保持当前选择不变） */
    categories: function (v, a) {
      return copy(v, { categories: arr(a.list) });
    },

    /* ------------------------------------------------------------------
     * 筛选栏编辑面板（本次功能）
     *
     * ★ 为什么这一组要住在状态机里，而不是 card.js 的临时变量里：
     *   面板的每一个可见结果（勾了几个源、哪个档位亮着、删除按钮是不是
     *   在等你再点一次）都必须是**状态的函数**。写成 DOM 里的临时变量，
     *   就又回到"每个处理器自己改一处、顺序不同结果不同"那条老路上去了
     *   —— 那正是第三轮返工花了一整轮才拆掉的东西。
     * ------------------------------------------------------------------ */

    /* ---------------- AI 设置面板（本次功能） ----------------
     * ⚠️⚠️ 这里**刻意没有** aiKeyDraft 之类的字段：
     *    Key 输入框的内容只活在 DOM 里，绝不进 view 状态。
     *    理由不是洁癖 —— 状态对象会被诊断自检**整个打出来**（见 card.js 末尾的快照），
     *    把 Key 放进状态等于顺手写进日志，而 R-E05 要求它一步都不许离开主进程那一侧。
     *    ⇒ 点「保存」时才现读 input.value。 */
    openAi: function (v) {
      return copy(v, { aiPanelOpen: true, aiBusy: '', aiMsg: null });
    },
    closeAi: function (v) {
      return copy(v, { aiPanelOpen: false, aiBusy: '', aiMsg: null });
    },
    /** 面板里「正在忙」与「上一次的结果」——两者都要有，否则用户点了不知道在等什么 */
    aiBusy: function (v, action) {
      return copy(v, { aiBusy: String((action && action.what) || ''), aiMsg: null });
    },
    aiMsg: function (v, action) {
      var m = (action && action.msg) || null;
      return copy(v, {
        aiBusy: '',
        aiMsg: m ? { ok: !!m.ok, text: String(m.text || '') } : null,
      });
    },

    /** 打开面板：把**当前选中的类型**作为编辑对象（绝不为别的类型开） */
    openEditor: function (v) {
      if (v.activeCategory == null) return v; // 「全部」不是一个类型，没有可编辑的东西
      var cur = null;
      for (var i = 0; i < arr(v.categories).length; i += 1) {
        if (String(v.categories[i].id) === String(v.activeCategory)) { cur = num(v.categories[i].pref); break; }
      }
      return copy(v, {
        editorOpen: true,
        editorCategory: String(v.activeCategory),
        /* 打开时清掉上一次的残留：勾选与源清单都还没读到，
           留着上一次的会让用户看到"另一个类型的勾"闪一下。 */
        editorSelected: [],
        editorSources: [],
        editorPref: cur,
        editorSaving: false,
        pendingDelete: null,
      });
    },

    closeEditor: function (v) {
      return copy(v, {
        editorOpen: false,
        editorSaving: false,
        pendingDelete: null,
        editorPref: null,
        /* ⚠️ 关面板也要把「添加源」那一行收起来：下次打开时
           一个空输入框留在那里，用户会以为"上次没加成功"。 */
        addSourceOpen: false,
        addSourceBusy: false,
      });
    },

    /** 面板数据到位（主进程回的源清单 + 该类型当前绑定的源） */
    editorData: function (v, a) {
      return copy(v, {
        editorSources: arr(a.sources),
        editorSelected: arr(a.sourceIds).map(String),
        editorSaving: false,
      });
    },

    /**
     * 勾选 / 取消勾选一个源。
     *
     * ⚠️ **保存中不许再改**（`editorSaving`）：两次写会互相覆盖 ——
     *    后写的那次赢，而用户看到的是自己最后点的那个结果，
     *    两者一致只是巧合。真正危险的是"第一次写返回失败"那条路径：
     *    界面已经把第二次的勾画上了，于是用户以为成了。
     */
    editorToggleSource: function (v, a) {
      if (!v.editorOpen || v.editorSaving) return v;
      if (v.editorCategory == null || String(v.editorCategory) !== String(v.activeCategory)) return v;
      var id = a.id == null ? null : String(a.id);
      if (id == null) return v;
      var next = [];
      var had = false;
      for (var i = 0; i < v.editorSelected.length; i += 1) {
        if (v.editorSelected[i] === id) { had = true; continue; }
        next.push(v.editorSelected[i]);
      }
      if (!had) next.push(id); // 取消勾选 = 从数组里摘掉（可逆：再勾一次就回来）
      next.sort();
      return copy(v, { editorSelected: next });
    },

    /** 设置偏好档位（1 喜欢 / 0 中性 / -1 不喜欢）—— 只改本地，持久化由调用方发起 */
    editorPref: function (v, a) {
      if (!v.editorOpen || v.editorSaving) return v;
      if (v.editorCategory == null || String(v.editorCategory) !== String(v.activeCategory)) return v;
      var p = Number(a.pref);
      if (p !== 1 && p !== 0 && p !== -1) return v; // 三档之外一律无操作（不夹取、不猜测）
      var list = arr(v.categories).map(function (c) {
        if (c && String(c.id) === String(v.activeCategory)) {
          var n = {};
          for (var k in c) if (Object.prototype.hasOwnProperty.call(c, k)) n[k] = c[k];
          n.pref = p;
          return n;
        }
        return c;
      });
      /* ⚠️ 两份都要写（见 createView 里 editorPref 的说明）：
         categories 那份给 chip 用，editorPref 那份给面板用，
         少写一份会出现"chip 上是不喜欢、面板里还是中性"这种自相矛盾的界面。 */
      return copy(v, { categories: list, editorPref: p });
    },

    /** 面板进入/离开"保存中"（保存期间禁用整块控件） */
    editorSaving: function (v, a) {
      return copy(v, { editorSaving: !!a.on });
    },

    /** 「＋ 添加源」：开/关那一行输入（顺带清掉上一次的忙碌态） */
    addSourceToggle: function (v, a) {
      if (!v.editorOpen) return v;
      var on = a && a.on != null ? !!a.on : !v.addSourceOpen;
      return copy(v, { addSourceOpen: on, addSourceBusy: false });
    },

    /** 正在验证一个 feed 地址（主进程要先抓一次，可能几秒） */
    addSourceBusy: function (v, a) {
      return copy(v, { addSourceBusy: !!a.on });
    },

    /**
     * 删除的**二次确认**。
     *
     * ⚠️ 为什么必须是两步：删除类型是不可逆的（虽然条目不会跟着走）。
     *    一次点击就删掉的话，误触的代价是"我辛苦分的类没了"；
     *    而弹一个系统确认框（`dialog`/`confirm`）在这个无边框小卡片上
     *    既突兀又不可控（`window.confirm` 在 Electron 渲染进程里同样不可靠，
     *    与当初 `window.prompt` 那个坑同源）。
     * ⇒ 就地两步：第一次点进入"等你再点一次"，同一个按钮上的文字变成
     *   「确认删除」。再点才真的删；点别处（任何其它动作）就撤销。
     */
    askDelete: function (v) {
      if (!v.editorOpen) return v;
      if (v.activeCategory == null) return v;
      return copy(v, { pendingDelete: String(v.activeCategory) });
    },
    cancelDelete: function (v) {
      return copy(v, { pendingDelete: null });
    },

    /** 删除完成（主进程确认了）：并入最新的类别表，并关掉面板 */
    categoryDeleted: function (v, a) {
      return copy(v, {
        categories: arr(a.list),
        /* ★ 当前选中的类型被删掉了 ⇒ 回到「全部」。
           不做这一步的话，activeCategory 会指向一个不存在的 id，
           随后 normalize 虽然会清掉它，但中间的取数会用那个 id 查一次空 ——
           用户看到的是一次莫名其妙的"这个口径下没有条目"。 */
        activeCategory: a.removedId != null && String(v.activeCategory) === String(a.removedId) ? null : v.activeCategory,
        editorOpen: false,
        editorCategory: null,
        editorSelected: [],
        editorSources: [],
        editorPref: null,
        editorSaving: false,
        pendingDelete: null,
      });
    },

    /** 强制重取（刷新按钮 / 主进程推来更新） */
    invalidate: function (v) {
      return copy(v, { forceToken: v.forceToken + 1, pendingDelete: null });
    },
  };

  /**
   * 唯一合法的状态转移。**全函数**：未知动作原样返回。
   * @param {object} view
   * @param {{type:string}} action
   */
  function reduce(view, action) {
    var v = view && typeof view === 'object' ? view : createView();
    if (!action || typeof action.type !== 'string') return normalize(v);
    var fn = Object.prototype.hasOwnProperty.call(REDUCERS, action.type) ? REDUCERS[action.type] : null;
    if (!fn) return normalize(v); // I4：未知动作 = 无操作
    return normalize(fn(v, action));
  }

  /* ------------------------------------------------------------------ */
  /* 派生层：**只读**。界面上的每一个字、每一个 hidden 都在这里决定          */
  /* ------------------------------------------------------------------ */

  /**
   * 取数身份。**刻意不含 expanded** —— 窗口大小不该引发网络请求（病 3）。
   * 相同 = 本地已有这份数据，可以跳过。
   *
   * ⚠️⚠️ 它是 fetch 口径的**唯一**实现，`derive` 必须调它、不许另写一份。
   *    理由不是洁癖：本轮返工第一版就是在 `derive` 里另算了一遍 limit/categoryIds，
   *    于是"翻页游标的出处标签"与"实际发出去的查询"成了两个可以各自漂移的副本。
   *    离线考裁判当场把这件事指了出来 —— 它有两个变异体是往这段源码里插的
   *    （"fetchKey 掺进 expanded"、"收起时 limit 减半"），
   *    另写一份之后那两个变异体**一个字都没被改到**，直接存活。
   *    ⇒ 保持单一实现，考裁判的靶子才在。
   */
  function fetchPlan(v) {
    var n = normalize(v);
    var allMode = n.showingAll;
    return {
      limit: allMode ? ALL_LIMIT : n.curated,
      categoryIds: n.activeCategory == null ? null : [String(n.activeCategory)],
      /* ★ 「看今天全部」必须**真的**只取今天 ——
         按钮上写着"（N）"而 N 是当日总数；查询不按日期收口的话，
         点下去会翻出前几天的条目，用户会认为"筛选是坏的"。
         精选模式刻意**不**收口：今天还没抓到时卡片也不该空着。 */
      todayOnly: allMode,
    };
  }

  /** 取数身份字符串。与 fetchPlan 同源（同一份 limit/categoryIds/todayOnly）。 */
  function fetchKeyOf(view) {
    var n = normalize(view);
    var f = fetchPlan(n);
    return (
      f.limit + '|' +
      (f.categoryIds ? f.categoryIds.join(',') : '*') + '|' +
      (f.todayOnly ? 'today' : 'all') + '|' +
      num(n.forceToken)
    );
  }

  function headlineOf(view, d) {
    if (d.empty) {
      if (view.phase === 'loading') return { text: '正在读取…', empty: true };
      if (view.phase === 'error') return { text: '读取失败：' + (view.error || '未知错误'), empty: true };
      return {
        text: view.lastIngestAt
          ? '这个口径下今天还没有条目。点「刷新」再拉一次，或换个类型看看。'
          : '还没有抓取过。点右下「刷新」拉一次。',
        empty: true,
      };
    }
    var parts = ['显示 ' + d.shown + ' 条'];
    var cat = d.activeChip && d.activeChip.id != null ? d.activeChip.name : null;
    if (cat) parts[0] += '（' + cat + '）';
    /* ★★ L1（总览一句话）—— 简报视图下，AI 写的那句话**排在最前面**。
       ⚠️ 三种「没有摘要」的情况都必须**如实说出来**，而不是安静地少一句话：
          · 没配 Key        → 告诉他在哪配（否则他永远不知道有这个功能）；
          · 降级（fallback）→ 说清这不是 AI 挑的（完整原因挂在 tooltip 上，不塞满这一行）；
          · 还没生成        → 同上，短标记。 */
    var ai = view.ai || null;
    var brief = ai && ai.brief;
    var lead = '';
    if (brief && brief.headline) lead = brief.headline;
    else if (ai && ai.key && !ai.key.configured) lead = '未配置 API Key（点 ⚙ 设置）';
    else if (brief && brief.status === 'fallback') {
      /* ★ P1：降级**不能只挂 tooltip** —— 用户不会去悬停，于是既不知道今天这份不是 AI 挑的，
         也不知道是不是自己 Key 没钱了。把原因的前半句直接写在总览句里（完整原因仍在 tooltip）。
         取「——」之前那一段：classifyFailure 的文案都是「短结论——怎么办」这个形状。 */
      var why = String(brief.detail || '').split('——')[0].trim().slice(0, 24);
      lead = '⚠ ' + (why || '摘要没生成');
    }
    if (lead) parts.unshift(lead);
    parts.push((view.showingAll ? '今天全部 ' : '今天共 ') + d.filteredTotal + ' 条');
    var older = Math.max(0, d.shown - d.filteredTotal);
    if (older > 0) parts.push('另含更早 ' + older + ' 条');
    /* ★ P1：未读计数。原来点过的条目只会变暗（.item[data-read=opened]），
       但**没有任何地方汇总** —— 用户没法回答「今天还有几条没看」。 */
    var unread = num(view.unreadToday);
    if (unread > 0) parts.push('还有 ' + unread + ' 条没看');
    var bad = num(view.health && view.health.bad);
    if (bad > 0) parts.push(bad + ' 个源异常');
    /* ★★ 今天一次都没抓成功时，**必须说出来**。
     *
     * ⚠️ 这一句是"全网断了一天，界面却一切正常"的唯一破绽：
     *    抓取全失败时库里还有昨天的条目，`todayTotal` 也照常算得出来，
     *    于是上面那串数字看起来完全正常 —— 用户不会知道内容不是今天的。
     *    调度器那边已经在退避重试了（见 scheduler.js 的 nextRunPlan），
     *    界面这边只需要**如实告诉他正在重试**，让他别以为程序坏了。
     *
     * ⚠️ 只在"有内容可看"时才挂这一句（空列表的文案已经说了抓取的事），
     *    否则同一件事会说两遍。 */
    if (view.fetchedToday === false) parts.push('今天还没抓到，正在自动重试');
    return { text: parts.join(' · ') + '。', empty: false };
  }

  /**
   * 把状态投影成"界面该长什么样"。**没有任何副作用、不做 I/O、不读 DOM。**
   * 因此它可以被离线测试穷举 —— 这是顺序无关性能被证明的前提。
   */
  function derive(view) {
    var v = normalize(view);
    var curatedLimit = v.curated;
    var shown = v.items.length;
    var filteredTotal = v.filteredTotal;
    var allMode = v.showingAll;

    /* —— 类别 chips：**永远存在**，与窗口状态、与数据多少都无关 ——
       （真机反馈"收起后类型选项消失"：那是 CSS 把 .filters 在收起态设成
         display:none 造成的。现在 chips 的**存在性**由这里保证，
         收起态只允许压缩它的高度，不允许把它拿掉。） */
    var chips = [{ id: null, name: '全部', on: v.activeCategory == null, custom: false, pref: 0 }];
    for (var i = 0; i < v.categories.length; i += 1) {
      var c = v.categories[i];
      chips.push({
        id: String(c.id),
        name: String(c.name == null ? '' : c.name),
        on: v.activeCategory === String(c.id),
        custom: true,
        /* ★ 偏好随 chip 一起给出去（本次功能）：界面上要能一眼看出
           "这个类型是我不喜欢的"，否则用户设完就再也看不到它 ——
           而"设了看不见"与"没设"在用户眼里完全一样。 */
        pref: num(c.pref),
      });
    }
    var activeIndex = 0;
    for (var k = 0; k < chips.length; k += 1) if (chips[k].on) { activeIndex = k; break; }

    var remaining = Math.max(0, filteredTotal - shown);
    var canShowAll = filteredTotal > curatedLimit;
    /* I1 自持性：已经在"全部"模式里就永远可见 —— 否则用户退不回来 */
    var allVisible = canShowAll || allMode;
    /* I2 非自指：只看 (filteredTotal, curatedLimit, hasMore)，**不看 shown** */
    var moreVisible = v.hasMore || filteredTotal > curatedLimit;

    /* ★★ 翻页语境是否自洽（本轮 blocker 的修法，见 createView 里 dataKey/cursorRev 的说明）：
       只有当 cursor 确实是**当前这份 fetch 身份**产出的，翻页才有意义。
       `fetchKey(view)` 在换类别 / 切口径 / invalidate 之后都会变 ⇒
       游标立刻失配 ⇒ 按钮变灰（而不是"点得出脏数据"）。
       ⚠️ 光靠 card.js 里的 moreKey 守卫不够：那个守卫是在语境**已经切走之后**
          才采样的，两次采样必然相等 ⇒ 抓不住 payload 自相矛盾的情况。 */
    var cursorValid = !!v.cursor && !!v.cursorKey && sameKey(v.cursorKey, fetchKeyOf(v));

    var d = {
      phase: v.phase,
      expanded: v.expanded,
      allMode: allMode,
      shown: shown,
      todayTotal: v.todayTotal,
      filteredTotal: filteredTotal,
      curatedLimit: curatedLimit,
      remaining: remaining,
      empty: shown === 0,
      stale: v.phase === 'loading' && shown > 0,
      chips: chips,
      activeChip: chips[activeIndex],
      activeIndex: activeIndex,
      /* ★ 翻页语境的出处：调用方（card.js）拿它**在发请求前**捕获，
         并把它原样带回来给 `data` / `moreData` / `error` 做身份校验。
         没有它，payload 就可能"游标来自旧查询、筛选项来自新查询"。 */
      fetchKey: fetchKeyOf(v),
      cursorValid: cursorValid,
      slider: {
        visible: true,
        min: 0,
        max: Math.max(0, chips.length - 1),
        value: activeIndex,
        disabled: chips.length <= 1,
        label: chips[activeIndex] ? chips[activeIndex].name : '全部',
        hint: chips.length > 1 ? '拖动切换类型' : '还没有更多类型',
      },
      buttons: {
        more: {
          visible: moreVisible,
          /* ★ 可点 = 有下一页 **且** 游标与当前语境同源（见 cursorValid）。
             换类别/切口径之后按钮立刻变灰，用户看到的是"现在翻不了"，
             而不是"点了翻出一批错类别的条目"。 */
          enabled: !!v.hasMore && cursorValid,
          disabled: !(v.hasMore && cursorValid),
          /* 文案区分两种"不可点"：已全部展开 / 正在切换语境 */
          label: !v.hasMore
            ? '已全部展开'
            : !cursorValid
              ? '展开更多（正在读取…）'
              : remaining > 0
                ? '展开更多（还有 ' + remaining + '）'
                : '展开更多（更早的）',
        },
        all: {
          visible: allVisible,
          enabled: allVisible,
          label: allMode ? '只看精选' : '看今天全部（' + filteredTotal + '）',
          primary: !allMode,
        },
        collapse: { visible: v.expanded, enabled: v.expanded },
        refresh: { visible: true, enabled: v.phase !== 'loading' },
      },
      health: v.health,
      lastIngestAt: v.lastIngestAt,
    };
    d.headline = headlineOf(v, d);

    /* ---------------- AI 设置面板（本次功能） ----------------
     * ★ 面板里每一个可见结果都在这里决定（与筛选栏编辑面板同一条规矩），
     *   只有 Key 输入框的内容例外 —— 它**故意**不在这里（见 REDUCERS.openAi 的说明）。 */
    var aiState = v.ai || null;
    d.aiPanel = {
      open: !!v.aiPanelOpen,
      busy: String(v.aiBusy || ''),
      msg: v.aiMsg || null,
      key: (aiState && aiState.key) || { configured: false, maskedTail: '', mode: null, encryption: true, broken: false },
      config: (aiState && aiState.config) || { endpoint: '', model: '', pickCount: 10 },
      usage: (aiState && aiState.usage) || { total: 0, knownBriefs: 0, unknownBriefs: 0, briefs: 0 },
      brief: (aiState && aiState.brief) || null,
      lastBriefDate: (aiState && aiState.lastBriefDate) || '',
    };

    /* —— 筛选栏编辑面板（本次功能）——
     * ★ 面板的**每一个**可见结果都在这里决定（没有一个字来自 card.js 里的临时变量）：
     *     open      要不要显示
     *     sources   勾选框的清单与勾选状态
     *     pref      三档里哪一档亮着
     *     delete    按钮文案（第一次「删除类型」/ 第二次「确认删除」）
     *   这样"点了没反应""点了两次结果不同"这两类问题在**状态层**就不可能存在，
     *   而不是靠 DOM 那边小心一点。 */
    var editingChip = null;
    if (v.editorOpen && v.activeCategory != null) {
      for (var ei = 0; ei < chips.length; ei += 1) {
        if (chips[ei].id === String(v.activeCategory)) { editingChip = chips[ei]; break; }
      }
    }
    var selSet = {};
    for (var si = 0; si < v.editorSelected.length; si += 1) selSet[v.editorSelected[si]] = true;
    d.editor = {
      visible: !!editingChip,
      categoryId: editingChip ? editingChip.id : null,
      categoryName: editingChip ? editingChip.name : '',
      /* 勾选框：**按源名排序**（而不是按 id）。
         源表是按 id 排的（= 登记顺序），对用户没有意义；他要找的是"某个站"。 */
      sources: v.editorSources
        .slice()
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'); })
        .map(function (s) {
          var sid = String(s.id);
          return {
            id: sid,
            name: String(s.name == null ? '' : s.name),
            selected: !!selSet[sid],
            /* 已停用的源仍然列出来（用户可以勾，但它不会被抓）——
               直接藏掉的话，用户会以为"这个源不见了"，而真相是它被停用了。 */
            enabled: s.enabled !== false,
            bad: !!s.lastStatus && s.lastStatus !== 'ok',
            title: (s.enabled === false ? '已停用（不会被抓取）' : '') + (s.lastError ? '　上次失败：' + s.lastError : ''),
          };
        }),
      selectedCount: v.editorSelected.length,
      loading: v.editorSources.length === 0,
      saving: !!v.editorSaving,
      pref: editingChip ? num(editingChip.pref) : 0,
      /* 三档的文案与"亮没亮"都在这里定，card.js 只负责照着画 */
      prefOptions: [
        { value: 1, label: '喜欢', hint: '多放' },
        { value: 0, label: '中性', hint: '正常参与' },
        { value: -1, label: '不喜欢', hint: '少放但不会没有' },
      ],
      /* ⚠️ 提示必须短到**一行装得下**（343px 宽）。
         它折成两行就会把「删除类型」挤出面板可视区 —— 真机上量到过
         （面板内容 397px，可视只有 155px）。三档的含义直接写在
         每个按钮的 title 里（悬停可读），这里只留最短的一行。
         ⚠️ 仍然要说清"在「全部」里"：配额随筛选范围的占比缩放，
            点进这个类型本身时不再受这个数限制（见 shared/quota.js）。 */
      prefHint: '不喜欢：少放但不会没有（「全部」里最多 ' + quotaOf(curatedLimit) + ' 条）',
      /* 删除：二次确认由状态承担（见 REDUCERS.askDelete 的说明） */
      deleting: v.pendingDelete != null && String(v.pendingDelete) === String(v.activeCategory),
      deleteLabel: v.pendingDelete != null && String(v.pendingDelete) === String(v.activeCategory) ? '确认删除' : '删除类型',
      /* 「＋ 添加源」（阶段 A）：输入行自己可折叠，忙碌时整块禁用。
         ⚠️ 忙碌态文案要说清"正在验证" —— 主进程会真的抓一次这个地址，
            可能要几秒；不说明的话用户会以为点了没反应，然后连点。 */
      addSource: {
        open: !!v.addSourceOpen,
        busy: !!v.addSourceBusy,
        toggleLabel: v.addSourceOpen ? '收起' : '＋ 添加源',
        placeholder: '粘贴 feed 地址（RSS/Atom）',
        hint: v.addSourceBusy
          ? '正在验证这个地址…（会真的抓一次，可能要几秒）'
          : '只支持 RSS / Atom。加进来的源只属于当前这个类型。',
      },
    };
    /* 面板的入口按钮：只为**一个真实的类型**出现（「全部」不是类型，没有可编辑的东西） */
    d.editorButton = { visible: v.activeCategory != null, open: d.editor.visible };

    /* —— 查询参数：**唯一**的取数口径来源 ——
       ⚠️ 必须是 fetchPlan 的结果，不许在这里另算一份（理由见 fetchPlan 的说明：
          另写一份会让考裁判的两个变异体失去靶子，而且两处可以各自漂移）。 */
    d.fetch = fetchPlan(v);
    d.sinceIso = v.sinceIso;
    return d;
  }

  /**
   * 取数身份。**刻意不含 expanded** —— 窗口大小不该引发网络请求（病 3）。
   * 相同 = 本地已有这份数据，可以跳过。
   */
  function fetchKey(view) {
    return fetchKeyOf(view);
  }

  /**
   * 翻页身份：换口径 / 换类别 / 换日期边界 / 刷新之后，翻页上下文就失效了。
   *
   * ⚠️ 它**必须**建立在 `fetchKeyOf` 之上，不许自己再拼一遍 limit/categoryIds ——
   *    同一段口径逻辑写两遍，就意味着两个副本可以各自漂移；而且考裁判的
   *    "fetchKey 掺进 expanded"那个变异体正是靠替换 `num(view.forceToken)` 生效的，
   *    文件里出现第二个一模一样的尾巴时，`String.replace` 只会改到**第一个**，
   *    于是变异体变成了"改 anotherKey 却什么都没抓到"的存活者。
   */
  function moreKey(view) {
    return 'more|' + fetchKeyOf(view) + '|' + String(view && view.sinceIso ? view.sinceIso : '-');
  }
  /* ------------------------------------------------------------------ */
  /* 出口（无条件赋值，不做环境探测 —— 探测失败是静默的）                    */
  /* ------------------------------------------------------------------ */
  global.MB_VIEW = {
    CURATED_DEFAULT: CURATED_DEFAULT,
    CURATED_MIN: CURATED_MIN,
    CURATED_MAX: CURATED_MAX,
    ALL_LIMIT: ALL_LIMIT,
    PAGE_LIMIT: PAGE_LIMIT,
    ACTION_TYPES: Object.keys(REDUCERS),
    clampCurated: clampCurated,
    quotaOf: quotaOf,
    createView: createView,
    reduce: reduce,
    derive: derive,
    normalize: normalize,
    fetchKey: fetchKey,
    moreKey: moreKey,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
