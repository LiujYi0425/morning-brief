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
  BRIEF_INGEST: 'brief:ingest', // R → M：手动触发抓取
  BRIEF_UPDATED: 'brief:updated', // M → R：抓取完成后主动推新数据
  CATEGORY_LIST: 'category:list',
  CATEGORY_CREATE: 'category:create',

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
    ingest: (trigger) => ipcRenderer.invoke(IPC.BRIEF_INGEST, trigger),
    categories: () => ipcRenderer.invoke(IPC.CATEGORY_LIST),
    createCategory: (name) => ipcRenderer.invoke(IPC.CATEGORY_CREATE, name),
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
