/**
 * src/main/brief-service.js —— 生成一份简报的**全部编排**（不碰 electron，可离线考）
 * =====================================================================
 * 落地架构文档的 ADR-004「分层处理」：
 *   第一层 rank   ：只有 id/来源/标题 → 让模型挑 8~12 条        （便宜）
 *   第二层 brief  ：只对挑中的那十几条做摘要 + 总览句 + 分组      （贵，但只有十几条）
 *   兜底          ：任一层挂了，都要**照常有东西看**（R-E04 的精神）
 *
 * ★ 为什么它不 import electron：这样整条链路（含两层调用、缓存闸门、
 *   解析失败、模型超时）都能被一个**假 client** 在离线断言里跑完，
 *   不需要网络、不需要 Key、不花一分钱。Key 由调用方注入，且只在这一层被透传给 client。
 * =====================================================================
 */
import { getBrief, itemsForBrief, saveBrief, getMeta, setMeta, briefTokenUsage } from '../store/db.js';
import { createAiClient } from '../shared/ai/client.js';
import {
  DEFAULT_ENDPOINT, DEFAULT_MODEL, DEFAULT_PICK_COUNT, DEFAULT_RANK_POOL,
  briefMessages, rankMessages,
} from '../shared/ai/prompt.js';
import { parseBriefReply, parseRankReply } from '../shared/ai/parse.js';
import {
  MAX_PICKS, briefCacheKey, compressionRatio, fallbackRank, pickExcerpt, selectRankInput, shouldGenerate, sumUsage,
} from '../shared/ai/plan.js';
import { localDay, localDayStartIso } from '../shared/day.js';

const META_KEYS = { endpoint: 'ai_endpoint', model: 'ai_model', pickCount: 'ai_pick_count' };

/** 读 AI 配置（**不含 Key** —— Key 住在 keystore，永远不进这张表） */
export function readAiConfig(db) {
  const pick = Number(getMeta(db, META_KEYS.pickCount));
  return {
    endpoint: String(getMeta(db, META_KEYS.endpoint) || DEFAULT_ENDPOINT),
    model: String(getMeta(db, META_KEYS.model) || DEFAULT_MODEL),
    pickCount: Number.isFinite(pick) && pick > 0 ? Math.max(3, Math.min(MAX_PICKS, pick)) : DEFAULT_PICK_COUNT,
  };
}

export function writeAiConfig(db, cfg) {
  if (cfg && cfg.endpoint != null) setMeta(db, META_KEYS.endpoint, String(cfg.endpoint).trim().slice(0, 200));
  if (cfg && cfg.model != null) setMeta(db, META_KEYS.model, String(cfg.model).trim().slice(0, 80));
  if (cfg && cfg.pickCount != null) {
    const n = Math.max(3, Math.min(MAX_PICKS, Number(cfg.pickCount) || DEFAULT_PICK_COUNT));
    setMeta(db, META_KEYS.pickCount, String(n));
  }
  return readAiConfig(db);
}

/** 今天已经花了多少（给设置面板显示 —— 北极星要求 Token 消耗可见） */
export function todayUsage(db, now = new Date()) {
  return briefTokenUsage(db, localDay(now));
}

/**
 * 生成（或复用）今天的简报。
 *
 * @param {object} opts
 * @param {object} opts.db
 * @param {string} [opts.apiKey] 明文只在主进程内部流转，**不进返回值**
 * @param {object} [opts.cfg] 省略则读库
 * @param {object} [opts.client] 注入的 AI client（测试用假 client）
 * @param {boolean} [opts.force] 强制重新生成（跳过"同一批输入不重复调"的闸门）
 * @param {Date} [opts.now]
 * @param {(msg:string)=>void} [opts.onLog]
 */
export async function generateBrief(opts = {}) {
  const db = opts.db;
  const now = opts.now || new Date();
  const log = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const date = localDay(now);
  const sinceIso = localDayStartIso(now);
  const cfg = opts.cfg || readAiConfig(db);
  const apiKey = String(opts.apiKey || '');
  const client = opts.client || createAiClient({ fetchImpl: opts.fetchImpl });
  const base = { ok: false, reason: '', date, status: 'none', detail: '', tokenUsed: null, raw: 0, kept: 0, ratio: null, warnings: [] };

  const all = itemsForBrief(db, { sinceIso, limit: 1000 });
  const sel = selectRankInput(all, { max: DEFAULT_RANK_POOL });
  if (!sel.rows.length) {
    return { ...base, reason: 'no-items', detail: '今天还没有抓到条目，等下一次抓取之后再生成' };
  }

  const inputHash = briefCacheKey({ date, model: cfg.model, ids: sel.rows.map((r) => r.id) });
  const prev = getBrief(db, date);
  const sameInput = !!(prev && prev.inputHash && prev.inputHash === inputHash && (prev.status === 'ok' || prev.status === 'partial'));
  const gate = shouldGenerate({ hasKey: !!apiKey, itemCount: sel.rows.length, sameInput, force: opts.force });
  if (!gate.go) {
    if (gate.reason === 'cached') return { ...base, ok: true, reason: 'cached', status: prev.status, brief: prev, detail: '候选没变，直接复用今天已有的简报（不重复花钱）' };
    if (gate.reason === 'no-key') return { ...base, reason: 'no-key', detail: '还没有配置 API Key —— 在「设置」里填一个就能生成摘要' };
    return { ...base, reason: gate.reason, detail: '这次没有生成（' + gate.reason + '）' };
  }

  const byId = new Map(all.map((it) => [Number(it.id), it]));
  const validIds = new Set(sel.rows.map((r) => r.id));
  const usages = [];
  const warnings = [];
  let picks = null;
  let degraded = '';

  log('简报：第一层初筛，候选 ' + sel.rows.length + ' 条（今天共 ' + sel.total + ' 条）');
  const r1 = await client.chat({
    stage: 'rank', endpoint: cfg.endpoint, model: cfg.model, apiKey,
    messages: rankMessages(sel.rows, { pickCount: cfg.pickCount }),
  });
  if (r1.ok) {
    usages.push(r1.usage);
    const p = parseRankReply(r1.text, { validIds, max: cfg.pickCount });
    if (p.ok) { picks = p.picks; warnings.push(...p.warnings); }
    else degraded = '初筛结果读不出来：' + p.reason;
  } else {
    degraded = (r1.failure && r1.failure.message) || '初筛调用失败';
  }

  let headline = '';
  let groups = [];
  let status = 'ok';
  let detail = '';

  if (picks) {
    const chosen = picks.map((p) => byId.get(p.id)).filter(Boolean);
    log('简报：第二层摘要，入选 ' + chosen.length + ' 条');
    const r2 = await client.chat({
      stage: 'brief', endpoint: cfg.endpoint, model: cfg.model, apiKey,
      messages: briefMessages(chosen.map((it) => ({ id: it.id, title: it.title, excerpt: pickExcerpt(it) })), { date }),
    });
    if (r2.ok) {
      usages.push(r2.usage);
      const b = parseBriefReply(r2.text, { validIds: new Set(chosen.map((it) => it.id)) });
      if (b.ok) {
        headline = b.headline;
        groups = b.groups.map((g) => ({
          name: g.name,
          items: g.items.map((gi) => {
            const src = byId.get(gi.id) || {};
            return { id: gi.id, title: src.title || '', url: src.url || '', source: src.sourceName || '', digest: gi.digest };
          }),
        }));
        warnings.push(...b.warnings);
        status = warnings.length ? 'partial' : 'ok';
      } else {
        status = 'fallback';
        detail = '摘要读不出来：' + b.reason;
      }
    } else {
      status = 'fallback';
      detail = (r2.failure && r2.failure.message) || '摘要调用失败';
    }
  } else {
    status = 'fallback';
    detail = degraded || '初筛没有返回可用的条目';
  }

  /* ★★ 降级：**今天必须有东西看**（R-E04）。
     模型全挂时用第一层挑中的（或纯本地的兜底排序）撑住列表，
     但**状态如实记为 fallback** —— 卡片上会写清"这些不是 AI 挑的"。
     悄悄降级成"看起来正常"的简报，是这里最不能犯的错。 */
  if (status === 'fallback') {
    const usePicks = picks && picks.length ? picks.map((p) => byId.get(p.id)).filter(Boolean) : fallbackRank(all, cfg.pickCount).map((p) => byId.get(p.id)).filter(Boolean);
    groups = [{
      name: '今日要点',
      items: usePicks.map((it) => ({ id: Number(it.id), title: it.title, url: it.url || '', source: it.sourceName || '', digest: '' })),
    }];
    headline = '';
  }

  const kept = groups.reduce((n, g) => n + g.items.length, 0);
  const usage = sumUsage(usages);
  const saved = saveBrief(db, {
    date,
    headline,
    groups,
    status,
    detail,
    model: cfg.model,
    inputHash,
    tokenUsed: usage ? usage.totalTokens : null,
    rawCount: sel.total,
    keptCount: kept,
    curatedIds: groups.flatMap((g) => g.items.map((i) => i.id)),
  }, now.toISOString());

  const brief = getBrief(db, date);
  log('简报：' + status + '（入选 ' + kept + ' / 候选 ' + sel.total + '，token ' + (usage ? usage.totalTokens : '未知') + '）');
  return {
    ok: true, reason: status, date, status, detail, brief,
    raw: sel.total, kept, ratio: compressionRatio(sel.total, kept),
    tokenUsed: usage ? usage.totalTokens : null, warnings, saved,
  };
}
