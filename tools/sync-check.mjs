#!/usr/bin/env node
/**
 * 晨报机 · 文档同步校验工具
 *
 * 用法：node tools/sync-check.mjs
 *
 * 它检查八件事（1–3、6 报 FAIL，4–5、7–8 报 WARN）：
 *   1. 每份文档/代理定义都有合法且完整的元数据块
 *   2. 每份文档声明依赖的上游版本，确实存在且版本匹配
 *   3. 每份文档有必需的章节（文档要「变更记录」，代理要七个章节）
 *   4. 项目计划工程书的「文档同步矩阵」覆盖了所有 doc_id
 *   5. agents/registry.json 与 agents/*.md 的实际内容一致
 *   6. **每条 depends_on 都存在「核对留痕」**（见下）
 *   7. **表格完整性** —— 空行不许把一张表断成两截
 *   8. **§6 同步矩阵里的版本号 vs frontmatter** —— 它现在是全库唯一的权威版本表
 *
 * ⚠️ **维护提醒：改检查项时，务必同步改这一段的条数和编号。**
 * 这条注释已经因为"加了检查忘了改计数"错过**两次**：
 * 第一次写"检查四件事"却列了 5 条；第二次写"六件事"时第 7 项已经实现。
 * 一次是疏忽，两次就是模式 —— 加检查项时，**这段注释是最容易被漏掉的那个副本。**
 * （它自己就是本文件第 6 项检查所针对的那类问题：声明与事实不符，而没有任何机器在看着。）
 *
 * ─────────────────────────────────────────────────────────────
 * 关于第 6 项：记账 vs 实质（R-D03 修订 + R-D05）
 * ─────────────────────────────────────────────────────────────
 *
 * `depends_on: ID@V` 的精确语义是 **「我已核对 ID 到 V 版」**，
 * 而不仅仅是「我依赖它」。上游一升版，`depends_on` 就过期，
 * 本工具立刻报错，逼你去核对 —— 这是**防"静默过期"的第一道闸**（第 2 项检查）。
 *
 * 但光有第一道闸不够：它只保证"版本号对上了"，不保证你真的看过。
 * 手改一个数字也能让它变绿。所以再加第二道闸（第 6 项检查）：
 *
 *   **每条 `depends_on: ID@V`，其字面量 `ID@V` 必须出现在"留痕位置"里。**
 *
 *   文档的留痕位置 = 它自己的「变更记录」章节
 *   代理的留痕位置 = 它自己的「Lessons」章节 ＋ `agents/README.md` §7
 *                     （代理定义的核对记录按既有约定集中记在后者）
 *
 * 这条检查把 `项目规则.md` 的 **R-D03「核对后即使不改也要留痕」**
 * 从"纪律"变成了"机器可查"。**写下核对结论的过程，就是核对本身。**
 *
 * 为什么这样设计（R-D05）：**更新 `depends_on` 与补写留痕都属于「记账」，不改版本号。**
 * 于是级联**只跑一轮**：
 *
 *   上游升版 → 下游核对（改 depends_on + 留痕，**不升版**）
 *            → 下游版本未变 → **它的下游不会过期** → 终止
 *
 * 旧机制下，下游"仅依赖跟进"也要升 patch，于是下游的下游跟着过期，
 * 级联递归下去（实测一次"改一句措辞"曾带出 9 个文件、并继续向第二轮扩散）。
 *
 * 版本号只表示一件事：**这份文档自己的实质内容变了。**
 * ─────────────────────────────────────────────────────────────
 *
 * 退出码：全部通过 0，有问题 1。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCAN_DIRS = ['.', 'docs', 'agents'];
const SKIP_PREFIX = '_';
const MASTER_PLAN = '项目计划工程书.md';
const REGISTRY = 'agents/registry.json';

const REQUIRED_DOC_KEYS = ['doc_id', 'version', 'updated', 'status'];
const REQUIRED_AGENT_KEYS = ['agent_id', 'version', 'type', 'updated', 'status', 'trigger', 'depends_on'];

const REQUIRED_DOC_SECTIONS = ['变更记录'];
const REQUIRED_AGENT_SECTIONS = [
  '职责',
  '不负责',
  '输入契约',
  '输出契约',
  '执行清单',
  '自检清单',
  'Lessons',
];

const errors = [];
const warnings = [];
const docs = new Map();   // doc_id -> { file, meta }
const agents = new Map(); // agent_id -> { file, meta }

/* ---------- 工具函数 ---------- */

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = text.slice(3, end);
  const data = {};
  for (const raw of block.split(/\r?\n/)) {
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const val = m[2].trim();
    data[m[1]] = val === '' ? null : val;
  }
  return data;
}

function parseDeps(str) {
  if (!str || str === 'none') return [];
  return str
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf('@');
      return i === -1 ? { id: s, version: null } : { id: s.slice(0, i), version: s.slice(i + 1) };
    });
}

/**
 * 判断文档里是否存在某个二级/三级标题。
 * 允许标题带编号和前缀修饰，例如 "## 7. 变更记录"、"### G.2 规则变更记录" 都算数。
 * 这样章节编号可以自由调整，不会因为改了编号就让校验失败。
 */
function hasSection(text, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#{2,3}\\s+.*${escaped}\\s*$`, 'm');
  return re.test(text);
}

/**
 * 取出某个二级/三级标题下的**正文**（到下一个同级或更高级标题为止）。
 * 用于第 6 项检查：核对留痕只认「变更记录 / Lessons」章节里的字面量，
 * **不认 frontmatter、不认页脚、不认正文里的顺口一提** ——
 * 否则 `depends_on: X@1.0.0` 这一行自身就含 `X@1.0.0`，检查会被自己满足。
 */
function extractSection(text, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#{2,3}\\s+.*${escaped}\\s*$`, 'm');
  const m = re.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^#{2,3}\s+/m);
  const body = next === -1 ? rest : rest.slice(0, next);

  // ⚠️ 必须去掉页脚 —— 这一步不是洁癖，是正确性。
  // 「变更记录」通常是文件的最后一节，若只切到"下一个 ## 标题"，
  // 页脚就会被算进来，而页脚里写着 `上游：MASTER-PLAN@1.2.0` ——
  // **等于让页脚替下游把留痕写掉了，检查自己满足自己**。
  // （这个洞真的存在过：代码写完先没截断页脚，结果 13 个受管单元里
  //   只有 2 个报缺留痕，而实际上有一半是在靠页脚蒙混过关。）
  return body
    .split(/\r?\n/)
    .filter((l) => !/^\s*\*[^*].*\*\s*$/.test(l)) // 只去 `*…*` 形式的页脚行，`**加粗**` 不受影响
    .join('\n');
}

function collectMarkdown(dir) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const name = entry.name;
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(abs, name);
    if (entry.isDirectory()) {
      if (dir === '.') out.push(...collectMarkdown(name));
      continue;
    }
    if (!name.endsWith('.md')) continue;
    if (name.startsWith(SKIP_PREFIX)) continue; // 模板文件不参与校验
    if (dir === '.' && name === 'README.md') continue;
    out.push(full);
  }
  return out;
}

/* ---------- 1 & 3：扫描并校验元数据与必需章节 ---------- */

const files = [];
for (const dir of SCAN_DIRS) files.push(...collectMarkdown(dir));

for (const file of [...new Set(files)]) {
  const raw = fs.readFileSync(file, 'utf8');

  /* ⚠️⚠️ CRLF 陷阱（2026-09-22 实测抓到，属"检查静默失效"）
   *
   * 旧的写法是 `const text = fs.readFileSync(file, 'utf8')` 直接喂给 parseFrontmatter。
   * 在 **CRLF** 文件上这会**静默丢掉 frontmatter 的最后一个键**，原因有三步、缺一不可：
   *   ① `text.indexOf('\n---', 3)` 定位到的是 `\r\n` 里的那个 `\n`，
   *      所以 `text.slice(3, end)` **把行尾的 `\r` 留在了块里**；
   *   ② `block.split(/\r?\n/)` 只吃成对的 `\r\n`，**末尾那个孤立的 `\r` 不会被切掉**；
   *   ③ JS 正则的 `.` **不匹配 `\r`**（`\r` 是行终止符），于是 `(.*)$` 匹配不上
   *      —— `$` 要求到达输入末尾，而 `.*` 又吃不掉那个 `\r`，回溯也救不回来。
   *   ⇒ 最后一行 `NO-MATCH`，那个键直接消失。
   *
   * 实际后果（真实发生）：`项目规则.md` 是全项目**唯一**的 CRLF 文件，
   * 而它 `depends_on` 恰好是**最后一个键** ⇒ 检查器**从来没看见过它的上游依赖**，
   * 于是"依赖未跟进"这条闸门对它**永久失效**，而且**不会有任何报错**。
   *
   * 处置：① 归一化（修正确性）；② 对 CRLF 直接判 FAIL（修约定 —— 不报就没人知道）。
   * 光做 ① 会让这个文件差异从"会报错"变成"被悄悄容忍"，那正是本项目最忌讳的方向。
   */
  const text = raw.replace(/\r\n?/g, '\n');
  const meta = parseFrontmatter(text);
  const r = rel(file);

  if (/\r/.test(raw)) {
    errors.push(
      `${r}：文件用了 **CRLF** 换行，本项目约定 **LF**（无 BOM）。` +
        `CRLF 会让 frontmatter 的最后一个键被解析器静默丢掉（原因见本循环上方的注释），` +
        `从而让该文件的依赖同步检查**永久失效且不报错**。请把该文件统一改为 LF。`
    );
  }

  if (!meta) {
    errors.push(`${r}：缺少元数据块（文件必须以 --- 开头）`);
    continue;
  }

  const isAgent = Boolean(meta.agent_id);
  const kind = isAgent ? 'agent' : 'doc';
  const required = isAgent ? REQUIRED_AGENT_KEYS : REQUIRED_DOC_KEYS;
  const idKey = isAgent ? 'agent_id' : 'doc_id';
  const id = meta[idKey];
  const sections = isAgent ? REQUIRED_AGENT_SECTIONS : REQUIRED_DOC_SECTIONS;

  for (const key of required) {
    if (!meta[key]) errors.push(`${r}：元数据缺少必填字段 \`${key}\``);
  }

  for (const s of sections) {
    if (!hasSection(text, s)) errors.push(`${r}：缺少必需章节「${s}」`);
  }

  if (id) {
    const bucket = isAgent ? agents : docs;
    if (bucket.has(id)) {
      errors.push(`${r}：${idKey} = "${id}" 与 ${bucket.get(id).file} 重复`);
    } else {
      bucket.set(id, { file: r, meta, text });
    }
  }
}

/* ---------- 2 & 6：依赖解析 + 核对留痕 ---------- */

// 代理定义的核对记录按既有约定集中记在 agents/README.md §7，故单独取出。
// ⚠️ 刻意**不**把 registry.json 算作留痕来源：那里的 `dependsOn` 字段本身就写着
//    `X@1.0.0`，把它算进来等于让检查自己满足自己（与 frontmatter 同理）。
let agentRecordText = '';
try {
  const t = fs.readFileSync(path.join(ROOT, 'agents', 'README.md'), 'utf8');
  agentRecordText = extractSection(t, '代理系统变更记录');
} catch {
  /* 取不到就让下面的检查自己去报错，不在这里吞掉问题 */
}

for (const [id, { file, meta, text }] of [...docs, ...agents]) {
  const deps = parseDeps(meta.depends_on);
  const isAgent = Boolean(meta.agent_id);

  // 留痕位置：文档 = 自己的「变更记录」；代理 = 自己的「Lessons」 ＋ agents/README.md §7
  const traceText = isAgent
    ? `${extractSection(text, 'Lessons')}\n${agentRecordText}`
    : extractSection(text, '变更记录');
  const traceWhere = isAgent
    ? '「Lessons」章节或 agents/README.md 的「代理系统变更记录」'
    : '「变更记录」章节';

  // ⚠️ 防静默失效：如果留痕位置取出来是**空的**，那么下面那条 `includes()` 必然为假、
  // 或者（更糟）看起来像"全都通过了"。整条检查会安静地失效 —— 这正是我们这轮
  // 在页脚漏洞上吃到过的教训（检查自己满足自己 / 检查悄悄不工作）。
  // 所以：位置取空 = 报错，而且要说清是"标题写法不匹配"这种最可能的原因。
  if (!traceText.trim()) {
    errors.push(
      `${file}：留痕位置（${traceWhere}）取到的是空内容 —— ` +
        `该章节可能不存在、或标题写法与检查不匹配。**这会让整条留痕检查静默失效，必须先修标题**`
    );
    continue;
  }

  for (const dep of deps) {
    const target = docs.get(dep.id) || agents.get(dep.id);
    if (!target) {
      errors.push(`${file}：依赖的上游 \`${dep.id}\` 不存在`);
      continue;
    }

    // 第二道闸（现在不再有"版本跟进"这个动作，所以这一条就是唯一的同步动作）：
    // 声明的版本必须是上游的当前版本。不等于 → 你还没核对，去核对。
    if (dep.version && target.meta.version !== dep.version) {
      errors.push(
        `[未跟进] ${file}：依赖未跟进 —— 声明 ${dep.id}@${dep.version}，但上游当前是 ${target.meta.version}。` +
          `请核对后把 depends_on 更新到 ${target.meta.version}（记账，不改本文件版本号）`
      );
    }

    // 第三道闸（R-D03）：核对过就必须留下痕迹，且痕迹必须含确切版本号。
    // 只改 depends_on 的数字而没写结论 → 在这里被抓住。
    if (dep.version) {
      const token = `${dep.id}@${dep.version}`;
      if (!traceText.includes(token)) {
        errors.push(
          `[缺留痕] ${file}：${traceWhere}里找不到 \`${token}\`。` +
            `请写明"已核对 ${token}，结论：…"（R-D03）`
        );
      }
    }
  }
}

/* ---------- 4：同步矩阵覆盖检查 ---------- */

const masterPath = path.join(ROOT, MASTER_PLAN);
if (!fs.existsSync(masterPath)) {
  errors.push(`缺少权威源文件 ${MASTER_PLAN}`);
} else {
  const master = fs.readFileSync(masterPath, 'utf8');
  for (const id of docs.keys()) {
    if (!master.includes('`' + id + '`')) {
      warnings.push(`项目计划工程书 §6 同步矩阵未收录 doc_id \`${id}\``);
    }
  }
  const masterMeta = docs.get('MASTER-PLAN');
  if (masterMeta && masterMeta.meta.version !== '1.0.0' && !master.includes(masterMeta.meta.version)) {
    warnings.push(`项目计划工程书的同步矩阵可能未反映最新版本 ${masterMeta.meta.version}`);
  }
}

/* ---------- 5：registry.json 与代理文件一致性 ---------- */

const registryPath = path.join(ROOT, REGISTRY);
if (!fs.existsSync(registryPath)) {
  warnings.push(`缺少 ${REGISTRY}`);
} else {
  let registry = null;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    errors.push(`${REGISTRY}：JSON 解析失败 —— ${e.message}`);
  }
  if (registry?.agents) {
    for (const entry of registry.agents) {
      const live = agents.get(entry.agentId);
      if (entry.status === 'ACTIVE') {
        if (!live) {
          errors.push(`${REGISTRY}：登记了 ACTIVE 代理 "${entry.agentId}"，但找不到对应定义文件`);
          continue;
        }
        if (entry.version !== live.meta.version) {
          errors.push(
            `${REGISTRY}：代理 "${entry.agentId}" 版本不一致 —— 注册表 ${entry.version}，定义文件 ${live.meta.version}`
          );
        }
      } else if (live && live.meta.status !== entry.status) {
        warnings.push(
          `${REGISTRY}："${entry.agentId}" 状态不一致 —— 注册表 ${entry.status}，定义文件 ${live.meta.status}`
        );
      }
    }
    for (const id of agents.keys()) {
      if (!registry.agents.some((a) => a.agentId === id)) {
        warnings.push(`${REGISTRY}：未登记代理 "${id}"`);
      }
    }
  }
}

/* ---------- 7：表格完整性（空行不许把表断成两截）----------
 *
 * 动机：2026-09-19 的编辑里，我两次在追加「变更记录」表格行时多插了一个空行，
 * 把一张表断成了两个独立的表 —— 渲染上是两截，语义上也是两截。
 *
 * 所有已有的检查都看不见它：它们只看章节标题在不在、版本号对不对。
 * 这与「页脚版本号」「同步矩阵版本号」是**同一类缺陷：机器不校验的载体**。
 * 所以在这里补上。
 *
 * 判据：某行以 | 开头，而它上面（隔着空行）最近的非空行也以 | 开头 → 报 WARN。
 *
 * 排除误报：**若这一行是"表头 + 紧随其后的分隔行（|---|）"，说明那本来就是一张新表**，
 * 不是被断开的旧表 —— 不报。（`docs/04` 的"测什么 / 不测什么"两张表就属于这种。）
 */

for (const [id, { file, text }] of [...docs, ...agents]) {
  const lines = text.split(/\r?\n/);
  const isDelimiter = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l || '');
  for (let i = 1; i < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i])) continue; // 本行不是表格行
    if (!/^\s*$/.test(lines[i - 1])) continue; // 上一行不是空行 → 正常
    if (isDelimiter(lines[i + 1])) continue; // 这是新表的表头 → 误报，放过
    let j = i - 2;
    while (j >= 0 && /^\s*$/.test(lines[j])) j--;
    if (j >= 0 && /^\s*\|/.test(lines[j])) {
      warnings.push(
        `${file}：第 ${i + 1} 行 —— 表格行之间插了空行，把上面的表断成了两截`
      );
    }
  }
}

/* ---------- 8：§6 同步矩阵里的版本号 vs frontmatter ----------
 *
 * 动机（2026-09-19）：`MASTER-PLAN` §6 同步矩阵**现在是全库唯一的权威版本表** ——
 * 根 `README.md` 已把那串容易漂移的版本号删掉，改为指向它
 * （见 MASTER-PLAN §7「C+E 已上线」· 六：与其反复修副本，不如去掉副本）。
 *
 * 但 §6 的表本身**仍是人写的副本**：表里"当前版本"那一列一旦落后，
 * 读表的人就被误导，而**没有任何检查在看着它**。这条检查把它接上。
 *
 * **故意只报 WARN，不报 FAIL** —— 因为 §6 有时会**故意**暂时落后：
 * 攒批场景下（把两件各自会触发全量级联的事合并成一次，中间态必然不一致，
 * 见 `docs/05` §7 的历史记录），那是**有意为之**，不该被机器判成错误。
 * 但它**必须浮出来**，而不是安静地留在那里。
 *
 * 与第 2 / 6 项的分工：第 2 项管 `depends_on`（声明我对上游的核对版本），
 * 第 6 项管**留痕**（证明我真的看过），这一项管**给人看的汇总表**是否准确。
 * 三件事，三个方向，缺一个都会漏。
 */

if (fs.existsSync(masterPath)) {
  const master = fs.readFileSync(masterPath, 'utf8');

  // ⚠️ 这里不能直接用 extractSection('文档同步矩阵')：该节标题是
  // `## 6. 文档同步矩阵 ⭐`，结尾那个 ⭐ 会让 extractSection 的 `\s*$` 匹配不上，
  // 于是静默返回空串、整条检查悄悄失效 —— 正是第 6 项检查所针对的那类失败。
  const heading = /^#{2,3}[ \t]+.*文档同步矩阵.*$/m.exec(master);
  if (!heading) {
    errors.push(`${MASTER_PLAN}：找不到「文档同步矩阵」章节 —— 第 8 项检查无法执行`);
  } else {
    const rest = master.slice(heading.index + heading[0].length);
    const nextHeading = rest.search(/^#{2,3}\s+/m);
    const matrixLines = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).split(/\r?\n/);

    for (const [id, { file, meta }] of docs) {
      const row = matrixLines.find(
        (l) => /^\s*\|/.test(l) && new RegExp('`' + id + '`').test(l.split('|')[1] || '')
      );
      if (!row) continue; // 未被矩阵收录 → 已由第 4 项检查报过，不重复报
      const cells = row.split('|').map((c) => c.trim());
      if (cells.length < 6) continue; // 形状不对，不是同步矩阵的数据行
      const declared = (cells[4] || '').replace(/\*/g, '').trim();
      if (declared && declared !== meta.version) {
        warnings.push(
          `${MASTER_PLAN} §6 同步矩阵：\`${id}\` 那一行写的版本是 ${declared}，` +
            `但 ${file} 的 frontmatter 是 ${meta.version} —— 二者必须一致（若是有意攒批，请在该行注明）`
        );
      }
    }
  }
}

/* ---------- 输出 ---------- */

const out = [];
const line = (s = '') => out.push(s);

line('');
line('晨报机 · 文档同步校验');
line('='.repeat(58));
line('');
line(`扫描到 ${docs.size} 份文档、${agents.size} 个代理定义`);
line('');
for (const [id, { file, meta }] of docs) line(`  [doc]   ${id.padEnd(16)} v${meta.version}  ${file}`);
for (const [id, { file, meta }] of agents) line(`  [agent] ${id.padEnd(16)} v${meta.version}  ${file}`);
line('');

if (warnings.length) {
  line(`警告 ${warnings.length} 项：`);
  for (const w of warnings) line(`  [WARN] ${w}`);
  line('');
}

if (errors.length) {
  const nFollow = errors.filter((e) => e.startsWith('[未跟进]')).length;
  const nTrace = errors.filter((e) => e.startsWith('[缺留痕]')).length;
  line(`错误 ${errors.length} 项：`);
  for (const e of errors) line(`  [FAIL] ${e}`);
  line('');
  if (nFollow || nTrace) {
    line(`其中：依赖未跟进 ${nFollow} 项 ｜ 缺核对留痕 ${nTrace} 项。`);
    line('两者都属「记账」：更新 depends_on、补写核对结论即可 —— **不要改本文件的版本号**（R-D05）。');
    line('');
  }
  line('结果：不通过。先修同步，再继续开发。');
} else {
  line('结果：全部通过。');
}
line('');

const report = out.join('\n');

// 同时打印到终端，并落一份 UTF-8 报告
// （Windows 控制台默认代码页可能显示不了中文，报告文件始终可读）
process.stdout.write(report + '\n');
try {
  fs.writeFileSync(path.join(ROOT, 'tools', 'sync-report.txt'), report, 'utf8');
} catch {
  /* 报告写不进去不影响校验本身 */
}

process.exit(errors.length ? 1 : 0);
