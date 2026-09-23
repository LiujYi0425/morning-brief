/**
 * src/shared/runtime-state.js —— 运行状态：pid 文件、心跳、以及"到底在不在跑"的判定
 * =====================================================================
 * ⚠️ **零依赖，不许 import electron。**
 *    两个消费者要用同一份实现：
 *      · `src/main/index.js`（Electron 主进程）—— 启动时登记自己、退出时注销
 *      · `tools/service.mjs`（普通 Node 的守护管理命令）—— 启动/停止/查状态
 *    而 `tools/service.mjs` 是纯 Node 跑的，它**加载不了**任何碰 electron 的模块。
 *    ⇒ 放这里而不是放 `src/main/`：那条路会在 `import` 阶段就炸。
 *
 * ---------------------------------------------------------------------
 * 为什么需要"运行状态"这件事（而不是简单地 tasklist 找进程名）
 * ---------------------------------------------------------------------
 * 最省事的做法是"看有没有叫 electron.exe 的进程"。它有两个致命问题：
 *   ① **认错人**：用户机器上可能还跑着别的 Electron 应用（VS Code 系、
 *      各种聊天工具），一刀切会杀错进程 —— 这是不可接受的操作。
 *   ② **不认识自己**：本项目允许用 `MB_DATA_DIR` 跑多个数据目录的实例，
 *      按名字找分不出哪个是哪个。
 * ⇒ 所以要有 **pid 文件**（谁、什么时候、哪个数据目录、日志在哪），
 *   再配一条**归属校验**：pid 活着 **且** 心跳文件里的 pid 与它一致。
 *   心跳是应用自己写的，别人不会去写它 —— 这就把"pid 被复用"这种小概率
 *   但后果严重的情况挡住了（进程号会被系统回收再分配）。
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** pid 文件名（放在数据目录里，跟着 MB_DATA_DIR 走） */
export const PID_FILE_NAME = 'morning-brief.pid';
export const HEARTBEAT_FILE_NAME = 'boot-heartbeat.txt';
/** 应用自己写的日志（主进程 + 渲染层都在这里） */
export const RUN_LOG_FILE_NAME = 'run.log';
/** 子进程原始 stdout/stderr 的兜底捕获（只在"应用还没装上自己的日志"时才有用） */
export const RAW_LOG_FILE_NAME = 'run.raw.log';
/** 停止请求文件：管理命令放一个，应用看到就自己退出 */
export const STOP_FILE_NAME = 'stop-request';

/**
 * 项目根目录（本文件住在 `<root>/src/shared/`）。
 *
 * ⚠️ 用"自己所在的位置"算，**不用当前工作目录** ——
 *    双击 .vbs 启动时 cwd 是桌面，用 cwd 会算到一个完全无关的地方。
 */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 默认数据目录名（项目内的子目录） */
export const DEFAULT_DATA_DIR_NAME = 'data';

/**
 * 数据目录。**默认在项目内**（`<项目>/data`），可用 `MB_DATA_DIR` 覆盖。
 *
 * ⚠️ 为什么从 `~/.morning-brief` 改成项目内（用户要求，2026-09-23）：
 *    之前数据在家目录、程序在 D 盘，两处分离 —— 拷给别人时数据不会跟着走
 *    （好事），但自己换机器/挪目录时又容易忘了带上它（坏事）。
 *    用户明确要求"简报数据放到晨报机文件夹之下"，于是：
 *      · 项目在哪里，数据就在哪里，搬走/备份都是搬一个目录；
 *      · 代价是**打包给其他人时必须排除 `data/`**，否则会把你的简报一起发出去
 *        —— 这一条已经写进 `.gitignore` 与打包配置里（见 build 配置的 files 排除项）。
 *
 * ⚠️ 三个入口（主进程 / service.mjs / launch.mjs）**都必须走这一个函数** ——
 *    各写一份默认值就一定会漂移，而漂移的表现是"应用写这个目录、
 *    管理命令查那个目录"，两边都觉得自己是对的。
 */
export function dataDirOf(env = process.env) {
  if (env.MB_DATA_DIR) return path.resolve(env.MB_DATA_DIR);
  return path.join(PROJECT_ROOT, DEFAULT_DATA_DIR_NAME);
}

/** 旧版默认位置（`~/.morning-brief`）—— 只用来在启动时给一句迁移提示 */
export function legacyDataDirOf(env = process.env) {
  const home = env.USERPROFILE || env.HOME || '';
  return home ? path.join(home, '.morning-brief') : null;
}

export function pidFilePath(dataDir) {
  return path.join(dataDir, PID_FILE_NAME);
}
export function heartbeatPath(dataDir) {
  return path.join(dataDir, HEARTBEAT_FILE_NAME);
}
export function runLogPath(dataDir) {
  return path.join(dataDir, RUN_LOG_FILE_NAME);
}
export function rawLogPath(dataDir) {
  return path.join(dataDir, RAW_LOG_FILE_NAME);
}
export function stopRequestPath(dataDir) {
  return path.join(dataDir, STOP_FILE_NAME);
}

/* ------------------------------------------------------------------ */
/* 停止请求（"文件即信号"）                                             */
/* ------------------------------------------------------------------ */

/**
 * 请应用退出。
 *
 * ⚠️⚠️ 为什么要有这条路径，而不是只用 `taskkill`：
 *
 *    实测踩到两次，两次都不是代码写错：
 *      · `taskkill /PID x` → **ERROR: Access denied**（权限不足 / 被安全软件拦）
 *      · `spawnSync('taskkill', ...)` 直接返回 `{status:null, error:'EPERM'}` ——
 *        连进程都没起来。而且它**不抛异常**，所以 `try/catch` 一点用都没有。
 *
 *    也就是说："杀进程"这条路依赖操作系统权限，而权限恰恰是常驻程序最不该
 *    依赖的东西。**一个用户装了就该能关掉的程序，不能要求管理员权限才能关。**
 *
 * ⇒ 主路径改成"文件即信号"：应用自己盯着数据目录里的一个文件，
 *   看到就 `app.quit()`。这条路径只需要**写自己数据目录的权限** ——
 *   而那正是启动它所需要的全部权限。（也是本项目一贯的做法：
 *   心跳、pid、boot.log 都是文件，不引入任何新协议。）
 *
 * `taskkill` 退居兜底：应用卡死、或者根本没跑起来（读不到文件）时才用。
 */
export function requestStop(dataDir, why = 'service.mjs stop') {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    stopRequestPath(dataDir),
    JSON.stringify({ at: new Date().toISOString(), by: why }) + '\n',
    'utf8',
  );
  return stopRequestPath(dataDir);
}

export function clearStopRequest(dataDir) {
  try {
    fs.rmSync(stopRequestPath(dataDir), { force: true });
  } catch {
    /* 删不掉也不影响 */
  }
}

export function hasStopRequest(dataDir) {
  try {
    return fs.statSync(stopRequestPath(dataDir)).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 日志落盘 —— **实现已搬到 run-log.js，这里不再保留副本**                */
/* ------------------------------------------------------------------ */
/*
 * ⚠️⚠️ 这段原本是 `createLogSink(file, maxBytes)` 的实现，现在**删掉了**。
 *    删的理由不是"整理代码"，而是一次真实的、差点漏掉的缺陷：
 *
 *     我加了 `src/shared/run-log.js`（把日志与启动检查点从主进程里搬出来，
 *     好让离线考裁判能真的调用它们），其中也导出了一个 `createLogSink` ——
 *     签名升级成了 `{ maxBytes, retryCooldownMs }`，并且加了"失败后能自愈"。
 *     而**这一个副本忘了删**。
 *
 *     于是 `index.js` 仍然 import 的是旧版（`(file, maxBytes)` 数字签名），
 *     却按新签名调用 `createLogSink(RUN_LOG, { maxBytes: 4MB })`：
 *        · `maxBytes` 变成了一个**对象**
 *        · `sizeOf() > maxBytes` 里发生对象比较 ⇒ 恒为 false
 *        · **截断永远不会触发 ⇒ run.log 无限增长**
 *     而两边的单元测试各自都是绿的 —— 因为测试 import 的是哪一个副本，
 *     就只验证了那一个副本的行为。
 *
 *     ⇒ 这就是本项目反复出现的"两份口径"形态（数据目录、CARD_SIZE、
 *       --win-pad 都栽过）。**同一件事只允许一个实现，其余地方一律 import。**
 *       离线考裁判里有一条断言专门数这个函数在整个仓库里出现了几次。
 *
 *     现在 `createLogSink` 的唯一实现在 `src/shared/run-log.js`。
 */

/* ------------------------------------------------------------------ */
/* pid 文件                                                            */
/* ------------------------------------------------------------------ */

/**
 * 写 pid 文件。
 *
 * ⚠️ **合并而不是覆盖**：管理命令先写下它知道的（它拿得到 child.pid，
 *    但不知道应用内部的启动时刻），应用启动后再补上自己的那份信息。
 *    两边都写同一个 pid，谁后写谁补全 —— 直接覆盖会把对方的信息抹掉。
 */
export function writePidFile(dataDir, info) {
  fs.mkdirSync(dataDir, { recursive: true });
  const prev = readPidFile(dataDir) || {};
  const merged = { ...prev, ...info, pid: Number(info.pid ?? prev.pid), at: new Date().toISOString() };
  fs.writeFileSync(pidFilePath(dataDir), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

/** 读 pid 文件。文件不存在 / 坏掉 / 不是对象 —— 一律返回 null（当作"没在跑"） */
export function readPidFile(dataDir) {
  try {
    const raw = fs.readFileSync(pidFilePath(dataDir), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

export function removePidFile(dataDir) {
  try {
    fs.rmSync(pidFilePath(dataDir), { force: true });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 心跳                                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析心跳文件。格式是一行 `k=v` 空格分隔：
 *   booted=2026-09-22T15:34:15.775Z pid=33156 electron=44.4.2 node=24.21.0
 *   process.type=browser RUN_AS_NODE=undefined
 *
 * @param {string|null} text
 * @returns {{booted:string|null, pid:number|null, electron:string|null, node:string|null, processType:string|null, runAsNode:string|null}|null}
 */
export function parseHeartbeat(text) {
  if (!text || !String(text).trim()) return null;
  const out = { booted: null, pid: null, electron: null, node: null, processType: null, runAsNode: null };
  for (const part of String(text).trim().split(/\s+/)) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i);
    const v = part.slice(i + 1);
    if (k === 'pid') {
      const n = Number(v);
      out.pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (k === 'booted') out.booted = v;
    else if (k === 'electron') out.electron = v;
    else if (k === 'node') out.node = v;
    else if (k === 'process.type') out.processType = v;
    else if (k === 'RUN_AS_NODE') out.runAsNode = v;
  }
  return out;
}

export function readHeartbeat(dataDir) {
  try {
    return parseHeartbeat(fs.readFileSync(heartbeatPath(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

/**
 * 进程是否存在。
 *
 * ⚠️ Windows 上 `process.kill(pid, 0)` 是 Node 提供的**唯一**不装依赖的存活性探测
 *    （内部走 OpenProcess）。它抛 `ESRCH` 表示不存在；抛 `EPERM` 表示存在但没权限
 *    —— 后者**也算存在**，不能当成"没在跑"（否则会重复启动出两个实例）。
 */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * 判定"这个数据目录下的晨报机到底在不在跑"。
 *
 * **纯函数**：输入全部由调用方提供 ⇒ 可以离线穷举每一种组合。
 * 真机上最难查的恰恰是这些组合（进程没了但 pid 文件还在、
 * pid 被别的程序复用了、心跳是上一次留下的……）。
 *
 * @param {object} o
 * @param {object|null} o.pidInfo    pid 文件内容
 * @param {object|null} o.heartbeat  心跳解析结果
 * @param {boolean} o.alive          pid 对应进程是否活着
 * @param {string|null} [o.imageName] pid 对应进程的映像名（拿不到传 null）
 * @returns {{state:'running'|'stopped'|'stale', pid:number|null, why:string}}
 */
export function classifyRun({ pidInfo, heartbeat, alive, imageName = null }) {
  if (!pidInfo) return { state: 'stopped', pid: null, why: '没有 pid 文件 —— 没有登记过运行中的实例' };

  const pid = Number(pidInfo.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'stale', pid: null, why: `pid 文件里的 pid 不是正整数（${JSON.stringify(pidInfo.pid)}）—— 文件损坏` };
  }

  if (!alive) {
    return { state: 'stale', pid, why: `进程 ${pid} 不存在 —— pid 文件是上次异常退出留下的（关机、崩溃、被任务管理器结束）` };
  }

  /* ★ 归属校验，两道：
     ① 心跳里的 pid 必须与 pid 文件一致。心跳只有本应用会写，所以这是最可靠的证据。
     ② 拿得到映像名时，必须是 electron。这一道是为了挡住"pid 被别的程序复用"：
        那种情况下心跳还是旧的、pid 却已经属于别人了。 */
  if (heartbeat && heartbeat.pid != null && heartbeat.pid !== pid) {
    return {
      state: 'stale',
      pid,
      why: `心跳文件里的 pid 是 ${heartbeat.pid}，与 pid 文件的 ${pid} 不一致 —— 进程号被系统回收后分配给了别的程序`,
    };
  }
  if (imageName && !/^electron(\.exe)?$/i.test(String(imageName).trim())) {
    return {
      state: 'stale',
      pid,
      why: `进程 ${pid} 现在是「${imageName}」而不是 electron —— pid 文件过期了（进程号被复用）`,
    };
  }

  return { state: 'running', pid, why: '进程存活且归属校验通过' };
}

/* ------------------------------------------------------------------ */
/* 给日志与界面用的小工具                                               */
/* ------------------------------------------------------------------ */

/** 毫秒 → `2 小时 13 分` 这种人话（都不足 1 分钟时给秒） */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '未知';
  const s = Math.floor(n / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

/**
 * 命令解析（**纯函数**，所以可以被离线考裁判穷举）。
 * 不认识的命令返回 `null`，由调用方打用法并退出 2 —— 不要静默当成 status，
 * 那会让人以为"我明明敲了 stop，怎么还在跑"。
 *
 * @param {string[]} argv
 * @returns {{cmd:string, flags:Record<string,string|boolean>}|null}
 */
export const KNOWN_COMMANDS = ['start', 'stop', 'restart', 'status', 'logs', 'help'];

export function parseCommand(argv = []) {
  const args = argv.filter((a) => typeof a === 'string');
  // 允许 --data-dir=xxx / -n 40 / --force 混排
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('-')) {
      rest.push(a);
      continue;
    }
    const key = a.replace(/^-+/, '');
    const eq = key.indexOf('=');
    if (eq > 0) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
      flags[key] = args[i + 1];
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  const cmd = (rest[0] || 'status').toLowerCase();
  if (!KNOWN_COMMANDS.includes(cmd)) return null;
  return { cmd, flags };
}
