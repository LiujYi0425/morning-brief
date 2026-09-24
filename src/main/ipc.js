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
 * @param {(trigger:string, categoryIds:number[]|null) => Promise<object>} deps.runIngest
 * @param {() => object} deps.listCategories
 * @param {(name:string) => object} deps.createCategory
 * @param {(id:number) => object} deps.deleteCategory
 * @param {(id:number) => object} deps.getCategorySources
 * @param {(id:number, sourceIds:number[]) => object} deps.setCategorySources
 * @param {(id:number, pref:number) => object} deps.setCategoryPref
 * @param {(payload:{name:string, feedUrl:string, categoryId?:number}) => Promise<object>} deps.addSource
 *   用户粘贴一个 feed 地址加源。**异步**：主进程要先抓一次验证。
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
  ipcMain.handle('category:delete', (_e, id) => deps.deleteCategory(id));
  ipcMain.handle('category:sources', (_e, id) => deps.getCategorySources(id));
  ipcMain.handle('category:setSources', (_e, payload) => {
    const p = payload || {};
    return deps.setCategorySources(p.categoryId, p.sourceIds);
  });
  ipcMain.handle('category:setPref', (_e, payload) => {
    const p = payload || {};
    return deps.setCategoryPref(p.categoryId, p.pref);
  });
  /* ★ 添加自定义源（阶段 A）。**异步**：主进程要先真的抓一次、解析一次
     （"先验再存"，理由见 main/index.js 里那段说明），
     所以渲染层必须等这个 promise —— 这一点在 preload 的注释里也写了。 */
  ipcMain.handle('source:add', async (_e, payload) => {
    const p = payload || {};
    log(`[ipc] 添加源请求：${p.name || '(无名)'} ${String(p.feedUrl || '').slice(0, 80)}`);
    return deps.addSource(p);
  });
  /* ⚠️ 手动刷新要**带上当前选中的类型**（本次改动）：
      在此之前 `brief:ingest` 只收一个 trigger，于是"我只想看安全类"
      这个意图与"刷新"这个动作之间没有任何联系 —— 点一次刷新照样把
      全部启用源打一遍。渲染层现在把 categoryIds 一起传下来。
      ⚠️ 兼容旧调用方：第二个参数缺省时 = 抓全部源（与改动前逐字一致）。 */
  ipcMain.handle('brief:ingest', async (_e, trigger, categoryIds) => {
    const ids = Array.isArray(categoryIds) ? categoryIds.map(Number).filter((n) => Number.isFinite(n)) : null;
    log(`[ipc] 手动触发抓取（${trigger || 'manual'}${ids && ids.length ? '，类型 ' + ids.join('/') : '，全部源'}）`);
    return deps.runIngest(trigger || 'manual', ids && ids.length ? ids : null);
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
  /* ⚠️⚠️ 这是通道白名单的**第二份副本**（第一份在 `src/preload/index.cjs` 的
     `IPC` 常量里，那份是因为 `sandbox:true` 下 preload 不能 require 本地文件
     才内联的）。两处必须同步 —— 只加一处的话，渲染层调用会**静默失败**：
     preload 里那个方法在、`ipcRenderer.invoke` 也发了，而主进程没有 handler，
     于是它变成一个永远 pending 或直接 reject 的 promise。
     ⇒ 新增通道时，**这个数组和 preload 的 IPC 常量都要改**。
     （`tools/test-all.mjs` 里有一条断言把两份逐项比对，漏一处就红。） */
  const expected = [
    'brief:get',
    'brief:more',
    'brief:ingest',
    'brief:updated',
    'category:list',
    'category:create',
    'category:delete',
    'category:sources',
    'category:setSources',
    'category:setPref',
    'source:add',
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
