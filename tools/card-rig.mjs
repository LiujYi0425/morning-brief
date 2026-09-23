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
    get() { return n._text; },
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
  'catNext', 'btnAddCat', 'list', 'foot', 'toast', 'btnMore', 'btnAll', 'btnRefresh', 'btnCollapse',
  'bar', 'grip', 'catbar'];

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
    ['btnMore', 'button'], ['btnAll', 'button'], ['btnRefresh', 'button'], ['btnCollapse', 'button'],
  ].forEach(([id, tag]) => { byId[id].tagName = tag.toUpperCase(); });

  const document = {
    readyState: 'complete',
    documentElement: makeNode('html'),
    body: makeNode('body'),
    activeElement: null,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => makeNode(tag),
    createDocumentFragment: () => { const f = makeNode('fragment'); f.isFragment = true; return f; },
    querySelector: (sel) => (sel === '.card' ? makeNode('div') : sel === '.foot' ? byId.foot : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };

  const api = {
    log: (m) => logs.push(String(m)),
    brief: {
      get: (opts) => { calls.push({ kind: 'get', opts }); return new Promise((res, rej) => pending.push({ kind: 'get', opts, res, rej })); },
      more: (opts) => { calls.push({ kind: 'more', opts }); return new Promise((res, rej) => pending.push({ kind: 'more', opts, res, rej })); },
      onUpdated: () => {},
      ingest: async () => ({ newItems: 0 }),
      createCategory: async () => ({ ok: true, categories: [] }),
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
    chips() { return byId.filters.children.map((c) => ({ name: c.textContent, on: c.getAttribute('data-on') === 'on' })); },
    rows() { return byId.list.children.map((r) => r.children.map((x) => x.textContent).join('|')); },
    rowTitles() { return byId.list.children.map((r) => (r.children[0] ? r.children[0].textContent : r.textContent)); },
    more() { return { text: byId.btnMore.textContent, disabled: byId.btnMore.disabled, hidden: byId.btnMore.hidden }; },
    allBtn() { return { text: byId.btnAll.textContent, disabled: byId.btnAll.disabled, hidden: byId.btnAll.hidden }; },
    headline() { return byId.headline.textContent; },
    /** 模拟"点某个 chip"（索引 0 = 全部） */
    clickChip(i) { byId.filters.children[i].fire('click'); },
    click(id) { byId[id].fire('click'); },
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
