/**
 * 更新的 **I/O 外壳** —— 检查、下载、装、退回。
 *
 * ⚠️ 判决逻辑**一行都不在这里**，全在 `src/shared/update.js`（纯函数、能离线穷举）。
 *    这里只做那些"必须碰 electron / fs / 网络"的事：读写状态文件、拷目录、
 *    发请求、spawn 那个活得比我们久的助手脚本。
 *    这条分工是有代价换来的：碰 electron 的模块**加载不进离线考裁判**
 *    （本项目的考裁判是纯 Node 跑的），所以凡是需要被断言的判断都不能写在这一层。
 *
 * 安装目录里正在运行的文件在 Windows 上是被锁住的 ⇒ 装新版和退旧版
 * **都不可能由我们自己完成**。只能 spawn `tools/win/update-helper.ps1`
 * （它等我们退出、干活、再把我们拉起来），然后自己退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  createUpdateState,
  normalizeState,
  beginUpdate,
  bumpAttempt,
  settle,
  judgeStartup,
  finishRollback,
  parseManifest,
  decideUpdate,
  formatBytes,
} from '../shared/update.js';

/** 状态文件名（放在数据目录里，跟数据库和日志同一处）。 */
export const STATE_FILE = 'update-state.json';
export const stateFileOf = (dataDir) => path.join(dataDir, STATE_FILE);

/** 回退快照与下载缓存的落点。 */
export const updatesDirOf = (dataDir) => path.join(dataDir, 'updates');
export const snapshotDirOf = (dataDir, version) =>
  path.join(updatesDirOf(dataDir), 'rollback', String(version).replace(/[^\w.-]/g, '_'));
export const downloadDirOf = (dataDir) => path.join(updatesDirOf(dataDir), 'download');

/** 默认清单地址：GitHub Release 的"最新版"稳定别名，永远指向最新那个 release 的附件。 */
export const DEFAULT_MANIFEST_URL =
  'https://github.com/LiujYi0425/morning-brief/releases/latest/download/latest.json';

export function manifestUrl(env = process.env) {
  return env.MB_UPDATE_URL || DEFAULT_MANIFEST_URL;
}

/* ───────────────────────── 状态文件 ───────────────────────── */

export function loadState(dataDir, currentVersion) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFileOf(dataDir), 'utf8'));
    return normalizeState(raw, currentVersion);
  } catch {
    /* 读不到 / 坏掉 ⇒ 当作全新。**不是**报错退出：
       一个坏掉的更新状态文件不该让应用起不来。 */
    return createUpdateState(currentVersion);
  }
}

export function saveState(dataDir, state) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const f = stateFileOf(dataDir);
    /* 先写临时文件再改名：直接覆写时若断电/被杀，会留下半个 JSON，
       而下次启动读到坏文件就**丢失了 pending** ⇒ 再也回退不了。 */
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, f);
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────── 启动看门狗 ───────────────────────── */

/**
 * **必须在启动最开头调用**（早于建窗口、早于开库）。
 *
 * 它做两件事：把"这一次启动"计入尝试次数，然后判断要不要回退。
 * 之所以要抢在最前面：坏更新的典型表现就是崩在启动路径上，
 * 那时窗口还没建、日志可能都写不出来 —— 只有"次数"这个信号还活着，
 * 因为它由**上一个好版本**写下的文件承载。
 *
 * @returns {{rollback:boolean, why:string, state:object}}
 */
export function bootWatchdog({ dataDir, currentVersion, log = () => {} }) {
  const before = loadState(dataDir, currentVersion);
  const bumped = bumpAttempt(before);
  if (bumped !== before) saveState(dataDir, bumped);

  const verdict = judgeStartup(bumped);
  log(`[update] 启动看门狗：${verdict.why}`);
  return { rollback: verdict.action === 'rollback', why: verdict.why, verdict, state: bumped };
}

/** 真正健康了（窗口 + 托盘都起来了）⇒ 认可这次更新。 */
export function markHealthy({ dataDir, currentVersion, log = () => {} }) {
  const s = loadState(dataDir, currentVersion);
  if (!s.pending) return { changed: false, state: s };
  const next = settle(s);
  saveState(dataDir, next);
  log(`[update] 更新 ${s.pending.from} → ${s.pending.to} 已确认健康`);
  return { changed: true, state: next };
}

/* ───────────────────────── 快照 ───────────────────────── */

/**
 * 把当前安装目录整份拷到回退目录。
 *
 * ⚠️ 只保留**最近一个**快照：一份就是 235MB 上下（绝大部分是 Electron 本身），
 *    留多份会悄悄吃掉硬盘。装新版之前会先删掉旧快照。
 */
export function snapshotInstall({ installDir, destDir, log = () => {} }) {
  const parent = path.dirname(destDir);
  fs.mkdirSync(parent, { recursive: true });
  /* 清掉上一份快照（只留最近一个） */
  for (const name of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
    const p = path.join(parent, name);
    if (p !== destDir) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
        log(`[update] 清掉旧快照 ${name}`);
      } catch { /* 删不掉就留着，不阻塞 */ }
    }
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.cpSync(installDir, destDir, { recursive: true });
  const n = countFiles(destDir);
  log(`[update] 快照完成：${destDir}（${n} 个文件）`);
  return { ok: true, dir: destDir, files: n };
}

function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue }
    for (const e of ents) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
      else n++;
    }
  }
  return n;
}

/* ───────────────────────── 检查与下载 ───────────────────────── */

/** 用 electron 的 net（Chromium 网络栈）取文本。Node 的 https 在本机连不上 github。 */
export async function fetchText(url, { timeoutMs = 15000, net } = {}) {
  const { net: electronNet } = net ? { net } : await import('electron');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v) } };
    try {
      const req = electronNet.request({ url, useSessionCookies: false });
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          finish(reject, new Error(`HTTP ${res.statusCode}`));
          res.resume?.();
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
        res.on('error', (e) => finish(reject, e));
      });
      req.on('error', (e) => finish(reject, e));
      setTimeout(() => finish(reject, new Error(`超时 ${timeoutMs}ms`)), timeoutMs);
      req.end();
    } catch (e) {
      finish(reject, e);
    }
  });
}

/**
 * 检查更新。**任何失败都只返回结果，不抛** ——
 * 检查更新失败不该影响应用运行（它是附加功能，不是启动路径）。
 */
export async function checkForUpdate({ dataDir, currentVersion, url, log = () => {}, net, allowPrerelease = false }) {
  const target = url || manifestUrl();
  let text;
  try {
    text = await fetchText(target, { net });
  } catch (e) {
    log(`[update] 检查失败（网络）：${e && e.message}`);
    return { action: 'error', why: '取不到清单：' + (e && e.message) };
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    log(`[update] 清单不合格：${parsed.error}`);
    return { action: 'error', why: '清单不合格：' + parsed.error };
  }
  const d = decideUpdate({ manifest: parsed.manifest, currentVersion, allowPrerelease });
  log(`[update] ${d.why}`);

  const s = loadState(dataDir, currentVersion);
  s.lastCheck = new Date().toISOString();
  saveState(dataDir, s);
  return d;
}

/** 下载安装包并校验 sha256。**校验不过就删掉**，绝不留下半个文件等下次误用。 */
export async function downloadUpdate({ manifest, dataDir, log = () => {}, net, onProgress }) {
  const dir = downloadDirOf(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(new URL(manifest.url).pathname) || 'update.exe');

  const { net: electronNet } = net ? { net } : await import('electron');
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v) } };
    const req = electronNet.request({ url: manifest.url, useSessionCookies: false });
    req.on('response', (res) => {
      if (res.statusCode !== 200) { finish(reject, new Error(`HTTP ${res.statusCode}`)); return }
      const out = fs.createWriteStream(file);
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (onProgress) onProgress(got, manifest.size);
      });
      res.pipe(out);
      out.on('finish', () => finish(resolve));
      out.on('error', (e) => finish(reject, e));
    });
    req.on('error', (e) => finish(reject, e));
    req.end();
  });

  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const size = fs.statSync(file).size;
  if (hash !== manifest.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`sha256 不符：期望 ${manifest.sha256.slice(0, 12)}… 实得 ${hash.slice(0, 12)}…`);
  }
  if (size !== manifest.size) {
    fs.rmSync(file, { force: true });
    throw new Error(`大小不符：期望 ${manifest.size} 实得 ${size}`);
  }
  log(`[update] 下载完成并校验通过：${file}（${formatBytes(size)}）`);
  return { file, size, sha256: hash };
}

/* ───────────────────────── 应用 / 回退 ───────────────────────── */

/** spawn 那个活得比我们久的助手，然后调用方应当立刻 `app.quit()`。 */
function spawnHelper({ script, waitPid, mode, installDir, exePath, installer, snapshotDir, resultFile, log }) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-WaitPid', String(waitPid),
    '-Mode', mode,
    '-InstallDir', installDir,
  ];
  if (exePath) args.push('-ExePath', exePath);
  if (installer) args.push('-Installer', installer);
  if (snapshotDir) args.push('-SnapshotDir', snapshotDir);
  if (resultFile) args.push('-ResultFile', resultFile);
  log(`[update] 交给助手脚本（${mode}）：${script}`);
  const child = spawn('powershell.exe', args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

export const helperScriptOf = (resourcesDir, rootDir) =>
  path.join(resourcesDir && fs.existsSync(path.join(resourcesDir, 'tools', 'win', 'update-helper.ps1'))
    ? resourcesDir
    : rootDir, 'tools', 'win', 'update-helper.ps1');

/**
 * 装新版：先快照（退路）→ 记 pending → spawn 助手 → 调用方退出。
 * ⚠️ `beginUpdate` 必须在**启动安装器之前**落盘：装完就晚了 ——
 *    新版本起不来时，我们已经没有机会再写这个文件。
 */
export function applyUpdate({ dataDir, currentVersion, manifest, installerFile, installDir, exePath, resourcesDir, rootDir, log = () => {} }) {
  const snap = snapshotDirOf(dataDir, currentVersion);
  let snapshot = null;
  try {
    snapshot = snapshotInstall({ installDir, destDir: snap, log });
  } catch (e) {
    log(`[update] ⚠️ 快照失败：${e && e.message} —— 没有退路就不会自动回退`);
  }

  const s = loadState(dataDir, currentVersion);
  const next = beginUpdate(s, { toVersion: manifest.version, snapshotDir: snapshot ? snap : '' });
  saveState(dataDir, next);

  const pid = spawnHelper({
    script: helperScriptOf(resourcesDir, rootDir),
    waitPid: process.pid,
    mode: 'apply',
    installDir,
    exePath,
    installer: installerFile,
    resultFile: path.join(updatesDirOf(dataDir), 'last-result.json'),
    log,
  });
  return { ok: true, helperPid: pid, snapshotDir: snapshot ? snap : '', state: next };
}

/** 回退：spawn 助手去把快照镜像回去，调用方退出。 */
export function rollbackNow({ dataDir, currentVersion, installDir, exePath, resourcesDir, rootDir, why, log = () => {} }) {
  const s = loadState(dataDir, currentVersion);
  if (!s.pending || !s.pending.snapshotDir) {
    return { ok: false, reason: '没有退路快照，无法回退' };
  }
  const snap = s.pending.snapshotDir;
  const pid = spawnHelper({
    script: helperScriptOf(resourcesDir, rootDir),
    waitPid: process.pid,
    mode: 'rollback',
    installDir,
    exePath,
    snapshotDir: snap,
    resultFile: path.join(updatesDirOf(dataDir), 'last-result.json'),
    log,
  });
  saveState(dataDir, finishRollback(s, { why }));
  return { ok: true, helperPid: pid, from: snap };
}
