/**
 * crashlog.js —— 主进程失败语义：**落盘错误上下文 + 明确的退出策略**
 * =====================================================================
 * 处置审查报告 **B13**（与 **B3「日志与可观测性」** 合并处理）。
 *
 * ---------------------------------------------------------------------
 * 背景：B13 的取证结论（不要凭直觉改写这段）
 * ---------------------------------------------------------------------
 *   · Node 的**默认**行为是「未捕获异常 → 打印栈 → 退出码 1」。
 *   · 但 **Electron 自己就注册了一个 `uncaughtException` 监听器** ——
 *     实测：脚本还没执行到注册那一步，`process.listenerCount('uncaughtException')` 已经是 1。
 *   · 所以 `index.js` 里原本那段「只打日志、不退出」的监听器，**不是**进程不退出的唯一原因；
 *     但**删掉它也恢复不了「崩溃即退出」** —— 光删解决不了问题。
 *   · 结论：这从来不是"要不要删一段多余代码"的问题，而是「**要不要主动处理**」的问题。
 *     **本模块就是那个"主动处理"。**
 *
 * 取证脚本与原始日志：`experiments/diag-uncaught-exception.mjs` + `report/diag-uncaught-exception.txt`
 *
 * ---------------------------------------------------------------------
 * 本模块定下的策略（就两件事：落盘、退出）
 * ---------------------------------------------------------------------
 *   uncaughtException
 *     **同步落盘完整上下文 → 立即 `process.exit(1)`**
 *     理由：同步异常之后进程状态未知。继续跑的代价是「卡片行为异常，却没有任何线索，
 *     而且后续错误会级联污染日志」。退出并留下崩溃记录，才能让**下一次启动**告诉用户上次出过事。
 *     **牺牲可用性，换可诊断性** —— 对一个常驻小工具来说这是划算的。
 *
 *   unhandledRejection
 *     **同步落盘 → 不退出，但必须可见**
 *     理由：promise 拒绝不必然破坏同步状态（可能只是一次 fetch 失败）。
 *     一刀切退出，会把"网络抖了一下"升级成"应用崩了"。
 *     **但绝不允许吞掉** —— 落盘 + 计数 + stderr，并且自检日志里会显示出来。
 *
 * ---------------------------------------------------------------------
 * 为什么退出用 `process.exit` 而不是 `app.exit`
 * ---------------------------------------------------------------------
 * 因为此刻**状态未知，就不该再信任 Electron 的生命周期**去帮我们收尾。
 * `process.exit(1)` 与 Node 默认语义一致（我们本来就在恢复那个语义），
 * 而且它不依赖 Electron 内部是否还健康。
 *
 * ---------------------------------------------------------------------
 * 为什么"必须同步写"（这条不是风格问题，是正确性要求）
 * ---------------------------------------------------------------------
 * 落盘之后**马上就要退出**。异步写（`fs.promises` / 回调式 `fs.writeFile`）
 * 会在进程退出时被直接丢掉 —— 于是崩溃记录**恰好在最需要它的时候不存在**。
 * 所以本模块只用 `node:fs` 的**同步** API。
 * （与 `index.js` 的「开机心跳」用 `writeFileSync` 是同一个理由。）
 *
 * ---------------------------------------------------------------------
 * 为什么本模块**不 import electron**（有意为之，请勿"顺手优化"掉）
 * ---------------------------------------------------------------------
 * 因为它根本不需要 —— 它只做「读写文件 + 决定退出码」。
 * 而 `index.js` / `window.js` 因为 import 了 electron，**必须有 GUI 运行时才能启动**，
 * 于是在沙箱 / CI / 无头环境里**根本测不了**。
 * 保持零依赖之后，`tools/test-crash-policy.mjs` 可以在**纯 Node** 下真的触发一次崩溃、
 * 真的断言退出码与落盘内容 —— 不需要 Electron。
 *
 *   > 等价先例：`focus-verdict.js`（判定逻辑）也是这么拆出来的。
 *   > **由此得到一条可推广的工程规则："凡是不需要 Electron 的逻辑，
 *   > 就不要让它被 electron 的 import 绑架。"**
 *   > 被绑架的代价不是"多一层依赖"，而是**这一块逻辑在所有无 GUI 的环境里永远无法被验证**。
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPORT_DIR = path.resolve(HERE, '..', '..', 'report');
/** 崩溃标记：**存在即代表"上一次运行崩过、且还没被任何人报告过"** */
export const CRASH_FILE = path.join(REPORT_DIR, 'crash-last.json');
/** 全量崩溃流水（append-only，永不删） */
export const CRASH_LOG = path.join(REPORT_DIR, 'crash-log.jsonl');
/** 非致命拒绝的流水 */
export const REJECTION_LOG = path.join(REPORT_DIR, 'rejection-log.txt');

export const FAILURE_KIND = Object.freeze({
  UNCAUGHT: 'uncaughtException',
  REJECTION: 'unhandledRejection',
});

export const EXIT_CODES = Object.freeze({
  /** 未捕获异常：与 Node 默认语义一致 */
  UNCAUGHT: 1,
});

let rejectionCount = 0;
let lastRejection = null;

function ensureDir() {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  } catch {
    /* 连目录都建不出来，只能让后续 write 抛错 —— 由调用方吞掉并退回 stderr */
  }
}

/**
 * 把任意抛出的东西归一成一条可落盘的记录。**纯函数**（除了读 process 事实）。
 */
export function buildCrashRecord(err, kind) {
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    kind,
    at: new Date().toISOString(),
    name: e.name,
    message: e.message,
    stack: e.stack || null,
    /** 致命与否由**种类**决定，不由调用方随口指定 —— 免得两处判断打架 */
    fatal: kind === FAILURE_KIND.UNCAUGHT,
    pid: process.pid,
    argv: process.argv.slice(1),
    cwd: process.cwd(),
    node: process.versions.node || null,
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
  };
}

/** 同步落盘。返回写入路径，便于调用方记录/断言。 */
export function writeCrashRecord(rec) {
  ensureDir();
  fs.writeFileSync(CRASH_FILE, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  fs.appendFileSync(CRASH_LOG, JSON.stringify(rec) + '\n', 'utf8');
  return CRASH_FILE;
}

export function writeRejectionRecord(rec) {
  ensureDir();
  fs.appendFileSync(REJECTION_LOG, JSON.stringify(rec) + '\n', 'utf8');
  return REJECTION_LOG;
}

/**
 * 取走"上一次崩溃"的记录，**取一次就消费掉**（标记文件被删除）。
 *
 * 为什么要消费：这个标记的语义是「有一次崩溃还没被人看到」。
 * 报告过之后就该消失，否则下一次正常启动会**重复报告同一场崩溃**，
 * 久而久之没人再看它 —— 那等于没有这个机制。
 *
 * 读取失败（文件被写坏/权限）时**不抛错**，而是返回一条 `unreadable` 记录：
 * 崩溃记录读不出来，本身就是要报告的一件事，不该让启动流程跟着挂掉。
 */
export function takePendingCrash() {
  try {
    if (!fs.existsSync(CRASH_FILE)) return null;
    const raw = fs.readFileSync(CRASH_FILE, 'utf8');
    fs.rmSync(CRASH_FILE, { force: true });
    return JSON.parse(raw);
  } catch (err) {
    try {
      fs.rmSync(CRASH_FILE, { force: true });
    } catch {
      /* ignore */
    }
    return {
      kind: 'unreadable',
      at: new Date().toISOString(),
      name: 'CrashRecordUnreadable',
      message: String((err && err.message) || err),
      fatal: true,
    };
  }
}

/** 一行人类可读描述。用于心跳、自检日志、控制台。 */
export function describeCrash(rec) {
  if (!rec) return 'none';
  return `${rec.kind}@${rec.at} :: ${rec.name}: ${rec.message}`;
}

/**
 * 装上失败处理器。返回一个可查询的句柄，方便自检把"本进程内发生过什么"显示出来。
 *
 * @param {{exitOnUncaught?: boolean, onRejection?: (rec: object) => void}} [opts]
 *   `exitOnUncaught`：仅用于**测试里模拟"坏掉的实现"**（见 tools/test-crash-policy.mjs）。
 *   生产路径不要传 false —— 那正好退化成 B13 最初那个"带伤继续跑"的老毛病。
 */
export function installFailureHandlers(opts = {}) {
  const exitOnUncaught = opts.exitOnUncaught !== false;

  process.on(FAILURE_KIND.UNCAUGHT, (err) => {
    const rec = buildCrashRecord(err, FAILURE_KIND.UNCAUGHT);
    let wrote = null;
    try {
      wrote = writeCrashRecord(rec);
    } catch (e) {
      /* 落盘失败也必须留痕：能落哪儿落哪儿 */
      console.error('[crash] ⚠️ 崩溃记录落盘失败：', (e && e.message) || e);
    }
    console.error(`[crash] uncaughtException → ${describeCrash(rec)}`);
    if (wrote) console.error(`[crash] 记录已落盘：${wrote}`);
    if (exitOnUncaught) {
      // 同步写已完成；状态未知，直接退出 —— 不要再给 Electron 收尾的机会
      process.exit(EXIT_CODES.UNCAUGHT);
    }
  });

  process.on(FAILURE_KIND.REJECTION, (reason) => {
    const rec = buildCrashRecord(reason, FAILURE_KIND.REJECTION);
    rejectionCount += 1;
    lastRejection = rec;
    try {
      writeRejectionRecord(rec);
    } catch (e) {
      console.error('[crash] ⚠️ 拒绝记录落盘失败：', (e && e.message) || e);
    }
    console.error(`[crash] unhandledRejection → 已落盘但**不退出**（第 ${rejectionCount} 次）：${describeCrash(rec)}`);
    if (typeof opts.onRejection === 'function') {
      try {
        opts.onRejection(rec);
      } catch {
        /* 回调自身出错不能连累主流程 */
      }
    }
  });

  return {
    exitOnUncaught,
    rejectionCount: () => rejectionCount,
    lastRejection: () => lastRejection,
  };
}

export function getRejectionCount() {
  return rejectionCount;
}

export function getLastRejection() {
  return lastRejection;
}

/** 清空计数器/缓存 —— 只给测试用，保证用例之间互不串味。 */
export function _resetForTest() {
  rejectionCount = 0;
  lastRejection = null;
}
