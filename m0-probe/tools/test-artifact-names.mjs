/**
 * tools/test-artifact-names.mjs —— 自检产物**命名契约**的离线考裁判
 * =====================================================================
 *
 * 一句话：**在不需要 Electron 的前提下，证明"隔离后缀真的能隔离"，并且证明"这份证明有效"。**
 *
 * ---------------------------------------------------------------------
 * 它管的是什么事故
 * ---------------------------------------------------------------------
 * 2026-09-19：`npm run calibrate`（考裁判）内部跑的那次 `--selftest`，
 * 把 `report/_selftest-report.md` —— **M0 验收记录本体** —— 覆盖成了一份
 * 写着「M0 未通过」的假记录（因为那次 `window.js` 是故意改坏的）。
 *
 * 修法是给产物加隔离后缀。而**这段命名逻辑必须自己先被证明是对的**，
 * 否则"修补丁的代码"会变成新的假象来源 —— 这正是本项目的老规矩：
 * **一个从未被证明能判错的检查，等于没有检查。**
 *
 * ---------------------------------------------------------------------
 * ⭐ 本文件的核心机制：测试自己也要考裁判（变异测试）
 * ---------------------------------------------------------------------
 *   M1 不做任何校验，直接把后缀拼进文件名 → 恶意后缀用例必须抓住
 *   M2 校验了，但白名单里混进 `/`            → 路径逃逸用例必须抓住
 *   M3 空后缀也给名字加一个点                → 正式产物比对用例必须抓住
 *
 * **任何一个变异体存活，本脚本即判 FAIL** —— 那说明用例表是假测试。
 *
 * ---------------------------------------------------------------------
 * 用法与退出码
 * ---------------------------------------------------------------------
 *   npm run test:names
 *   node tools/test-artifact-names.mjs
 *
 *   退出码 0 = 命名正确，且用例表已被证明有判别力
 *   退出码 1 = 命名有错，**或**用例表是假测试（有变异体存活）
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TAG_ENV,
  CALIB_TAG,
  CANONICAL_REPORT,
  CANONICAL_LOG,
  sanitizeTag,
  selftestReportName,
  selftestLogName,
  tagFromEnv,
  isIsolated,
} from '../src/main/artifact-names.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(HERE, '..', 'report');
const OUT = path.resolve(REPORT_DIR, 'test-artifact-names.txt');

const lines = [];
const say = (s = '') => {
  lines.push(s);
  process.stdout.write(s + '\n');
};

let bad = 0;
function check(desc, actual, expected) {
  const ok = actual === expected;
  if (!ok) bad += 1;
  say(`  ${ok ? '✓' : '✗'} ${desc}  →  ${JSON.stringify(actual)}${ok ? '' : `（期望 ${JSON.stringify(expected)}）`}`);
  return ok;
}

say('┌─ 产物命名契约 · 离线考裁判 ────────────────────────────────');
say('│ 被测：src/main/artifact-names.js');
say(`│ 环境变量：${TAG_ENV}　｜　校准后缀：${CALIB_TAG}`);
say('│ ⚠️ 范围：只考"名字算得对不对"，不考"校准器有没有真的传对变量"。');
say('└────────────────────────────────────────────────────────────');
say();

/* ================================================================== */
/* 用例表 —— 每一条都要说明"为什么它在"                                  */
/* ================================================================== */

/**
 * 恶意 / 非法后缀。它们**全部**必须降级成 `''`（= 正式产物）。
 * 白名单排除了 `/` 与 `\`，所以拼出来的名字不可能逃出 report/。
 */
const HOSTILE = [
  { tag: '../evil', why: '相对路径穿越' },
  { tag: 'a/b', why: '正斜杠分隔' },
  { tag: 'a\\b', why: '反斜杠分隔（Windows）' },
  { tag: '.\\..\\evil', why: 'Windows 形式穿越' },
  { tag: 'C:/abs', why: '绝对路径' },
  { tag: 'a\0b', why: '空字节截断' },
  { tag: 'a b', why: '空格' },
  { tag: 'a*b', why: '通配符' },
  { tag: '后缀', why: '非 ASCII（避免不同代码页下表现不一致）' },
  { tag: 'x'.repeat(33), why: '超过长度上限' },
  { tag: '', why: '空串' },
  { tag: '   ', why: '只有空白' },
  { tag: null, why: 'null' },
  { tag: undefined, why: 'undefined' },
  { tag: 42, why: '数字（非字符串）' },
];

/** 合法后缀 → 期望产物名。`''` 那一条就是**正式留痕的基准名**。 */
const LEGIT = [
  { tag: '', report: CANONICAL_REPORT, log: CANONICAL_LOG, why: '未隔离 = 正式产物（基准名）' },
  { tag: CALIB_TAG, report: '_selftest-report.calib.md', log: 'selftest-log.calib.txt', why: '校准器实际用的后缀' },
  { tag: '-v2', report: '_selftest-report-v2.md', log: 'selftest-log-v2.txt', why: '横线开头' },
  { tag: '_run1', report: '_selftest-report_run1.md', log: 'selftest-log_run1.txt', why: '下划线开头' },
  { tag: 'a1B2', report: '_selftest-reporta1B2.md', log: 'selftest-loga1B2.txt', why: '字母数字' },
];

/* ================================================================== */
/* 第一关 · 命名正确性                                                  */
/* ================================================================== */
say('--- 第一关 · 命名正确性 ---');

// 1a. 正式产物名必须与常量逐字一致 —— 防止常量与函数悄悄漂移
check('空后缀 → 正式报告名 === CANONICAL_REPORT', selftestReportName(''), CANONICAL_REPORT);
check('空后缀 → 正式日志名 === CANONICAL_LOG', selftestLogName(''), CANONICAL_LOG);

for (const c of LEGIT) {
  const got = `_selftest-report${sanitizeTag(c.tag)}.md` === selftestReportName(c.tag)
    && selftestLogName(c.tag) === `selftest-log${sanitizeTag(c.tag)}.txt`;
  if (!got) { bad += 1; say(`  ✗ ${JSON.stringify(c.tag)} 的名字与 sanitizeTag 不自洽`); continue; }
  say(`  ✓ ${JSON.stringify(c.tag)} → ${selftestReportName(c.tag)}　（${c.why}）`);
  if (selftestReportName(c.tag) !== c.report) { bad += 1; say(`      ✗ 报告名期望 ${c.report}`); }
  if (selftestLogName(c.tag) !== c.log) { bad += 1; say(`      ✗ 日志名期望 ${c.log}`); }
}

// 1b. 恶意后缀必须全部降级
say();
say('  · 恶意/非法后缀必须降级为空（= 正式产物）');
for (const h of HOSTILE) {
  const s = sanitizeTag(h.tag);
  const ok = s === '';
  if (!ok) bad += 1;
  say(`    ${ok ? '✓' : '✗'} ${JSON.stringify(h.tag)} → ${JSON.stringify(s)}　（${h.why}）`);
}

// 1c. **真正的安全断言**：产物路径必须永远落在 report/ 里
say();
say('  · 路径逃逸检查（真正的安全断言）');
for (const h of HOSTILE) {
  const p = path.join(REPORT_DIR, selftestReportName(h.tag));
  const inside = path.dirname(p) === REPORT_DIR;
  if (!inside) bad += 1;
  say(`    ${inside ? '✓' : '✗'} ${JSON.stringify(h.tag)} → ${path.relative(REPORT_DIR, p)}`);
}

// 1d. 环境变量读取
say();
check(`tagFromEnv({}) → ''`, tagFromEnv({}), '');
check(`tagFromEnv({ ${TAG_ENV}: '${CALIB_TAG}' }) → '${CALIB_TAG}'`, tagFromEnv({ [TAG_ENV]: CALIB_TAG }), CALIB_TAG);
check(`tagFromEnv({ ${TAG_ENV}: '../x' }) → ''`, tagFromEnv({ [TAG_ENV]: '../x' }), '');
check('isIsolated(\'\') === false', isIsolated(''), false);
check(`isIsolated('${CALIB_TAG}') === true`, isIsolated(CALIB_TAG), true);

/* ================================================================== */
/* 第二关 · 用例表本身的判别力（变异测试）                                */
/* ================================================================== */
say();
say('--- 第二关 · 用例表本身的判别力（变异测试）---');

const impl = (tag) => ({ report: selftestReportName(tag), log: selftestLogName(tag) });

const MUTANTS = [
  {
    id: 'M1',
    name: '不做任何校验，直接把后缀拼进文件名',
    fn: (tag) => {
      const t = typeof tag === 'string' ? tag : '';
      return { report: `_selftest-report${t}.md`, log: `selftest-log${t}.txt` };
    },
  },
  {
    id: 'M2',
    name: '白名单里混进了 `/` 与 `\\`',
    fn: (tag) => {
      const t = typeof tag === 'string' && /^[.A-Za-z0-9_/\\-]+$/.test(tag) ? tag : '';
      return { report: `_selftest-report${t}.md`, log: `selftest-log${t}.txt` };
    },
  },
  {
    id: 'M3',
    name: '空后缀也硬加一个点（正式产物被改名）',
    fn: (tag) => {
      const t = typeof tag === 'string' ? tag : '';
      return { report: `_selftest-report.${t}.md`, log: `selftest-log.${t}.txt` };
    },
  },
];

const ALL_TAGS = [...LEGIT.map((c) => c.tag), ...HOSTILE.map((h) => h.tag)];

for (const m of MUTANTS) {
  const caught = ALL_TAGS.filter((tag) => {
    const want = impl(tag);
    const got = m.fn(tag);
    return got.report !== want.report || got.log !== want.log;
  });
  const ok = caught.length > 0;
  if (!ok) bad += 1;
  say(`  ${ok ? '✓' : '✗'} ${m.id} ${ok ? '已被抓住' : '存活（这是个假测试！）'}（${caught.length} 条用例报警）—— ${m.name}`);
}

/* ================================================================== */
/* 结论                                                                */
/* ================================================================== */
say();
const ok = bad === 0;
say('┌─ 结论 ──────────────────────────────────────────────────────');
if (ok) {
  say(`│ ✓ PASS —— 命名正确，且用例表已被证明有判别力（${MUTANTS.length}/${MUTANTS.length} 变异体全部落网）`);
  say('│ ⚠️ 但这只覆盖"名字算得对不对"。');
  say(`│    "校准器有没有真的把 ${TAG_ENV}=${CALIB_TAG} 传进主进程"，仍需 npm run calibrate 实跑一次。`);
  say('│    那一侧由校准器自己的"守卫"（跑前快照 / 跑后逐字节比对）兜底。');
} else {
  say(`│ ✗ FAIL —— ${bad} 处问题（见上）`);
}
say('└────────────────────────────────────────────────────────────');

try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    `产物命名契约 · 离线考裁判\n生成时间：${new Date().toISOString()}\n结果：${ok ? 'PASS' : 'FAIL'}\n\n` + lines.join('\n') + '\n',
    'utf8',
  );
  say(`\n[test] 结果已写入 report/test-artifact-names.txt`);
} catch (err) {
  say(`\n[test] 结果落盘失败：${err && err.message}`);
}

process.exit(ok ? 0 : 1);
