/**
 * src/shared/ai/plan.js —— "要不要调、送多少、失败了怎么办"（**全纯函数**）
 * =====================================================================
 * 这一层是整件事里**唯一出错的代价是钱**的地方，所以它被刻意做成纯函数：
 *   同一份输入必须得到同一个决定 —— 才可能被离线断言穷举，
 *   也才可能在"为什么今天没生成简报"这种问题上给出一个**确定**的答案。
 *
 * ⚠️ 它不 import electron、不发请求、不读文件（R-B11：判断逻辑不许被 IO 绑架）。
 * =====================================================================
 */
import { fnv1a } from '../../ingest/urls.js';

/** 精选条数上限（北极星辅助指标：300 条进、12 条出） */
export const MAX_PICKS = 12;
/** 送进第一层的候选上限 */
export const MAX_RANK_POOL = 300;
/** 最多重试几次（含第一次） */
export const MAX_ATTEMPTS = 3;

/** 一个中文字 ≈ 1 token，一个非中文字符 ≈ 0.3 token（粗算，**只用于预估成本，不冒充真实用量**） */
export function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  let cjk = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x2e80 && c <= 0x9fff) cjk += 1;
    else if (c >= 0xf900 && c <= 0xfaff) cjk += 1;
    else if (c >= 0xff00 && c <= 0xffef) cjk += 1;
  }
  const rest = Math.max(0, s.length - cjk);
  return Math.ceil(cjk + rest * 0.3);
}

export function estimateMessagesTokens(messages) {
  let n = 0;
  for (const m of messages || []) n += estimateTokens(m && m.content) + 4;
  return n;
}

/** 条目取一句话摘要用的正文片段（**空就是空** —— 不编造） */
export function pickExcerpt(item, len = 300) {
  const raw = String((item && (item.summary || item.content)) || '');
  const text = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, Math.max(0, len));
}

/**
 * 第一层的候选：按"最新"倒序取前 N 条。
 *
 * 排序口径与列表一致（有时间的按时间、没时间的排最后），
 * 因为不一致的后果是"简报里最早的那条，在列表里排第一"—— 用户会以为程序错乱。
 */
export function selectRankInput(items, opts = {}) {
  const max = Math.max(1, Math.min(MAX_RANK_POOL, Number(opts.max) || MAX_RANK_POOL));
  const pool = (items || []).filter((it) => it && it.id != null && String(it.title || '').trim());
  pool.sort((a, b) => {
    const ta = a.publishedAt || a.fetchedAt || '';
    const tb = b.publishedAt || b.fetchedAt || '';
    if (ta === tb) return Number(b.id) - Number(a.id);
    if (!ta) return 1;
    if (!tb) return -1;
    return ta < tb ? 1 : -1;
  });
  return { rows: pool.slice(0, max).map((it) => ({
    id: Number(it.id),
    title: String(it.title).trim(),
    source: String(it.sourceName || it.source || ''),
  })), dropped: Math.max(0, pool.length - max), total: pool.length };
}

/**
 * 缓存键：**同一天 + 同一批候选 + 同一个模型 ⇒ 不再调第二次**。
 *
 * ⚠️ 这条是"花钱的闸门"，不是优化。少了它，每次刷新都会重新烧一遍钱 ——
 *    而用户点刷新时想的只是"看看有没有新东西"。
 * 键里带 model 的理由：换了模型之后，旧结果就不再是"同样的输入同一个结论"了。
 */
export function briefCacheKey(parts) {
  const ids = (parts && parts.ids ? parts.ids : []).map(Number).sort((a, b) => a - b);
  const seed = [String(parts && parts.date), String(parts && parts.model), ids.join(',')].join('|');
  return 'h' + fnv1a(seed).toString(16);
}

/**
 * 要不要现在就生成？—— 纯函数，所以"为什么今天没生成"可以被回答。
 * @returns {{go:boolean, reason:string}}
 */
export function shouldGenerate(opts = {}) {
  if (!opts.hasKey) return { go: false, reason: 'no-key' };
  if (!opts.itemCount) return { go: false, reason: 'no-items' };
  if (opts.running) return { go: false, reason: 'running' };
  if (opts.sameInput && !opts.force) return { go: false, reason: 'cached' };
  return { go: true, reason: opts.force ? 'forced' : 'new-input' };
}

/** 重试决策：只重试**可能自愈**的错误；鉴权/参数错误重试一百次也不会对 */
export function retryDecision(info = {}) {
  const attempt = Math.max(1, Number(info.attempt) || 1);
  const kind = String(info.kind || '');
  const retryable = kind === 'rate-limit' || kind === 'server' || kind === 'network' || kind === 'timeout';
  if (!retryable) return { retry: false, delayMs: 0, reason: '这类错误重试不会变好（' + (kind || '未知') + '）' };
  if (attempt >= MAX_ATTEMPTS) return { retry: false, delayMs: 0, reason: '已经试了 ' + attempt + ' 次' };
  return { retry: true, delayMs: 800 * Math.pow(2, attempt - 1), reason: '第 ' + (attempt + 1) + ' 次尝试' };
}

/** 把一次失败归成可读的一类（**中文，且要能指导下一步**） */
export function classifyFailure(info = {}) {
  const status = Number(info.status) || 0;
  const err = String(info.error || '');
  if (info.kind === 'no-key') return { kind: 'no-key', message: '还没有填 API Key —— 在卡片底栏「设置」里填一个' };
  if (status === 401 || status === 403) return { kind: 'auth', message: 'API Key 被拒绝（HTTP ' + status + '）—— 检查 Key 是否有效、是否与所选端点匹配' };
  if (status === 404) return { kind: 'not-found', message: '端点或模型名不对（HTTP 404）—— 检查设置里的端点和模型' };
  if (status === 429) return { kind: 'rate-limit', message: '被限流了（HTTP 429）—— 稍后会自动重试' };
  if (status === 400) return { kind: 'bad-request', message: '请求被拒绝（HTTP 400）—— 多半是模型名不对' };
  if (status >= 500) return { kind: 'server', message: '模型服务端出错（HTTP ' + status + '）—— 稍后会自动重试' };
  if (/timeout|abort/i.test(err)) return { kind: 'timeout', message: '请求超时 —— 网络慢或端点不可达' };
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket/i.test(err)) return { kind: 'network', message: '连不上模型端点 —— 检查网络/代理' };
  if (status) return { kind: 'http', message: '请求失败（HTTP ' + status + '）' };
  return { kind: 'unknown', message: '调用失败：' + (err || '没有更多信息').slice(0, 120) };
}

/**
 * 兜底排序：模型挂了也不能"今天没东西看"（R-E04 的精神）。
 * 口径刻意简单且**可解释**：按时间倒序，同一个来源最多两条。
 */
export function fallbackRank(items, n = 10) {
  const want = Math.max(1, Number(n) || 10);
  const sorted = (items || []).slice().sort((a, b) => {
    const ta = a.publishedAt || a.fetchedAt || '';
    const tb = b.publishedAt || b.fetchedAt || '';
    if (ta === tb) return Number(b.id) - Number(a.id);
    if (!ta) return 1;
    if (!tb) return -1;
    return ta < tb ? 1 : -1;
  });
  const perSource = new Map();
  const out = [];
  for (const it of sorted) {
    /* ⚠️ 空标题必须在这里也丢掉 —— 不能只在 selectRankInput 里丢。
       兜底路径是「模型挂了」的那条路，而**越是出问题的时候，越不该冒出空白条目**。 */
    if (!String((it && it.title) || '').trim()) continue;
    const key = String(it.sourceName || it.source_id || '?');
    const c = perSource.get(key) || 0;
    if (c >= 2) continue;
    perSource.set(key, c + 1);
    out.push({ id: Number(it.id), score: 0.5 });
    if (out.length >= want) break;
  }
  return out;
}

/** 压缩率（百分比，保留一位）—— 北极星辅助指标，必须可见 */
export function compressionRatio(rawCount, keptCount) {
  const raw = Number(rawCount) || 0;
  if (!raw) return null;
  return Math.round((Number(keptCount) || 0) / raw * 1000) / 10;
}

/** 两次调用的用量合计（拿不到真实值就如实记 null，不拿估算冒充） */
export function sumUsage(usages) {
  let p = 0, c = 0, t = 0, known = false;
  for (const u of usages || []) {
    if (!u) continue;
    if (u.promptTokens != null) { p += u.promptTokens; known = true; }
    if (u.completionTokens != null) { c += u.completionTokens; known = true; }
    if (u.totalTokens != null) { t += u.totalTokens; }
  }
  return known ? { promptTokens: p, completionTokens: c, totalTokens: t || p + c } : null;
}
