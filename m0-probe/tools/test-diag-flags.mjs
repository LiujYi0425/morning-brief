/**
 * tools/test-diag-flags.mjs —— 诊断开关**解析口径**的离线考裁判
 * =====================================================================
 *
 * 一句话：**在不需要 Electron 的前提下，证明"开关设了就会被认出来"，
 * 并且证明"这份证明有效"。**
 *
 * ---------------------------------------------------------------------
 * 它管的是什么事故
 * ---------------------------------------------------------------------
 * 2026-09-20，阿木反馈卡片上的拖动把手**拖不动**。我们查到两条事实：
 *   · 本机已验证：卡片窗口是 `resizable: false`，且渲染层里没有任何 JS 拖动代码；
 *   · 外部证据：有可对照的 A/B（把 `resizable` 改回 `true`，窗口立刻恢复可拖）。
 *
 * 于是需要一个开关，让"是不是 `resizable: false` 干的"这件事**能实测**。
 * 而这里最危险的错误不是"开关没用" —— 是**假阴性**：
 *
 *     开关明明设了，却解析成 false
 *       → 诊断跑成了默认态
 *       → 观测到的现象与"开关关着"时一模一样
 *       → 得出「resizable 与拖动无关」这个**错误结论**
 *       → 然后被写进留痕
 *
 * 这个错误链条的每一环都静默无声。所以这一段解析逻辑必须自己先被证明是对的
 * —— 本项目的老规矩：**一个从未被证明能判错的检查，等于没有检查。**
 *
 * ---------------------------------------------------------------------
 * ⭐ 本文件的核心机制：测试自己也要考裁判（变异测试）
 * ---------------------------------------------------------------------
 *   M1 不看输入一律返回 true   → "没设却当成设了"的用例必须抓住
 *   M2 不看输入一律返回 false  → "设了却当成没设"的用例必须抓住（就是上面那条链条）
 *   M3 不做大小写归一          → 'TRUE' / 'On ' 这类用例必须抓住
 *
 * **任何一个变异体存活，本脚本即判 FAIL** —— 那说明用例表是假测试。
 *
 * ---------------------------------------------------------------------
 * ⚠️ 覆盖范围的边界（必须说清楚，不许冒充）
 * ---------------------------------------------------------------------
 * 本脚本能证明：**"给定的输入会被解析成什么"**（纯函数，可离线穷举）。
 * 本脚本**不能**证明：真实运行时环境变量到底有没有传进去 ——
 *   那是终端的事，只能靠 `window.js` 无条件打的那行 `[diag]` 留痕来确认。
 * 因此这里额外做一件"接线检查"：**静态读 `window.js` 的源码**，断言
 *   ① 开关真的被用上了（构造函数里不再有写死的 `resizable: false`）；
 *   ② 那行无条件留痕还在。
 * 这两条是"源码事实"，不是"运行时事实"，但足以挡住"模块写好了却没接上"。
 *
 * ---------------------------------------------------------------------
 * 用法与退出码
 * ---------------------------------------------------------------------
 *   npm run test:flags
 *   node tools/test-diag-flags.mjs
 *
 *   退出码 0 = 解析正确、接线正确，且用例表已被证明有判别力
 *   退出码 1 = 解析有错，**或**用例表是假测试（有变异体存活），**或**接线断了
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIAG_RESIZABLE_ENV, parseFlag, diagResizable } from '../src/main/diag-flags.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(HERE, '..', 'report');
const OUT = path.resolve(REPORT_DIR, 'test-diag-flags.txt');
const WINDOW_JS = path.resolve(HERE, '..', 'src', 'main', 'window.js');

const lines = [];
const say = (s = '') => {
  lines.push(s);
  process.stdout.write(s + '\n');
};

let bad = 0;
function expect(desc, actual, wanted) {
  const ok = actual === wanted;
  if (!ok) bad += 1;
  say(
    `  ${ok ? '✓' : '✗'} ${desc}  →  ${JSON.stringify(actual)}` +
      (ok ? '' : `（期望 ${JSON.stringify(wanted)}）`),
  );
  return ok;
}

say('┌─ 诊断开关解析契约 · 离线考裁判 ─────────────────────────────');
say('│ 被测：src/main/diag-flags.js');
say(`│ 环境变量：${DIAG_RESIZABLE_ENV}`);
say('│ ⚠️ 范围：只考"给定输入解析成什么" + "源码接线是否还在"。');
say('│          不考"终端到底有没有把变量传进去"（那件事只能看运行时留痕）。');
say('└────────────────────────────────────────────────────────────');
say();

/* ------------------------------------------------------------------ */
/* 用例表：输入 → 期望                                                     */
/* ------------------------------------------------------------------ */

const CASES = [
  // 应当为真（"设了"的各种写法）
  { name: "字符串 '1'", raw: '1', want: true },
  { name: "字符串 'true'", raw: 'true', want: true },
  { name: "大写 'TRUE'", raw: 'TRUE', want: true },
  { name: "混合 'True'", raw: 'True', want: true },
  { name: "带空格 ' 1 '", raw: ' 1 ', want: true },
  { name: "带空格 ' on '", raw: ' on ', want: true },
  { name: "字符串 'yes'", raw: 'yes', want: true },
  { name: '布尔 true', raw: true, want: true },
  { name: '数字 1', raw: 1, want: true },

  // 应当为假（"没设"与各种非真值）
  { name: 'undefined', raw: undefined, want: false },
  { name: 'null', raw: null, want: false },
  { name: '空字符串', raw: '', want: false },
  { name: '纯空格', raw: '   ', want: false },
  { name: "字符串 '0'", raw: '0', want: false },
  { name: "字符串 'false'", raw: 'false', want: false },
  { name: "字符串 'off'", raw: 'off', want: false },
  { name: "字符串 'no'", raw: 'no', want: false },
  { name: "边界值 '2'", raw: '2', want: false },
  { name: "接近但不等价的 'true '（内部含空格）", raw: 'tru e', want: false },
  { name: '布尔 false', raw: false, want: false },
  { name: '数字 0', raw: 0, want: false },
  { name: '数字 2', raw: 2, want: false },
  { name: '空对象', raw: {}, want: false },
  { name: '空数组', raw: [], want: false },
];

/** 用给定实现跑一遍用例表，返回失败条数 */
function runCases(parseImpl, { verbose }) {
  let local = 0;
  for (const c of CASES) {
    const got = parseImpl(c.raw);
    if (got !== c.want) {
      local += 1;
      if (verbose) say(`  ✗ ${c.name} → ${JSON.stringify(got)}（期望 ${JSON.stringify(c.want)}）`);
    }
  }
  return local;
}

say(`【一】被测实现 parseFlag —— ${CASES.length} 条用例`);
const realBad = runCases(parseFlag, { verbose: true });
if (realBad === 0) say('  （全部通过，未逐条列出）');
say();

/* ------------------------------------------------------------------ */
/* 接线层：diagResizable 从"环境对象"读值的口径                              */
/* ------------------------------------------------------------------ */

say('【二】接线层 diagResizable —— 从环境对象取值');
expect('空对象（变量未设）读到 false', diagResizable({}), false);
expect("设成 '1' 读到 true", diagResizable({ [DIAG_RESIZABLE_ENV]: '1' }), true);
expect("设成 '0' 读到 false", diagResizable({ [DIAG_RESIZABLE_ENV]: '0' }), false);
expect('env 传 null 不抛错且为 false', diagResizable(null), false);
expect('env 传 undefined 不抛错且为 false', diagResizable(undefined), false);
expect('不传参（走 process.env）返回布尔', typeof diagResizable(), 'boolean');
say();

/* ------------------------------------------------------------------ */
/* 接线检查：源码里真的接上了吗（挡"模块写好了却没接上"）                       */
/* ------------------------------------------------------------------ */

say('【三】源码接线检查 —— src/main/window.js');
const winSrc = fs.readFileSync(WINDOW_JS, 'utf8');

expect(
  '卡片窗口构造函数里不再有写死的 resizable: false',
  /^\s*resizable: false,\s*$/m.test(winSrc),
  false,
);
expect(
  '构造函数里引用的是本地常量 resizable',
  /^\s*resizable,\s*$/m.test(winSrc),
  true,
);
expect(
  '本地常量由 diagResizable() 计算',
  /const resizable = diagResizable\(\);/m.test(winSrc),
  true,
);
expect('已 import 该模块', /from '\.\/diag-flags\.js'/m.test(winSrc), true);
expect(
  '无条件诊断留痕仍在（"开关没生效"必须留得下痕迹）',
  winSrc.includes("'[diag] 卡片窗口 resizable=' + win.isResizable()"),
  true,
);
say();

/* ------------------------------------------------------------------ */
/* ⭐ 变异测试：用例表自己也要被考                                          */
/* ------------------------------------------------------------------ */

say('【四】⭐ 变异测试 —— 用例表有判别力吗（存活即判 FAIL）');

const MUTANTS = [
  {
    id: 'M1',
    desc: '不看输入，一律返回 true',
    impl: () => true,
  },
  {
    id: 'M2',
    desc: '不看输入，一律返回 false',
    // 这正是那段危险链条的实现：开关设了也认不出来
    impl: () => false,
  },
  {
    id: 'M3',
    desc: '做了归一但漏掉大小写（不 toLowerCase）',
    impl: (raw) =>
      typeof raw === 'string' && ['1', 'true', 'on', 'yes'].includes(raw.trim()),
  },
];

let survived = 0;
for (const m of MUTANTS) {
  const n = runCases(m.impl, { verbose: false });
  const caught = n > 0;
  if (!caught) survived += 1;
  say(`  ${caught ? '✓' : '✗'} ${m.id} ${m.desc} → ${caught ? `落网（${n} 条用例抓住）` : '存活！用例表是假测试'}`);
}
say();

/* ------------------------------------------------------------------ */
/* 结论                                                                  */
/* ------------------------------------------------------------------ */

const ok = bad === 0 && survived === 0;
say('────────────────────────────────────────────────────────────');
if (ok) {
  say(`结论：✅ PASS —— ${CASES.length} 条用例全过，${MUTANTS.length} 个变异体全部落网，接线完好。`);
} else {
  if (bad) say(`结论：❌ FAIL —— 有 ${bad} 处断言不成立。`);
  if (survived) say(`结论：❌ FAIL —— 有 ${survived} 个变异体存活，用例表不具备判别力。`);
}
say('────────────────────────────────────────────────────────────');

try {
  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
} catch (err) {
  process.stdout.write(`（报告写入失败，不影响退出码：${err.message}）\n`);
}

process.exit(ok ? 0 : 1);
