/**
 * src/main/artifact-names.js —— 自检产物的**命名契约**（零依赖 · 纯函数）
 * =====================================================================
 * 一句话：**决定"这一次自检的产物写到哪个文件名"。**
 *
 * ---------------------------------------------------------------------
 * 为什么单独成一个模块（对应项目硬规则 R-B11）
 * ---------------------------------------------------------------------
 * 命名这件事**不需要 Electron**。写在 `index.js` 里的话，想验证它就得先启动
 * 整个 Electron —— 而本机沙箱里 Electron 是启动不了的，于是这段逻辑
 * **永远没法被验证**。抽出来之后，纯 Node 秒级可验：见 `tools/test-artifact-names.mjs`。
 *
 * ---------------------------------------------------------------------
 * 为什么需要"后缀"这个机制（2026-09-19 实际踩到的坑）
 * ---------------------------------------------------------------------
 * `npm run calibrate`（考裁判）内部会跑一次 `--selftest`，而那一次
 * `src/main/window.js` 是**故意改坏**的（`showInactive()` → `show()`）。
 * 若不做隔离，那一次运行的产物就会覆盖：
 *
 *     report/_selftest-report.md   ← **M0 验收记录本体**
 *     report/selftest-log.txt
 *
 * 于是正式留痕里会留下一份写着「M0 未通过」的**假记录**，还会误导人去走
 * MASTER-PLAN §4 的 R8/R9 降级预案。当时校准器只还原了源码、没管报告 ——
 * **源码干净，留痕却是错的。**
 *
 * 解法：校准器传 `M0_SELFTEST_TAG=.calib`，主进程据此把产物另存为
 * `_selftest-report.calib.md` / `selftest-log.calib.txt`，正式留痕一字不动。
 *
 * ⚠️ **安全**：后缀会拼进文件名，所以只接受白名单字符。
 *    校验不通过一律**当作没设置**（宁可产物同名，也不让非法值决定写到哪里）。
 *    白名单排除了 `/` 与 `\`，因此 `path.join(REPORT_DIR, name)` 不可能逃出 report/。
 * =====================================================================
 */

/** 传递隔离后缀的环境变量名（写：校准器；读：主进程） */
export const TAG_ENV = 'M0_SELFTEST_TAG';

/** 校准器使用的隔离后缀。改这里 = 改两侧的约定（本文件是唯一真源）。 */
export const CALIB_TAG = '.calib';

/** 正式产物的文件名 —— 这两个是「不许被校准覆盖」的基准名（= 后缀为空时的产物） */
export const CANONICAL_REPORT = '_selftest-report.md';
export const CANONICAL_LOG = 'selftest-log.txt';

/** 后缀长度上限（防呆，不是安全边界） */
const MAX_TAG_LEN = 32;
/** 白名单：点、横线、下划线、字母、数字。刻意不含路径分隔符与空字节。 */
const TAG_RE = /^[.A-Za-z0-9_-]+$/;

/**
 * 归一化后缀。非法 / 空 / 非字符串 → `''`（= 正式产物）。
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeTag(raw) {
  if (typeof raw !== 'string') return '';
  const t = raw.trim();
  if (!t || t.length > MAX_TAG_LEN) return '';
  return TAG_RE.test(t) ? t : '';
}

/** 自检验收报告的文件名（后缀为空时等于 `CANONICAL_REPORT`） */
export function selftestReportName(tag) {
  return `_selftest-report${sanitizeTag(tag)}.md`;
}

/** 自检日志的文件名（后缀为空时等于 `CANONICAL_LOG`） */
export function selftestLogName(tag) {
  return `selftest-log${sanitizeTag(tag)}.txt`;
}

/**
 * 从环境变量读后缀。非法值静默降级为 `''`。
 * @param {Record<string, unknown>} [env]
 */
export function tagFromEnv(env = process.env) {
  return sanitizeTag(env ? env[TAG_ENV] : '');
}

/** 这个后缀是否代表"隔离运行"（即产物不属于正式留痕） */
export function isIsolated(tag) {
  return sanitizeTag(tag) !== '';
}
