/**
 * src/shared/keystore-format.js —— Key 的**形状与存储模式**（纯函数，可离线考）
 * =====================================================================
 * ⚠️ 为什么"判断"要和"加密"分家：加密必须碰 electron（`safeStorage`），
 *   而"这个 Key 长得对不对""这种环境该用哪种存法"是**能离线穷举的决策**。
 *   混在一起的后果是这两条最要紧的规则（R-E02 / R-E05）**一条都测不了**。
 * =====================================================================
 */

/**
 * 只露尾巴。**永远不返回原文** —— 这个函数是 UI 能看到的唯一"Key 的影子"。
 * ⚠️ 长度 ≤ 4 时连尾巴都不露：那点长度本身就是信息。
 */
export function maskTail(key) {
  const s = String(key == null ? '' : key);
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}

/** 粗校：只挡明显不是 Key 的东西（空格/换行/太短），**不做格式白名单** —— 各家 Key 长得都不一样 */
export function looksLikeKey(input) {
  const s = String(input == null ? '' : input).trim();
  if (s.length < 8) return { ok: false, reason: '太短了（少于 8 个字符），不像是 Key' };
  if (/\s/.test(s)) return { ok: false, reason: '里面混进了空格或换行 —— 复制时多带了字符' };
  return { ok: true, value: s };
}

/**
 * 该用哪种存法？
 *
 * ⚠️⚠️ 架构文档的安全约束 4：`safeStorage.isEncryptionAvailable()` 为 false 时
 *   **必须明示用户并让他选**，**不允许静默降级为明文**。
 *   这条不是洁癖：静默明文意味着用户以为自己"加密存好了"，
 *   而实际上一个记事本就能读走他的 Key。
 *
 * @returns {{mode:'encrypted'|'memory'|'plaintext', warn:string}}
 */
export function decideStoreMode(requested, available) {
  if (requested === 'memory') {
    return { mode: 'memory', warn: '只存在内存里 —— 重启程序就要重填（但磁盘上不会留下任何痕迹）' };
  }
  if (requested === 'plaintext') {
    return { mode: 'plaintext', warn: '⚠️ 明文落盘：这台机器上任何能读你用户目录的程序都能拿到它' };
  }
  if (available) return { mode: 'encrypted', warn: '' };
  return { mode: '', warn: '这台机器上没有可用的系统加密（钥匙串），没法加密保存 —— 请改选「只存内存」或「明文落盘」' };
}
