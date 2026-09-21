#!/usr/bin/env node
/**
 * tools/calibrate-focus-referee.mjs —— 验收 3「不抢焦点」的**考裁判**（校准器）
 * =====================================================================
 * 一句话：**故意把被测代码改错，看测试敢不敢报警。**
 *
 * ---------------------------------------------------------------------
 * 为什么非要做这一步
 * ---------------------------------------------------------------------
 * 验收 3 的裁判（`window.js · startFocusTest`）自己给自己打分。它曾经是个
 * 「永远绿灯的假测试」：测试期内**没有任何"显示卡片"的动作**，于是
 * `cardFocusCount` 必然是 0，无论 `showInactive()` 有没有被误写成 `show()`，
 * 结论都一模一样（2026-09-18 修，加了主动 hide→show 与第三态 `invalid`）。
 *
 * 但"我改了"不等于"它现在真的会红"。《M0 验收记录》§6.4 第 4 条写得很清楚：
 * **考裁判不可跳过** —— 一个从未被证明能判错的检查，等于没有检查。
 * 本脚本就是把那条手工动作变成一条命令。
 *
 * ---------------------------------------------------------------------
 * 它具体做什么（六步，全程无人值守）
 * ---------------------------------------------------------------------
 *   1. 读 `src/main/window.js`，用**唯一锚点**定位校准点（必须恰好命中 1 处，
 *      0 处或 2 处一律拒绝开工 —— 宁可不动手，也不改错地方）；
 *   2. 备份原文到 `report/window.js.calib-backup`；
 *   3. 植入已知错误：把校准点那一行的 `win.showInactive()` 换成 `win.show()`
 *      （`show()` 会激活窗口 → 必然抢焦点 → 裁判**必须**报 fail）；
 *   4. 跑一次 `node tools/launch-electron.mjs . --selftest`，输出留档；
 *   5. 从「验收摘要」里读出第 3 条的 status，与期望值比对；
 *   6. **无论成败都还原**（含 Ctrl+C / 未捕获异常路径），并**逐字节校验**
 *      还原结果与原文一致 —— 不然"校准"就变成了"留下一个故意的 bug"。
 *
 * ---------------------------------------------------------------------
 * 判定是三态，不许合并（本项目的老规矩）
 * ---------------------------------------------------------------------
 *   CALIBRATED  (退出码 0)  裁判报 fail —— 它真的能判错，读数从此可信
 *   DEAD        (退出码 1)  裁判仍报 pass —— **测试是假的**，必须先修裁判
 *   INCONCLUSIVE(退出码 2)  压根没测到（没找到第 3 条 / cardShowCount=0 /
 *                           启动失败 / 还原失败）—— 不许冒充前两者
 *
 * 为什么 INCONCLUSIVE 必须单独存在：如果植入错误后自检连"显示卡片"都没发生，
 * 那"报 pass"可能只是**测试根本没跑起来**，而不是"裁判判不出来"。
 * 两者要修的东西完全不同，混在一起就会修错地方。
 *
 * ---------------------------------------------------------------------
 * ⚠️ 为什么必须把自检产物隔离开（2026-09-19 实际踩到的坑）
 * ---------------------------------------------------------------------
 * 第 4 步跑的是**真正的主进程**，它会照常把报告写到 `report/_selftest-report.md`
 * —— 也就是 **M0 验收记录本体**。于是"故意改坏"的那一次运行会**覆盖掉正式验收记录**，
 * 留下一份写着「M0 未通过」的假记录（第 3 条必然 fail，且会误导人去走 §4 降级预案）。
 * 当时本脚本只还原了源码、没管报告 —— **源码干净，留痕却是错的。**
 *
 * 修法是两层，缺一不可：
 *   · **隔离**（预防）：给子进程设 `M0_SELFTEST_TAG=.calib`，主进程据此把产物另存为
 *     `_selftest-report.calib.md` / `selftest-log.calib.txt`（默认空后缀，正式运行不受影响）。
 *   · **守卫**（验证）：跑前快照正式产物，跑后逐字节比对；发现被改动就**立刻还原并告警**。
 *     不能只做隔离 —— 那依赖"环境变量一定传到了"这个假设，而假设会失效。
 *
 * ---------------------------------------------------------------------
 * 用法
 * ---------------------------------------------------------------------
 *   npm run calibrate                    # 推荐
 *   node tools/calibrate-focus-referee.mjs
 *   node tools/calibrate-focus-referee.mjs --keep     # 故意不还原（仅排查用）
 *
 * 产物：
 *   report/calibration-focus-referee.md   本次校准结论（含原始读数）
 *   report/calib-focus-run.txt            自检原始输出（全文留档）
 *   report/window.js.calib-backup         原文备份（还原失败时的救命稻草）
 *   report/_selftest-report.calib.md      隔离的自检报告（**不是** M0 验收记录）
 *   report/selftest-log.calib.txt         隔离的自检日志
 *
 * 保证不动（跑完可复查）：
 *   report/_selftest-report.md            正式验收记录 —— 本脚本保证它逐字节不变
 *   report/selftest-log.txt               正式自检日志 —— 同上
 * =====================================================================
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// ⚠️ 命名契约与主进程**共用同一个真源**（零依赖模块，纯 Node 也能加载）——
//    否则校准器和 index.js 会各写一份文件名，然后悄悄漂移。
import { TAG_ENV, CALIB_TAG, selftestReportName, selftestLogName } from '../src/main/artifact-names.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGET = path.join(ROOT, 'src', 'main', 'window.js');
const REPORT_DIR = path.join(ROOT, 'report');
const BACKUP = path.join(REPORT_DIR, 'window.js.calib-backup');
const RUN_LOG = path.join(REPORT_DIR, 'calib-focus-run.txt');
const OUT_MD = path.join(REPORT_DIR, 'calibration-focus-referee.md');

/**
 * 自检产物隔离后缀 —— 传给子进程的 `M0_SELFTEST_TAG`。
 * 取自 `src/main/artifact-names.js`，与主进程共用同一个真源。
 */
const TAG = CALIB_TAG;

/**
 * 正式产物清单（跑前快照、跑后逐字节比对）。
 * 名字**也**由 `artifact-names.js` 以「空后缀」推导 —— 这样"正式名"和"隔离名"
 * 出自同一个函数，不会出现"两边各写一份、然后有一份写错"的事。
 *
 * 这是一个**守卫**，不是冗余：隔离靠"环境变量传到了"这个假设，
 * 而假设会失效（有人手改了 index.js、或 spawn 方式变了）。守卫不依赖任何假设。
 */
const GUARDED = [
  { name: selftestReportName(''), label: '正式验收记录' },
  { name: selftestLogName(''), label: '正式自检日志' },
].map((f) => ({ ...f, file: path.join(REPORT_DIR, f.name) }));

const KEEP = process.argv.includes('--keep');
const SELFTEST_TIMEOUT_MS = 120_000;

/**
 * 唯一锚点：必须是「hide 之后 300ms 再显示卡片」这一整段。
 * 只锚 `win.showInactive();` 这一行是危险的 —— 文件里另有 3 处同样的调用
 * （L175 初次显示、L216 从隐藏唤回、L440 setCardVisible），改错一处就是
 * 修改了产品行为却不自知。所以锚点带上缩进与前后两行，确保唯一。
 */
const ANCHOR = [
  '    win.hide();',
  '    setTimeout(() => {',
  '      if (!win.isDestroyed()) win.showInactive();',
  '    }, 300);',
].join('\n');

const ANCHOR_PATCHED = ANCHOR.replace('win.showInactive();', 'win.show();');

/* ================= 输出小工具 ================= */
const say = (s = '') => process.stdout.write(s + '\n');

/* ================= 还原：必须有兜底，且必须校验 ================= */
let original = null;
let restored = false;

function restore(reason) {
  if (restored || original === null || KEEP) return true;
  try {
    writeFileSync(TARGET, original, 'utf8');
    const back = readFileSync(TARGET, 'utf8');
    if (back !== original) {
      say(`✗✗ 还原后校验不一致！请手工从 ${BACKUP} 恢复 window.js`);
      return false;
    }
    restored = true;
    say(`[calib] ✓ 已还原 window.js（逐字节一致）｜触发原因：${reason}`);
    return true;
  } catch (err) {
    say(`✗✗ 还原失败：${err && err.message}`);
    say(`     原文备份在：${BACKUP}`);
    return false;
  }
}

process.on('exit', () => { restore('process exit'); });
process.on('SIGINT', () => { restore('SIGINT'); process.exit(130); });
process.on('SIGTERM', () => { restore('SIGTERM'); process.exit(143); });
process.on('uncaughtException', (err) => {
  say(`✗ 校准器自身抛错：${err && err.stack}`);
  restore('uncaughtException（校准器自身）');
  process.exit(2);
});

/* ================= 第 1 步：定位校准点 ================= */
say('┌─ 验收 3 · 考裁判（校准）────────────────────────────────────');
say(`│ 目标文件 : src/main/window.js`);
say(`│ 植入错误 : win.showInactive()  →  win.show()`);
say(`│ 期望结果 : 验收 3 报 fail`);
say('└────────────────────────────────────────────────────────────');
say();

if (!existsSync(TARGET)) {
  say(`✗ 找不到目标文件：${TARGET}`);
  process.exit(2);
}

const src = readFileSync(TARGET, 'utf8');
const hits = src.split(ANCHOR).length - 1;

if (hits === 0) {
  const alreadyPatched = src.includes(ANCHOR_PATCHED);
  say('✗ 锚点未命中（0 处）。可能原因：');
  say(alreadyPatched
    ? '  · window.js 当前已处于"植入错误"状态 —— 先还原再跑本脚本'
    : '  · startFocusTest() 的时序被改动了 —— 请同步更新本脚本的 ANCHOR');
  process.exit(2);
}
if (hits > 1) {
  say(`✗ 锚点在文件中出现 ${hits} 次，无法确定改哪一处。拒绝开工（宁可不动手，也不改错地方）。`);
  process.exit(2);
}
say('[calib] ✓ 锚点唯一命中 1 处，定位成功');

/* ================= 第 2 步：备份 ================= */
original = src;
mkdirSync(REPORT_DIR, { recursive: true });
try {
  copyFileSync(TARGET, BACKUP);
  say(`[calib] ✓ 原文已备份到 report/window.js.calib-backup`);
} catch (err) {
  say(`✗ 备份失败，拒绝继续（没有退路的改动不做）：${err && err.message}`);
  process.exit(2);
}

/* ================= 第 3 步：植入已知错误 ================= */
const patched = src.replace(ANCHOR, ANCHOR_PATCHED);
if (patched === src) {
  say('✗ 植入错误失败（替换后内容没变）—— 拒绝继续');
  process.exit(2);
}
writeFileSync(TARGET, patched, 'utf8');
say('[calib] ✓ 已植入已知错误（卡片将被 show() 激活，必然抢焦点）');
say();

/* ===== 第 3.5 步：快照正式留痕（守卫用，必须在跑之前） ===== */
const snapshots = GUARDED.map((f) => ({
  ...f,
  before: existsSync(f.file) ? readFileSync(f.file) : null,
}));
for (const s of snapshots) {
  say(`[calib] 守卫快照｜${s.label} ${s.name}：${s.before === null ? '当前不存在' : s.before.length + ' 字节'}`);
}
say();

/**
 * 跑后校验正式留痕有没有被改动；被改了就地还原。
 * 返回 [{ name, label, changed, restored }]。
 *
 * 为什么必须有这一层：**隔离是约定，守卫是验证。**
 * 隔离依赖「环境变量确实传到了子进程」这个假设，而假设会失效
 * （有人改回 index.js、spawn 方式变了、以后换了别的入口）。
 * 只靠约定的话，链路一断就会**静默地**污染正式留痕 —— 那正是本次要修的病灶。
 */
function guardArtifacts() {
  const result = [];
  for (const s of snapshots) {
    const now = existsSync(s.file) ? readFileSync(s.file) : null;
    const same =
      (now === null && s.before === null) ||
      (now !== null && s.before !== null && now.equals(s.before));
    if (same) {
      result.push({ name: s.name, label: s.label, changed: false, restored: false });
      continue;
    }
    let restored = false;
    try {
      if (s.before === null) rmSync(s.file, { force: true });
      else writeFileSync(s.file, s.before);
      restored = true;
    } catch { /* 还原失败：如实上报，不掩盖 */ }
    result.push({ name: s.name, label: s.label, changed: true, restored });
  }
  return result;
}

/* ================= 第 4 步：跑自检 ================= */
say('[calib] 正在跑自检（约 15 秒）…');
say();

const child = spawn(
  process.execPath,
  ['tools/launch-electron.mjs', '.', '--selftest'],
  {
    cwd: ROOT,
    env: (() => {
      // 与 launch-electron.mjs 同样的净化：不净化的话 electron.exe 会退化成普通 Node
      const e = { ...process.env };
      delete e.ELECTRON_RUN_AS_NODE;
      // 隔离：让这一次"故意改坏"的自检把产物另存为 *.calib.*，不去覆盖正式验收记录
      e[TAG_ENV] = TAG;
      return e;
    })(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

let out = '';
child.stdout.on('data', (b) => { out += b.toString('utf8'); });
child.stderr.on('data', (b) => { out += b.toString('utf8'); });

const killer = setTimeout(() => {
  say(`✗ 自检超过 ${SELFTEST_TIMEOUT_MS / 1000} 秒未结束，强制终止`);
  try { child.kill(); } catch { /* ignore */ }
}, SELFTEST_TIMEOUT_MS);

child.on('close', (code) => {
  clearTimeout(killer);
  try { writeFileSync(RUN_LOG, out, 'utf8'); } catch { /* ignore */ }

  /* ============ 第 4.5 步：守卫 —— 正式留痕有没有被这次运行改动 ============ */
  const guardResult = guardArtifacts();
  const contaminated = guardResult.filter((g) => g.changed);
  const guardLine = contaminated.length === 0
    ? '✓ 未被改动（正式验收记录与日志保持原样）'
    : contaminated
        .map((g) => `${g.restored ? '⚠️ 曾被改动，已自动还原' : '✗ 被改动且还原失败'}：${g.name}`)
        .join('；');

  /* ============ 第 5 步：判读 ============ */
  // 焦点测试的原始读数：`--- 焦点测试` 之后的那个 JSON 对象
  const focusLine = out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('{') && l.includes('cardShowCount') && l.includes('verdict'));
  let focus = null;
  if (focusLine) { try { focus = JSON.parse(focusLine); } catch { /* ignore */ } }

  // 验收摘要里的第 3 条：形如 `  3. [fail] 焦点 ...`
  const m = out.match(/^\s*3\.\s*\[(\w+)\]\s*(.*)$/m);
  const status3 = m ? m[1] : null;
  const title3 = m ? m[2].trim() : '';

  const summary = (() => {
    const sm = out.match(/^\{\s*"pass".*\}$/m);
    if (!sm) return null;
    try { return JSON.parse(sm[0]); } catch { return null; }
  })();

  /* ============ 判定（三态，不许合并）============ */
  let verdict;   // CALIBRATED | DEAD | INCONCLUSIVE
  let why;

  if (!m) {
    verdict = 'INCONCLUSIVE';
    why = `自检输出里找不到「验收摘要」的第 3 条（launcher 退出码 ${code}）。测试没跑到判定阶段，无法校准。`;
  } else if (status3 === 'fail') {
    verdict = 'CALIBRATED';
    why = '植入已知错误后，裁判确实报了 fail —— 这个检查**能判错**，读数从此可信。';
  } else if (focus && focus.cardShowCount === 0) {
    verdict = 'INCONCLUSIVE';
    why = `裁判报的是「${status3}」，但测试期内"显示卡片"根本没发生（cardShowCount=0）。`
        + ' 这说明不是"裁判判不出来"，而是**测试没跑起来**。先修这个，再谈校准。';
  } else {
    verdict = 'DEAD';
    why = `植入已知错误（show() 激活窗口、必然抢焦点）后，裁判仍然报「${status3}」——`
        + ' 这个检查**判不出错**，它给出的每一个 pass 都是无效的。必须先修裁判。';
  }

  /* ============ 第 6 步：还原 ============ */
  const ok = restore('校准结束');
  if (!ok && verdict !== 'INCONCLUSIVE') {
    verdict = 'INCONCLUSIVE';
    why += ' 另：window.js 还原失败，现场可能已被污染 —— 请先恢复到干净状态。';
  }

  /* ============ 汇报 ============ */
  const icon = verdict === 'CALIBRATED' ? '✓' : verdict === 'DEAD' ? '✗' : '?';
  const label = {
    CALIBRATED: 'CALIBRATED · 裁判有效',
    DEAD: 'DEAD · 裁判是假的',
    INCONCLUSIVE: 'INCONCLUSIVE · 没测到，不许冒充通过',
  }[verdict];

  say();
  say('┌─ 校准结论 ──────────────────────────────────────────────────');
  say(`│ ${icon} ${label}`);
  say(`│ 验收 3 状态 : ${status3 ?? '(未找到)'}  ${title3 ? ':: ' + title3.slice(0, 60) : ''}`);
  if (focus) {
    say(`│ 原始读数    : cardShowCount=${focus.cardShowCount} cardFocusCount=${focus.cardFocusCount} panelBlurCount=${focus.panelBlurCount}`);
  } else {
    say('│ 原始读数    : (未解析到)');
  }
  if (summary) say(`│ 验收摘要    : ${JSON.stringify(summary)}`);
  say(`│ launcher退出: ${code}`);
  say(`│ 正式留痕    : ${guardLine}`);
  say('└────────────────────────────────────────────────────────────');
  say();
  say(why);
  say();
  if (contaminated.length) {
    say('⚠️⚠️ 守卫告警：本次运行**动到了正式留痕**（隔离没生效）。');
    say('     说明「M0_SELFTEST_TAG 能传到主进程」这个前提已经不成立了 ——');
    say('     请检查 src/main/index.js 的 SELFTEST_TAG 与 spawn 处的传参。');
    for (const g of contaminated) {
      say(`     · ${g.label} ${g.name}：${g.restored ? '已自动还原' : '**还原失败，请手工检查**'}`);
    }
    say('     ⚠️ 另外：那一次自检的结论也不该被当成 M0 验收结果。');
    say();
  }

  const md = [
    '# 验收 3 · 考裁判（校准）记录',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 目标：\`src/main/window.js\` · \`startFocusTest()\` 的 \`hide() → 300ms → (显示卡片)\``,
    `- 植入的已知错误：\`win.showInactive()\` → \`win.show()\`（会激活窗口 → 必然抢焦点）`,
    `- 期望：验收 3 报 \`fail\``,
    '',
    `## 结论：**${label}**`,
    '',
    why,
    '',
    '## 原始读数',
    '',
    '| 项 | 值 |',
    '|---|---|',
    `| 验收 3 状态 | \`${status3 ?? '(未找到)'}\` |`,
    `| 验收 3 标题 | ${title3 || '(未找到)'} |`,
    `| cardShowCount（"显示卡片"发生了几次） | ${focus ? focus.cardShowCount : '(未解析)'} |`,
    `| cardFocusCount（卡片抢到焦点几次） | ${focus ? focus.cardFocusCount : '(未解析)'} |`,
    `| panelBlurCount（面板被挤失焦几次） | ${focus ? focus.panelBlurCount : '(未解析)'} |`,
    `| 验收摘要 | \`${summary ? JSON.stringify(summary) : '(未解析)'}\` |`,
    `| launcher 退出码 | ${code} |`,
    `| 还原 window.js | ${ok ? '✓ 已还原且逐字节一致' : '✗ 未还原 / 校验失败'} |`,
    `| 正式留痕（验收记录 / 日志） | ${guardLine} |`,
    '',
    '## 校准器自己的可信度',
    '',
    '- **能判出"裁判是假的"吗？** 能。若裁判恒报 pass（DEAD），本脚本退出码 1，绝不会把它读成"通过"。',
    '- **能判出"测试没跑起来"吗？** 能。`cardShowCount === 0` 时判 INCONCLUSIVE（退出码 2），不冒充前两者。',
    '- **会不会留下污染？** 三层：① **隔离** —— 子进程带 `M0_SELFTEST_TAG=.calib`，本次自检产物另存为',
    '  `_selftest-report.calib.md` / `selftest-log.calib.txt`，**不碰**正式留痕；',
    '  ② **守卫** —— 跑前快照、跑后逐字节比对正式产物，被改动就地还原并告警；',
    '  ③ **还原源码** —— 逐字节校验，失败则本次结论一律降级为 INCONCLUSIVE。',
    '',
    '  ⚠️ 这条曾经是**不准确**的：早期版本只还原源码，却放任这次自检覆盖掉',
    '  `report/_selftest-report.md` —— 也就是 M0 验收记录本体，留下一份写着「M0 未通过」的',
    '  假记录（2026-09-19 实际发生，见 `docs/05-M0验收记录.md`）。①②为此而加。',
    '',
    `> 原始自检输出全文：\`report/calib-focus-run.txt\`　｜　原文备份：\`report/window.js.calib-backup\``,
    '',
    `*由 \`tools/calibrate-focus-referee.mjs\` 于 ${new Date().toISOString()} 自动生成 —— 手工跑法见该脚本头部注释。*`,
    '',
  ].join('\n');
  try {
    writeFileSync(OUT_MD, md, 'utf8');
    say(`[calib] 结论已写入 report/calibration-focus-referee.md`);
  } catch (err) {
    say(`[calib] 结论落盘失败：${err && err.message}`);
  }
  say(`[calib] 自检原始输出：report/calib-focus-run.txt`);

  process.exit(verdict === 'CALIBRATED' ? 0 : verdict === 'DEAD' ? 1 : 2);
});
