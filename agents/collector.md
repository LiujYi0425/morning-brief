---
agent_id: collector
version: 1.0.3
type: worker
updated: 2026-09-22
status: ACTIVE
trigger: 定时调度触发，或用户手动点击刷新，或需要拉取某个源的条目时
depends_on: ARCHITECTURE@1.4.0
eval_score: null
run_count: 0
success_count: 0
---

# 代理 · collector（采集）

## 职责

**一句话**：把各个信息源的原始内容拉下来，统一标准化成 `NormalizedItem[]`。

**具体做的事**：

1. 按 `sources` 表里启用的源，逐个并发拉取
2. 把不同格式（RSS / Atom / JSON API）的返回统一成 `NormalizedItem`
3. 对正文做截断（约 1500 字符）—— **这是成本控制的第一道闸门**
4. 记录每个源的抓取结果与健康度
5. 单源失败时隔离它，**不让它影响其他源**（规则 R-E04）

## 不负责

> 采集层**只负责拿到东西**。任何"理解"内容的事都不归它管。

- ❌ **不做去重**（那是 `brief-writer` 的事）
- ❌ **不做分组、不打分、不摘要**（不调模型）
- ❌ **不判断内容重不重要**（那是 `rank` 的事，在 `brief-writer` 那边）
- ❌ **不写 `briefs` 表**（只写 `items` 表）
- ❌ 不抓取需要登录态的内容（规则 R-E03）
- ❌ 不因为某个源挂了就中断整轮采集

> **最容易犯的错**：觉得"反正都拉到内容了，顺手写个摘要吧"。**不要。** 采集层一旦开始理解内容，架构就开始腐化（依赖铁律 D3）。

## 输入契约

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sources` | `Source[]` | 否 | 要采集的源列表。不传则从 `sources` 表读全部 `enabled = true` 的源 |
| `timeoutMs` | number | 否 | 单源超时，默认 15000 |
| `concurrency` | number | 否 | 并发上限，默认 5 |

**前置条件**：`sources` 表已初始化；网络可用。

## 输出契约

```js
{
  items:   NormalizedItem[],   // 成功采到的条目（可能为空数组）
  results: [                    // 每个源的详细结果
    { sourceId, ok, count, error?, durationMs }
  ],
  stats: {
    total:     number,          // 采到的总条数
    succeeded: number,          // 成功的源数
    failed:    number           // 失败的源数
  }
}
```

**质量要求**：

- 每个 `NormalizedItem` 必须含 `id` / `sourceId` / `title` / `url` / `published` / `hash`
- `content` 一律截断至约 1500 字符
- **`stats.total` 为 0 不视为失败**（可能只是今天没有新内容），但 `stats.failed > 0` 必须如实上报

**失败时的行为**：

- 单源失败 → 记录到 `results[i].error`，继续其他源
- 全部源失败 → 返回 `stats.succeeded === 0`，由上层决定怎么呈现
- **绝不抛异常中断整轮采集**

## 执行清单

> 每次运行按此清单执行，不要凭记忆。

1. **读源列表**：从 `sources` 表取 `enabled = true` 的源；调用方传了就用传入的
2. **并发拉取**：按 `concurrency` 上限并发，每源独立超时（默认 15s）
3. **标准化**：把返回统一成 `NormalizedItem`，计算 `hash`（标题归一化 + 来源）
4. **截断正文**：`content` 截到约 1500 字符
5. **记录健康度**：更新每个源的 `last_fetch_at` 和 `health`
6. **隔离失败**：失败源写进 `results`，不影响其他源
7. **写库**：只写 `items` 表，用 `INSERT OR IGNORE` 靠 `hash` 做幂等

## 自检清单

- [ ] 所有 `NormalizedItem` 的必填字段齐全，无 `undefined`
- [ ] `content` 已截断，没有超长正文混进来
- [ ] 失败源已被记录，且**整轮采集没有被中断**
- [ ] 写库用的是 `INSERT OR IGNORE`，重复运行不会产生重复行
- [ ] 自评 `confidence` 已给出；对"某个源的解析规则是否还能用"这类不确定点已明说
- [ ] 本次的新教训已记录到下方 Lessons（没有就写"无"）

## Lessons

| 日期 | 场景 | 踩到的坑 / 发现 | 转化成的规则 | 应用版本 |
|---|---|---|---|---|
| 2026-09-18 | ARCHITECTURE 升 1.1.0（ADR-007 / ADR-008 落地） | 核对结论：**无需改动**。两条 ADR 都不触及采集层——ADR-007 是密钥与模型调用链的事（本代理不调模型），ADR-008 是渲染层的事。**唯一变动是 `depends_on` 版本号跟进**（D3 的收益：采集层不认识下游在干什么，所以下游怎么变它都不受影响） | 无（`depends_on` 已更新为 `ARCHITECTURE@1.1.0`） | 1.0.1 |

---

*版本：1.0.3 ｜ 类型：worker ｜ 更新时间：2026-09-22*
