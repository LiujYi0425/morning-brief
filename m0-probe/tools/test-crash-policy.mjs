/**
 * tools/test-crash-policy.mjs —— 主进程失败语义的离线考裁判
 * =====================================================================
 * 一句话：**在不需要 Electron 的前提下，真的触发一次崩溃，验证"落盘 + 退出"确实发生。**
 *
 * ---------------------------------------------------------------------
 * 为什么能离线做（这不是巧合，是设计出来的）
 * ---------------------------------------------------------------------
 * `src/main/crashlog.js` **有意不 import electron** —— 它只做「读写文件 + 决定退出码」。
 * 所以本文件可以在纯 Node 下真的 `throw` 一个未捕获异常，真的去读那条崩溃记录，
 * 真的去断言退出码。**不需要 GUI 运行时**。
 *
 *   > 反面例子：如果这堆逻辑留在 `index.js` 里（它 import 了 electron），
 *   > 那么在沙箱 / CI / 无头环境里，这个策略**永远无法被验证** ——
 *   > 只能靠"人手跑一次应用然后祈祷"。
 *
 * ---------------------------------------------------------------------
 * 三个子进程角色
 * ---------------------------------------------------------------------
 *   --child uncaught          安装处理器 → 抛未捕获异常
 *   --child uncaught-noexit   同上，但**故意不退出**（变异体：模拟 B13 最初那个坏实现）
 *   --child rejection         安装处理器 → 制造一次未处理的 promise 拒绝
 *
 * ---------------------------------------------------------------------
 * ⭐ 考裁判在这里的形态：**用一个"已知坏掉"的实现反证断言有判别力**
 * ---------------------------------------------------------------------
 * `uncaught-noexit` 就是那个已知坏掉的实现。它必须给出**退出码 0**。
 * 于是"真实现必须给出退出码 1"这条断言就有了判别力 ——
 * 如果哪天有人把 `exitOnUncaught` 默认值改错、或者干脆删掉退出那一行，
 * 本脚本会**立刻红**，而不是继续安静地报绿。
 *
 * ---------------------------------------------------------------------
 * 用法与退出码
 * ---------------------------------------------------------------------
 *   npm run test:crash
 *   node tools/test-crash-policy.mjs
 *
 *   退出码 0 = 策略按设计工作
 *   退出码 1 = 有断言不通过
 * =====================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CRASH_FILE,
  CRASH_LOG,
  REJECTION_LOG,
  buildCrashRecord,
  describeCrash,
  takePendingCrash,
  FAILURE_KIND,
  EXIT_CODES,
} from '../src/main/crashlog.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'report', 'test-crash-policy.txt');
const SELF = fileURLToPath(import.meta.url);
const MARKER = 'BOOM-崩溃策略测试';

/* ================================================================== */
/* 子进程分支 —— 必须在任何测试代码之前拦住                            */
/* ================================================================== */
const childIdx = process.argv.indexOf('--child');
if (childIdx !== -1) {
  const mode = process.argv[childIdx + 1];
  const { installFailureHandlers } = await import('../src/main/crashlog.js');

  // 兜底：任何情况下都不许挂死，2 秒后强制退出并给一个可识别的码
  setTimeout(() => process.exit(70), 2000);

  if (mode === 'uncaught') {
    installFailureHandlers();
    setTimeout(() => {
      throw new Error(MARKER);
    }, 50);
  } else if (mode === 'uncaught-noexit') {
    // ★ 变异体：这正是 B13 最初那个「只打日志、不退出」的坏实现
    installFailureHandlers({ exitOnUncaught: false });
    setTimeout(() => {
      throw new Error(MARKER);
    }, 50);
    setTimeout(() => process.exit(0), 400);
  } else if (mode === 'rejection') {
    installFailureHandlers();
    Promise.reject(new Error(MARKER));
    setTimeout(() => process.exit(0), 400);
  } else {
    console.error(`未知子进程模式：${mode}`);
    process.exit(71);
  }

  /* ★ 必须在这里"停车"：不然执行流会顺着往下跑**主测试**，
   *   于是子进程又会去 spawn 一堆子进程 —— 递归爆炸，而且看起来像测试挂了。
   *   永远不 resolve 的 Promise 是最干净的停法：
   *   上面的 setTimeout / 处理器会各自把进程按预期结束掉。 */
  await new Promise(() => {});
}

/* ================================================================== */
/* 主测试                                                              */
/* ================================================================== */
const lines = [];
const say = (s = '') => {
  lines.push(s);
  process.stdout.write(s + '\n');
};

let bad = 0;
const check = (ok, name, detail = '') => {
  if (ok) {
    say(`  ✓ ${name}`);
  } else {
    bad += 1;
    say(`  ✗ ${name}`);
    if (detail) say(`      ${detail}`);
  }
};

/* ---- 备份现场：report/ 是真实证据目录，测试不许留假崩溃记录 ---- */
const backup = new Map();
for (const f of [CRASH_FILE, CRASH_LOG, REJECTION_LOG]) {
  backup.set(f, fs.existsSync(f) ? fs.readFileSync(f) : null);
}
const restore = () => {
  for (const [f, content] of backup) {
    try {
      if (content === null) fs.rmSync(f, { force: true });
      else fs.writeFileSync(f, content);
    } catch {
      /* ignore */
    }
  }
};

function clearArtifacts() {
  for (const f of [CRASH_FILE, CRASH_LOG, REJECTION_LOG]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function runChild(mode) {
  const r = spawnSync(process.execPath, [SELF, '--child', mode], {
    encoding: 'utf8',
    timeout: 15000,
  });
  return { code: r.status, stderr: r.stderr || '', stdout: r.stdout || '' };
}

say('┌─ 主进程失败语义 · 考裁判（落盘 + 退出策略）─────────────────');
say('│ 被测：src/main/crashlog.js');
say('│ 策略：uncaughtException → 同步落盘 → exit(1)');
say('│       unhandledRejection → 同步落盘 → 不退出但可见');
say('│ ⚠️ 范围：真的触发崩溃、真的读落盘内容与退出码（纯 Node，不需要 Electron）');
say('└────────────────────────────────────────────────────────────');
say();

try {
  /* ============ 第一关：uncaughtException 必须落盘并退出 ============ */
  say('--- 第一关 · uncaughtException → 落盘 + exit(1) ---');
  clearArtifacts();

  const c1 = runChild('uncaught');
  check(
    c1.code === EXIT_CODES.UNCAUGHT,
    `退出码 = ${EXIT_CODES.UNCAUGHT}`,
    `实际 ${c1.code}（stderr 尾部：${c1.stderr.trim().split('\n').slice(-2).join(' | ')}）`,
  );

  const existsAfterUncaught = fs.existsSync(CRASH_FILE);
  check(existsAfterUncaught, '崩溃标记文件已生成', CRASH_FILE);

  let rec = null;
  if (existsAfterUncaught) {
    try {
      rec = JSON.parse(fs.readFileSync(CRASH_FILE, 'utf8'));
    } catch (e) {
      say(`      ✗ 崩溃记录解析失败：${e && e.message}`);
      bad += 1;
    }
  }
  if (rec) {
    check(rec.kind === FAILURE_KIND.UNCAUGHT, `kind = ${FAILURE_KIND.UNCAUGHT}`, `实际 ${rec.kind}`);
    check(String(rec.message).includes(MARKER), '记录了原始错误消息');
    check(rec.fatal === true, 'fatal = true（致命由种类决定，不由调用方随口指定）');
    check(typeof rec.stack === 'string' && rec.stack.includes('Error'), '保留了调用栈');
    check(Boolean(rec.at && rec.pid && rec.node), '带了时间 / pid / node 版本');
  }

  // 全量流水也要能对上
  const logLines = fs.existsSync(CRASH_LOG)
    ? fs.readFileSync(CRASH_LOG, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  check(logLines.length === 1, 'crash-log.jsonl 追加了 1 条', `实际 ${logLines.length} 条`);

  /* ============ 第二关：崩溃标记"报告一次即消费" ============ */
  say('');
  say('--- 第二关 · 崩溃标记必须"报告一次就消失" ---');
  const first = takePendingCrash();
  const second = takePendingCrash();
  check(Boolean(first && first.message && String(first.message).includes(MARKER)), '第一次取到了那条崩溃记录');
  check(second === null, '第二次取返回 null —— 不会重复报告同一场崩溃');
  check(!fs.existsSync(CRASH_FILE), '取走后标记文件已被删除');

  /* ============ 第三关：unhandledRejection 落盘但不退出 ============ */
  say('');
  say('--- 第三关 · unhandledRejection → 落盘 + 不退出 ---');
  clearArtifacts();

  const c2 = runChild('rejection');
  check(c2.code === 0, '退出码 = 0（不退出，应用继续活着）', `实际 ${c2.code}`);
  check(!fs.existsSync(CRASH_FILE), '**没有**生成致命崩溃标记（它不该被当成崩溃）');

  const rejLines = fs.existsSync(REJECTION_LOG)
    ? fs.readFileSync(REJECTION_LOG, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  check(rejLines.length === 1, 'rejection-log.txt 记录了 1 条', `实际 ${rejLines.length} 条`);
  if (rejLines.length === 1) {
    let rj = null;
    try {
      rj = JSON.parse(rejLines[0]);
    } catch {
      /* ignore */
    }
    if (rj) {
      check(rj.kind === FAILURE_KIND.REJECTION, `kind = ${FAILURE_KIND.REJECTION}`, `实际 ${rj.kind}`);
      check(rj.fatal === false, 'fatal = false（非致命）');
      check(String(rj.message).includes(MARKER), '记录了原始拒绝原因');
    } else {
      check(false, 'rejection 记录可解析');
    }
  }

  /* ============ 第四关：纯函数的边界 ============ */
  say('');
  say('--- 第四关 · 纯函数边界（不落盘、不退出）---');
  const norm = buildCrashRecord('只是一个字符串', FAILURE_KIND.UNCAUGHT);
  check(norm.name === 'Error' && norm.message.includes('只是一个字符串'), '非 Error 的抛出物被归一成 Error');
  check(norm.fatal === true, 'fatal 由 kind 推导');
  check(
    buildCrashRecord(new Error('x'), FAILURE_KIND.REJECTION).fatal === false,
    'kind=unhandledRejection 时 fatal=false',
  );
  check(describeCrash(null) === 'none', 'describeCrash(null) 安全返回 none');
  check(describeCrash(norm).includes('uncaughtException'), 'describeCrash 输出可读的一行');

  /* ============ 第五关 · 考裁判：证明上面的断言有判别力 ============ */
  say('');
  say('--- 第五关 · 考裁判（变异体必须落网）---');
  clearArtifacts();

  const c3 = runChild('uncaught-noexit');
  check(
    c3.code === 0,
    '变异体「落盘但不退出」的退出码 = 0',
    `实际 ${c3.code} —— 若它不是 0，说明变异体没生效，第一关的断言就没有判别力`,
  );
  check(
    fs.existsSync(CRASH_FILE),
    '变异体一样落了盘（证明第一关能区分的是"退不退出"，不是"写没写文件"）',
  );
  say('      ⇒ 结论：第一关"退出码必须 = 1"这条断言**有判别力** ——');
  say('        一个不退出实现会被它当场抓住，而不是安静地报绿。');

  clearArtifacts();
} finally {
  restore();
}

/* ================================================================== */
const ok = bad === 0;
say('');
say('┌─ 结论 ──────────────────────────────────────────────────────');
if (ok) {
  say('│ ✓ PASS —— 落盘与退出策略按设计工作，且断言已被证明有判别力');
  say('│ ⚠️ 范围：本脚本验的是 crashlog.js 的策略本体。');
  say('│    "index.js 有没有正确装上它"仍需一次真启动（沙箱可能不允许）。');
} else {
  say(`│ ✗ FAIL —— ${bad} 项不通过（见上）`);
}
say('└────────────────────────────────────────────────────────────');

try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    `主进程失败语义 · 考裁判\n生成时间：${new Date().toISOString()}\n结果：${ok ? 'PASS' : 'FAIL'}\n\n` + lines.join('\n') + '\n',
    'utf8',
  );
  say(`\n[test] 结果已写入 report/test-crash-policy.txt`);
} catch (err) {
  say(`\n[test] 结果落盘失败：${err && err.message}`);
}

process.exit(ok ? 0 : 1);
