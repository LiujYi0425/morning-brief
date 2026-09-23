/**
 * src/store/db-setup.js —— 建立数据库连接（**延迟加载 `node:sqlite`**）
 * =====================================================================
 * ⚠️ 这个文件存在的唯一理由：**`node:sqlite` 不能在 Electron 主进程顶层静态 import。**
 *
 * ### 真机实测的崩法（2026-09-22）
 * 应用启动序列的检查点日志显示：
 *
 *     module-evaluated        ← 模块开始求值
 *     heartbeat-written       ← 心跳文件写成功
 *     （然后进程 0.7 秒后以 0xC0000005 访问冲突退出）
 *     ← `app.whenReady()` **从未触发**
 *
 * 没有 JS 异常、`uncaughtException` 一条没接到、stdout / stderr 全空 ——
 * 说明那是**原生层崩溃**，不是 JS 错误。把静态 import 改成延迟 import 之后就正常了。
 *
 * ### 为什么改成 `await import()` 就能活
 * 静态 `import` 在**模块求值期**就把原生模块拉进来，而那发生在
 * `app.whenReady()` 之前 —— 此时 Electron 的原生环境尚未初始化完。
 * 延迟到 `whenReady` 之后（甚至更晚，第一次真正要读写数据时）再加载，就避开了那个窗口。
 *
 * ### 附带的好处（这也是本项目的架构规则）
 * 纯逻辑模块（解析 / 归一化 / 指纹）与"需要原生能力"的部分**就此分开**：
 * `urls.js` / `entities.js` / `feed-parse.js` 全部零依赖、可在纯 Node 下测试，
 * 只有这个文件碰 `node:sqlite`。
 * =====================================================================
 */

import path from 'node:path';
import fs from 'node:fs';

/** 缓存的模块与连接（单例） */
let modPromise = null;
let conn = null;

/**
 * 动态加载 `node:sqlite`。**只在真正要用的时候调用。**
 * @returns {Promise<{DatabaseSync: Function}>}
 */
async function loadSqlite() {
  if (!modPromise) {
    modPromise = import('node:sqlite').catch((err) => {
      // 加载失败要给出可操作的信息，而不是一句"undefined"
      modPromise = null;
      throw new Error(
        `无法加载 node:sqlite：${err && err.message}。` +
          `本工程依赖 Electron 内嵌 Node 自带的 SQLite（已实测 electron 44 + node 24 可用）。` +
          `若你的 Electron 版本较老，请升级 Electron。`,
      );
    });
  }
  return modPromise;
}

/** 供诊断用：不实际连接，只回答"数据库驱动能不能加载" */
export async function probeDriver() {
  const m = await loadSqlite();
  return { ok: typeof m.DatabaseSync === 'function', keys: Object.keys(m) };
}

/**
 * 打开（或复用）数据库连接。
 *
 * ⚠️ **异步** —— 因为加载驱动是异步的。这一点会传染给调用方，
 *    但那正是我们想要的：调用方无法"假装它已经好了"。
 *
 * @param {string} file
 * @param {(db:any)=>void} init 拿到连接后的初始化回调（建表等，由 db.js 提供）
 * @returns {Promise<any>}
 */
export async function openConnection(file, init) {
  if (conn) return conn;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  const { DatabaseSync } = await loadSqlite();
  conn = new DatabaseSync(file);

  if (typeof init === 'function') init(conn);
  return conn;
}

/** 已打开的连接（未打开则为 null）—— 同步取用，供已经 await 过 openConnection 的代码使用 */
export function getConnection() {
  return conn;
}

export function closeConnection() {
  if (conn) {
    try {
      conn.close();
    } catch {
      /* 关不掉不影响退出 */
    }
    conn = null;
  }
}
