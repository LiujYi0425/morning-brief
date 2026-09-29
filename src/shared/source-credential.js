/**
 * src/shared/source-credential.js —— 「源凭据」的**解析与脱敏**（纯函数、零依赖、可离线穷举）
 * =====================================================================
 * 为什么需要它（用户 2026-09-28 授权：「如果某些资讯途径需要进行其它操作或者授权，
 * 你可以增加授权途径」）：
 *   有些**完全正当**的资讯途径要在请求里带一个凭据才肯返回 feed：
 *     · 官方 API 型源：`X-API-Key: …` / `Authorization: Bearer …`；
 *     · 需要 Referer 的公开 JSON 接口（不少国内站点就这么判）；
 *     · 自建服务上的私有 feed：`Cookie: …`。
 *   没有这个能力，这些源只能靠"把 Key 拼进 URL" —— 那串东西会**明文落库**、
 *   还会出现在日志与错误信息里。有它之后，凭据走**加密文件**、日志里只出现名字。
 *
 * ⚠️ 与口径①的关系：本项目**不做需要登录态或对抗性抓取的内容**。
 *    这里支持的是"用户自己有权访问的源，把访问凭据交给程序"——
 *    凭证由用户提供、只存在本机、只发给用户填的那个地址。
 *    它不改变"不抓 HTML 正文、不绕反爬"这条边界（URL 依旧要过协议白名单）。
 *
 * ⚠️ 抽成纯函数：解析规则（尤其是"哪些头不许设"）必须能被逐条断言，
 *    而 index.js / keystore 那些碰 electron 的地方加载不进离线考裁判。
 */

/** 最多几条 —— 凭据是给"一个 feed 请求"用的，不是让人配一整套代理头 */
export const MAX_HEADER_COUNT = 8;
/** 单条值长度上限（一个 Key 几百字符足够了；超长多半是粘错了别的东西） */
export const MAX_HEADER_VALUE_LEN = 2048;
/** 名字长度上限（RFC 7230 的 token 在实践中很短） */
export const MAX_HEADER_NAME_LEN = 64;

/**
 * **不许由用户设置**的请求头。
 * ⚠️ 这不是"洁癖"，每一条都有具体后果：
 *   · `Host`         —— 改它等于把请求引到另一个虚拟主机（SSRF 的经典一步）；
 *   · `Content-Length` / `Transfer-Encoding` / `Connection` —— 请求体框架，改坏了
 *                       会得到一个挂住或畸形的请求（而错误信息看不出是这里）；
 *   · `Upgrade`      —— 会把一个普通 GET 变成协议升级。
 * 需要 `Cookie` 的场景**允许**（用户自己有权访问的源，凭证是他自己的）。
 */
export const FORBIDDEN_HEADERS = Object.freeze([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
]);

/** RFC 7230 的 token：`Name` 只能是这些字符 */
const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * 把用户在界面上粘的多行文本解析成请求头字典。
 *
 * 格式：一行一条 `名字: 值`；空行与 `#` 开头的行忽略；名字大小写不敏感（统一成小写键）。
 * 同名的**后者覆盖前者**（不是报错：用户改一行不用先删掉旧行）。
 *
 * @param {string} text
 * @returns {{ok:true, headers:Record<string,string>, names:string[]}|{ok:false, error:string}}
 */
export function parseHeaderLines(text) {
  const raw = String(text == null ? '' : text);
  if (raw.length > MAX_HEADER_COUNT * (MAX_HEADER_NAME_LEN + MAX_HEADER_VALUE_LEN + 8) * 4) {
    return { ok: false, error: '内容太长了，确认一下是不是粘错了东西' };
  }
  const out = {};
  const names = [];
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf(':');
    if (i <= 0) {
      return { ok: false, error: `这一行不是「名字: 值」的格式：${s.slice(0, 40)}` };
    }
    const name = s.slice(0, i).trim();
    const value = s.slice(i + 1).trim();
    if (!name) return { ok: false, error: '有一行没写名字（应当是「名字: 值」）' };
    if (name.length > MAX_HEADER_NAME_LEN) return { ok: false, error: `请求头名字太长了：${name.slice(0, 20)}…` };
    if (!NAME_RE.test(name)) {
      return { ok: false, error: `请求头名字里有非法字符：${name.slice(0, 30)}` };
    }
    const low = name.toLowerCase();
    if (FORBIDDEN_HEADERS.includes(low)) {
      return { ok: false, error: `不能设置 ${name} 这个请求头（改它会把请求引到别处，或者让请求本身坏掉）` };
    }
    if (!value) return { ok: false, error: `${name} 是空的 —— 要么删掉这一行，要么把值填上` };
    if (value.length > MAX_HEADER_VALUE_LEN) {
      return { ok: false, error: `${name} 的值太长了（超过 ${MAX_HEADER_VALUE_LEN} 个字符）` };
    }
    /* 值里不许再有控制字符：`\n` 已经被分行处理掉，这里挡的是 `\r`、`\t` 之外的那些
       （它们能构造出"头注入"）。制表符允许 —— 有些 token 里真的带。 */
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
      return { ok: false, error: `${name} 的值里有控制字符，重新粘一次` };
    }
    if (out[low] === undefined) names.push(name);
    out[low] = value;
  }
  if (names.length > MAX_HEADER_COUNT) {
    return { ok: false, error: `请求头太多了（最多 ${MAX_HEADER_COUNT} 条）` };
  }
  return { ok: true, headers: out, names };
}

/**
 * 给日志/界面用的脱敏副本：**只保留名字，值一律变成掩码**。
 *
 * ⚠️ 这个函数存在的唯一理由：凭据**绝不许**出现在日志、错误信息、IPC 回传里
 *    （与 API Key 同一条硬边界，见 keystore.js 的说明）。
 *    所以任何要打日志的地方必须先过它 —— 而不是"我记得别打"。
 *
 * @param {Record<string,string>} headers
 * @returns {Record<string,string>}
 */
export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const s = String(v == null ? '' : v);
    out[k] = s.length > 4 ? '••••' + s.slice(-2) : '••••';
  }
  return out;
}

/** 是否配置了凭据（空对象算没配） */
export function hasCredentials(headers) {
  return !!headers && Object.keys(headers).length > 0;
}

/** 供日志/界面显示的一行摘要：`Authorization, X-API-Key`（**没有值**） */
export function describeHeaders(headers) {
  const names = Object.keys(headers || {});
  return names.length ? names.join(', ') : '';
}
