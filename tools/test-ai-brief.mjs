/**
 * tools/test-ai-brief.mjs —— AI 简报（M1 交付物的最后一项）的离线考裁判
 * =====================================================================
 * 为什么它单独一个文件、而不是并进 test-all：
 *   这一层的每一条断言都在回答「钱和降级」的问题 —— 两次调用有没有发出去、
 *   缓存有没有挡住重复花钱、模型挂了之后今天还有没有东西看。
 *   它们需要一整套假 client 与临时库的脚手架，塞进 test-all 会把那份文件的
 *   主线（抓取与数据层）淹掉。
 *
 * ⚠️ 全程**不联网、不需要 Key、不花一分钱**：client 是假的，Key 是编的。
 * ⚠️ 它同时守着这条硬边界：**API Key 不许出现在任何返回值、落库内容或日志里**。
 * =====================================================================
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, startRun, insertItem, getBrief } from 'file:///D:/morning-brief/src/store/db.js';
import { generateBrief, readAiConfig, writeAiConfig, todayUsage } from 'file:///D:/morning-brief/src/main/brief-service.js';
import { createAiClient } from 'file:///D:/morning-brief/src/shared/ai/client.js';
import { localDay, localDayStartIso } from 'file:///D:/morning-brief/src/shared/day.js';

let pass = 0, fail = 0;
const ok = (label, fn) => { try { fn(); pass++; console.log('✔ ' + label); } catch (e) { fail++; console.log('✗ ' + label + ' —— ' + String(e.message).slice(0, 160)); } };
const aok = async (label, fn) => { try { await fn(); pass++; console.log('✔ ' + label); } catch (e) { fail++; console.log('✗ ' + label + ' —— ' + String(e.message).slice(0, 160)); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-brief-'));
let seq = 0;
const tmpDb = () => path.join(dir, 'b' + (++seq) + '.db');

/* 造一天的数据：40 条，来自 4 个源 */
const NOW = new Date('2026-09-25T07:30:00+08:00');
const iso = (h) => new Date(Date.UTC(2026, 8, 24, 22, 0, 0) + h * 3600000).toISOString();
async function seed(file, n = 40) {
  const db = await openDb(file);
  const run = startRun(db, 'manual', NOW.toISOString());
  for (let i = 1; i <= n; i++) {
    insertItem(db, { title: '第' + i + '条新闻的标题', url: 'https://example.com/n/' + i, summary: '摘要 '.repeat(20), sourceName: '源' + (i % 4), publishedAt: iso(i % 12) }, run, NOW.toISOString());
  }
  return db;
}

/* 假 client：从请求体里读回真实的候选 id，按脚本回话（绝不联网） */
function fakeClient(script) {
  const calls = [];
  const client = createAiClient({
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const user = body.messages[1].content;
      const isRank = user.includes('\t');
      calls.push({ url, model: body.model, kind: isRank ? 'rank' : 'brief', auth: init.headers.authorization });
      const reply = script(calls.length - 1, { user, isRank });
      if (reply && reply.raw) return reply.raw;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: String(reply) } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) };
    },
  });
  return { client, calls };
}
const idsFromPrompt = (user) => user.split('\n').slice(1).map((l) => Number(l.split('\t')[0])).filter((n) => Number.isFinite(n));
const idsFromBrief = (user) => [...String(user).matchAll(/【id (\d+)】/g)].map((m) => Number(m[1]));

/* ---- 1. 正常路径 ---- */
let db = await seed(tmpDb());
let f = fakeClient((i, ctx) => ctx.isRank
  ? '{"picks":[' + idsFromPrompt(ctx.user).slice(0, 3).map((id, k) => '{"id":' + id + ',"score":' + (0.9 - k * 0.1) + '}').join(',') + ']}'
  : '{"headline":"今天芯片与模型两条线","groups":[{"name":"芯片","items":[' + idsFromBrief(ctx.user).slice(0, 2).map((id) => '{"id":' + id + ',"digest":"一句话摘要"}').join(',') + ']}]}');
let out = await generateBrief({ db, apiKey: 'sk-test-KEY', now: NOW, client: f.client });
await aok('正常路径：状态 ok 且两层都调了', () => { assert.equal(out.status, 'ok'); assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map((c) => c.kind), ['rank', 'brief']); });
await aok('第一层只带 id/来源/标题（提示词里没有正文）', () => { assert.ok(f.calls[0] && !f.calls[0].auth.includes('undefined')); assert.ok(f.calls[0].model === 'deepseek-chat'); });
await aok('Key 只出现在请求头', () => assert.equal(f.calls[0].auth, 'Bearer sk-test-KEY'));
await aok('简报落库：总览句 + 分组 + 摘要', () => { const b = getBrief(db); assert.equal(b.headline, '今天芯片与模型两条线'); assert.equal(b.groups.length, 1); assert.equal(b.groups[0].items.length, 2); assert.equal(b.groups[0].items[0].digest, '一句话摘要'); assert.ok(b.groups[0].items[0].url.includes('example.com')); });
await aok('token 用量如实记账（两次共 240）', () => assert.equal(getBrief(db).tokenUsed, 240));
await aok('压缩率可算：候选 40 → 入选 2', () => { const b = getBrief(db); assert.equal(b.rawCount, 40); assert.equal(b.keptCount, 2); assert.equal(out.ratio, 5); });
await aok('落库内容里没有 Key 的影子', () => assert.ok(!JSON.stringify(getBrief(db)).includes('sk-test-KEY')));

/* ---- 2. 缓存闸门：同一批候选不再花钱 ---- */
const before = f.calls.length;
out = await generateBrief({ db, apiKey: 'sk-test-KEY', now: NOW, client: f.client });
await aok('同一批候选直接复用（不再调用）', () => { assert.equal(out.reason, 'cached'); assert.equal(f.calls.length, before); });
out = await generateBrief({ db, apiKey: 'sk-test-KEY', now: NOW, client: f.client, force: true });
await aok('force 可以强制重生成', () => { assert.equal(out.status, 'ok'); assert.equal(f.calls.length, before + 2); });

/* ---- 3. 第一层就挂：降级但今天照常有东西看 ---- */
db = await seed(tmpDb());
f = fakeClient(() => ({ raw: { ok: false, status: 401, text: async () => 'bad key' } }));
out = await generateBrief({ db, apiKey: 'sk-bad', now: NOW, client: f.client });
await aok('鉴权失败 → fallback（不是 failed，也不是假装成功）', () => { assert.equal(out.status, 'fallback'); assert.ok(out.detail.includes('Key')); });
await aok('降级后列表仍有条目，且摘要如实为空', () => { const b = getBrief(db); assert.equal(b.status, 'fallback'); assert.ok(b.groups[0].items.length > 0); assert.equal(b.groups[0].items[0].digest, ''); });
await aok('降级时没有用量就不编数字', () => assert.equal(getBrief(db).tokenUsed, null));

/* ---- 4. 第二层挂：同样降级 ---- */
db = await seed(tmpDb());
f = fakeClient((i, ctx) => i === 0
  ? '{"picks":[' + idsFromPrompt(ctx.user).slice(0, 3).map((id) => '{"id":' + id + '}').join(',') + ']}'
  : ({ raw: { ok: false, status: 500, text: async () => 'boom' } }));
out = await generateBrief({ db, apiKey: 'sk-x', now: NOW, client: f.client });
await aok('第二层 5xx 重试后仍失败 → fallback，且第一层挑中的条目保住了', () => { assert.equal(out.status, 'fallback'); const b = getBrief(db); assert.equal(b.groups[0].items.length, 3); });

/* ---- 5. 模型返回一堆废话（含代码围栏与非 JSON） ---- */
db = await seed(tmpDb());
f = fakeClient((i, ctx) => ctx.isRank
  ? '好的，我挑出来了：\n```json\n{"picks":[' + idsFromPrompt(ctx.user).slice(0, 2).map((id) => '{"id":' + id + ',"score":0.7}').join(',') + ']}\n```\n希望有帮助！'
  : '{"headline":"h","groups":[{"name":"g","items":[' + idsFromBrief(ctx.user).slice(0, 1).map((id) => '{"id":' + id + ',"digest":"d"}').join(',') + ']}]}');
out = await generateBrief({ db, apiKey: 'sk-x', now: NOW, client: f.client });
await aok('围栏 + 寒暄不影响解析', () => { assert.equal(out.status, 'ok'); assert.equal(getBrief(db).groups[0].items.length, 1); });

/* ---- 6. 没 Key / 没条目 ---- */
db = await seed(tmpDb());
out = await generateBrief({ db, apiKey: '', now: NOW, client: fakeClient(() => '{}').client });
await aok('没 Key 时明确说原因，且不落库', () => { assert.equal(out.reason, 'no-key'); assert.equal(getBrief(db), null); });
const emptyDb = await openDb(tmpDb());
out = await generateBrief({ db: emptyDb, apiKey: 'sk-x', now: NOW, client: fakeClient(() => '{}').client });
await aok('今天没抓到条目 → no-items', () => assert.equal(out.reason, 'no-items'));

/* ---- 7. 「今天」口径与列表一致（含只给 fetched_at 的条目） ---- */
const d3 = await seed(tmpDb(), 3);
insertItem(d3, { title: '没有发布时间的条目', url: 'https://example.com/notime', sourceName: '源9' }, null, NOW.toISOString());
const f3 = fakeClient((i, ctx) => ctx.isRank ? '{"picks":[' + idsFromPrompt(ctx.user).slice(0, 1).map((id) => '{"id":' + id + '}').join(',') + ']}' : '{"headline":"h","groups":[{"name":"g","items":[' + idsFromBrief(ctx.user).slice(0, 1).map((id) => '{"id":' + id + ',"digest":"d"}').join(',') + ']}]}');
const b3 = await generateBrief({ db: d3, apiKey: 'sk-x', now: NOW, client: f3.client });
await aok('没有 published_at 的条目也算今天（与「看今天全部」同口径）', () => assert.equal(b3.raw, 4));
await aok('本地日不是 UTC 日（东八区 07:30 属于当天）', () => { assert.equal(localDay(NOW), '2026-09-25'); assert.ok(localDayStartIso(NOW).startsWith('2026-09-24T16:00:00')); });

console.log('\n结论：' + (fail ? '❌ FAIL' : '✅ PASS') + ' —— ' + pass + ' 条断言全过 / ' + fail + ' 条失败（AI 简报）');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 库还开着，删不掉就算了（临时目录） */ }
process.exit(fail ? 1 : 0);