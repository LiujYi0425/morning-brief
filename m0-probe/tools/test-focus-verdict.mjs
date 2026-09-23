/**
 * tools/test-focus-verdict.mjs —— 焦点测试**判定逻辑**的离线考裁判
 * =====================================================================
 *
 * 一句话：**在不需要 Electron 的前提下，证明"判定转得对"，并且证明"这份证明本身有效"。**
 *
 * ---------------------------------------------------------------------
 * 为什么需要它（以及它不能替代什么）
 * ---------------------------------------------------------------------
 * 验收 3 的完整链条有两段：
 *
 *   ① 采集：`hide() → showInactive()` 到底会不会产生 focus 事件   ← 需要 Electron
 *   ② 判定：三个计数器 → pass / fail / invalid                    ← **纯逻辑**
 *
 * 本文件考的是 ②。① 仍然只能靠 `tools/calibrate-focus-referee.mjs`（真跑一次 Electron）。
 * **两者不可互相冒充** —— 本文件全绿也不代表"裁判能在真实世界里判错"，
 * 它只代表"给定读数，判定这段代码是对的"。
 *
 * 之所以值得单独做这一层：只要 import `window.js` 就需要一个 GUI 运行时，
 * 于是在沙箱 / CI / 无头环境里验收 3 **永远没法被验证**。把判定拆进
 * `src/main/focus-verdict.js` 之后，这一半在任何地方都能验，而且秒级完成。
 *
 * ---------------------------------------------------------------------
 * 判定三态（与 focus-verdict.js 的约定一致）
 * ---------------------------------------------------------------------
 *   running —— 测试未结束
 *   fail    —— 抢了焦点（卡片 focus，或面板被挤失焦）
 *   invalid —— 没抢焦点，但测试期内"显示卡片"一次都没发生 ⇒ **什么都没测到**
 *   pass    —— 显示过，且没抢
 *
 * 判定顺序：**先看"抢没抢"，再看"测没测到"**。
 * 若反过来，`cardFocusCount > 0` 这条铁证会被 `cardShowCount === 0` 吞掉，
 * 降级成"没测到" —— 那是"把确凿的失败洗成干净"，与"把 UNABLE 洗成 PASS"同样危险。
 *
 * ---------------------------------------------------------------------
 * ⭐ 本文件的核心机制：**测试自己也要考裁判**
 * ---------------------------------------------------------------------
 * 一份测试用例表可能本身就是假的 —— 如果它太弱，任何实现都能通过它。
 * 所以本文件同时做**变异测试**：造几个"已知坏掉"的实现，**断言用例表必须能把它们抓住**。
 *
 *   M1 恒返回 pass            → 用例表必须抓到（否则表里根本没有失败用例）
 *   M2 只判两态（invalid 当 pass）→ 用例表必须抓到（否则"没测到"被洗成"通过"）
 *   M3 判定顺序反了            → 用例表必须抓到（否则铁证被降级）
 *
 * **只要有任何一个变异体存活，本脚本就判 FAIL** —— 因为它说明"这份证明"是无效的。
 *
 * ---------------------------------------------------------------------
 * 用法与退出码
 * ---------------------------------------------------------------------
 *   npm run test:verdict
 *   node tools/test-focus-verdict.mjs
 *
 *   退出码 0 = 判定正确，且用例表已被证明有判别力
 *   退出码 1 = 判定有错，**或**用例表是假测试（变异体存活）
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFocusVerdict, FOCUS_VERDICT } from '../src/main/focus-verdict.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'report', 'test-focus-verdict.txt');

const lines = [];
const say = (s = '') => {
  lines.push(s);
  process.stdout.write(s + '\n');
};

const { RUNNING, PASS, FAIL, INVALID } = FOCUS_VERDICT;

/* ================================================================== */
/* 用例表 —— 每一条都要说明"为什么它在这里"，而不是凑数                  */
/* ================================================================== */
const CASES = [
  {
    name: '测试还没结束 → running',
    why: '未完成时不许给出任何结论（否则等于提前判卷）',
    input: { finished: false, cardFocusCount: 0, panelBlurCount: 0, cardShowCount: 0 },
    expect: RUNNING,
  },
  {
    name: '正常态：显示过 1 次、零抢焦点 → pass',
    why: '这是 2026-09-18 实测的真实读数（cardShowCount=1，两个计数器都是 0）',
    input: { finished: true, cardShowCount: 1, cardFocusCount: 0, panelBlurCount: 0 },
    expect: PASS,
  },
  {
    name: '★ 植入已知错误：show() 抢到焦点 → fail',
    why: '这就是 calibrate-focus-referee.mjs 要制造的场景。它必须判 fail，否则裁判是假的',
    input: { finished: true, cardShowCount: 1, cardFocusCount: 1, panelBlurCount: 0 },
    expect: FAIL,
  },
  {
    name: '面板被挤得失焦（卡片没收到 focus 事件）→ fail',
    why: '平台差异下"抢焦点"可能只表现为面板 blur。漏掉这条就等于漏掉一整种失败形态',
    input: { finished: true, cardShowCount: 1, cardFocusCount: 0, panelBlurCount: 1 },
    expect: FAIL,
  },
  {
    name: '两种抢焦点信号同时出现 → fail',
    why: '边界：不要因为"两个都非 0"而走进某个奇怪分支',
    input: { finished: true, cardShowCount: 2, cardFocusCount: 3, panelBlurCount: 2 },
    expect: FAIL,
  },
  {
    name: '测试期内没显示过卡片 → invalid（不是 pass）',
    why: '核心纪律：什么都没测到 ≠ 通过。这条就是"永远绿灯的假测试"的守门人',
    input: { finished: true, cardShowCount: 0, cardFocusCount: 0, panelBlurCount: 0 },
    expect: INVALID,
  },
  {
    name: '★ 判定优先级：有 focus 事件但 cardShowCount=0 → fail（不是 invalid）',
    why: '**顺序反了就会在这里挂**。focus 事件是确凿的失败证据，不许被"没测到"降级吞掉',
    input: { finished: true, cardShowCount: 0, cardFocusCount: 1, panelBlurCount: 0 },
    expect: FAIL,
  },
  {
    name: '★ 判定优先级（第二条）：只有面板失焦、且 cardShowCount=0 → fail',
    why: '上一条只靠 focus 计数守着优先级；换"面板失焦"这个信号再守一遍 —— 单点守卫太薄',
    input: { finished: true, cardShowCount: 0, cardFocusCount: 0, panelBlurCount: 1 },
    expect: FAIL,
  },
  {
    name: '字段缺失（undefined）不崩、按 0 处理 → invalid',
    why: '计数器来自多个事件源，缺字段时宁可判"没测到"，也不许抛错或误判通过',
    input: { finished: true },
    expect: INVALID,
  },
  {
    name: '入参整个是 null → 安全降级为 running',
    why: '调用方可能在没有测试状态时问结论。这里不能抛，也不能假装有结论',
    input: null,
    expect: RUNNING,
  },
];

/* ================================================================== */
/* 变异体 —— "已知坏掉"的实现，用来证明用例表有判别力                    */
/* ================================================================== */
const MUTANTS = [
  {
    id: 'M1',
    name: '恒返回 pass（"永远绿灯"的极致形态）',
    impl: () => PASS,
    expectCaughtAtLeast: ['★ 植入已知错误', '测试期内没显示过卡片'],
  },
  {
    id: 'M2',
    name: '只判两态 —— 把 invalid 当成 pass',
    impl: (s) => {
      if (!s || !s.finished) return RUNNING;
      if ((s.cardFocusCount || 0) > 0 || (s.panelBlurCount || 0) > 0) return FAIL;
      return PASS;
    },
    expectCaughtAtLeast: ['测试期内没显示过卡片'],
  },
  {
    id: 'M3',
    name: '判定顺序反了 —— 先看"有没有显示"再看"抢没抢"',
    impl: (s) => {
      if (!s || !s.finished) return RUNNING;
      if ((s.cardShowCount || 0) === 0) return INVALID;
      if ((s.cardFocusCount || 0) > 0 || (s.panelBlurCount || 0) > 0) return FAIL;
      return PASS;
    },
    expectCaughtAtLeast: ['★ 判定优先级'],
  },
];

function runTable(impl) {
  const failed = [];
  for (const c of CASES) {
    let got;
    try {
      got = impl(c.input);
    } catch (err) {
      got = `THREW: ${err && err.message}`;
    }
    if (got !== c.expect) failed.push({ case: c, got });
  }
  return failed;
}

/* ================================================================== */
/* 开跑                                                                */
/* ================================================================== */
say('┌─ 验收 3 · 焦点判定逻辑 · 离线考裁判 ────────────────────────');
say('│ 被测：src/main/focus-verdict.js · computeFocusVerdict()');
say(`│ 用例：${CASES.length} 条　变异体：${MUTANTS.length} 个`);
say('│ ⚠️ 范围：只考"判定"，不考"采集" —— 真实 focus 事件仍需 npm run calibrate');
say('└────────────────────────────────────────────────────────────');
say();

let bad = 0;

/* ---- 第一关：判定本身对不对 ---- */
say('--- 第一关 · 判定正确性 ---');
const realFailed = runTable(computeFocusVerdict);
for (const c of CASES) {
  const hit = realFailed.find((f) => f.case === c);
  if (hit) {
    bad += 1;
    say(`  ✗ ${c.name}`);
    say(`      期望 ${c.expect}，实际 ${hit.got}`);
    say(`      理由：${c.why}`);
  } else {
    say(`  ✓ ${c.name}  →  ${c.expect}`);
  }
}
say();

/* ---- 第二关：用例表有没有判别力（考裁判的递归版本）---- */
say('--- 第二关 · 用例表本身的判别力（变异测试）---');
for (const m of MUTANTS) {
  const caught = runTable(m.impl);
  const caughtNames = caught.map((f) => f.case.name);
  const mustCatch = m.expectCaughtAtLeast;
  const missed = mustCatch.filter((needle) => !caughtNames.some((n) => n.includes(needle)));

  if (missed.length > 0) {
    bad += 1;
    say(`  ✗ ${m.id} 存活 —— 用例表没抓到它！`);
    say(`      变异体：${m.name}`);
    say(`      本该被这些用例抓住：${missed.join(' / ')}`);
    say('      ⇒ 说明用例表太弱，第一关的全绿不算数。');
  } else {
    say(`  ✓ ${m.id} 已被抓住（${caught.length} 条用例报警）—— ${m.name}`);
  }
}
say();

/* ---- 结论 ---- */
const ok = bad === 0;
say('┌─ 结论 ──────────────────────────────────────────────────────');
if (ok) {
  say(`│ ✓ PASS —— 判定正确，且用例表已被证明有判别力（${MUTANTS.length}/${MUTANTS.length} 变异体全部落网）`);
  say('│ ⚠️ 但这只覆盖"判定"。真实 focus 事件会不会发生，仍需 npm run calibrate。');
} else {
  say(`│ ✗ FAIL —— ${bad} 处问题（见上）`);
}
say('└────────────────────────────────────────────────────────────');

try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    `验收 3 · 焦点判定逻辑 · 离线考裁判\n生成时间：${new Date().toISOString()}\n结果：${ok ? 'PASS' : 'FAIL'}\n\n` + lines.join('\n') + '\n',
    'utf8',
  );
  say(`\n[test] 结果已写入 report/test-focus-verdict.txt`);
} catch (err) {
  say(`\n[test] 结果落盘失败：${err && err.message}`);
}

process.exit(ok ? 0 : 1);
