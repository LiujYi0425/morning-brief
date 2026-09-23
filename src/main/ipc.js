/**
 * src/main/ipc.js —— IPC 路由（含需求 3 的协议白名单）
 * =====================================================================
 * 三条安全口径（照搬本项目已定的基线，不是新发明）：
 *
 *   ① **网络与外部程序只在主进程**。渲染进程只能请求"打开某个 item"，
 *      不能自己发起任何请求 —— 所以它的 CSP 是 `default-src 'none'`。
 *   ② **协议白名单只放 http/https**。`file:` / `javascript:` / `ms-msdt:` 之类
 *      一律拒绝。这不是洁癖：卡片会显示**来自互联网的标题**，
 *      而链接是外部数据 —— 没有白名单就等于把外部数据当命令执行。
 *   ③ **失败要回话**，不要静默。拒绝时返回原因，界面能显示"这个链接不可打开"。
 * =====================================================================
 */

import { ipcMain, shell } from 'electron';
// ★ 协议白名单拆到零依赖模块（`url-guard.js`）——理由见该文件顶部：
//   它 import 了 electron 就没法被离线断言，而这是一条**安全边界**。
import { validateExternalUrl } from './url-guard.js';

/**
 * 注册全部 IPC。
 *
 * @param {object} deps
 * @param {() => object} deps.getBrief
 * @param {(cursor:object) => object} deps.getMore
 * @param {(trigger:string) => Promise<object>} deps.runIngest
 * @param {() => object} deps.listCategories
 * @param {(next:string) => void} deps.setCardState
 * @param {() => void} deps.minimize
 * @param {(p:object) => object} deps.drag
 * @param {(mode:string) => Promise<object>} deps.applyLevel
 * @param {(db:object, id:number) => void} [deps.markOpened]
 * @param {(msg:string)=>void} [deps.log]
 */
export function registerIpc(deps) {
  const log = deps.log || (() => {});

  ipcMain.handle('brief:get', (_e, opts) => deps.getBrief(opts || {}));
  ipcMain.handle('brief:more', (_e, payload) => {
    // 兼容两种调用：只传 cursor，或传 { cursor, categoryIds }
    const p = payload && typeof payload === 'object' && 'cursor' in payload ? payload : { cursor: payload };
    return deps.getMore(p);
  });
  ipcMain.handle('category:create', (_e, name) => deps.createCategory(name));
  ipcMain.handle('brief:ingest', async (_e, trigger) => {
    log(`[ipc] 手动触发抓取（${trigger || 'manual'}）`);
    return deps.runIngest(trigger || 'manual');
  });
  ipcMain.handle('category:list', () => deps.listCategories());

  ipcMain.handle('card:setState', (_e, next) => {
    deps.setCardState(next);
    return { ok: true, state: next };
  });
  ipcMain.handle('card:minimize', () => {
    deps.minimize();
    return { ok: true };
  });

  ipcMain.handle('card:drag', (_e, payload) => deps.drag(payload));

  /* ---- 需求 3：点击跳转 ---- */
  ipcMain.handle('item:open', async (_e, payload) => {
    const { id, url } = payload || {};
    /* ★ 无条件留痕（真机踩过）：用户报"点击没反应"时，
       如果这里不打日志，就分不清是"渲染层没调用"还是"调用了但被拦/失败"。
       一行日志把这两个世界分开。 */
    log(`[ipc] item:open id=${id} url=${url ? String(url).slice(0, 80) : '(空)'}`);

    const v = validateExternalUrl(url);
    if (!v.ok) {
      log(`[ipc] ✗ 拒绝打开（id=${id}）：${v.reason}`);
      return { ok: false, reason: v.reason };
    }
    try {
      await shell.openExternal(url);
      if (deps.markOpened && Number.isFinite(id)) deps.markOpened(id);
      log(`[ipc] ✓ 已交给系统浏览器：${String(url).slice(0, 60)}`);
      return { ok: true };
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      log(`[ipc] ✗ openExternal 失败：${reason}`);
      return { ok: false, reason: `打开失败：${reason}` };
    }
  });

  ipcMain.handle('level:apply', async (_e, mode) => deps.applyLevel(mode || 'bottom'));

  ipcMain.handle('app:log', (_e, msg) => {
    console.log('[renderer]', msg);
    return { ok: true };
  });
}

/** 给自检用：把通道表与 preload 内联副本逐项比对 */
export function checkChannelParity(rendererChannels) {
  const expected = [
    'brief:get',
    'brief:more',
    'brief:ingest',
    'brief:updated',
    'category:list',
    'category:create',
    'card:setState',
    'card:minimize',
    'card:drag',
    'item:open',
    'level:apply',
    'app:log',
  ].sort();
  const actual = (rendererChannels || []).slice().sort();
  const missing = expected.filter((c) => !actual.includes(c));
  const extra = actual.filter((c) => !expected.includes(c));
  return { ok: missing.length === 0 && extra.length === 0, expected, missing, extra };
}
