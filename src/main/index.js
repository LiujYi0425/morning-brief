/**
 * src/main/index.js —— 产品入口
 * =====================================================================
 * ⚠️ 两条 Electron 环境陷阱，照搬 M0 的结论（见 m0-probe/README.md B10 / B11）：
 *   1) 本机环境的 `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 静默退化成普通 Node
 *      （不开窗口、报错还指向别处）。它只能在 spawn 之前删 —— 由启动器负责。
 *   2) ESM 主进程里**不能**顶层 `await app.whenReady()`（死锁，且不报错）。
 *      ⇒ 一律 `app.whenReady().then(...)`。
 * =====================================================================
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, screen, powerMonitor } from 'electron';

import { createCardWindow, setCardState, nativeHwnd, CARD_SIZE, alignToPhysicalGrid } from './window.js';
import { registerIpc } from './ipc.js';
import {
  createScheduler,
  catchUpDecision,
  nextRunAt,
  formatHm,
  parseFetchTime,
} from './scheduler.js';
import {
  writePidFile,
  removePidFile,
  runLogPath,
  hasStopRequest,
  clearStopRequest,
  dataDirOf,
  legacyDataDirOf,
  probeWritable,
} from '../shared/runtime-state.js';
import { createBootMark, teeConsole, createLogSink } from '../shared/run-log.js';
import { bootWatchdog, markHealthy, rollbackNow, checkForUpdate, downloadUpdate, applyUpdate } from './updater.js';
import { formatBytes } from '../shared/update.js';
import { runIngest } from '../ingest/fetch-feeds.js';
import {
  openDb,
  queryItems,
  countItems,
  sourceHealth,
  listCategories,
  listSources,
  listSourceIdsOfCategory,
  setCategorySources,
  setCategoryPref,
  deleteCategory,
  addCustomSource,
  prefByCategory,
  getMeta,
  setMeta,
  upsertCategory,
  upsertSources,
} from '../store/db.js';
import { selectByQuota, quotaOf, scopedQuota } from '../shared/quota.js';
/* ★ 「添加源」要复用这两件**已经存在**的东西，不许另写一份：
     · `validateExternalUrl` —— 协议白名单（安全边界，见 url-guard.js）
     · `fetchText` / `parseFeed` —— 与正式抓取同一个抓取器与同一个解析器
   ⚠️ 另写一份的话，"添加时验得过"与"抓取时抓得动"会各自漂移，
      而那正是本项目反复栽过的"两份口径"。 */
import { validateExternalUrl } from './url-guard.js';
import { fetchText } from '../ingest/fetch-feeds.js';
import { parseFeed } from '../ingest/feed-parse.js';
/* ★ "这个地址能不能当源"是**纯判定**，拆在 feed-url.js 里 ——
   留在这个文件（它 import 了 electron）就等于那段判定**永远没有断言**。
   ⚠️ 它与 url-guard 是**两件事**，别合并：那个管"点击能不能打开"（用户路径），
      这个管"程序能不能定期去抓"（程序自己出网的路径，边界更严：
      本机/内网地址一律拒绝）。 */
import { validateNewSource } from './feed-url.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/**
 * 取一个**运行时资源**的真实路径（开发态 / 打包态自动切换）。
 *
 * ⚠️⚠️ 为什么不能直接用 `path.join(ROOT, ...)`：
 *
 *   打包之后整个应用被塞进 `resources/app.asar` —— 那是**一个文件**，
 *   只是 Electron 的 fs 补丁让它"看起来像目录"。于是：
 *     · `fs.readFileSync('app.asar/x')` ✅ 能用（补丁管到）
 *     · `powershell.exe -File "app.asar\tools\win\set-window-level.ps1"` ❌
 *       **PowerShell 不认识 asar**，它看到的是一个普通文件路径，
 *       中间那层"目录"在真实文件系统里不存在 ⇒ 脚本直接报找不到。
 *
 *   ⇒ 凡是要**交给外部程序**的资源（置底脚本、托盘图标）都必须放在
 *     asar 外面 —— 由 electron-builder 的 `extraResources` 铺到
 *     `resources/` 下，再用 `process.resourcesPath` 找。
 *
 *   开发态则仍然从项目里取（`extraResources` 只在打包时生效）。
 *
 * @param {string} rel 相对路径（打包态与开发态用同一个相对位置）
 */
function runtimeAsset(rel) {
  if (app.isPackaged && process.resourcesPath) {
    const packed = path.join(process.resourcesPath, rel);
    if (fs.existsSync(packed)) return packed;
    /* 打包态却找不到 ⇒ 这是**打包配置漏了**，不是运行环境问题。
       如实报出来，别悄悄退回 asar 里那个 PowerShell 读不了的路径。 */
    console.error(`[main] ⚠️ 打包资源缺失：${packed}（检查 package.json 的 build.extraResources）`);
  }
  /* ⚠️ 开发态：先按 <项目>/<rel> 找（`tools/win/set-window-level.ps1` 就在那儿 ✓），
     找不到再退到 `src/renderer/<rel>` —— **托盘图标**就是后一种：
     它实际住在 `src/renderer/assets/tray-16.png`，打包时由 extraResources
     铺成 `resources/assets/`（于是打包态走上面那条路 ✓）。
     少了这一步，`npm start` 时托盘会**静默消失**，而托盘菜单里的「退出晨报机」
     是**唯一的退出入口**（卡片上没有关闭按钮，这是设计如此）。 */
  const dev = path.join(ROOT, rel);
  if (fs.existsSync(dev)) return dev;
  const devAlt = path.join(ROOT, 'src', 'renderer', rel);
  if (fs.existsSync(devAlt)) return devAlt;
  return dev;
}

/* 数据目录：开发态在项目内 `data/`，**打包态在 Electron 的 userData 下**，
 * 可用 `MB_DATA_DIR` 覆盖。
 * ⚠️ 口径来自 `runtime-state.js` 的 `dataDirOf`，**不在这里另写一份** ——
 *   各写一份必然漂移，而漂移的表现是"应用写这个目录、管理命令查那个目录"。 */
function resolvePackagedUserData() {
  if (!app.isPackaged) return null;
  try {
    return app.getPath('userData');
  } catch {
    /* `app.getPath` 在极少数平台上于 ready 之前会抛。
       兜底自己拼一个 —— 路径对不对是次要的，**能不能起来**是主要的。 */
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'morning-brief');
  }
}
const DATA_DIR = dataDirOf(process.env, { packagedUserData: resolvePackagedUserData() });
const DB_FILE = path.join(DATA_DIR, 'brief.db');

/* 迁移提示：旧版把数据放在 `~/.morning-brief`。
 * ⚠️ 为什么不自动搬：那会在用户不知情的情况下动他的数据文件。
 *    但**必须说一声** —— 否则升级之后看到空卡片，第一反应是"我的简报丢了"。 */
{
  const legacy = legacyDataDirOf(process.env);
  if (legacy && legacy !== DATA_DIR && !fs.existsSync(DB_FILE) && fs.existsSync(path.join(legacy, 'brief.db'))) {
    console.log('[main] ⚠️ 现在的数据目录是 ' + DATA_DIR + '，但那里还没有数据库。');
    console.log('[main]    在旧位置发现了数据：' + legacy);
    console.log('[main]    想搬过来：把该目录下的文件拷到 ' + DATA_DIR + ' 即可（或设 MB_DATA_DIR 指回旧位置）。');
  }
}

/** 心跳文件：证明"真的起来了"。不带它的话，静默失败会看起来像"正在启动" */
const HEARTBEAT = path.join(DATA_DIR, 'boot-heartbeat.txt');

/**
 * 统一日志落盘（**主进程与渲染层都进同一个文件**）。
 *
 * ⚠️ 为什么必须有（两次踩坑，第二次是后台运行引入的）：
 *
 *   第一次：渲染层每一条日志都要经 IPC 回到主进程，而主进程原来只
 *   `console.log` —— **不通过终端启动就一条都拿不到**。
 *   界面问题只能靠真机日志定位（我在离线侧看不到界面），而"必须先开个终端"
 *   把取证成本抬得太高：用户双击一下图标就再也拿不到证据了。
 *
 *   第二次（**更严重**）：加了后台运行之后，`service.mjs` 用
 *   `stdio: [..., fd, fd]` 把子进程 stdout 指向 `run.log`。
 *   实测结果是 —— 应用**确实**正常启动了（心跳、数据库、定时器全跑了），
 *   而 **`run.log` 是 0 字节**。Electron/Chromium 在 Windows 上不保证
 *   把主进程的 `console.log` 送到继承来的句柄，脱离终端时尤其如此。
 *   于是 `logs` 形同虚设，而且**启动失败时的诊断全部失效**：
 *   我专门写了"失败就把日志末尾打出来"，那个文件却永远是空的。
 *
 *   ⇒ 结论写死在这里：**日志必须由应用自己写**。重定向只能当兜底。
 */
const RUN_LOG = runLogPath(DATA_DIR);
const writeRunLog = createLogSink(RUN_LOG, { maxBytes: 4 * 1024 * 1024 });

/* ⚠️⚠️ 这里曾经是 `teeConsole()` / `safeInspect()` / `mark()` 三个函数体，
 *    它们搬去了 `src/shared/run-log.js`。搬家的理由是一次真事故：
 *    本文件 import 了 electron ⇒ 离线考裁判**加载不了它** ⇒ 这三段逻辑
 *    没有任何测试能碰到 ⇒ 有一次重构删掉了它们依赖的 `BOOT_LOG` 常量，
 *    而 `mark()` 里的 `catch {}` 把 `ReferenceError` 静静吞掉 ——
 *    整条启动取证通道死了两天，应用照常启动，谁都没发现。
 *
 * ⇒ 现在它们住在零依赖模块里，测试可以**真的调用**并断言"确实写出了东西"，
 *   而不是像原来那样只能断言"调用没抛异常"（那条断言在事故期间一直是绿的）。 */
const mark = createBootMark(DATA_DIR, writeRunLog);

/* ---------------- 最早的一批检查点 ----------------
 * 这些在模块求值阶段就跑 —— 若"连第一条都没有"，说明 import 阶段就出事了。
 *
 * ⚠️ 顺序：**先接上 console，再打第一条检查点**。
 *    反过来的话，最早那几行（恰恰是"崩在 import 阶段"时唯一能拿到的信息）
 *    只会出现在 stdout 上 —— 而后台运行时 stdout 是收不到的。
 *
 * ⚠️ 这里**不 catch**：`mark` 对"代码错误"是抛的（见 run-log.js 的说明），
 *    而模块求值期抛错会让 Electron 直接把栈打到 stderr + 进程退出 ——
 *    这正是我们想要的：**宁可启动失败并留下栈，也不要"起来了但取证通道是坏的"。** */
teeConsole(writeRunLog);
mark('module-evaluated', `pid=${process.pid} type=${process.type} node=${process.versions.node}`);

/** 进程级兜底：任何未捕获异常都要落盘（否则崩溃是静默的） */
process.on('uncaughtException', (err) => {
  mark('uncaughtException', `${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'crash-last.txt'), String((err && err.stack) || err), 'utf8');
  } catch {
    /* 已经要退了，尽力而为 */
  }
  /* ⚠️ 崩溃退出前注销 pid 文件。少了这一步，下一次 `service status` 会说
     "运行中"（pid 文件还在、进程号又碰巧被别人用上），而实际上早就崩了 ——
     这正是"状态查询撒谎"最典型的一种。 */
  try {
    removePidFile(DATA_DIR);
  } catch {
    /* 尽力而为 */
  }
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  mark('unhandledRejection', String((reason && reason.stack) || reason).split('\n').slice(0, 3).join(' | '));
});

/* ---------------- Electron 自身的启动失败也要落盘 ----------------
 * ⚠️ 这两条监听器**暂时不注册**（真机踩过：加上它们之后应用从能跑变成 0xC0000005 崩溃）。
 *    它们本身是好的诊断手段，但要**单独验一次**再加回来 ——
 *    不能顺手塞进启动路径。启动失败目前靠 `boot.log` 的检查点序列定位，
 *    以及 `tools/launch.mjs` 的心跳守护（超时没心跳就报警）。 */

/** 数据目录不可写时的原因（null = 可写）。见心跳那一块的说明 */
let dataDirError = null;

/** 心跳：证明"真的起来了"。写在最早，因为后面的步骤都可能崩 */
{
  /* ⚠️⚠️ 这一句原来是**裸的** `fs.mkdirSync`（没有 try，且在模块顶层）。
     数据目录不可写时它会抛 `EPERM`/`ENOTDIR`，模块顶层没有 catch ⇒
     `uncaughtException` ⇒ `exit(1)`。而此刻窗口还没建、GUI 程序没有控制台、
     `boot.log` 也写不进去（就是同一个目录）—— 用户看到的是
     **"双击了，什么都没发生"**。
     这是交付审计逐行走出来的、打包后必然命中的那一条。
     ⇒ 现在：探一次可写性，探不通就记下来，并在 `bootstrap` 里弹一个
        看得见的错误框（`dialog.showErrorBox` 在 ready 之前也能用）。 */
  const probe = probeWritable(DATA_DIR);
  if (!probe.ok) {
    dataDirError = probe.error;
    mark('datadir-UNWRITABLE', `${DATA_DIR} :: ${probe.error}`);
  } else {
    const line =
      `booted=${new Date().toISOString()} pid=${process.pid} ` +
      `electron=${process.versions.electron} node=${process.versions.node} ` +
      `process.type=${process.type} RUN_AS_NODE=${JSON.stringify(process.env.ELECTRON_RUN_AS_NODE)}\n`;
    try {
      fs.writeFileSync(HEARTBEAT, line, 'utf8');
      mark('heartbeat-written');
    } catch (err) {
      mark('heartbeat-FAILED', String(err && err.message));
    }
  }
}

/* ---------------- 更新看门狗（位置是刻意的） ----------------
 *
 * ⚠️⚠️ 必须在**建窗口之前、而且是尽可能早**的地方跑，理由只有一个：
 *    坏更新的典型表现就是**崩在启动路径上** —— 那种情况下窗口根本没建起来，
 *    日志也可能写不出去（数据目录不可写时正是如此）。
 *    如果把计数放在"窗口建好之后"，那么"窗口建不起来"这种最需要回退的故障
 *    恰恰是**永远不会累加计数**的那种 ⇒ 回退机制会在它唯一该起作用的场景里静默失效。
 *
 *     计数之所以在那种极端情况下仍然可靠，是因为它由**上一个好版本**
 *     写下的 `update-state.json` 承载，不依赖本次启动能活多久。
 *
 * 开发态**不参与**：项目目录不是安装出来的，没有"装回去"这回事，
 * 误触发只会把源码树搅乱。 */
const updateGuard = { rollback: false, why: '未检查' };
if (app.isPackaged && !dataDirError) {
  try {
    const r = bootWatchdog({
      dataDir: DATA_DIR,
      currentVersion: app.getVersion(),
      log: (m) => console.log(m),
    });
    updateGuard.rollback = r.rollback;
    updateGuard.why = r.why;
    mark('update-watchdog', r.rollback ? 'ROLLBACK' : 'ok');
    if (r.rollback) {
      const res = rollbackNow({
        dataDir: DATA_DIR,
        currentVersion: app.getVersion(),
        installDir: path.dirname(app.getPath('exe')),
        exePath: app.getPath('exe'),
        resourcesDir: process.resourcesPath,
        rootDir: ROOT,
        why: r.why,
        log: (m) => console.log(m),
      });
      mark('update-rollback', res.ok ? 'spawned' : `FAILED ${res.reason}`);
      /* 助手会等我们退出再把旧版本镜像回去；这里必须立刻退，
         否则我们占着安装目录，它永远拷不动。 */
      if (res.ok) {
        console.log('[update] 已判定这次更新是坏的，交给助手回退并重启');
        app.quit();
      }
    }
  } catch (err) {
    /* 看门狗自己出错**绝不能**影响启动 —— 它是附加保护，不是启动路径 */
    mark('update-watchdog-FAILED', String(err && err.message));
  }
}

/* ---------------- 登记自己（后台运行管理用） ----------------
 *
 * ⚠️ 写在**心跳之后、bootstrap 之前**，位置是刻意的：
 *    `service.mjs start` 会在 spawn 之后等这一份登记。若等到窗口建好才写，
 *    它会白等几秒；若写在模块最前面，那么"import 阶段就崩"的实例也会留下
 *    pid 文件 —— 而那种实例恰恰最需要被识别成"没起来"。
 *    心跳已经是"真的起来了"的最早证据，pid 文件跟着它走最合适。
 *
 * ⚠️ **合并写入**：`service.mjs` 在 spawn 那一刻已经用它知道的 pid 登记过一次，
 *    这里补上应用自己才知道的（启动时刻、版本、日志路径）。直接覆盖会把
 *    `source` 等字段抹掉，而 status 要用它们区分"谁启动的"。
 */
try {
  writePidFile(DATA_DIR, {
    pid: process.pid,
    source: 'app',
    booted: true,
    bootedAt: new Date().toISOString(),
    electron: process.versions.electron,
    node: process.versions.node,
    /* ★ 登记**自己的映像名**（开发态 electron.exe / 打包态 MorningBrief.exe）。
       classifyRun 用它做归属校验：pid 文件说"这个 pid 是我的"，
       而进程列表里那个 pid 的映像名必须与之相符。
       ⚠️ 不登记的话，校验只能退回写死的 "electron" ——
          打包版会被误判成"pid 被复用"，于是 `stop` 报成功却什么都没做。 */
    image: path.basename(process.execPath),
    root: ROOT,
    dataDir: DATA_DIR,
    log: runLogPath(DATA_DIR),
  });
  mark('pidfile-written', `pid=${process.pid}`);
} catch (err) {
  mark('pidfile-FAILED', String(err && err.message));
}

/** 默认精选条数（需求 2 的口径：默认只给精选，更多由用户主动展开） */
const CURATED = Number(process.env.MB_CURATED || 15);

/** 翻页每页条数 */
const PAGE = Number(process.env.MB_PAGE || 15);

/** "看今天全部"模式一次最多取多少条（上限 200 由 db.queryItems 夹取） */
const ALL_LIMIT = Number(process.env.MB_ALL_LIMIT || 120);

/**
 * 有偏好时，候选池取 `want × 这个倍数`（再与 200 夹取）。
 *
 * 为什么需要多取：配额要**从池子里挑**。只取 15 条的话，
 * 池子里可能一条"不喜欢"都没有（它们排在更后面），
 * 于是"不能没有"这条又变成了空话 —— 而这次它连报错都不会有。
 * 取 4 倍是个折中：足够覆盖"不喜欢排得很靠后"的常见情形，
 * 又不至于每次请求都扫全表。 */
const QUOTA_POOL_FACTOR = 4;

/* ---------------- 抓取时刻（默认 07:30，可用环境变量覆盖） ----------------
 *
 * ⚠️ 解析逻辑在 `scheduler.js` 的 `parseFetchTime` 里，**不在这里** ——
 *    因为 `index.js` import 了 electron，离线侧根本加载不了它，
 *    留在这儿就等于那段逻辑永远不可能被测试。
 *    这里是"读环境变量 + 把结果说出来"，一步不多。
 *
 *   MB_FETCH_HOUR=7  MB_FETCH_MINUTE=30   → 07:30（默认就是这个）
 *   非法值会被挡下并退回默认，日志里会明说。
 */
const FETCH_TIME = parseFetchTime(process.env);
const FETCH_AT = formatHm(FETCH_TIME.hour, FETCH_TIME.minute);

/* ---------------- 心跳：**第二个副本已删除** ----------------
 *
 * ⚠️ 这里原本还有第二段一模一样的心跳写入（`mkdirSync` + `writeFileSync(HEARTBEAT)`
 *    + 一句 `catch {}`）。删掉它有三个理由，第三个才是关键：
 *
 *   ① **重复**：上一段（见 `heartbeat-written` 那一块）已经写过同一个文件、
 *      同样内容，第二段纯属白写。
 *   ② **它的失败是静默的**：第一段失败会 `mark('heartbeat-FAILED')` 把原因记进
 *      检查点；第二段只有 `catch {}`。于是同一个故障在两段里表现不一致 ——
 *      看日志的人会以为只有一处会失败。
 *   ③ ★ **它的 `mkdirSync` 没有被 try 包住**（在 `try` 外面）。
 *      这是审查员逐行走出来的真问题：一旦数据目录不可写（打包进 asar、
 *      放在 Program Files、磁盘满），这一句会抛 `ENOTDIR`/`EPERM/`EACCES`，
 *      而模块顶层没有 catch ⇒ `uncaughtException` ⇒ `exit(1)`。
 *      启动检查点全在它**之前**，所以顺序上还留下了一串"看起来正常"的检查点，
 *      然后进程无声退出 —— 对 GUI 子系统程序来说就是**双击没反应**。
 *      （`run-log.js` 的 `createBootMark` 自带 try，裸奔的只有这一处。）
 *
 * ⇒ 心跳只写一次，且写在唯一那个有 try、有失败留痕的地方。
 */

/* ---------------- 数据库（单例连接，**异步打开一次**） ----------------
 *
 * ⚠️ `node:sqlite` **不能在 Electron 主进程顶层静态 import**（真机实测：0xC0000005
 *    原生崩溃、`app.whenReady()` 永不触发、没有任何 JS 报错）。
 *    所以驱动要延迟加载、连接要在 `whenReady` 之后 `await` 打开。
 *
 * ⇒ `getDb()` 保持**同步返回**：因为它在 `whenReady` 里已经 await 过一次，
 *   之后所有调用点都能确定拿到连接。这样 IPC 处理器与调度器都不用变成异步，
 *   而"必须等连接就绪"这件事由启动序列的顺序保证。
 */
let db = null;
function getDb() {
  if (!db) {
    // 走到这里说明调用方早于启动序列 —— 明确报错，不要静默返回 undefined
    throw new Error('数据库尚未就绪：getDb() 只能在 whenReady 初始化之后调用');
  }
  return db;
}

/* ---------------- 写操作串行化 ----------------
 * node:sqlite 的 DatabaseSync 是同步的，但**抓取是异步的**。
 * 若抓取期间用户翻页、而抓取又在写同一张表，就会读到"写了一半"的状态。
 * 用一个极简的 promise 链把写操作串起来 —— 抓取是冷路径，串行不损失体验。 */
let writeChain = Promise.resolve();
function serialize(fn) {
  const run = () => fn();
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/** 组一份"当前简报"给界面 */
function buildBrief({ limit = CURATED, categoryIds = null, todayOnly = false } = {}) {
  const d = getDb();
  /* ⚠️ 夹取：`limit` 来自渲染层，属于**请求参数**，不能直接当口径值用 */
  const want = Math.max(1, Math.min(200, Number.isFinite(Number(limit)) ? Math.round(Number(limit)) : CURATED));
  // "今天"的起点（本地日）—— 查询与计数**用同一个** sinceIso，口径必须逐字一致
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const sinceIso = start.toISOString();

  /* ★★ 配额（本次改动，"少放但不能没有"的落点）。
   *
   * ⚠️⚠️ 为什么不能只做"降权排序"：排序保证不了「不能没有」——
   *     只要喜欢/中性的候选够填满 15 条，不喜欢的那条就被挤到第 16 位以后，
   *     精选里一条都不剩。用户说的是"少放"，而排序给他的是"不放"，
   *     这两件事在用户眼里完全不同。
   * ⇒ 必须**先多取一批候选、再按配额选取**（选取逻辑在 shared/quota.js，
   *   纯函数、可离线穷举 —— 它 import 不了 electron，所以不能写在这个文件里）。
   *
   * ⚠️ 只在**真的有偏好**时才多取：没有任何"喜欢/不喜欢"时，
   *    多取一批纯属浪费（每次请求多扫几百行），而且会让 allMode 的
   *    "看今天全部"变成"看今天的一部分"。 */
  const prefs = prefByCategory(d);
  const hasPref = [...prefs.values()].some((p) => p !== 0);
  const pool = hasPref ? Math.min(200, Math.max(want * QUOTA_POOL_FACTOR, want + 60)) : want;

  const page = queryItems(d, { limit: pool, categoryIds, todayOnly: !!todayOnly, sinceIso });

  let items = page.rows;
  let hasMore = page.hasMore;
  let nextCursor = page.nextCursor;
  let quotaCounts = null;
  let seenIds = null;
  /** 本次实际生效的配额（回给界面做解释用）。没偏好时就是默认那一档。 */
  let quotaUsed = quotaOf(CURATED);
  if (hasPref) {
    /* 条目的偏好归属：一个条目可能同时属于多个类型（多对多），
       口径是"喜欢 > 不喜欢 > 中性"（见 quota.js 的 classOf）。 */
    const byItem = new Map();
    for (const it of page.rows) byItem.set(it.id, []);
    /* ⚠️ 用一条 SQL 把候选的类别一次取出来，而不是每个条目查一次 ——
       200 条 × 1 次查询在冷启动路径上是肉眼可见的卡顿。 */
    if (page.rows.length) {
      const ids = page.rows.map((r) => r.id);
      const rows = d
        .prepare(
          `SELECT item_id, category_id FROM item_category WHERE item_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids);
      for (const r of rows) {
        const list = byItem.get(r.item_id);
        if (list) list.push(r.category_id);
      }
    }
    const candidates = page.rows.map((r) => ({ ...r, categories: byItem.get(r.id) || [] }));
    /* ★ 配额随**筛选范围**的占比缩放（理由见 shared/quota.js 的 scopedQuota）：
       在「全部」下它就是 quotaOf(15) = 3，"少放"一分不松；
       点进那个类型本身时放宽到不设限 —— 用户点的是"我要看这个类型"，
       拿整份精选的 20% 去卡它会把"配比"变成"过滤"。

       ⚠️⚠️ 缩放的**两个输入必须来自同一套筛选口径**，而且分母要是
          "范围内一共有多少条"：我第一版用 `candidates.length`（本次取的候选页）
          当分母 —— 那是个**摆设**，候选页永远是固定上限，点进类型时它不变
          ⇒ 缩放算出来还是 3 条。真实库上的演练（957 条）当场把这个错抓了出来。 */
    const scopeWhere = [];
    const scopeParams = [];
    scopeWhere.push('(published_at >= ? OR (published_at IS NULL AND fetched_at >= ?))');
    scopeParams.push(sinceIso, sinceIso);
    if (categoryIds && categoryIds.length) {
      scopeWhere.push(
        `id IN (SELECT item_id FROM item_category WHERE category_id IN (${categoryIds.map(() => '?').join(',')}))`,
      );
      scopeParams.push(...categoryIds);
    }
    const scopeSql = scopeWhere.join(' AND ');
    /* 范围内一共多少条（与列表同一套口径） */
    const poolSize = d.prepare(`SELECT COUNT(*) AS n FROM item WHERE ${scopeSql}`).get(...scopeParams).n;
    /* 范围内属于"不喜欢"那些类型的**条目数**。
       ⚠️ 一个条目可能同时属于多类，所以这里是"命中任一不喜欢的类型"，
          与 `classOf` 的判定（喜欢优先）刻意**不完全等价** ——
          它只是个缩放的估计量，多算一点点只会让配额略宽，
          而偏向"少算"会让用户点进类型时被莫名砍掉几条（那才是坏的方向）。 */
    const dislikedIds = [];
    for (const [k, v] of prefs.entries()) {
      const n = Number(k);
      if (Number(v) === -1 && Number.isFinite(n)) dislikedIds.push(n);
    }
    const tagged = dislikedIds.length
      ? d
          .prepare(
            `SELECT COUNT(*) AS n FROM item WHERE ${scopeSql} ` +
              `AND id IN (SELECT item_id FROM item_category WHERE category_id IN (${dislikedIds.map(() => '?').join(',')}))`,
          )
          .get(...scopeParams, ...dislikedIds).n
      : 0;
    const effQuota = scopedQuota({ limit: want, poolSize, tagged });
    const sel = selectByQuota({ items: candidates, limit: want, prefByCategory: prefs, quota: effQuota });
    items = sel.picked;
    quotaCounts = sel.counts;
    quotaUsed = sel.quota;

    /* ★ 游标与"还有更多"的处置（配额把池子掐掉之后，这两件事都要重算）。
     *
     * 池子里的候选被跳过了一部分，而游标指向"最后一条**选中**项" ——
     * 于是下一页会**从池子中段重新开始**，把被跳过的那批再取一遍，
     * 用户看到的是同一条出现两次（"翻页坏了"的典型观感）。
     *
     * ⚠️ 我刻意**不**在渲染层顺手去重：那是把口径问题藏进 UI，
     *    日志里会彻底消失（本项目已经栽过两次同类：靠 UI 兜底 = 没有证据）。
     *    ⇒ 正确的处置是把"本页已经在池子里见过的 id"记进游标，
     *      翻页时显式跳过它们 —— 跳过是**有据可查**的行为，去重是掩盖。
     *
     * ⚠️ 只在有偏好时才这么做：没有偏好时池子就是页本身，
     *    多带一份 id 列表只会让游标变胖。 */
    seenIds = page.rows.map((r) => r.id);
    hasMore = page.hasMore || candidates.length > items.length;
    const last = items[items.length - 1];
    nextCursor =
      hasMore && last
        ? { publishedAt: last.published_at, id: last.id, pendingNull: last.published_at === null, seenIds }
        : null;
  }

  const health = sourceHealth(d);
  const lastIngest = getMeta(d, 'last_ingest_at');
  /* ★ "今天到底抓到没有"（本轮修复的另一半）。
     ⚠️ 为什么需要单独一个布尔量：抓取全失败时**库里还有昨天/更早的数据**，
        于是总览句照常说"今天共 N 条"，用户完全看不出今天其实一次都没成功。
        对一个"每天一次"的产品，那是最误导人的一种状态 ——
        界面上一切正常，只是内容不是今天的。
     ⇒ 判据用 `last_success_at`（有源成功才算），与调度器同一口径。 */
  const lastSuccess = getMeta(d, 'last_success_at');
  const fetchedToday = !!lastSuccess && Date.parse(lastSuccess) >= Date.parse(sinceIso);

  /* ★ 两个数必须分开（真机踩过）：
   *   todayTotal    = **不带筛选**的当日总数   → 决定"看今天全部"按钮**存不存在**
   *   filteredTotal = **带筛选**的当日总数     → 决定"还有没有更多可以翻"
   *   第一版只有一个 todayCount，而且用 `todayCount > items.length` 判断按钮可见性。
   *   于是"看今天全部"一旦把列表加载到等于总数，**按钮就把自己藏起来了** ——
   *   用户看到的现象是"点了之后按钮就消失了，收起一下它才回来"。
   *   ⇒ 按钮的存在性必须由**与"已显示多少"无关**的量决定。 */
  const todayTotal = countItems(d, { sinceIso });
  const filteredTotal = categoryIds && categoryIds.length ? countItems(d, { sinceIso, categoryIds }) : todayTotal;

  return {
    items,
    hasMore,
    nextCursor,
    todayTotal,
    filteredTotal,
    totalShown: items.length,
    health,
    categories: listCategories(d),
    lastIngestAt: lastIngest,
    lastSuccessAt: lastSuccess,
    fetchedToday,
    /* ★ 配额口径随简报一起给出去（本次改动）：界面要能说出
       "不喜欢的最多 3 条" —— 用户设了"不喜欢"却看不到任何解释的话，
       他会以为设置没生效。数字**只有这一个来源**（shared/quota.js）。
       ⚠️ 这里给的是**本次实际用的**那一档（它随筛选范围缩放，见 scopedQuota），
          而不是写死的 quotaOf(CURATED) —— 否则界面上的解释与实际行为对不上，
          那正是本项目反复栽过的"文案与行为不符"。 */
    quota: quotaUsed,
    quotaCounts,
    /* ★★ `curated` 是**服务端口径常量**，不是"本次请求的 limit"（真机第三轮返工）。
     *
     * 旧代码写的是 `curated: limit` —— 一个回显。渲染层拿它去判断
     * `todayTotal > curated` 该不该显示「看今天全部」，于是：
     *   点「看今天全部」→ 渲染层请求 limit=60 → 服务端回显 curated=60
     *   → 判定 45 > 60 为假 → **按钮把自己藏了**，而且这个错值会一直留在
     *   渲染层状态里，收起、刷新都救不回来。
     * 这就是"按钮可见性取决于它自己的效果"（自指）的完整链路。
     * ⇒ 现在这里**只回口径常量**；请求实际用了多少条另用 `limitUsed` 如实报出，
     *   两者不再混用。渲染层也不再拿 `curated` 反推任何按钮。 */
    curated: CURATED,
    limitUsed: want,
    todayOnly: !!todayOnly,
    /* 日期边界随简报一起给渲染层：翻页时它原样带回来，
       保证第 2 页与第 1 页用的是**同一个**边界（跨午夜也不会错位）。 */
    sinceIso,
    activeCategory: categoryIds && categoryIds.length ? categoryIds[0] : null,
    dataDir: DATA_DIR,
  };
}

/* ---------------- 卡片状态 ---------------- */
const cardState = { value: 'collapsed' };

/**
 * 拖动处理（JS 手动拖动的**主进程侧**）。
 *
 * ⚠️ 三条都是真机取证过的修法，别再动：
 *   ① 坐标**进入算术前取整**（`screenX/Y` 是小数 ⇒ 窗口边拖边变大）
 *   ② 位置**对齐物理像素网格**（150% 下奇数坐标 ⇒ 尺寸多 1px）
 *   ③ 尺寸取**设计值**，不每帧现读（现读会把被撑大的值逐帧传递）
 */
function makeDragHandler(win) {
  let session = null;
  return (payload) => {
    if (!win || win.isDestroyed()) return { ok: false, reason: '窗口不存在' };
    const p = payload || {};
    const phase = p.phase;
    const cx = Math.round(Number(p.x) || 0);
    const cy = Math.round(Number(p.y) || 0);

    if (phase === 'begin') {
      const b = win.getBounds();
      const d = screen.getDisplayNearestPoint({ x: cx, y: cy });
      const step = alignToPhysicalGrid(cx, cy, d.scaleFactor);
      session = {
        bx: b.x,
        by: b.y,
        cx: step.x,
        cy: step.y,
        size: CARD_SIZE[cardState.value] || CARD_SIZE.collapsed,
        step: step.step,
        scale: d.scaleFactor,
        moved: 0,
      };
      return { ok: true, phase, start: { x: b.x, y: b.y } };
    }

    if (!session) return { ok: false, reason: '没有活跃拖动会话' };

    if (phase === 'move') {
      const d = screen.getDisplayNearestPoint({ x: cx, y: cy });
      const g = alignToPhysicalGrid(cx, cy, d.scaleFactor);
      if (g.x === session.cx && g.y === session.cy) return { ok: true, moved: false };
      const nx = session.bx + (g.x - session.cx);
      const ny = session.by + (g.y - session.cy);
      session.moved = Math.max(Math.abs(g.x - session.cx), Math.abs(g.y - session.cy));
      win.setBounds({ x: nx, y: ny, width: session.size.w, height: session.size.h });
      const after = win.getBounds();
      return {
        ok: true,
        moved: true,
        expect: { x: nx, y: ny },
        actual: { x: after.x, y: after.y },
        sizeExact: after.width === session.size.w && after.height === session.size.h,
      };
    }

    if (phase === 'end') {
      const b = win.getBounds();
      const d = screen.getDisplayMatching(b);
      const g = alignToPhysicalGrid(b.x, b.y, d.scaleFactor);
      const want = CARD_SIZE[cardState.value] || CARD_SIZE.collapsed;
      win.setBounds({ x: g.x, y: g.y, width: want.w, height: want.h });
      const settled = win.getBounds();
      const sizeExact = settled.width === want.w && settled.height === want.h;
      console.log(
        `[drag] end 落点=(${settled.x},${settled.y}) 尺寸=${settled.width}x${settled.height} ` +
          `（设计 ${want.w}x${want.h}）尺寸精确=${sizeExact} 网格步长=${g.step}`,
      );
      session = null;
      return { ok: true, phase, settled, sizeExact };
    }
    return { ok: false, reason: `未知阶段 ${phase}` };
  };
}

/* ---------------- 置底 ---------------- */
let levelApplied = { ok: false, status: 'not-attempted', detail: null };
async function applyBottomLevel(win) {
  try {
    win.setAlwaysOnTop(false);
  } catch {
    /* 失败也继续 */
  }
  const hwnd = nativeHwnd(win);
  if (!hwnd) {
    levelApplied = { ok: false, status: 'failed', detail: '取不到窗口原生句柄（不猜，故不置底）' };
    console.log(`[level] ✗ ${levelApplied.detail}`);
    return levelApplied;
  }
  /* ★ 置底脚本必须**在项目内**，而且打包后必须**在 asar 外**。
   *
   * ⚠️ 两个坑叠在一起，缺一条就静默失效：
   *   ① 原来这里指向项目**外面**的 m0-probe 目录 —— 项目一搬走路径就断了。
   *   ② 修好 ① 之后，打包又会遇到第二个：脚本进了 asar，
   *      而 `powershell.exe -File` **读不了 asar 里的路径**
   *      （PowerShell 不认识那个"文件里的文件系统"）。
   *      ⇒ 所以走 `runtimeAsset`，它在打包态指向 `resources/` 下的真实文件。
   *      这一条不补的话，打包版**置底会静默失效**：
   *      卡片浮在所有窗口上面，而日志里只有一行 unavailable。 */
  const script = runtimeAsset(path.join('tools', 'win', 'set-window-level.ps1'));
  if (!fs.existsSync(script)) {
    levelApplied = { ok: false, status: 'unavailable', detail: `找不到置底脚本：${script}` };
    console.log(`[level] ✗ ${levelApplied.detail}`);
    return levelApplied;
  }
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ProcessId', String(process.pid), '-Mode', 'bottom', '-WindowHandle', hwnd],
        { timeout: 15000, windowsHide: true, encoding: 'utf8' },
        (err, stdout) => (err ? reject(Object.assign(err, { stdout })) : resolve(stdout)),
      );
    });
    const raw = JSON.parse(String(out).replace(/^\uFEFF/, '').trim());
    // ★ 归属校验：脚本动的必须是我们给的那个句柄
    const ok = raw.ok === true && String(raw.hwnd) === hwnd;
    levelApplied = { ok, status: ok ? 'applied' : 'failed', detail: raw.detail || JSON.stringify(raw), raw };
  } catch (err) {
    levelApplied = { ok: false, status: 'failed', detail: `调用置底脚本失败：${err.message}` };
  }
  console.log(`[level] ${levelApplied.status} —— ${levelApplied.detail}`);
  return levelApplied;
}

/* ---------------- 启动 ---------------- */
let cardWin = null;
let scheduler = null;
/** 停止请求的轮询器（见 bootstrap 里的说明） */
let stopWatcher = null;
/** 托盘。⚠️ 必须是模块级引用 —— 局部变量会被 GC 掉，托盘图标随即消失 */
let tray = null;

/**
 * 启动序列。
 *
 * ⚠️ 为什么不再直接写 `app.whenReady().then(init)`（真机踩过）：
 *    在某条启动路径下，**模块求值时 `ready` 已经触发过**，
 *    此时再挂 `.then()` 会**永远不执行** —— 表现为"进程活着、窗口没有、
 *    没有任何报错"。检查点日志里就是 `heartbeat-written` 之后什么都没有。
 *    ⇒ 先查 `app.isReady()`，已经就绪就直接跑；否则才挂 `.then()`。
 */
async function bootstrap() {
  mark('bootstrap-enter');

  /* ★ 数据目录不可写 → **必须让用户看见**。
     这是"双击没反应"的唯一解药：GUI 程序没有控制台，光退出等于什么都没说。
     `dialog.showErrorBox` 在 `ready` 之前也能用，而且它是**原生**消息框 ——
     不依赖我们自己的窗口，所以在我们连窗口都建不起来时它照样能弹出来。 */
  if (dataDirError) {
    const msg =
      `晨报机需要一个可写的数据目录，但下面这个位置写不进去：\n\n${DATA_DIR}\n\n` +
      `原因：${dataDirError}\n\n` +
      `它要放数据库与运行日志。可以：\n` +
      `  · 检查该目录的权限，或看杀毒软件有没有拦住它\n` +
      `  · 若它落在网盘同步目录里，先暂停同步\n` +
      `  · 或者设置环境变量 MB_DATA_DIR 指到别处`;
    console.error('[main] ✗ ' + msg.replace(/\n+/g, ' '));
    try {
      const { dialog } = await import('electron');
      dialog.showErrorBox('晨报机 · 无法启动', msg);
    } catch {
      /* 弹不出来就只能靠日志了 */
    }
    app.quit();
    return;
  }

  try {
    // ★ 必须 await：驱动是延迟加载的（见 getDb 上方的说明）
    db = await openDb(DB_FILE);
    mark('db-opened', DB_FILE);
  } catch (err) {
    mark('db-FAILED', String(err && err.message));
    console.error('[main] ✗ 数据库打不开：', err && err.message);
    app.quit();
    return;
  }

  try {
    cardWin = createCardWindow({ expanded: false });
    mark('card-window-created');

    /* ★ 主动让渲染层做一次 DOM 自检。
       为什么：真机反馈"筛选没有 / 按钮消失"，而我在离线侧看不到界面，
       靠读代码推理连续两次没打中。⇒ 把"界面到底长什么样"变成终端里的一行 JSON。
       时机放在数据刷新之后（否则读到的是空列表，没意义）。 */
    cardWin.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        if (!cardWin || cardWin.isDestroyed()) return;
        cardWin.webContents
          .executeJavaScript('window.MB_DOMCHECK ? window.MB_DOMCHECK("main-triggered") : "MB_DOMCHECK 未定义"')
          .catch((err) => mark('domcheck-FAILED', String(err && err.message)));
      }, 3500);
    });
  } catch (err) {
    mark('card-window-FAILED', String(err && err.message));
    console.error('[main] ✗ 建窗口失败：', err && err.message);
    app.quit();
    return;
  }

  const drag = makeDragHandler(cardWin);

  /* ★ 抓取动作**只定义一次**，界面按钮与托盘菜单共用。
     ⚠️ 不这么做的后果是"两份口径"：托盘那份漏了 `serialize`、
     或者漏了推 `brief:updated`，于是从托盘刷新时界面不更新，
     而用户会以为"托盘的刷新不管用"。 */
  const doIngest = (trigger, categoryIds = null) =>
    serialize(async () => {
      const r = await runIngest({
        dbFile: DB_FILE,
        trigger,
        /* ★ 界面刷新时带当前选中的类型 ⇒ 只抓**该类型绑定的源并集**；
           托盘刷新不带（= null）⇒ 抓全部启用源 —— 托盘是"我现在就要
           最新的一份"，不该被卡片上的筛选状态影响。 */
        categoryIds,
        log: (m) => console.log('[ingest]', m),
      });
      // 抓完通知界面刷新
      if (cardWin && !cardWin.isDestroyed()) cardWin.webContents.send('brief:updated', buildBrief());
      return {
        ok: r.ok,
        failed: r.failed,
        newItems: r.newItems,
        health: r.health,
        scope: r.scope,
        scopedEmpty: !!r.scopedEmpty,
      };
    });

  const setCardExpanded = (on) => {
    cardState.value = on ? 'expanded' : 'collapsed';
    setCardState(cardWin, cardState.value);
    return cardState.value;
  };

  /* ---------------- 更新：检查与安装 ----------------
   *
   * 口径（用户定的）：**只提示，用户点了才装**，不静默更新。
   *   理由：这是个常驻桌面的挂件 —— 静默装完重启，等于在用户正看简报时
   *   把卡片抽走再放回来，而且他不会知道发生过什么。
   *
   * 两段式：第一次点 = 查；查到之后菜单变成"更新到 x.y.z"，第二次点 = 装。
   *   把"查"和"装"分开，是为了让"我点了它却什么都没发生"这种情况不存在 ——
   *   每一次点击都会让菜单文字或日志发生变化。
   */
  let updateBusy = false;
  let updateReady = null;   // 已确认可用、等用户点第二次的清单
  let updateNote = '';      // 上一次检查的结论（显示在菜单里）

  /* 外部触发：数据目录里放一个 `update-request` 文件，下次启动就真的去装。
     与 `stop-request` 完全同一套做法 —— 命令行、脚本、运维都用得上。
     它也让"演练一次真实升级"不必有人去点托盘的第二次点击。 */
  const UPDATE_REQUEST = path.join(DATA_DIR, 'update-request');
  const consumeUpdateRequest = () => {
    try {
      if (!fs.existsSync(UPDATE_REQUEST)) return false;
      fs.rmSync(UPDATE_REQUEST, { force: true });
      console.log('[update] 收到外部更新请求（数据目录里的 update-request 文件）');
      return true;
    } catch {
      return false;
    }
  };

  const updateMenuLabel = () => {
    if (updateBusy) return '正在处理更新…';
    if (updateReady) return `✅ 更新到 ${updateReady.version}（点击安装并重启）`;
    return updateNote ? `检查更新（${updateNote}）` : '检查更新';
  };

  const runUpdateCheck = async ({ interactive = false } = {}) => {
    if (updateBusy) return;
    /* 开发态不参与自更新：项目目录不是"装"出来的，没有装回去这回事。
       误触发只会把源码树搅乱，所以这里明确拒绝而不是"试试看"。 */
    if (!app.isPackaged) {
      updateNote = '开发态不支持';
      if (interactive) console.log('[update] 开发态不参与自更新');
      return;
    }
    if (!updateReady) {
      updateBusy = true;
      try {
        const r = await checkForUpdate({
          dataDir: DATA_DIR,
          currentVersion: app.getVersion(),
          log: (m) => console.log(m),
        });
        if (r.action === 'available') {
          updateReady = r.manifest;
          updateNote = '';
          if (interactive) console.log(`[update] 发现新版本 ${r.manifest.version}，再点一次即安装`);
        } else {
          updateNote = r.action === 'none' ? '已是最新' : '检查失败';
        }
      } catch (err) {
        updateNote = '检查失败';
        console.log('[update] 检查异常：' + (err && err.message));
      } finally {
        updateBusy = false;
      }
      if (!updateReady) return;
      if (!interactive) return;   // 自动检查只负责把菜单点亮
    }

    /* 第二次点击（或用户在已知有新版时点击）⇒ 下载 + 装 */
    updateBusy = true;
    try {
      console.log(`[update] 开始下载 ${updateReady.version} …`);
      const dl = await downloadUpdate({
        manifest: updateReady,
        dataDir: DATA_DIR,
        log: (m) => console.log(m),
        onProgress: (got, total) => {
          if (total && got % (8 * 1024 * 1024) < 65536) {
            console.log(`[update] 下载中 ${formatBytes(got)} / ${formatBytes(total)}`);
          }
        },
      });
      const res = applyUpdate({
        dataDir: DATA_DIR,
        currentVersion: app.getVersion(),
        manifest: updateReady,
        installerFile: dl.file,
        installDir: path.dirname(app.getPath('exe')),
        exePath: app.getPath('exe'),
        resourcesDir: process.resourcesPath,
        rootDir: ROOT,
        log: (m) => console.log(m),
      });
      if (!res.ok) {
        updateNote = '安装准备失败';
        updateBusy = false;
        return;
      }
      console.log('[update] 已交给助手安装，本进程即将退出以便替换文件');
      /* 必须退：Windows 锁着我们正在运行的那些文件，助手在等我们消失。 */
      app.quit();
    } catch (err) {
      console.log('[update] 下载/安装失败：' + (err && err.message));
      updateNote = '下载失败';
      updateBusy = false;
    }
  };

  registerIpc({
    getBrief: (opts) => buildBrief(opts),
    /* ⚠️ 翻页必须**带上筛选条件**（真机踩过）：
       第一版 getMore 只收 cursor、丢掉了 categoryIds，
       于是"筛了类别之后再翻页"会翻出**不属于该类别**的条目。
       ⚠️ 还要带上 `todayOnly`：否则「看今天全部」模式翻到第 2 页就翻出
       前几天的条目 —— 与按钮文案不符（同一类 bug 的第二次现身）。 */
    getMore: ({ cursor, categoryIds, todayOnly, sinceIso }) => {
      const d = getDb();
      const page = queryItems(d, {
        limit: PAGE,
        cursor,
        categoryIds: categoryIds || null,
        todayOnly: !!todayOnly,
        sinceIso: sinceIso || null,
        /* ⚠️ 配额翻页：游标里带着"首页已经在池子里见过的 id"，
           翻页必须显式跳过它们，否则同一条会出现两次（见 db.queryItems 的说明）。 */
        skipIds: (cursor && cursor.seenIds) || null,
      });
      return { items: page.rows, hasMore: page.hasMore, nextCursor: page.nextCursor };
    },
    createCategory: (name) => {
      const d = getDb();
      const clean = String(name || '').trim().slice(0, 12);
      if (!clean) return { ok: false, reason: '类别名不能为空' };
      const existing = listCategories(d).find((c) => c.name === clean);
      if (existing) return { ok: false, reason: '这个类别已经存在' };
      const max = listCategories(d).reduce((m, c) => Math.max(m, c.sort_order), -1);
      upsertCategory(d, clean, max + 1, new Date().toISOString());
      console.log(`[category] 新增「${clean}」`);
      return { ok: true, name: clean, categories: listCategories(d) };
    },

    /* ---------------- 筛选栏（本次功能） ----------------
     * 四件事：删除类型 / 读「类型包含哪些源」/ 写「类型包含哪些源」/ 三档偏好。
     *
     * ⚠️ 四条都要**把结果说清楚**（ok + 原因 + 最新状态）：
     *    渲染层拿它决定提示文案，而且**失败必须说出来** ——
     *    静默失败在这里的表现是"用户勾了、界面也勾上了、但库里没变"，
     *    下次启动那个勾就没了，用户会以为"设置存不住"。 */
    deleteCategory: (id) => {
      const d = getDb();
      const r = deleteCategory(d, id);
      if (!r.ok) {
        console.log(`[category] ✗ 删除失败：${r.reason}`);
        return { ok: false, reason: r.reason };
      }
      /* ★★ 删除只影响分类与绑定，**条目一条都不动** ——
         这是"勾选/取消勾选是可逆的筛选，不是删除"这条语义的边界。
         这里把条目数**如实报出来**（rs.itemsKept），日志与提示都能自证。 */
      console.log(
        `[category] 已删除「${r.removed.name}」：解除 ${r.removed.tags} 条条目标签、` +
          `${r.removed.bindings} 个源绑定；条目仍然保留 ${r.itemsKept} 条`,
      );
      return { ok: true, removed: r.removed, itemsKept: r.itemsKept, categories: listCategories(d) };
    },
    getCategorySources: (id) => {
      const d = getDb();
      const bound = listSourceIdsOfCategory(d, id);
      const boundSet = new Set(bound.map(Number));
      /* ★★ 清单里**只能有已绑定的源** —— 这一条是真机量出来的缺陷。
       *
       * ⚠️ 我第一版写的是 `listSources(d)`（库里全部 36 个源），理由看着挺合理：
       *    "让用户看到别的源，好把它们勾进来"。真机上的实际后果是：
       *    打开「开源与工程」（只绑了 9 个）时，面板里列出 **36 行**，
       *    内容高度 397px 而可视区只有 155px ⇒
       *    「喜欢程度」三档与「删除类型」整个掉到面板外面，用户**点不到**。
       *    而这一切在离线考裁判里**一声都不响** —— 那份假清单只有 9 个源，
       *    面板自然装得下。典型的"只有真实数据规模才会暴露"的缺陷，
       *    我是靠真机量具（量出 count=36）才看见的。
       *
       * ⇒ 口径改成：面板只列**这个类型包含的源**。
       *    "把别的源加进来"改由面板底部的「＋ 添加源」承担（用户粘贴一个 feed 地址）——
       *    不能靠"把所有源都堆在面板里"来兜底：
       *    宁可少一个功能，也不能让主要操作点不到。 */
      return {
        ok: true,
        categoryId: Number(id),
        sourceIds: bound,
        /* 源清单与健康度一起给出去：界面要显示"这个源上次抓成功没有"，
           否则用户会往一个已经死掉的源上勾选。 */
        sources: listSources(d)
          .filter((s) => boundSet.has(Number(s.id)))
          .map((s) => ({
            id: Number(s.id),
            name: s.name,
            enabled: !!s.enabled,
            lastStatus: s.last_status || null,
            lastError: s.last_error || null,
          })),
      };
    },
    setCategorySources: (id, sourceIds) => {
      const d = getDb();
      const r = setCategorySources(d, id, sourceIds);
      if (!r.ok) {
        console.log(`[category] ✗ 写入源映射失败：${r.reason}`);
        return r;
      }
      const c = listCategories(d).find((x) => Number(x.id) === r.categoryId);
      console.log(`[category] 「${c ? c.name : r.categoryId}」现在包含 ${r.sourceIds.length} 个源`);
      return { ...r, categories: listCategories(d) };
    },

    /* ---------------- 「＋ 添加源」（阶段 A） ----------------
     *
     * 用户粘贴一个 feed 地址，主进程负责**先验再存**：
     *   ① 协议白名单（复用 url-guard —— 这是安全边界，不是可选步骤）
     *   ② 真的抓一次、真的解析一次 —— **解析成功才入库**
     *   ③ 地址已存在就明确告知（并区分"是预置源"还是"你加过"）
     *
     * ⚠️⚠️ 为什么必须"先验再存"：不验的话，用户粘一个网页地址进来，
     *    它会被存成一个**永远失败的源**，界面上从此多一个"源异常"，
     *    而用户不知道那是自己加错了 —— 他会以为是程序坏了。
     *    验过之后，"加不进去"和"加进去了但抓不到"是两件能被分开的事。
     *
     * ⚠️ 为什么不校验"抓到的条目数与分类是否合理"：那是猜测。
     *    只要它是一份能解析出条目的合法 feed，就如实收下。
     */
    addSource: async (payload) => {
      const d = getDb();
      const p = payload || {};

      /* ① 纯判定（在可被离线穷举的 feed-url.js 里，含"不许本机/内网地址"） */
      const v = validateNewSource(p);
      if (!v.ok) {
        console.log(`[source] ✗ 拒绝添加：${v.reason}`);
        return { ok: false, reason: v.reason };
      }
      /* ② 再走一次协议白名单：与"点击打开"共用同一条安全边界。
         ⚠️ 这不是重复劳动 —— feed-url 管"像不像一个源地址"，
            url-guard 管"这个协议能不能出网"，两者谁都不能替代谁。 */
      const ug = validateExternalUrl(v.feedUrl);
      if (!ug.ok) {
        console.log(`[source] ✗ 拒绝添加：${ug.reason}`);
        return { ok: false, reason: ug.reason };
      }
      const url = v.feedUrl;
      const name = v.name;
      if (listSources(d).some((s) => s.feed_url === url)) {
        return { ok: false, reason: '这个地址已经在库里了' };
      }

      /* ③ **先验再存**：用与正式抓取同一个 fetchText 真抓一次、真解析一次。
         ⚠️⚠️ 少了这一步，用户粘一个网页地址进来会存成一个**永远失败的源**，
            界面上从此多一个"源异常"，而用户不知道那是自己加错了 ——
            他会以为程序坏了。验过之后，"加不进去"和"加进去了但抓不到"
            是两件能被分开的事。 */
      let parsed = null;
      let fetchErr = null;
      try {
        const res = await fetchText(url);
        if (!res.ok) fetchErr = res.error || `HTTP ${res.status}`;
        else parsed = parseFeed(res.text, { sourceName: name });
      } catch (err) {
        fetchErr = (err && err.message) || String(err);
      }
      if (fetchErr) {
        console.log(`[source] ✗ 试抓失败（不存入）：${url} —— ${fetchErr}`);
        return { ok: false, reason: `抓不到这个地址：${fetchErr}` };
      }
      if (!parsed || !parsed.ok) {
        const kind = (parsed && parsed.contentKind) || '认不出';
        console.log(`[source] ✗ 不是可解析的 feed（不存入）：${url} —— ${kind}`);
        return {
          ok: false,
          reason: `这个地址不是可解析的 feed（实际拿到的是「${kind}」）。只支持 RSS / Atom。`,
        };
      }

      /* 到这里 parsed 一定是 ok 的 ⇒ format 一定有值。
         ⚠️ 写一句 fail-fast 而不是 `parsed.format || 'rss'`：
            兜底默认值会把"解析器改了、format 字段没了"这种**开发错误**
            悄悄变成一个看起来正常的源，而错误的落点离现场很远。
            （这条与 `_FALLBACK` 那个"缺省值必须站在正常那边"的教训相反 ——
              那里缺省值是"给用户看的"，这里缺省值是"掩盖逻辑错误"。） */
      if (!parsed.format) throw new Error('解析成功却没有 format —— parseFeed 的契约变了');

      const add = addCustomSource(d, { name, feedUrl: url, kind: parsed.format }, new Date().toISOString());
      if (!add.ok) return { ok: false, reason: add.reason, existed: add.existed };

      /* ⚠️ 顺手绑到**当前类型**：用户是在某个类型的编辑面板里加的源，
         不绑的话它会是一个"抓得到但哪个类型都不属于"的孤儿 ——
         用户加完切回列表却什么也看不到，会以为没加上。 */
      const catId = Number(p.categoryId);
      if (Number.isFinite(catId)) {
        const cur = listSourceIdsOfCategory(d, catId);
        if (!cur.includes(add.id)) setCategorySources(d, catId, cur.concat([add.id]));
      }

      console.log(
        `[source] ✓ 已添加自定义源「${name}」${url}（${parsed.format}，试抓拿到 ${parsed.items.length} 条）` +
          (Number.isFinite(catId) ? `，并绑到类型 ${catId}` : ''),
      );
      return {
        ok: true,
        id: add.id,
        name,
        feedUrl: url,
        format: parsed.format,
        itemCount: parsed.items.length,
        categories: listCategories(d),
      };
    },

    setCategoryPref: (id, pref) => {
      const d = getDb();
      const r = setCategoryPref(d, id, pref);
      if (!r.ok) {
        console.log(`[category] ✗ 写入偏好失败：${r.reason}`);
        return r;
      }
      const label = r.pref === 1 ? '喜欢' : r.pref === -1 ? '不喜欢' : '中性';
      /* ⚠️ 这里报的是**「全部」口径下**的配额（3 条）。点进这个类型本身时
         配额会随范围缩放（见 shared/quota.js 的 scopedQuota），所以文案里
         必须带上"在全部里"，否则用户点进类型看到不止 3 条时会以为配额坏了。 */
      console.log(`[category] 「${r.name}」的偏好 = ${label}（在「全部」里最多 ${quotaOf(CURATED)} 条，且至少 1 条）`);
      return { ...r, categories: listCategories(d), quota: quotaOf(CURATED), quotaScope: 'all' };
    },

    runIngest: doIngest,
    listCategories: () => listCategories(getDb()),
    setCardState: (next) => {
      setCardExpanded(next === 'expanded');
    },
    /* ⚠️ 这里原来是 minimize: () => setCardExpanded(false) ——
       它对应的 IPC 通道 card:minimize 渲染层一次都没调用过（死通道），阶段 B 删掉。 */
    drag,
    applyLevel: (mode) => (mode === 'bottom' ? applyBottomLevel(cardWin) : Promise.resolve(levelApplied)),
    markOpened: (id) => {
      try {
        getDb().prepare("UPDATE item SET read_state = 'opened' WHERE id = ?").run(id);
      } catch {
        /* 标记失败不影响打开 */
      }
    },
    /* 渲染层的日志经 IPC 回到主进程。`console.log` 已经接到统一日志文件上了
       （见文件上方的 teeConsole），所以这里只需要打一次 —— 再单独写一次
       会让同一行在文件里出现两遍。 */
    log: (m) => console.log(m),
  });

  mark('ipc-registered');

  /* ---------------- 托盘：收包的人唯一的退出方式 ----------------
   *
   * ⚠️⚠️ 为什么这一块是**打包分发的必需品**，而不是"锦上添花"：
   *
   *   卡片窗口是 `frame:false` + `skipTaskbar:true` + 不可缩放，界面上也**没有
   *   退出按钮**（那是刻意的：关闭按钮会和"点击即展开/收起"打架）。
   *   在开发机上这没问题 —— 有 `tools/service.mjs stop`、有三个 .vbs。
   *   但打包之后那三样**全都不存在**（.vbs 要 node，service.mjs 要 node +
   *   `node_modules/electron/dist/electron.exe`）。
   *
   *   ⇒ 没有托盘的话，收包的人**只能去任务管理器结束进程**。
   *     这比工程自己写的原则（"一个用户装了就该能关掉的程序，不能要求
   *     管理员权限才能关"）更糟：**没有任何路径**。
   *
   * ⚠️ 托盘图标必须**显式进包**：electron-builder 的 `buildResources`（默认
   *   `build/`）不会被打进 asar，所以托盘图标走的是 `src/renderer/assets/`
   *   （它在 asar 里，Electron 的 fs 补丁能读到）。
   */
  try {
    const iconFile = runtimeAsset(path.join('assets', 'tray-16.png'));
    if (!fs.existsSync(iconFile)) {
      mark('tray-SKIPPED', `找不到托盘图标：${iconFile}（跑 node tools/make-icon.mjs 生成）`);
      console.log(`[tray] ✗ 找不到托盘图标，跳过：${iconFile}`);
    } else {
      const { Tray, Menu, nativeImage, shell } = await import('electron');
      const img = nativeImage.createFromPath(iconFile);
      if (img.isEmpty()) {
        mark('tray-FAILED', '托盘图标解不开（文件在，但不是合法 PNG）');
        console.log('[tray] ✗ 托盘图标解不开，跳过');
      } else {
        tray = new Tray(img);
        tray.setToolTip('晨报机');
        const rebuildMenu = () => {
          if (!tray || tray.isDestroyed()) return;
          const last = getMeta(getDb(), 'last_success_at');
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: cardState.value === 'expanded' ? '收起卡片' : '展开卡片', click: () => setCardExpanded(cardState.value !== 'expanded') },
              { type: 'separator' },
              { label: '立即刷新（抓一遍全部源）', click: () => { doIngest('tray'); } },
              { label: '打开数据目录', click: () => { shell.openPath(DATA_DIR); } },
              { type: 'separator' },
              {
                label: last ? `上次成功抓取：${new Date(last).toLocaleString()}` : '还没有成功抓取过',
                enabled: false,
              },
              { label: `下次抓取：${nextRunAt(new Date(), FETCH_TIME.hour, FETCH_TIME.minute).toLocaleString()}`, enabled: false },
              { type: 'separator' },
              {
                label: updateMenuLabel(),
                enabled: !updateBusy,
                click: () => { void runUpdateCheck({ interactive: true }); },
              },
              { type: 'separator' },
              /* ★ 收包的人要的就是这一项。它走 `app.quit()`，于是
                 `will-quit` 会把 pid 文件与停止请求一并清掉 —— 与
                 `service.mjs stop` 走的是同一条退出路径。 */
              { label: '退出晨报机', click: () => app.quit() },
            ]),
          );
        };
        rebuildMenu();
        // 菜单里的"上次抓取/下次抓取"是会变的，展开/收起也是 —— 每次弹出前重算一次
        tray.on('click', () => {
          setCardExpanded(cardState.value !== 'expanded');
          rebuildMenu();
        });
        mark('tray-created');
        console.log('[tray] 已创建（右键菜单：展开/刷新/打开数据目录/检查更新/退出）');

        /* ★★ 走到这里才算"这次启动真的健康" —— 窗口建起来了、托盘也起来了。
           更新看门狗就是拿这一句当作"新版本没问题"的证据；
           少了它，装了新版之后每次启动都会被计入失败次数，最后无辜地自动回退。
           （所以它必须放在托盘创建**成功之后**，不能提前到 bootstrap 开头。） */
        try {
          const h = markHealthy({
            dataDir: DATA_DIR,
            currentVersion: app.getVersion(),
            log: (m) => console.log(m),
          });
          if (h.changed) mark('update-healthy', h.state.current);
        } catch (err) {
          mark('update-healthy-FAILED', String(err && err.message));
        }

        /* 启动后延迟查一次更新。
            失败只记日志、绝不打扰用户；
            但若数据目录里有 `update-request`，就当成"用户已经同意装"直接走完。 */
        setTimeout(() => {
          void runUpdateCheck({ interactive: consumeUpdateRequest() });
        }, 8000);
      }
    }
  } catch (err) {
    /* ⚠️ 托盘建不起来**不该拖垮启动** —— 它是一个便利入口，
       而不是主功能。但必须留痕（`mark` + stderr），否则就成了静默缺失。 */
    mark('tray-FAILED', String(err && err.message));
    console.log(`[tray] ✗ 创建失败（不影响主功能）：${err && err.message}`);
  }

  // 置底（窗口已建、尺寸已校正，此刻 hwnd 定了）
  try {
    await applyBottomLevel(cardWin);
    mark('level-applied', JSON.stringify(levelApplied.status));
  } catch (err) {
    mark('level-FAILED', String(err && err.message));
  }

  /* ---------------- 定时抓取 ---------------- */
  scheduler = createScheduler({
    run: () =>
      serialize(() =>
        runIngest({ dbFile: DB_FILE, trigger: 'schedule', log: (m) => console.log('[ingest]', m) }).then((r) => {
          if (cardWin && !cardWin.isDestroyed()) cardWin.webContents.send('brief:updated', buildBrief());
          return r;
        }),
      ),
    lastSuccessIso: () => {
      const d = getDb();
      /* ⚠️ **只认 last_success_at，不许退回 last_ingest_at。**
       *
       * 退回就等于"失败的尝试也算成功过"。具体后果：早上断网时启动一次，
       * 全部源失败，`last_ingest_at` 照样被更新 ⇒ catchUpDecision 认为
       * "今天已经抓过" ⇒ **之后一整天都不再重试**，
       * 用户看到的是"卡片空了一天，而程序明明在跑"。
       *
       * 这正是这两个键分开存的意义所在。之前写入端漏了 last_success_at，
       * 读取端又用 `||` 兜了回去，两处一叠加，这个防线就等于不存在。 */
      return getMeta(d, 'last_success_at');
    },
    hour: FETCH_TIME.hour,
    minute: FETCH_TIME.minute,
    log: (m) => console.log(m),
  });
  scheduler.start();
  mark('scheduler-started', `at=${FETCH_AT}`);

  // 唤醒后补抓（休眠跨过了抓取时刻的情形）
  powerMonitor.on('resume', () => {
    const d = catchUpDecision(
      getMeta(getDb(), 'last_success_at'),
      new Date(),
      FETCH_TIME.hour,
      FETCH_TIME.minute,
    );
    console.log(`[power] 系统唤醒，补抓判定：${d.due ? '需要' : '不需要'} —— ${d.reason}`);
    if (d.due) scheduler.checkNow('catchup');
  });

  /* ---------------- 停止请求（"文件即信号"） ----------------
   *
   * ⚠️ 为什么是文件而不是信号 / 窗口消息：
   *    `stop` 原来只有 `taskkill` 一条路，实测撞到两次权限问题
   *    （Access denied；spawnSync 直接 EPERM 且**不抛异常**）。
   *    而"能写自己数据目录"是启动它所需要的最低权限 ——
   *    **一个装了就该能关掉的程序，不该要求管理员权限才能关。**
   *
   * ⚠️ 启动时先清掉**陈旧的**请求文件：上一次停止请求可能没能送达
   *    （应用当时已经卡死），留在那里会让这一次刚起来就自己退出 ——
   *    用户看到的是"启动成功但窗口一闪就没了"，最难查的那种。
   */
  clearStopRequest(DATA_DIR);
  stopWatcher = setInterval(() => {
    if (!hasStopRequest(DATA_DIR)) return;
    console.log('[main] 收到停止请求（数据目录里的 stop-request 文件），正在退出');
    clearStopRequest(DATA_DIR);
    app.quit();
  }, 1000);

  console.log(`[main] 就绪。数据目录 ${DATA_DIR}`);
  console.log(
    `[main] 抓取时刻：每天 ${FETCH_AT}（本地时间）${FETCH_TIME.overridden ? '［来自环境变量］' : '［默认值］'}`,
  );
  /* ⚠️ 配置写错必须**大声说出来**。静默回退到默认值等于让人以为自己配上了，
     然后第二天早上发现简报没更新却找不到原因。 */
  for (const n of FETCH_TIME.notes) console.log(`[main] ⚠️ 配置有问题：${n}`);
  console.log(`[main] 下次定时抓取：${nextRunAt(new Date(), FETCH_TIME.hour, FETCH_TIME.minute).toLocaleString()}`);
}

/* ⚠️ 启动形状**刻意与 m0-probe 的 index.js 一致**（那条路径已真机验证能跑）：
 *   只调 `app.whenReady().then(...)`，**不加** `app.isReady()` 分支、
 *   也**不在模块顶层注册** `app.on(...)`。
 *
 *   为什么把这两条写下来：我一度为了"更稳"加了 `if (app.isReady())` 与三个
 *   `app.on(...)` 监听器，结果**应用从能跑到崩**（检查点停在
 *   `heartbeat-written` 之后、`whenReady` 永不触发，退出码 0xC0000005）。
 *   去掉之后恢复正常。⇒ **在"已经验证能跑的形状"上做最小改动**，
 *   想加健壮性要单独验一次，别顺手加。 */
app.whenReady().then(() =>
  bootstrap().catch((err) => {
    mark('bootstrap-threw', String((err && err.stack) || err).split('\n')[0]);
    console.error('[main] ✗ 启动失败：', err);
  }),
);

app.on('window-all-closed', () => {
  if (scheduler) scheduler.stop();
  app.quit();
});

/* ---------------- 优雅退出时注销自己 ----------------
 *
 * ⚠️ `will-quit` 只在**退出流程**里触发，不参与启动序列 ——
 *    这一点很重要：这个项目有一条真机换来的铁律（见上方那段注释），
 *    **不许在启动路径上顺手加监听器**（曾经因此从能跑变成 0xC0000005）。
 *    `will-quit` 与启动顺序无关，所以是安全的。
 *
 * 为什么必须有：少了它，`service stop` 的优雅路径会留下一个 pid 文件，
 * 于是下一次 `status` 要靠"归属校验"才发现是陈旧的 —— 那是兜底，不是正常路径。
 * 正常路径就该是"进程走了、登记也撤了"。
 */
app.on('will-quit', () => {
  try {
    if (stopWatcher) clearInterval(stopWatcher);
    /* 托盘要显式销毁：否则退出后图标可能残留在通知区域，
       一直到用户把鼠标划过那里才消失（Windows 上的经典现象）。 */
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
    removePidFile(DATA_DIR);
    clearStopRequest(DATA_DIR);
    mark('pidfile-removed');
  } catch {
    /* 退出路径上尽力而为 */
  }
});
