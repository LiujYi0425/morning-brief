/**
 * tools/lib/fail-blocks.mjs —— 把一份考裁判的输出切成「失败块」
 * =====================================================================
 * 谁在用：tools/test-mutants.mjs 的判据 —— "失败的**正是**那条断言"。
 *
 * ⚠️ 为什么要单独一个模块：这是**闸门自己的判据**，而它在 2026-09-30 静默坏过两次，
 *    两次都表现为"结论看起来很正常"：
 *
 *   ① 旧写法 `out.includes(m.expect)` 只问"整个输出里有没有这串字"。
 *      而**通过**的断言也会把自己的名字打进输出（`✓ 名字`）⇒
 *      83 条 expect 里有 31 条（37%）是某条通过断言的子串 ⇒
 *      **任何无关的红**（夹具抖动、时钟边界）都会让每条变异体都报"落网"。
 *      ⇒ 判据改成"只在失败块里找"。
 *
 *   ② 收紧之后又踩到第二个坑：两份考裁判的**格式不一样** ——
 *      · tools/test-all.mjs      打 `  ✗ 名字`（两个空格缩进）+ 紧跟的缩进明细；
 *      · tools/test-ai-brief.mjs 打 `✗ 名字 —— 明细`（**顶格**，一行到底）。
 *      旧解析只认前者 ⇒ test-ai-brief 那一整份文件的变异体**全部**被判成"漏网"，
 *      而它们其实全都落网了（失败明细里就写着 expect 那串字）。
 *      ⇒ 这是本项目最怕的那类故障：**闸门坏了，而它读起来像"断言不够"**。
 *
 * ⇒ 两条格式一起认。这条解析本身由 test-all 里那两条断言盯着（两种格式各一条 +
 *   一条"通过断言的文本不许参与匹配"），不再靠"看起来对"。
 */

/**
 * 一行「失败头」。⚠️ 缩进判据是 0~3 个空格：
 *   · test-all 用 2 个空格；
 *   · test-ai-brief 顶格；
 *   · 4 个及以上空格是**明细行**（见下面的续行规则），不能当成新的失败头。
 */
const FAIL_HEAD = /^\s{0,3}[✗✘]\s+(\S.*)$/;

/**
 * 切成失败块：每块 = 失败头那行 + 紧跟的缩进明细行（trim 过）。
 * 一段块的文本里出现 expect，才算"失败的正是那条断言"。
 */
export function parseFailBlocks(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text == null ? '' : text).split('\n')) {
    const head = line.match(FAIL_HEAD);
    if (head) {
      cur = [head[1]];
      blocks.push(cur);
      continue;
    }
    /* 缩进 4+ 且不是空白 ⇒ 这是上一条失败的明细（异常堆栈、期望/实际值都在这里） */
    if (cur && /^\s{4,}\S/.test(line)) {
      cur.push(line.trim());
      continue;
    }
    /* 通过行、顶格的新段落（小节标题 / 结论行）都意味着"上一条失败已经结束" */
    if (/^\s*[✔✓]/.test(line) || /^\S/.test(line)) cur = null;
  }
  return blocks;
}

/** expect 是否出现在**某一条失败**的信息里（通过断言的文本不参与匹配） */
export function failureMentions(text, expect) {
  return parseFailBlocks(text).some((block) => block.join('\n').includes(expect));
}
