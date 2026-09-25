/**
 * src/shared/ai/client.js —— 唯一真正发请求的地方（fetch 可注入）
 * =====================================================================
 * ⚠️ 三条不能破的边界：
 *   ① **API Key 只在这里被贴到请求头上**，绝不进入任何返回值、日志或错误信息
 *      （R-E05：渲染进程从设计上拿不到 Key —— 而"拿不到"要靠代码结构保证，
 *        不是靠"我们记得别写进去"）。
 *   ② **不 import electron** —— 于是它能在纯 Node 里被一个假 fetch 完整考一遍。
 *   ③ 超时与重试是**决策**（在 plan.js 里，纯函数），这里只负责执行。
 * =====================================================================
 */
import { chatRequestBody, chatUrl } from './prompt.js';
import { classifyFailure, retryDecision } from './plan.js';
import { readChatText, readUsage } from './parse.js';

export const DEFAULT_TIMEOUT_MS = 30000;
/** 单次回复上限：第一层只需一串 id，第二层十几条摘要，2000 足够且能挡住"模型开始长篇大论" */
const MAX_TOKENS = { rank: 600, brief: 2000 };

export function createAiClient(opts = {}) {
  const doFetch = opts.fetchImpl || ((...a) => fetch(...a));
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  async function once({ endpoint, model, apiKey, messages, maxTokens, jsonMode }) {
    const url = chatUrl(endpoint);
    const body = chatRequestBody(model, messages, { maxTokens, jsonMode, temperature: opts.temperature });
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + String(apiKey || '') },
        body: JSON.stringify(body),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (e) {
      /* ⚠️ 这里**只取错误类型与消息**：异常对象上可能挂着请求配置（含鉴权头），
         原样透出去就等于把 Key 写进了日志。 */
      return { ok: false, failure: classifyFailure({ error: String((e && e.name) || '') + ' ' + String((e && e.message) || e) }) };
    }
    const status = Number(res && res.status) || 0;
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    if (!res || !res.ok) return { ok: false, failure: classifyFailure({ status, error: text.slice(0, 200) }) };
    let json = null;
    try { json = JSON.parse(text); } catch { /* 下面按空回复处理 */ }
    if (!json) return { ok: false, failure: { kind: 'bad-json', message: '端点返回的不是 JSON（多半端点填错了）' } };
    return { ok: true, text: readChatText(json), usage: readUsage(json) };
  }

  /**
   * 发一次 chat 请求（含重试）。
   * @returns {{ok:boolean, text?:string, usage?:object, attempts:number, failure?:{kind,message}}}
   */
  async function chat(args) {
    const maxTokens = args.maxTokens || MAX_TOKENS[args.stage] || 1000;
    let attempt = 1;
    let last = null;
    for (;;) {
      const r = await once({ ...args, maxTokens });
      if (r.ok) return { ok: true, text: r.text, usage: r.usage, attempts: attempt };
      last = r.failure;
      const d = retryDecision({ attempt, kind: last && last.kind });
      if (!d.retry) return { ok: false, failure: last, attempts: attempt };
      await sleep(d.delayMs);
      attempt += 1;
    }
  }

  return { chat };
}

/** 连通性测试用：最小的一次真实调用（用户在设置里点「测试」时跑） */
export async function testConnection(client, cfg) {
  const r = await client.chat({
    endpoint: cfg.endpoint,
    model: cfg.model,
    apiKey: cfg.apiKey,
    stage: 'rank',
    maxTokens: 16,
    messages: [
      { role: 'system', content: '只回一个字。' },
      { role: 'user', content: '回「好」' },
    ],
  });
  if (!r.ok) return { ok: false, message: (r.failure && r.failure.message) || '调用失败' };
  return { ok: true, model: cfg.model, message: '通了（模型回了 ' + JSON.stringify(String(r.text || '').slice(0, 12)) + '）' };
}
