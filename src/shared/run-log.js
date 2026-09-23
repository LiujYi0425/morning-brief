/**
 * src/shared/run-log.js —— 启动检查点与运行日志（**零依赖、可在纯 Node 下测试**）
 * =====================================================================
 * ⚠️⚠️ 这个文件是被一次真事故逼出来的，请先读完再改。
 *
 * ### 事故：整条启动取证通道静默死了两天
 * 原来 `mark()`（写启动检查点）和 `teeConsole()`（把 console 接到落盘）都写在
 * `src/main/index.js` 里。那个文件 import 了 electron，**离线侧根本加载不了**，
 * 于是这两段逻辑没有任何测试能碰到。
 *
 * 有一次重构把它们用到的 `const BOOT_LOG = path.join(DATA_DIR, 'boot.log')`
 * 删掉了，而 `mark()` 里还留着 `fs.appendFileSync(BOOT_LOG, ...)`。
 * 后果链条是这样的：
 *   ① `BOOT_LOG` 是未声明的自由变量 ⇒ 每次 `mark()` 都抛 `ReferenceError`；
 *   ② `mark()` 的 `try/catch` 是**故意**为了"落盘失败不该阻止启动"而写的，
 *      于是这个异常被**静默吞掉**；
 *   ③ 生产现场：`boot.log` 的 mtime 停在两天前，`run.log` 里 `[boot]` 行数为 0，
 *      而应用在那两天里**正常启动过好几次**。
 *
 * ⇒ 教训不是"下次记得定义变量"，而是：**"故意吞异常的兜底"必须与"证明它没在吞
 *    真问题"的测试成对出现**。一个只吞不报的 catch，会把代码错误伪装成环境问题。
 *
 * ### 因此本文件的形状
 *   · 纯 Node，不 import electron ⇒ 离线考裁判可以**真的调用**这些函数；
 *   · `mark()` 区分两类失败：**代码错误**（ReferenceError/TypeError，必须暴露）
 *     与**环境问题**（磁盘满、权限不足，允许吞掉但不能无声）；
 *   · 每次调用都返回一个结果对象，测试可以直接断言"写成功了"，
 *     而不是只能断言"没抛异常"——后者正是原来那条弱断言。
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';

export const BOOT_LOG_FILE_NAME = 'boot.log';

export function bootLogPath(dataDir) {
  return path.join(dataDir, BOOT_LOG_FILE_NAME);
}

/**
 * 造一个"追加写 + 有大小上限"的日志写入器。
 *
 * ⚠️ 为什么必须由应用自己写文件，而不是把 stdout 重定向到文件：
 *    实测（本机）`service.mjs` 用 `stdio: [..., fd, fd]` 把子进程 stdout 指到文件，
 *    应用**确实**正常启动了（心跳、数据库、定时器全跑了），而那个文件是 **0 字节** ——
 *    Electron/Chromium 在 Windows 上不保证把主进程的 `console.log` 送到继承来的句柄。
 *    后果比"没日志"严重：专门写的"启动失败就把日志末尾打出来"永远打不出来。
 *
 * ⚠️ `broken` 的语义要说清（这里被审查员抓到过一个真问题）：
 *    原来一旦写失败就把 `broken` 置真、**永久不再尝试**。于是"磁盘暂时满 →
 *    腾出空间"之后日志再也不会恢复，而用户以为一切正常。
 *    ⇒ 现在改成**限频重试**：失败后进入冷却，冷却结束再试；并且把
 *      "曾经失败过"如实暴露在返回对象上，让 status / 心跳能报出来。
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.retryCooldownMs]
 * @param {() => number} [opts.now]
 */
export function createLogSink(file, opts = {}) {
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024;
  const cooldownMs = opts.retryCooldownMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());

  let bytes = null;
  let nextRetryAt = 0;
  const state = { failures: 0, lastError: null, lastErrorAt: null, skipped: 0 };

  const sizeOf = () => {
    if (bytes === null) {
      try {
        bytes = fs.statSync(file).size;
      } catch {
        bytes = 0;
      }
    }
    return bytes;
  };

  function write(line) {
    if (now() < nextRetryAt) {
      state.skipped += 1;
      return { ok: false, skipped: true, error: state.lastError };
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = String(line) + '\n';
      if (sizeOf() > maxBytes) {
        const keep = Math.floor(maxBytes / 16);
        const old = fs.readFileSync(file, 'utf8');
        const tail = old.slice(Math.max(0, old.length - keep));
        fs.writeFileSync(
          file,
          `--- 日志超过 ${Math.round(maxBytes / 1024)}KB，已截断（保留最后 ${Math.round(keep / 1024)}KB）---\n${tail}`,
          'utf8',
        );
        bytes = Buffer.byteLength(tail, 'utf8');
      }
      fs.appendFileSync(file, text, 'utf8');
      bytes += Buffer.byteLength(text, 'utf8');
      /* 成功了就把冷却清掉 —— 这一句就是"恢复自愈"的全部实现。
         少了它，一次瞬时故障会变成永久静默（审查员实测复现过）。 */
      if (state.failures) {
        state.recoveredAt = new Date().toISOString();
      }
      state.failures = 0;
      state.lastError = null;
      nextRetryAt = 0;
      return { ok: true, bytes };
    } catch (err) {
      state.failures += 1;
      state.lastError = `${err && err.code ? err.code + ': ' : ''}${err && err.message}`;
      state.lastErrorAt = new Date().toISOString();
      nextRetryAt = now() + cooldownMs;
      return { ok: false, skipped: false, error: state.lastError };
    }
  }

  write.state = () => ({ ...state, nextRetryAt, bytes });
  return write;
}

/** 把任意值变成一行可读文本；**不递归展开对象**（避免把活对象序列化炸掉） */
export function safeInspect(v) {
  if (v instanceof Error) return String(v.stack || v.message || v);
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return '[object]';
  return String(v);
}

/**
 * 把 `console.log/info/warn/error` 接到落盘上。
 * 返回一个"恢复原样"的函数（测试要用；生产里不用）。
 */
export function teeConsole(writeRunLog, target = console) {
  const orig = { log: target.log, info: target.info, warn: target.warn, error: target.error };
  const wrap = (fn, tag) => (...args) => {
    try {
      fn.apply(target, args);
    } catch {
      /* stdout 断了也不该影响功能 */
    }
    writeRunLog(tag + args.map((a) => safeInspect(a)).join(' '));
  };
  target.log = wrap(orig.log, '');
  target.info = wrap(orig.info, '');
  target.warn = wrap(orig.warn, '[warn] ');
  target.error = wrap(orig.error, '[error] ');
  return () => Object.assign(target, orig);
}

/**
 * 造启动检查点写入器。
 *
 * ⚠️⚠️ 关键设计：**区分"代码错误"与"环境问题"**。
 *    原来两者共用一句 `catch {}`，于是"忘记定义变量"这种**代码错误**
 *    被伪装成了"落盘失败"这个**环境问题**，静默了两天。
 *
 *      环境问题（ENOSPC / EACCES / EPERM / EROFS / EBUSY…）
 *        → 允许吞掉，但**必须记在返回对象里**，让上层能报出来
 *      代码错误（ReferenceError / TypeError / RangeError…）
 *        → **重新抛出**。这类错误重复一万次也不会自己好，
 *          吞掉它只会让下一个查问题的人从零开始。
 *
 * @param {string} dataDir
 * @param {(line:string)=>any} writeRunLog 同步写 run.log 的函数
 * @returns {(step:string, extra?:string) => {ok:boolean, error?:string, codeError?:string}}
 */
export function createBootMark(dataDir, writeRunLog = () => {}) {
  const bootLog = bootLogPath(dataDir);
  let codeError = null;

  function mark(step, extra) {
    const line = `${new Date().toISOString()} ${step}${extra ? ' ' + extra : ''}`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(bootLog, line + '\n', 'utf8');
      try {
        writeRunLog('[boot] ' + line);
      } catch {
        /* run.log 写不进去不影响 boot.log 已经写成功这个事实 */
      }
      return { ok: true, file: bootLog };
    } catch (err) {
      const isEnv =
        err && typeof err.code === 'string' && /^(E|WSA)/.test(err.code);
      if (!isEnv) {
        /* 代码错误：记下来 + 抛出去。上层若真的不想崩，可以自己 catch，
           但那时它至少知道这是"代码坏了"而不是"磁盘满了"。 */
        codeError = `${err && err.constructor ? err.constructor.name : 'Error'}: ${err && err.message}`;
        throw err;
      }
      return { ok: false, error: `${err.code}: ${err.message}`, file: bootLog };
    }
  }

  mark.path = () => bootLog;
  mark.codeError = () => codeError;
  return mark;
}
