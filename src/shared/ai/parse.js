/**
 * src/shared/ai/parse.js —— 解析模型回复（**纯函数**）
 * =====================================================================
 * 为什么这一层要单独存在、而且要写得这么啰嗦：
 *   模型**不是**一台会守约的机器。它会加解释、包代码围栏、漏个引号、
 *   把 id 写成字符串、多给几条、少给几条。这些都不会报错 ——
 *   只会让"今天没有简报"变成一件说不清原因的事。
 * ⇒ 所以这里的原则是：**能救就救，救不了就明确说救不了**，
 *   绝不返回一个"看起来像成功了"的空壳（那正是本项目最警戒的失败形态）。
 * =====================================================================
 */

/**
 * 从一段可能裹着解释/代码围栏的文本里，抠出第一个**配平**的 JSON 对象。
 *
 * ⚠️ 不能用 `/\{[\s\S]*\}/` 这种正则：正文里出现一个 `}`（比如摘要里写了个
 *    花括号）就会把截断点放错，得到的是一段**语法上合法但内容被切掉**的 JSON ——
 *    而 JSON.parse 会成功。那比直接失败更糟：简报会静默地少一半。
 * ⇒ 这里用逐字符扫描，并且**认字符串与转义**（引号里的花括号不算数）。
 */
export function extractJsonObject(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // 括号没配平：宁可判定失败，也不要半截
}

/** 把任意输入夹成一个整数 id（模型经常回字符串） */
export function toId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  const n = Number(String(v == null ? '' : v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseJson(text) {
  const raw = extractJsonObject(text);
  if (raw === null) return { ok: false, reason: '没有找到 JSON 对象' };
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'JSON 不是一个对象' };
    return { ok: true, obj };
  } catch (e) {
    return { ok: false, reason: 'JSON 解析失败：' + String((e && e.message) || e).slice(0, 80) };
  }
}

/**
 * 第一层的回复 → 入选名单。
 * @param {string} text 模型原文
 * @param {object} opts
 * @param {Set<number>} opts.validIds 候选里真实存在的 id（**编造的 id 一律丢弃**）
 * @param {number} [opts.max] 最多要几条
 * @returns {{ok:boolean, picks:Array<{id:number,score:number}>, warnings:string[], reason?:string}}
 */
export function parseRankReply(text, opts = {}) {
  const valid = opts.validIds instanceof Set ? opts.validIds : new Set();
  const max = Math.max(1, Number(opts.max) || 12);
  const warnings = [];
  const res = parseJson(text);
  if (!res.ok) return { ok: false, picks: [], warnings, reason: res.reason };

  const list = Array.isArray(res.obj.picks) ? res.obj.picks : Array.isArray(res.obj.items) ? res.obj.items : null;
  if (!list) return { ok: false, picks: [], warnings, reason: '回复里没有 picks 数组' };

  const seen = new Set();
  const picks = [];
  let dropped = 0;
  for (const it of list) {
    const id = toId(it && (it.id != null ? it.id : it.itemId));
    if (id == null || !valid.has(id) || seen.has(id)) { dropped += 1; continue; }
    seen.add(id);
    let score = Number(it && it.score);
    if (!Number.isFinite(score)) score = 0.5;          // 没给分就当中间值，不当 0（0 会被后面的排序当成"最差"）
    score = Math.max(0, Math.min(1, score));
    picks.push({ id, score });
  }
  if (dropped) warnings.push('丢弃了 ' + dropped + ' 条（id 不存在或重复）');
  if (!picks.length) return { ok: false, picks: [], warnings, reason: '一条可用的 id 都没有' };
  picks.sort((a, b) => b.score - a.score || a.id - b.id); // 同分时按 id 稳定排序（否则每次跑出来的顺序都不一样）
  if (picks.length > max) { warnings.push('模型给多了，截到 ' + max + ' 条'); picks.length = max; }
  return { ok: true, picks, warnings };
}

/**
 * 第二层的回复 → 简报正文。
 * @returns {{ok:boolean, headline:string, groups:Array, warnings:string[], reason?:string}}
 */
export function parseBriefReply(text, opts = {}) {
  const valid = opts.validIds instanceof Set ? opts.validIds : new Set();
  const maxDigest = Math.max(20, Number(opts.maxDigest) || 60);
  const maxHeadline = Math.max(10, Number(opts.maxHeadline) || 40);
  const warnings = [];
  const res = parseJson(text);
  if (!res.ok) return { ok: false, headline: '', groups: [], warnings, reason: res.reason };

  const headline = String(res.obj.headline || res.obj.summary || '').replace(/\s+/g, ' ').trim().slice(0, maxHeadline);
  const rawGroups = Array.isArray(res.obj.groups) ? res.obj.groups : [];
  const groups = [];
  const seen = new Set();
  let dropped = 0;
  for (const g of rawGroups) {
    const name = String((g && g.name) || '').replace(/\s+/g, ' ').trim().slice(0, 12);
    const items = Array.isArray(g && g.items) ? g.items : [];
    const out = [];
    for (const it of items) {
      const id = toId(it && (it.id != null ? it.id : it.itemId));
      if (id == null || !valid.has(id) || seen.has(id)) { dropped += 1; continue; }
      seen.add(id);
      const digest = String((it && (it.digest || it.summary)) || '').replace(/\s+/g, ' ').trim().slice(0, maxDigest);
      out.push({ id, digest });
    }
    if (out.length) groups.push({ name: name || '要点', items: out });
  }
  if (dropped) warnings.push('丢弃了 ' + dropped + ' 条（id 不存在或重复）');
  if (!groups.length) return { ok: false, headline, groups: [], warnings, reason: '没有一条可用的分组内容' };
  return { ok: true, headline, groups, warnings };
}

/** OpenAI 兼容响应里的取文本（各家字段略有出入，统一在这里兜住） */
export function readChatText(json) {
  const ch = json && json.choices && json.choices[0];
  if (!ch) return '';
  if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
  if (typeof ch.text === 'string') return ch.text;
  return '';
}

/** 用量统计（缺字段就给 null，**不许拿估算值冒充真实用量** —— 北极星要求它可见且可信） */
export function readUsage(json) {
  const u = (json && json.usage) || null;
  if (!u) return { promptTokens: null, completionTokens: null, totalTokens: null };
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const total = n(u.total_tokens);
  const p = n(u.prompt_tokens);
  const c = n(u.completion_tokens);
  return { promptTokens: p, completionTokens: c, totalTokens: total != null ? total : (p != null && c != null ? p + c : null) };
}
