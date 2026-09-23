import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve(here, '..', '..', 'report');

/**
 * 9 条验收标准（MASTER-PLAN §4 · M0）。
 *
 * kind 的含义：
 *   auto    —— 程序能自己给出结论
 *   hybrid  —— 程序给数据，但最终结论需要人眼确认
 *   manual  —— 只能人来做（例如"去看三档缩放"）
 */
export const CHECKS = [
  {
    id: 1,
    title: 'Electron 无边框透明置顶窗口正常渲染',
    kind: 'auto',
    how: '窗口创建成功 + 页面加载完成 + transparent/frame/alwaysOnTop 三个标志位实际生效',
  },
  {
    id: 2,
    title: 'backdrop-filter 在透明窗口内确实生效',
    kind: 'auto',
    how:
      '在诊断区铺一层程序生成的高频棋盘格当可控背景（不依赖桌面壁纸），用 capturePage 截图后计算 A 区（有 blur）与 B 区（对照组）的拉普拉斯方差之比。' +
      '内建校准：每次都先跑一遍「把 A 区 blur 也关掉」的状态，两区应当一致；若不一致说明尺子本身坏了，结论判 UNABLE。' +
      '2026-09-18 起不再依赖肉眼，实现在 blurmeasure.js',
  },
  {
    id: 3,
    title: '窗口不抢焦点',
    kind: 'auto',
    how:
      '20 秒焦点测试：测试期内主动做一次"显示卡片"（hide → showInactive），再数卡片的 focus 事件数与面板的 blur 事件数。' +
      '三态判定：有抢焦点 → fail；没抢但期间根本没显示过 → invalid（这不是通过）；显示过且没抢 → pass。' +
      '需在面板点一次按钮触发；2026-09-18 起结论由程序自动判定并写回验收状态，人不再需要读数字自己判断',
  },
  {
    id: 4,
    title: '全屏应用时窗口自动隐去',
    kind: 'manual',
    how: '手动开一个全屏应用（视频/PPT），看卡片是否让位。M0 只验证可行性，不要求自动实现',
  },
  {
    id: 5,
    title: '三档透明度在纯白 / 纯黑 / 花哨风景壁纸上对比度均 ≥ 4.5:1',
    kind: 'manual',
    how: '换三张壁纸，每张切三档透明度，共 9 次目视。文字看不清即不通过',
  },
  {
    id: 6,
    title: '100% / 125% / 150% 三档缩放下卡片物理尺寸一致、文字清晰',
    kind: 'hybrid',
    how: '程序读出当前缩放下卡片的 DIP 与物理尺寸（自动）；切到另外两档缩放各测一次（手动）',
  },
  {
    id: 7,
    title: '双屏混合缩放下主屏与副屏均不模糊、不拉伸',
    kind: 'manual',
    how: '需要两块分辨率/缩放不同的显示器。若本机不具备，必须显式记为「无法验证」而不是跳过',
  },
  {
    id: 8,
    title: '卡片跨屏拖动后吸附位置与记忆坐标均正确，偏差 ≤ 5px',
    kind: 'hybrid',
    how: '程序做坐标往返一致性与吸附落点测量（自动）；跨屏拖动的目视偏差需人确认',
  },
  {
    id: 9,
    title: 'scaleFactor 的可靠读取方式已确认',
    kind: 'auto',
    how: '两条独立证据链交叉校验：分辨率一致性 + 缩放比一致性。任一不符即判读数不可信',
  },
];

export const STATUS = {
  PENDING: 'pending',
  PASS: 'pass',
  FAIL: 'fail',
  WARN: 'warn',
  UNABLE: 'unable',
};

const state = {
  startedAt: new Date().toISOString(),
  checks: {},
  facts: null,
  notes: {},
};

for (const c of CHECKS) {
  state.checks[c.id] = {
    id: c.id,
    status: STATUS.PENDING,
    detail: '尚未判定',
    evidence: [],
    updatedAt: null,
  };
}

export function setCheck(id, { status, detail, evidence }) {
  const c = state.checks[id];
  if (!c) return null;
  if (status) c.status = status;
  if (detail !== undefined) c.detail = detail;
  if (Array.isArray(evidence) && evidence.length) {
    c.evidence = evidence.filter(Boolean);
  }
  c.updatedAt = new Date().toISOString();
  return c;
}

export function addEvidence(id, line) {
  const c = state.checks[id];
  if (!c || !line) return null;
  if (!c.evidence.includes(line)) c.evidence.push(line);
  c.updatedAt = new Date().toISOString();
  return c;
}

export function setFacts(facts) {
  state.facts = facts;
}

export function setNote(id, note) {
  state.notes[id] = note;
}

export function getProbeState() {
  return {
    startedAt: state.startedAt,
    checks: CHECKS.map((c) => ({ ...c, ...state.checks[c.id], notes: state.notes[c.id] || '' })),
    facts: state.facts,
    summary: summarize(),
  };
}

export function summarize() {
  const counts = { pass: 0, fail: 0, warn: 0, unable: 0, pending: 0 };
  for (const c of Object.values(state.checks)) {
    counts[c.status] = (counts[c.status] || 0) + 1;
  }
  return counts;
}

/* ------------------------------------------------------------------ */
/* 报告导出                                                             */
/* ------------------------------------------------------------------ */

function fmtStatus(s) {
  return (
    {
      pass: '✅ 通过',
      fail: '❌ 不通过',
      warn: '⚠️ 有保留',
      unable: '⛔ 无法验证',
      pending: '⬜ 未判定',
    }[s] || s
  );
}

function jsonBlock(obj) {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

export async function buildReport() {
  const s = getProbeState();
  const now = new Date();
  const L = [];

  L.push('# M0 地基验证 · 验收记录');
  L.push('');
  L.push(`> 生成时间：${now.toLocaleString('zh-CN')}`);
  L.push('> 对应里程碑：MASTER-PLAN §4 · M0（9 条验收标准）');
  L.push('> 本记录由 `m0-probe` 自动生成，人工判定项请连同截图一并留档。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('## 0. 结论摘要');
  L.push('');
  L.push('| 状态 | 条数 |');
  L.push('|---|---|');
  L.push(`| ✅ 通过 | ${s.summary.pass || 0} |`);
  L.push(`| ❌ 不通过 | ${s.summary.fail || 0} |`);
  L.push(`| ⚠️ 有保留 | ${s.summary.warn || 0} |`);
  L.push(`| ⛔ 无法验证 | ${s.summary.unable || 0} |`);
  L.push(`| ⬜ 未判定 | ${s.summary.pending || 0} |`);
  L.push('');

  if (s.summary.fail > 0) {
    L.push('> **M0 未通过。** 存在不通过项，按 MASTER-PLAN §4 M0 失败预案处理：');
    L.push('> ① 若 `backdrop-filter` 不可行（R8）→ 把 `data-surface` 默认值改为 `opaque`（ADR-008）；');
    L.push('> ② 若混合缩放不可解（R9）→ 同上降级，并把「混合缩放副屏」列为已知限制。');
    L.push('> **注意：这两条都只需要改一个默认值，不需要重审设计规范** —— 这是 ADR-008 的收益。');
  } else if (s.summary.pending === 0 && s.summary.unable === 0) {
    L.push('> **M0 全部通过**，可以进入 M1。');
  } else {
    L.push('> 仍有未判定或无法验证项，M0 尚未收尾。');
  }
  L.push('');
  L.push('---');
  L.push('');

  L.push('## 1. 逐条验收');
  L.push('');
  for (const c of s.checks) {
    L.push(`### 验收 ${c.id} · ${c.title}`);
    L.push('');
    L.push(`- **结论**：${fmtStatus(c.status)}`);
    L.push(`- **判定方式**：${c.kind === 'auto' ? '程序自动' : c.kind === 'hybrid' ? '程序给数据 + 人眼确认' : '人工判定'}`);
    L.push(`- **怎么测的**：${c.how}`);
    L.push(`- **说明**：${c.detail}`);
    if (c.evidence.length) {
      L.push('- **证据**：');
      for (const e of c.evidence) L.push(`  - ${e}`);
    }
    if (c.notes) {
      L.push(`- **人工备注**：${c.notes}`);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('## 2. 环境与探测原始数据');
  L.push('');
  if (s.facts) {
    L.push('### 2.1 Electron 侧读数');
    L.push('');
    L.push(jsonBlock(s.facts.electronDisplays));
    L.push('');
    L.push('### 2.2 Windows 侧真实读数（独立裁判）');
    L.push('');
    L.push(jsonBlock(s.facts.windowsDisplays));
    L.push('');
    L.push('### 2.3 scaleFactor 交叉校验');
    L.push('');
    L.push(jsonBlock(s.facts.scaleCrossCheck));
    L.push('');
    L.push('### 2.4 GPU / 合成状态');
    L.push('');
    L.push(jsonBlock(s.facts.gpu));
  } else {
    L.push('（未采集到探测数据）');
  }
  L.push('');

  L.push('---');
  L.push('');
  L.push('## 3. M0 收尾待办');
  L.push('');
  L.push('- [ ] 本记录已提交，且九项都有明确结论（没有"忘记测了"）');
  L.push('- [ ] 无法验证的项已显式记录为「无法验证」+ 原因，**不是留空**');
  L.push('- [ ] 若触发降级：`data-surface` 默认值已改为 `opaque`，并已在 MASTER-PLAN §7 记一次 P2 变更');
  L.push('- [ ] MASTER-PLAN §5 进度看板、§8 风险表（R8/R9 状态）已更新');
  L.push('- [ ] `design-critic` 已按 1.1.0 版第五组跑过双形态检查');
  L.push('- [ ] 运行 `node tools/sync-check.mjs` 全绿');
  L.push('');
  L.push('---');
  L.push('');
  L.push('*本文件由 m0-probe 生成，可按需补充截图与人工结论。*');
  L.push('');

  return L.join('\n');
}

export async function saveReport() {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const file = path.join(REPORT_DIR, `M0-验收记录_${stamp}.md`);
  const text = await buildReport();
  await fs.writeFile(file, text, 'utf8');
  return file;
}

/** 自检模式用：固定文件名，方便脚本化验证 */
export async function saveReportAs(name) {
  await fs.mkdir(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, name);
  await fs.writeFile(file, await buildReport(), 'utf8');
  return file;
}
