/**
 * src/main/feed-url.js —— "这个地址能不能当做一个源"（零依赖 · 纯函数）
 * =====================================================================
 * 一句话：**决定用户粘贴进来的那个地址能不能被收下当源。**
 *
 * ---------------------------------------------------------------------
 * 为什么单独一个文件（与 `url-guard.js` 同一条理由）
 * ---------------------------------------------------------------------
 * 这是**纯判定**，不需要 Electron。留在 `src/main/index.js` 里的话
 * （那个文件 `import { app } from 'electron'`），想验证它就得先启动整个应用
 * ⇒ 这段判定**永远没法被离线断言**，只剩"跑起来粘一个试试"。
 * ⇒ 拆出来之后由 `tools/test-all.mjs` 逐条断言（含变异测试）。
 *
 * 这与 `url-guard.js` 是**两件事，别合并**（虽然都叫"校验 URL"）：
 *   · `validateExternalUrl`：决定"这条资讯的链接能不能交给系统浏览器打开"
 *     —— 那是**用户点击**的路径，安全边界是"别执行外部数据"。
 *   · 本文件：决定"这个地址能不能存成一个源、并让程序**定期主动去抓**"
 *     —— 那是**程序自己出网**的路径，边界更严：
 *       不许内网/本机地址（否则程序会变成一个被外部数据牵着走的探测器）。
 * =====================================================================
 */

/** 源地址的长度上限。URL 本身有更长的，但真实 feed 地址不会这么长 */
export const MAX_FEED_URL_LEN = 500;

/** 源名字的长度上限（界面上一行放得下） */
export const MAX_SOURCE_NAME_LEN = 24;

/**
 * 本机 / 内网地址一律拒绝。
 *
 * ⚠️ 为什么这条必须有（不是洁癖）：源是**程序会定期主动去抓**的地址。
 *    允许 `http://127.0.0.1:xxxx` 就等于给"外部数据 → 本机请求"开了一条路
 *    （用户可能被一段话术骗着粘一个本机地址进来）。而正常用途里，
 *    本机地址只会是用户自己在跑 RSSHub —— 那也应该由用户显式知道这件事，
 *    而不是靠程序默默允许。
 *
 * ⚠️ 只拦**字面量**：`localhost` / `127.x` / `0.0.0.0` / `::1` /
 *    私有网段（10 / 172.16-31 / 192.168）/ 链路本地（169.254）。
 *    域名解析到内网（DNS rebinding）这里拦不住 —— 那是另一个层级的问题，
 *    写下来是为了不让人误以为这条能挡全部。
 */
export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true; // 没有主机名 ⇒ 不是可抓的地址
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 不是 IPv4 字面量 ⇒ 交给协议与主机名规则
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * 校验一个待添加的源。
 *
 * @param {{name?:string, feedUrl?:string}} input
 * @returns {{ok:boolean, reason?:string, name?:string, feedUrl?:string}}
 *   · 失败时 `reason` 是**给用户看的正文**（要能照着改），不是错误码。
 */
export function validateNewSource(input) {
  const p = input || {};
  const url = String(p.feedUrl == null ? '' : p.feedUrl).trim();
  const name = String(p.name == null ? '' : p.name).trim();

  if (!url) return { ok: false, reason: '先把 feed 地址粘进去' };
  if (url.length > MAX_FEED_URL_LEN) {
    return { ok: false, reason: `地址太长了（超过 ${MAX_FEED_URL_LEN} 个字符），确认一下是不是粘多了` };
  }
  if (!name) return { ok: false, reason: '给它起个名字吧（列表里显示这个名字）' };
  if (name.length > MAX_SOURCE_NAME_LEN) {
    return { ok: false, reason: `名字太长了（最多 ${MAX_SOURCE_NAME_LEN} 个字）` };
  }
  /* 控制字符（含换行/制表）：地址里出现它们几乎一定是复制带进来的，
     而且它们能骗过"看起来像 http"的肉眼检查。 */
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    return { ok: false, reason: '地址里混进了控制字符（换行/制表符之类），重新粘一次' };
  }

  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: '这不是一个能解析的地址（要 http:// 或 https:// 开头）' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `只支持 http / https，这个地址是 ${u.protocol} 开头的` };
  }
  if (!u.hostname) return { ok: false, reason: '这个地址里没有主机名' };
  if (isPrivateHost(u.hostname)) {
    return { ok: false, reason: '本机 / 内网地址不能作为源（程序会定期去抓它）' };
  }

  /* ⚠️ 存的是**归一化之后**的地址（`u.href`），不是用户粘的原文。
     理由：`source.feed_url` 上有 UNIQUE 约束，"同一个地址写成两种形式"
     （末尾多个斜杠、大小写不同的主机名）会绕过去重，存成两个源 ——
     而它们抓的是同一份内容，用户会看到重复条目。 */
  return { ok: true, name, feedUrl: u.href };
}
