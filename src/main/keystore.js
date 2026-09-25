/**
 * src/main/keystore.js —— API Key 的加密存取（**唯一持有者**）
 * =====================================================================
 * 架构文档 §2 把它列为"唯一持有者"，§4.2 的安全约束把边界写死了：
 *   ① Key 明文**绝不允许**进入数据库、日志、崩溃报告、IPC 回传；
 *   ② 密文落 `userData` 下的**独立文件**，不进任何会被导出/备份的表；
 *   ③ 没有"读回明文"这个通道 —— 渲染进程从设计上就拿不到 Key；
 *   ④ 系统加密不可用时**必须让用户选**，不许静默明文（见 decideStoreMode）。
 *
 * ⚠️ 这个文件是全项目**唯一** import safeStorage 的地方。
 *    它的接口窄到只有五个函数，就是为了让"Key 会不会泄漏"这件事
 *    可以被逐行看完 —— 而不是散落在十几个调用点上靠自觉。
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { decideStoreMode, looksLikeKey, maskTail } from '../shared/keystore-format.js';

const FILE = 'keystore.bin';
/** 只在 'memory' 模式下有值 —— 刻意放在模块级而不是全局对象上（少一个可被别的模块摸到的地方） */
let memoryKey = null;

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

/** 读明文（**只有主进程内部的调用方能拿到**，渲染层没有对应的 IPC 通道） */
export function readKey() {
  if (memoryKey) return memoryKey;
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const box = JSON.parse(raw);
    if (box && box.mode === 'encrypted' && typeof box.data === 'string') {
      return safeStorage.decryptString(Buffer.from(box.data, 'base64'));
    }
    if (box && box.mode === 'plaintext' && typeof box.data === 'string') return box.data;
  } catch {
    /* 文件不存在 / 解不开（换了机器、系统钥匙串变了）都走这里 —— 一律当成"没有配"，
       而不是抛出去把启动流程打断。**失败必须可见**那条规矩由 status() 的
       `broken` 字段承担（见下）。 */
  }
  return null;
}

/** 给界面看的元信息 —— **没有明文** */
export function status() {
  const available = encryptionAvailable();
  let mode = null;
  let broken = false;
  if (memoryKey) mode = 'memory';
  else {
    try {
      const box = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
      mode = box && box.mode === 'encrypted' ? 'encrypted' : box && box.mode === 'plaintext' ? 'plaintext' : null;
    } catch {
      mode = null;
      broken = fs.existsSync(filePath()); // 文件在、但读不出来 = 坏了（换机器/钥匙串变了）
    }
  }
  const key = broken ? null : readKey();
  return {
    configured: !!key,
    maskedTail: key ? maskTail(key) : '',
    mode,
    broken,
    encryption: available,
  };
}

/**
 * 存 Key。
 * @param {string} input 用户粘进来的原文
 * @param {'encrypted'|'memory'|'plaintext'} [requested] 系统加密不可用时，用户必须显式选一种
 */
export function setKey(input, requested) {
  const chk = looksLikeKey(input);
  if (!chk.ok) return { ok: false, reason: chk.reason };
  const available = encryptionAvailable();
  const decided = decideStoreMode(requested, available);
  if (!decided.mode) return { ok: false, reason: decided.warn, needsChoice: true, encryption: available };

  try {
    if (decided.mode === 'memory') {
      memoryKey = chk.value;
      try { fs.rmSync(filePath(), { force: true }); } catch { /* 删不掉也不影响本次会话 */ }
      return { ok: true, mode: 'memory', warn: decided.warn };
    }
    if (decided.mode === 'plaintext') {
      memoryKey = null;
      fs.writeFileSync(filePath(), JSON.stringify({ mode: 'plaintext', data: chk.value }), { encoding: 'utf8', mode: 0o600 });
      return { ok: true, mode: 'plaintext', warn: decided.warn };
    }
    memoryKey = null;
    const data = safeStorage.encryptString(chk.value).toString('base64');
    fs.writeFileSync(filePath(), JSON.stringify({ mode: 'encrypted', data }), { encoding: 'utf8', mode: 0o600 });
    return { ok: true, mode: 'encrypted', warn: '' };
  } catch (e) {
    /* ⚠️ 错误信息里**不能带上 chk.value** —— 写盘失败时把 Key 打进日志，
       等于把"加密存储"这件事一次性作废。 */
    return { ok: false, reason: '保存失败：' + String((e && e.message) || e).slice(0, 120) };
  }
}

export function clearKey() {
  memoryKey = null;
  try {
    fs.rmSync(filePath(), { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: '删除失败：' + String((e && e.message) || e).slice(0, 120) };
  }
}
