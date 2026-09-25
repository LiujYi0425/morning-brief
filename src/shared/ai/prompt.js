/**
 * src/shared/ai/prompt.js —— 两层的提示词与请求体构造（**纯函数**）
 * =====================================================================
 * 为什么提示词必须集中住在一个文件里（架构文档 §2 的 `brief/prompt.js`）：
 *   提示词是这种产品里**唯一靠"改一个字就变行为"**的东西。
 *   散落在调用点上的后果是：想对比两个版本，得先把整个仓库翻一遍。
 *
 * ⚠️ 这一层**绝不碰 API Key** —— 它只生产"要发什么"，
 *    鉴权头由 client.js 在最后一刻贴上去（R-E05 的边界从文件划分上就立住了）。
 * =====================================================================
 */

/** 默认端点与模型（用户可在设置里改成任意 OpenAI 兼容端点） */
export const DEFAULT_ENDPOINT = 'https://api.deepseek.com';
export const DEFAULT_MODEL = 'deepseek-chat';

/** 默认每天让模型挑几条 —— 北极星辅助指标写的是"300 条进，12 条出" */
export const DEFAULT_PICK_COUNT = 10;
/** 送进第一层的候选上限（再多的标题也只是烧钱，且会稀释判断力） */
export const DEFAULT_RANK_POOL = 300;

const RANK_SYSTEM = [
  '你是一个中文资讯编辑，负责替一位只想要"今天值得看的东西"的读者做初筛。',
  '你会收到一份候选清单（每行：id、来源、标题），请挑出最值得读的若干条。',
  '判断标准：① 信息量（不是标题党）；② 与"今天"的相关性；③ 多样性 —— 同一个来源最多两条，同一件事只留一条。',
  '只输出 JSON，不要任何解释、不要 Markdown 代码围栏。格式：{"picks":[{"id":123,"score":0.9}]}',
  'score 是 0 到 1 之间的小数，表示"值得读"的程度。id 必须来自候选清单，不许编造。',
].join('\n');

const BRIEF_SYSTEM = [
  '你是一个中文简报编辑。你会收到今天已初筛的若干条资讯，请产出当天的简报。',
  '只输出 JSON，不要任何解释、不要 Markdown 代码围栏。格式：',
  '{"headline":"一句话总览","groups":[{"name":"分组名","items":[{"id":123,"digest":"一到两句摘要"}]}]}',
  '要求：',
  '① headline 是一句话，说清"今天大概发生了什么"，不超过 40 字，不要"今天"以外的空话；',
  '② groups 里每组 1 到 5 条，组名不超过 6 个字，按重要性排序；',
  '③ digest 用一到两句话概括这条资讯本身（不要复述标题），每条不超过 60 字；',
  '④ 只能使用收到的 id，不许编造；宁可少写几条，也不许凑数。',
].join('\n');

/** 把候选渲染成模型最容易读的紧凑格式：一行一条，制表符分隔 */
function renderRows(rows) {
  return rows
    .map((r) => {
      const title = String(r.title || '').replace(/[\t\r\n]+/g, ' ').slice(0, 90);
      const src = String(r.source || '').replace(/[\t\r\n]+/g, ' ').slice(0, 20);
      return r.id + '\t' + src + '\t' + title;
    })
    .join('\n');
}

/**
 * 第一层（便宜的那层）：让模型从候选里挑 N 条。
 *
 * ⚠️ 送进去的**只有 id / 来源 / 标题** —— 不带正文。
 *    这正是 ADR-004"短输入短输出"的字面含义：这一层要做的是**筛**，不是**读**。
 *    把正文塞进来的代价是 token 直接乘十倍，而筛选质量并不会因此变好。
 */
export function rankMessages(rows, opts = {}) {
  const want = Math.max(1, Math.min(30, Number(opts.pickCount) || DEFAULT_PICK_COUNT));
  const head = [
    '候选共 ' + rows.length + ' 条，请挑出最值得读的 ' + want + ' 条（可以少于 ' + want + ' 条，但要说明不值得）。',
    'id\t来源\t标题',
  ].join('\n');
  return [
    { role: 'system', content: RANK_SYSTEM },
    { role: 'user', content: head + '\n' + renderRows(rows) },
  ];
}

/**
 * 第二层（贵的那层）：只对入选的少数条目做深度摘要。
 *
 * ⚠️ 这一层才允许带正文片段（截断过），条数已被第一层压到十几个 ——
 *    这就是"千万不要给每条都写摘要"的落地方式。
 */
export function briefMessages(picks, opts = {}) {
  const date = String(opts.date || '');
  const body = picks
    .map((p) => {
      const excerpt = String(p.excerpt || '').replace(/\s+/g, ' ').slice(0, 400);
      return '【id ' + p.id + '】' + String(p.title || '') + (excerpt ? '\n' + excerpt : '');
    })
    .join('\n\n');
  const head = '日期：' + date + '\n今天入选 ' + picks.length + ' 条：';
  return [
    { role: 'system', content: BRIEF_SYSTEM },
    { role: 'user', content: head + '\n\n' + body },
  ];
}

/**
 * OpenAI 兼容的 /chat/completions 请求体。
 * `response_format` 只对支持的端点有意义 —— 所以由调用方决定要不要带（见 client.js）。
 */
export function chatRequestBody(model, messages, opts = {}) {
  const body = {
    model: String(model || DEFAULT_MODEL),
    messages,
    temperature: opts.temperature == null ? 0.3 : Number(opts.temperature),
  };
  if (opts.maxTokens) body.max_tokens = Number(opts.maxTokens);
  if (opts.jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/** 把端点与路径拼起来（用户可能填 `https://x.com` 或 `https://x.com/v1` 或整个 URL） */
export function chatUrl(endpoint) {
  const base = String(endpoint || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}
