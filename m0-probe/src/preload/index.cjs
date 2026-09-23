'use strict';

/**
 * 唯一的通信边界（架构文档 §1.1）。
 * 白名单式暴露 API，不做任何逻辑。
 *
 * ===================================================================
 * ⚠️ M0 关键发现（已登记 docs/04-项目审查报告.md · B2）
 *
 * 为什么这个文件里"重复"了一份通道名？——因为 sandbox: true 下，
 * preload 的 require 是一个受限 polyfill，**不支持 require 本地文件**。
 * 也就是说：
 *     sandbox: true（安全基线要求）
 *   + require('../shared/contract.cjs')（D6 要求词汇表唯一）
 *   两者无法同时成立，除非引入打包步骤把 contract 内联进 preload。
 *
 * M0 的处理方式是"重复 + 自检"，而不是偷偷把 sandbox 关掉：
 *   1. 这里内联一份只读通道表（不引入任何逻辑）
 *   2. 通过 __channels 暴露出去，主进程启动时与 contract.cjs 逐项比对
 *   3. 一旦有人改了 contract.cjs 却忘了改这里 → 主进程立刻报错并写进验收记录
 * 这样"重复"就从隐患变成了被机械检查的不变量。
 *
 * 产品阶段的建议：引入 esbuild，把 preload 打成一个自包含的 CJS 文件，
 * 从而既保住 sandbox: true，又消除这份重复。
 * ===================================================================
 */

const { contextBridge, ipcRenderer } = require('electron');

/* --- 与 src/shared/contract.cjs 的 IPC 段逐项对应的只读副本 --- */
const IPC = Object.freeze({
  CAPABILITY_GET: 'capability:get',
  CAPABILITY_REPORT: 'capability:report',
  CAPABILITY_RENDERER_FACTS: 'capability:rendererFacts',
  CONTRACT_PARITY: 'contract:parity',

  PROBE_STATE: 'probe:state',
  PROBE_PATCH: 'probe:patch',
  REPORT_EXPORT: 'report:export',

  WINDOW_GET_STATE: 'window:getState',
  WINDOW_SET_STATE: 'window:setState',
  WINDOW_SET_SURFACE: 'window:setSurface',
  WINDOW_SET_OPACITY: 'window:setOpacity',
  WINDOW_SNAP: 'window:snap',
  WINDOW_RECORD_POS: 'window:recordPos',
  WINDOW_MOVE_TO_DISPLAY: 'window:moveToDisplay',
  WINDOW_SET_VISIBLE: 'window:setVisible',
  WINDOW_SET_DIAG: 'window:setDiag',
  WINDOW_STATE_CHANGED: 'window:stateChanged',
  CARD_DIAG: 'card:diag',

  FOCUS_TEST_START: 'focusTest:start',
  FOCUS_TEST_STATE: 'focusTest:state',

  LOG: 'app:log',
});

/** 订阅辅助：只把载荷交出去，不泄漏 event 对象 */
function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = Object.freeze({
  /**
   * 通道表本身也暴露出去 —— 主进程会拿它和 contract.cjs 比对。
   * 这是上面那段"重复"的安全网。
   */
  __channels: Object.freeze(Object.values(IPC)),

  capability: Object.freeze({
    get: () => ipcRenderer.invoke(IPC.CAPABILITY_GET),
    reportRendererFacts: (data) => ipcRenderer.invoke(IPC.CAPABILITY_RENDERER_FACTS, data),
  }),

  probe: Object.freeze({
    getState: () => ipcRenderer.invoke(IPC.PROBE_STATE),
    patch: (payload) => ipcRenderer.invoke(IPC.PROBE_PATCH, payload),
    exportReport: () => ipcRenderer.invoke(IPC.REPORT_EXPORT),
    onState: (cb) => subscribe(IPC.PROBE_STATE, cb),
  }),

  card: Object.freeze({
    getState: () => ipcRenderer.invoke(IPC.WINDOW_GET_STATE),
    setState: (next) => ipcRenderer.invoke(IPC.WINDOW_SET_STATE, next),
    setSurface: (next) => ipcRenderer.invoke(IPC.WINDOW_SET_SURFACE, next),
    setOpacity: (id) => ipcRenderer.invoke(IPC.WINDOW_SET_OPACITY, id),
    setVisible: (v) => ipcRenderer.invoke(IPC.WINDOW_SET_VISIBLE, v),
    setDiag: (on) => ipcRenderer.invoke(IPC.WINDOW_SET_DIAG, on),
    snap: () => ipcRenderer.invoke(IPC.WINDOW_SNAP),
    recordPos: () => ipcRenderer.invoke(IPC.WINDOW_RECORD_POS),
    moveToDisplay: (id) => ipcRenderer.invoke(IPC.WINDOW_MOVE_TO_DISPLAY, id),
    onStateChanged: (cb) => subscribe(IPC.WINDOW_STATE_CHANGED, cb),
    onDiag: (cb) => subscribe(IPC.CARD_DIAG, cb),
  }),

  focusTest: Object.freeze({
    start: (ms) => ipcRenderer.invoke(IPC.FOCUS_TEST_START, ms),
    onState: (cb) => subscribe(IPC.FOCUS_TEST_STATE, cb),
  }),

  log: (msg) => ipcRenderer.invoke(IPC.LOG, msg),
});

contextBridge.exposeInMainWorld('m0', api);
