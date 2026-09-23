/**
 * src/main/url-guard.js —— 外链协议白名单（零依赖 · 纯函数）
 * =====================================================================
 * 一句话：**决定"这条资讯的链接能不能交给系统浏览器打开"。**
 *
 * ---------------------------------------------------------------------
 * 为什么单独一个文件（对应项目硬规则 R-B11）
 * ---------------------------------------------------------------------
 * "这个 URL 安不安全"是**纯判定**，不需要 Electron。留在 `ipc.js` 里的话
 * （那里 `import { shell } from 'electron'`），想验证它就得先启动整个应用 ——
 * 于是这条**安全边界永远没法被离线断言**，只剩"跑起来点一下试试"。
 * 拆出来之后由 `tools/test-all.mjs` 逐条断言（含变异测试）。
 *
 * ---------------------------------------------------------------------
 * 为什么必须有白名单（这不是洁癖）
 * ---------------------------------------------------------------------
 * 卡片的标题与链接**来自互联网**（RSS 是外部数据）。
 * 没有白名单就等于"把外部数据当命令执行"：
 *
 *   · `javascript:...`      → 在某些 Electron 版本里能在渲染进程执行脚本
 *   · `file:///C:/...`      → 打开本地文件（信息泄露 + 可能触发关联程序）
 *   · `ms-msdt:` / `search-ms:` → Windows 协议处理器历史上出过 RCE
 *   · `smb://...`           → 触发 NTLM 认证（凭据泄露）
 *
 * ⇒ **只放 http 与 https**。其余一律拒绝，并把原因说清楚（用户要能看懂
 *    "为什么这条打不开"，而不是点了没反应）。
 * =====================================================================
 */

/** 允许打开的两个协议（**不要扩展这个列表**，除非有明确理由） */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 校验一个 URL 能不能交给系统浏览器。
 *
 * @param {unknown} url
 * @returns {{ok: boolean, reason?: string, href?: string}}
 */
export function validateExternalUrl(url) {
  if (typeof url !== 'string') {
    return { ok: false, reason: url == null ? '这条资讯没有链接' : '链接不是文本' };
  }
  const trimmed = url.trim();
  if (trimmed === '') return { ok: false, reason: '这条资讯没有链接' };

  // 控制字符会骗过"看起来像 http"的检查（\nhttps:// 之类），先挡掉
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: '链接里含控制字符，拒绝打开' };
  }

  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: '链接格式不合法' };
  }

  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    // 说清是哪个协议 —— 用户看到 `smb:` 才知道发生了什么
    return { ok: false, reason: `出于安全，不打开 ${u.protocol} 协议的链接` };
  }

  // 只放 http(s) 之后主机名必须非空（`https:///x` 这类畸形）
  if (!u.hostname) return { ok: false, reason: '链接没有主机名' };

  return { ok: true, href: u.href };
}

export { ALLOWED_PROTOCOLS };
