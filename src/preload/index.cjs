/**
 * src/preload/index.cjs —— 唯一的通信边界（白名单式）
 * =====================================================================
 * ⚠️ 与 m0-probe 同一处踩坑：`sandbox: true` 下 preload 的 `require`
 * 是受限 polyfill，**不能 require 本地文件** ⇒ 通道名必须在这里内联一份。
 * 那份重复由 `__channels` 暴露出去，主进程启动时逐项比对（漂移就报错），
 * 于是"重复"变成被机器检查的不变量，而不是隐患。
 * =====================================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

const IPC = Object.freeze({
  BRIEF_GET: 'brief:get', // R → M：取当前简报（首页 N 条 + 健康度 + 统计）
  BRIEF_MORE: 'brief:more', // R → M：翻页（游标式）
  BRIEF_INGEST: 'brief:ingest', // R → M：手动触发抓取（可带当前类型）
  BRIEF_UPDATED: 'brief:updated', // M → R：抓取完成后主动推新数据
  CATEGORY_LIST: 'category:list',
  CATEGORY_CREATE: 'category:create',
  CATEGORY_DELETE: 'category:delete', // ★ 只删分类与绑定，绝不删条目
  CATEGORY_SOURCES: 'category:sources', // 读「这个类型包含哪些源」
  CATEGORY_SET_SOURCES: 'category:setSources', // 写「这个类型包含哪些源」
  CATEGORY_SET_PREF: 'category:setPref', // 喜欢 / 中性 / 不喜欢
  SOURCE_ADD: 'source:add', // ★ 用户粘贴一个 feed 地址加源（主进程先验再存）

  CARD_SET_STATE: 'card:setState',
  CARD_MINIMIZE: 'card:minimize',
  CARD_DRAG: 'card:drag', // ★ 坐标只有 x/y/phase
  OPEN_EXTERNAL: 'item:open', // ★ 需求 3：跳转详情页（主进程做协议白名单）

  LEVEL_APPLY: 'level:apply',
  APP_LOG: 'app:log',
});

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = Object.freeze({
  __channels: Object.freeze(Object.values(IPC)),

  brief: Object.freeze({
    get: (opts) => ipcRenderer.invoke(IPC.BRIEF_GET, opts),
    more: (payload) => ipcRenderer.invoke(IPC.BRIEF_MORE, payload),
    /* ★ 刷新可以带当前类型（第二参）：选中类型时只抓**该类型绑定的源并集**，
       「全部」时不传 ⇒ 抓全部启用源（与改动前逐字一致）。
       为什么必须带上：不带的话，"我只想看安全类"这个意图与"刷新"这个动作
       之间没有任何联系 —— 点一次刷新照样把全部源打一遍。 */
    ingest: (trigger, categoryIds) => ipcRenderer.invoke(IPC.BRIEF_INGEST, trigger, categoryIds),
    categories: () => ipcRenderer.invoke(IPC.CATEGORY_LIST),
    createCategory: (name) => ipcRenderer.invoke(IPC.CATEGORY_CREATE, name),
    deleteCategory: (id) => ipcRenderer.invoke(IPC.CATEGORY_DELETE, id),
    categorySources: (id) => ipcRenderer.invoke(IPC.CATEGORY_SOURCES, id),
    setCategorySources: (categoryId, sourceIds) =>
      ipcRenderer.invoke(IPC.CATEGORY_SET_SOURCES, { categoryId, sourceIds }),
    setCategoryPref: (categoryId, pref) => ipcRenderer.invoke(IPC.CATEGORY_SET_PREF, { categoryId, pref }),
    /* ★ 添加自定义源：**异步且可能慢**（主进程要先抓一次验证），
       ⚠️ 渲染层必须 `await` 它并处理失败 —— 失败原因是给用户看的正文
          （"这个地址不是可解析的 feed（实际拿到的是「HTML 网页」）"）。 */
    addSource: (payload) => ipcRenderer.invoke(IPC.SOURCE_ADD, payload),
    onUpdated: (cb) => subscribe(IPC.BRIEF_UPDATED, cb),
  }),

  card: Object.freeze({
    setState: (next) => ipcRenderer.invoke(IPC.CARD_SET_STATE, next),
    minimize: () => ipcRenderer.invoke(IPC.CARD_MINIMIZE),
    drag: (payload) => ipcRenderer.invoke(IPC.CARD_DRAG, payload),
  }),

  /** 需求 3：打开原文。**只传 URL 与 id** —— 协议校验在主进程做。 */
  openItem: (id, url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, { id, url }),

  level: Object.freeze({
    apply: (mode) => ipcRenderer.invoke(IPC.LEVEL_APPLY, mode),
  }),

  log: (msg) => ipcRenderer.invoke(IPC.APP_LOG, msg),
});

contextBridge.exposeInMainWorld('mb', api);
