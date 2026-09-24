/**
 * tools/card-rig.mjs —— 把 `card.js` **原样**装进 node:vm 的取证装置
 * =====================================================================
 * 为什么必须有它（这是本项目第三轮返工里最贵的一课）：
 *
 *   本轮的 blocker 是"loadMore 把陈旧语境的 cursor 配上当前语境发出去"。
 *   单看 `loadMore` 是对的，单看 `moreKey` 守卫也是对的，单看 reducer 也是对的
 *   —— 错在**它们之间**，而且只在"切语境 + 在数据回来之前点一下"这个交错里现形。
 *   纯函数考裁判（test-interaction.mjs 的第一~三层）永远看不到这种 bug：
 *   它测的是 reducer，而 bug 住在 reducer 与 IPC 之间那段**顺序**里。
 *
 *   ⇒ 把 card.js 当成被测对象装进沙箱，IPC 换成可编排的假桥：
 *     每一笔请求都由测试决定**何时**、**以什么内容**返回，
 *     于是"点 A → 立刻点 B → 让 A 后回"这种排列可以被逐字重放。
 *
 * ⚠️ 装置必须诚实，否则会把正确行为当成 bug（我在这上面绕了三圈）：
 *   ① 结算请求必须等 boot() 跑完（否则在"用户还没点过"的假前提下取证）
 *   ② 结算必须取**最新**那一笔在途请求（合并循环会作废旧的并重发）
 *   ③ 造第二页数据必须**接续游标**（id 更小、时间更早）——
 *      随手自增 id 在真库里不可能出现，而 card.js 的衔接诊断会正确地拒掉它
 *   ④ 每一笔结算之后要留够事件循环时间（循环是 async 的，会再发一次请求）
 *
 * 依赖：只用 node 内置（fs / path / vm）。零运行时依赖是项目硬约束。
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.resolve(HERE, '..', 'src', 'renderer');

export const CARD_SRC = fs.readFileSync(path.join(RENDERER, 'card.js'), 'utf8');
export const VM_SRC = fs.readFileSync(path.join(RENDERER, 'view-model.js'), 'utf8');
export const INDEX_SRC = fs.readFileSync(path.resolve(HERE, '..', 'src', 'main', 'index.js'), 'utf8');

/** 测试用的类别表（与 test-interaction.mjs 的 CATS 同源） */
export const CATS = [
  { id: 1, name: 'AI' },
  { id: 2, name: '开源' },
  { id: 3, name: '行业' },
];

/* ------------------------------------------------------------------ */
/* 极简 DOM —— 只实现 card.js 真正用到的那几个面                        */
/* ------------------------------------------------------------------ */
function makeNode(tag) {
  /* ⚠️ `textContent` 的读法必须是**递归拼接后代文本**，与真 DOM 一致。
     第一版只返回节点自己写进去的那一份，于是"从容器上读面板的文案"永远得到空串 ——
     而那会让断言去改本来完全正确的 card.js（我在这上面误判过一次：
     面板明明渲染对了，断言却说"面板里没有标题"）。 */
  const collectText = (n) => {
    if (n.children.length === 0) return n._text;
    let s = n._text;
    for (const c of n.children) s += collectText(c);
    return s;
  };
  const n = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], parentNode: null,
    style: {}, dataset: {}, attrs: {}, handlers: {}, _text: '',
    hidden: false, disabled: false, tabIndex: 0, value: '0', min: '0', max: '0',
    type: '', id: '', className: '', title: '',
    offsetLeft: 0, offsetWidth: 40, clientWidth: 400, clientHeight: 100,
    scrollHeight: 100, scrollWidth: 400, scrollLeft: 0,
    classList: { add() {}, remove() {}, contains: () => false },
  };
  Object.defineProperty(n, 'textContent', {
    get() { return collectText(n); },
    set(v) { n._text = String(v); n.children.length = 0; },
  });
  Object.defineProperty(n, 'firstChild', { get() { return n.children[0] || null; } });
  n.appendChild = (c) => {
    /* ⚠️ 真 DOM 里 appendChild 一个 DocumentFragment 会把它的**子节点**搬进来，
       片段本身不留在树上。忘了这一步，列表看起来就只有 1 个孩子（一个片段），
       而那是装置的假象，不是 card.js 的问题 —— 我在这上面误判过一次。 */
    if (c && c.isFragment) {
      for (const k of c.children.slice()) { k.parentNode = n; n.children.push(k); }
      c.children.length = 0;
      return c;
    }
    c.parentNode = n;
    n.children.push(c);
    return c;
  };
  n.removeChild = (c) => { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); return c; };
  n.setAttribute = (k, v) => { n.attrs[k] = String(v); if (k === 'hidden') n.hidden = true; };
  n.getAttribute = (k) => (k in n.attrs ? n.attrs[k] : null);
  n.removeAttribute = (k) => { delete n.attrs[k]; if (k === 'hidden') n.hidden = false; };
  n.hasAttribute = (k) => k in n.attrs;
  n.addEventListener = (t, fn) => { (n.handlers[t] = n.handlers[t] || []).push(fn); };
  n.removeEventListener = () => {};
  n.fire = (t, ev) => {
    for (const h of n.handlers[t] || []) h(Object.assign({ type: t, preventDefault() {}, stopPropagation() {} }, ev || {}));
  };
  n.focus = () => {};
  n.contains = (o) => o === n || n.children.some((c) => c.contains && c.contains(o));
  n.getBoundingClientRect = () => ({ width: 400, height: 340, top: 0, left: 0, bottom: 340, right: 400 });
  return n;
}

const IDS = ['date', 'health', 'healthText', 'headline', 'filters', 'catSlider', 'catLabel', 'catPrev',
  'catNext', 'btnAddCat', 'btnEditCat', 'catPanel', 'list', 'foot', 'toast', 'btnMore', 'btnAll',
  'btnRefresh', 'btnCollapse', 'bar', 'grip', 'catbar'];

/* ------------------------------------------------------------------ */
/* 装置                                                                */
/* ------------------------------------------------------------------ */
/**
 * @param {string} [cardSrc] 覆盖 card.js 源码（变异测试用）
 */
export function makeRig(cardSrc) {
  const calls = [];
  const pending = [];
  const logs = [];
  const tracer = [];
  let nextId = 100;

  const byId = {};
  for (const id of IDS) { const n = makeNode('div'); n.id = id; byId[id] = n; }
  [['catSlider', 'input'], ['catPrev', 'button'], ['catNext', 'button'], ['btnAddCat', 'button'],
    ['btnEditCat', 'button'], ['btnMore', 'button'], ['btnAll', 'button'], ['btnRefresh', 'button'],
    ['btnCollapse', 'button'],
  ].forEach(([id, tag]) => { byId[id].tagName = tag.toUpperCase(); });
  /* ⚠️ 两个入口按钮在 card.html 里带 `hidden` —— 装置必须**照抄**这一点，
     否则"选中「全部」时编辑入口不出现"这条断言会基于一个假前提取证。 */
  byId.btnEditCat.setAttribute('hidden', 'hidden');

  const cardNode = makeNode('div');
  cardNode.className = 'card';
  /* ⚠️ `.card` 必须返回**同一个节点**（真 DOM 里本来就是同一个元素）。
     每次新建一个的话，"在节点上累计的量"会与另一端对不上 ——
     这里刚好有个例子：`panelBox()` 读的是 `document.querySelector('.card')`，
     而 `domSelfCheck` 读的是另一次调用的结果，两边必须是同一个元素才自洽。 */
  const document = {
    readyState: 'complete',
    documentElement: makeNode('html'),
    body: makeNode('body'),
    activeElement: null,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => makeNode(tag),
    createDocumentFragment: () => { const f = makeNode('fragment'); f.isFragment = true; return f; },
    querySelector: (sel) => (sel === '.card' ? cardNode : sel === '.foot' ? byId.foot : null),
    /* ⚠️ 只支持测试真正用到的两个选择器，其余返回空 —— 装置**宁缺毋滥**：
       一个"什么都匹配得上"的假 querySelector 会让 DOM 自检读出一堆假阳性。 */
    querySelectorAll: (sel) => {
      if (sel === '#filters .chip') return byId.filters.children;
      if (sel === '#filters .chip[role="radio"]') return byId.filters.children.filter((c) => c.getAttribute('role') === 'radio');
      if (sel === '#filters .chip[aria-checked="true"]') return byId.filters.children.filter((c) => c.getAttribute('aria-checked') === 'true');
      return [];
    },
    addEventListener: () => {},
  };

  const api = {
    log: (m) => logs.push(String(m)),
    brief: {
      get: (opts) => { calls.push({ kind: 'get', opts }); return new Promise((res, rej) => pending.push({ kind: 'get', opts, res, rej })); },
      more: (opts) => { calls.push({ kind: 'more', opts }); return new Promise((res, rej) => pending.push({ kind: 'more', opts, res, rej })); },
      onUpdated: () => {},
      /* ★ ingest 记下**两个**参数（本次改动：第二个是当前类型的 id 列表）。
         `brief:ingest` 带上当前类型是这个功能的一半 ——
         不带的话"我只想看安全类"与"刷新"之间仍然没有任何联系。 */
      ingest: async (trigger, categoryIds) => { calls.push({ kind: 'ingest', trigger, categoryIds }); return { newItems: 0 }; },
      createCategory: async (name) => { calls.push({ kind: 'createCategory', name }); return { ok: true, categories: [] }; },
      /* ---- 筛选栏（本次功能）---- */
      categorySources: (id) => { calls.push({ kind: 'categorySources', id }); return new Promise((res, rej) => pending.push({ kind: 'categorySources', id, res, rej })); },
      setCategorySources: (id, ids) => { calls.push({ kind: 'setCategorySources', id, sourceIds: ids }); return new Promise((res, rej) => pending.push({ kind: 'setCategorySources', id, sourceIds: ids, res, rej })); },
      setCategoryPref: (id, pref) => { calls.push({ kind: 'setCategoryPref', id, pref }); return new Promise((res, rej) => pending.push({ kind: 'setCategoryPref', id, pref, res, rej })); },
      deleteCategory: (id) => { calls.push({ kind: 'deleteCategory', id }); return new Promise((res, rej) => pending.push({ kind: 'deleteCategory', id, res, rej })); },
      /* ★ 添加源（阶段 A）：**异步且慢**（主进程要先抓一次验证），
         所以装置里也做成"要等结算"的样子 —— 否则测不出"忙碌期间不许连点"。 */
      addSource: (payload) => { calls.push({ kind: 'addSource', payload }); return new Promise((res, rej) => pending.push({ kind: 'addSource', payload, res, rej })); },
    },
    card: { setState: async () => ({ ok: true }), drag: async () => ({ ok: true }) },
    openItem: async () => ({ ok: true }),
  };

  const sandbox = {
    console, Promise, JSON, Math, Date, Number, String, Object, Array, Error, RegExp, Boolean,
    setTimeout, clearTimeout, window: null, document,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  /* ⚠️ vm 沙箱里**没有** window/globalThis 的自引用 —— 而 card.js 用的是
     `window.setTimeout` / `window.addEventListener` 这类写法。
     少了这两行，`window.setTimeout` 会抛 "window.setTimeout is not a function"，
     而它发生在渲染路径里 ⇒ 表现是"界面不动"，看起来像 card.js 坏了。
     （这是装置的坑，不是被测代码的坑 —— 记在这里省得下次再查一遍。） */
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.addEventListener = () => {};
  sandbox.mb = api;
  sandbox.MB_RENDERER_DIAG = { send: (m) => logs.push('DIAG ' + m) };

  vm.createContext(sandbox);
  new vm.Script(VM_SRC, { filename: 'view-model.js' }).runInContext(sandbox);

  /* 观测版 reduce：逐次记下状态转移（本装置唯一的"读心术"）。 */
  const vmProbe = { reduces: [] };
  const _reduce = sandbox.MB_VIEW.reduce;
  sandbox.MB_VIEW.reduce = (v, a) => {
    vmProbe.reduces.push(a && a.type);
    return _reduce(v, a);
  };
  /* 观测版 derive：把 card.js 实际拿去渲染的那份 view 留下来。
     ⚠️ 只是**留档**，不参与任何断言以外的用途。 */
  const _derive = sandbox.MB_VIEW.derive;
  let lastView = null;
  sandbox.MB_VIEW.derive = (v) => { lastView = v; return _derive(v); };

  new vm.Script(cardSrc || CARD_SRC, { filename: 'card.js' }).runInContext(sandbox);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = (p, fn, arg) => sleep(12).then(() => { fn(arg); return sleep(12); });

  return {
    sandbox, api, calls, pending, logs, tracer, vmProbe, document,
    get view() { return lastView; },
    sleep,
    /** ⚠️ 必须先 await 这个：boot() 的第一次取数会被紧随其后的 invalidate 作废，
     *  要等"启动那两次 dispatch 都落定、第二个 get 已在途"再开始取证。 */
    settleBoot: () => sleep(25),
    items(tag, n) {
      return Array.from({ length: n }, (_, i) => ({
        id: nextId++, title: tag + (i + 1), url: 'https://e/' + tag + (i + 1),
        source_name: 'S', published_at: '2026-09-22T00:00:00Z', read_state: 'unread',
      }));
    },
    /** 造**接续在游标之后**的一页（分页语义正确：id 更小、时间不晚于游标） */
    olderItems(tag, n, cursor) {
      const base = cursor && cursor.id != null ? cursor.id : nextId;
      const stamp = (cursor && cursor.publishedAt) || '2026-09-21T00:00:00Z';
      return Array.from({ length: n }, (_, i) => ({
        id: base - 1 - i, title: tag + (i + 1), url: 'https://e/' + tag + (i + 1),
        source_name: 'S', published_at: stamp, read_state: 'unread',
      }));
    },
    last(kind) { return this.calls[this.calls.length - 1]; },
    inflight(kind) { return pending.filter((p) => p.kind === kind && !p.settled).length; },
    has(kind) { return pending.some((p) => p.kind === kind && !p.settled); },
    /** 结算**最新**那笔在途请求（合并循环会作废旧的并重发，取旧的那笔等于喂给死请求） */
    take(kind) {
      const list = pending.filter((p) => p.kind === kind && !p.settled);
      const p = list[list.length - 1];
      if (p) p.settled = true;
      return p;
    },
    ok(kind, payload) {
      const p = this.take(kind);
      tracer.push('ok(' + kind + ') found=' + !!p);
      if (!p) throw new Error('没有在途的 ' + kind);
      return settle(p, (v) => { p.res(v); }, payload);
    },
    fail(kind, message) {
      const p = this.take(kind);
      tracer.push('fail(' + kind + ') found=' + !!p);
      if (!p) throw new Error('没有在途的 ' + kind);
      return settle(p, () => { p.rej(new Error(message)); });
    },
    /* ---- DOM 读取便捷方法（断言里用，都是只读） ---- */
    el(id) { return byId[id]; },
    /** 读某个元素的属性（只读）。用于断言 `data-editing` 这类"状态开关" */
    attr(id, name) { const n = byId[id]; return n ? n.getAttribute(name) : null; },
    chips() { return byId.filters.children.map((c) => ({ name: c.textContent, on: c.getAttribute('data-on') === 'on' })); },
    rows() { return byId.list.children.map((r) => r.children.map((x) => x.textContent).join('|')); },
    rowTitles() { return byId.list.children.map((r) => (r.children[0] ? r.children[0].textContent : r.textContent)); },
    more() { return { text: byId.btnMore.textContent, disabled: byId.btnMore.disabled, hidden: byId.btnMore.hidden }; },
    allBtn() { return { text: byId.btnAll.textContent, disabled: byId.btnAll.disabled, hidden: byId.btnAll.hidden }; },
    headline() { return byId.headline.textContent; },
    /** 模拟"点某个 chip"（索引 0 = 全部） */
    clickChip(i) { byId.filters.children[i].fire('click'); },
    click(id) { byId[id].fire('click'); },

    /* ------------------------------------------------------------------
     * 筛选栏编辑面板（本次功能）
     *
     * ⚠️ 全部只读（除了 fire，那是"模拟用户操作"本身）——
     *    装置一旦能**写**界面状态，测试就会开始验证装置自己。
     * ------------------------------------------------------------------ */
    /** 面板里的源勾选框（按渲染顺序） */
    panelBoxes() {
      const boxes = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.tagName === 'INPUT' && c.getAttribute && c.type === 'checkbox') boxes.push(c);
          walk(c);
        }
      };
      walk(byId.catPanel);
      return boxes;
    },
    /** 勾选框的可读快照：名字 + 勾没勾 + 是否禁用 */
    panelSources() {
      return this.panelBoxes().map((b) => ({
        id: b.dataset.sourceId,
        name: b.parentNode ? b.parentNode.children.map((x) => x.textContent).join('') : '',
        checked: !!b.checked,
        disabled: !!b.disabled,
      }));
    },
    /** 模拟"点第 i 个源勾选框" */
    clickPanelBox(i) {
      const b = this.panelBoxes()[i];
      if (!b) throw new Error('面板里没有第 ' + i + ' 个勾选框');
      b.checked = !b.checked; // 真 DOM 是先翻转再派发 change
      b.fire('change');
      return b;
    },
    /**
     * 按**源 id** 点勾选框。
     * ⚠️ 断言里优先用它，而不是下标：面板是按源**名**排序的
     *    （界面要对用户有意义的顺序），下标会随名字/语言环境漂移 ——
     *    拿下标写断言的话，某天加一个源就会让一条无关的断言变红。
     */
    clickPanelBoxById(id) {
      const i = this.panelBoxes().findIndex((b) => String(b.dataset.sourceId) === String(id));
      if (i < 0) throw new Error('面板里没有 id=' + id + ' 的勾选框');
      return this.clickPanelBox(i);
    },
    /** 偏好那一排（喜欢 / 中性 / 不喜欢）以及哪一档亮着 */
    panelPrefs() {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.getAttribute && c.getAttribute('role') === 'radio') {
            out.push({ label: c.textContent, on: c.getAttribute('data-on') === 'on', checked: c.getAttribute('aria-checked') === 'true' });
          }
          walk(c);
        }
      };
      walk(byId.catPanel);
      return out;
    },
    /** 模拟"点第 i 档偏好" */
    clickPanelPref(i) {
      const btns = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.getAttribute && c.getAttribute('role') === 'radio') btns.push(c);
          walk(c);
        }
      };
      walk(byId.catPanel);
      if (!btns[i]) throw new Error('面板里没有第 ' + i + ' 档偏好');
      btns[i].fire('click');
    },
    /** 面板里所有按钮的文案（用于找「删除类型」/「确认删除」/「关闭」） */
    panelButtons() {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.tagName === 'BUTTON') out.push({ text: c.textContent, disabled: !!c.disabled, armed: c.getAttribute('data-armed') === 'on' });
          walk(c);
        }
      };
      walk(byId.catPanel);
      return out;
    },
    /** 点面板里文案匹配的那个按钮 */
    clickPanelButton(re) {
      const find = (n) => {
        for (const c of n.children) {
          if (c.tagName === 'BUTTON' && re.test(c.textContent)) return c;
          const hit = find(c);
          if (hit) return hit;
        }
        return null;
      };
      const b = find(byId.catPanel);
      if (!b) throw new Error('面板里找不到按钮 ' + re);
      b.fire('click');
      return b;
    },
    panel() {
      return {
        hidden: !!byId.catPanel.hidden,
        text: byId.catPanel.children.map((c) => c.textContent).join(' | '),
        rows: byId.catPanel.children.length,
      };
    },
    /** 面板里的文本输入框（阶段 A 的「添加源」那一行） */
    panelInputs() {
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.tagName === 'INPUT' && c.type === 'text') out.push(c);
          walk(c);
        }
      };
      walk(byId.catPanel);
      return out;
    },
    /** 在「添加源」那一行里填名字与地址，然后点「添加」 */
    fillAddSource(name, url) {
      const inputs = this.panelInputs();
      if (inputs.length < 2) throw new Error('「添加源」那一行没打开（只找到 ' + inputs.length + ' 个输入框）');
      inputs[0].value = name;
      inputs[1].value = url;
      this.clickPanelButton(/^添加$|^验证中/);
      return { name: inputs[0].value, url: inputs[1].value };
    },
    /** 面板状态里与「添加源」有关的那几个开关（由 card.js 从 derive 取） */
    addSourceHint() {
      const t = byId.catPanel.textContent;
      return { hasVerifying: /正在验证这个地址/.test(t), text: t.slice(0, 200) };
    },
    editBtn() {
      return { hidden: !!byId.btnEditCat.hidden, open: byId.btnEditCat.getAttribute('data-open') === 'on' };
    },
  };
}

export function firstPayload(rig, tag, over) {
  return Object.assign({
    items: rig.items(tag, 15), hasMore: true,
    nextCursor: { publishedAt: '2026-09-22T00:00:00Z', id: 15, pendingNull: false },
    categories: CATS, todayTotal: 45, filteredTotal: 45, curated: 15,
    health: { total: 20, ok: 18, bad: 2, never: 0 },
    lastIngestAt: '2026-09-22T06:00:00.000Z', sinceIso: '2026-09-21T16:00:00.000Z',
  }, over || {});
}

/** 造一个"首页已经到位"的装置（少写三行样板） */
export async function bootedRig(cardSrc) {
  const rig = makeRig(cardSrc);
  await rig.settleBoot();
  await rig.ok('get', firstPayload(rig, '首页'));
  await rig.ok('get', firstPayload(rig, '首页'));
  return rig;
}

/**
 * 造一个"首页到位 + 已经选中第 `chipIndex` 个类型"的装置。
 *
 * ⚠️ 选中类型后必须再把那次取数结算掉 —— 否则装置停在"取数在途"的状态，
 *    而那种状态下点任何东西都会走"意图已变 ⇒ 结果作废"的分支，
 *    断言会基于一个假前提失败（我在这上面绕过一圈）。
 */
export async function bootedRigOnChip(chipIndex, cardSrc) {
  const rig = await bootedRig(cardSrc);
  rig.clickChip(chipIndex);
  await rig.sleep(12);
  await rig.ok('get', firstPayload(rig, '筛选' + chipIndex));
  return rig;
}
