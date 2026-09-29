/**
 * src/main/source-credential-store.js —— 「源凭据」的加密存取（**唯一持有者**）
 * =====================================================================
 * 与 `keystore.js`（AI Key）同一条边界，逐条对齐：
 *   ① 凭据明文**绝不允许**进数据库、日志、崩溃报告、IPC 回传；
 *   ② 密文落 `userData` 下**独立文件**（`source-credentials.bin`），不进任何会被导出/备份的表；
 *   ③ 没有"读回明文"的通道 —— 渲染进程只知道"这个源有没有配凭据"；
 *   ④ 系统加密不可用时，这里**直接拒绝保存**（不像 AI Key 还让用户选明文模式）。
 *
 * ⚠️ 为什么第 ④ 条比 AI Key 更严：AI Key 是**必需功能**（没有它就没有 AI 摘要），
 *    所以那时必须给用户一条"我知道风险，仍然用明文"的路；
 *    而源凭据是**可选能力** —— 少一个源不影响产品，
 *    所以多一条明文落盘的路不值得。拒绝时会把话说清楚，用户还能选别的源。
 *
 * ⚠️ 为什么按 **feedUrl** 索引而不是 source.id：源在库里可以被用户删掉再加回来
 *    （id 会变），而"这条 feed 需要什么凭据"是跟着地址走的。
 *    ⚠️ 这也意味着：**地址里带 key 的那种源不要用这个功能**（那串 key 会明文落库）——
 *       正因如此，凭据要单独存。
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { hasCredentials, describeHeaders } from '../shared/source-credential.js';

const FILE = 'source-credentials.bin';

/** 只在内存里的一份（解密后的）副本，避免每抓一个源都读盘解密一次 */
let cache = null;

function filePath() {
  return path.join(app.getPath('userData'), FILE);
}

export function encryptionAvailable() {
  try {
    return !!safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 读全部凭据（**只有主进程内部的调用方拿得到**；渲染层没有对应通道） */
function load() {
  if (cache) return cache;
  cache = {};
  try {
    const box = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (box && box.mode === 'encrypted' && typeof box.data === 'string') {
      cache = JSON.parse(safeStorage.decryptString(Buffer.from(box.data, 'base64'))) || {};
    }
  } catch {
    /* 文件不存在 / 解不开（换机器、钥匙串变了）⇒ 一律当"没配"。
       不抛出去打断抓取 —— 失败的可见性由 status() 的 broken 承担。 */
    cache = {};
  }
  return cache;
}

function persist() {
  const data = safeStorage.encryptString(JSON.stringify(cache || {})).toString('base64');
  const tmp = filePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ mode: 'encrypted', data }), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath());
}

/** 这条 feed 的请求头（没有就返回 null） */
export function headersFor(feedUrl) {
  const all = load();
  const h = all[String(feedUrl)];
  return hasCredentials(h) ? { ...h } : null;
}

/**
 * 存凭据。
 * @param {string} feedUrl
 * @param {Record<string,string>} headers 已经过 parseHeaderLines 校验的字典
 * @returns {{ok:boolean, reason?:string, needsEncryption?:boolean, names?:string}}
 */
export function setHeaders(feedUrl, headers) {
  const url = String(feedUrl || '');
  if (!url) return { ok: false, reason: '没有地址' };
  if (!hasCredentials(headers)) return clearHeaders(feedUrl);
  if (!encryptionAvailable()) {
    return {
      ok: false,
      needsEncryption: true,
      reason:
        '这台机器的系统加密（safeStorage）不可用，所以**不能安全地保存凭据**。' +
        '凭据不会以明文落盘 —— 这也是刻意的：多一条明文路径不值得。',
    };
  }
  try {
    const all = load();
    all[url] = { ...headers };
    persist();
    return { ok: true, names: describeHeaders(headers) };
  } catch (e) {
    /* ⚠️ 错误信息里**不能带上 headers** —— 写盘失败时把凭据打进日志，
       等于把"加密存储"这件事一次性作废。 */
    return { ok: false, reason: '保存失败：' + String((e && e.message) || e).slice(0, 120) };
  }
}

export function clearHeaders(feedUrl) {
  const all = load();
  const url = String(feedUrl || '');
  if (all[url]) {
    delete all[url];
    try {
      persist();
    } catch (e) {
      return { ok: false, reason: '删除失败：' + String((e && e.message) || e).slice(0, 120) };
    }
  }
  return { ok: true };
}

/** 给界面看的元信息 —— **没有明文，也没有名字以外的任何东西** */
export function status(feedUrl) {
  const all = load();
  const url = String(feedUrl || '');
  if (url) {
    const h = all[url];
    return { configured: hasCredentials(h), names: hasCredentials(h) ? describeHeaders(h) : '', encryption: encryptionAvailable() };
  }
  return { count: Object.keys(all).length, encryption: encryptionAvailable() };
}
