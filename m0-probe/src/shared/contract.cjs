'use strict';

/**
 * 全项目唯一的"词汇表"（架构铁律 D6）。
 * 不允许在别处硬编码 IPC 通道名、枚举值或尺寸常量。
 *
 * ⚠️ M0 发现 1：本文件是 .cjs 而不是架构文档里写的 .js
 * 原因：Electron 在 sandbox: true 下要求 preload 必须是 CommonJS。
 * 而主进程是 ESM（package.json type: module）。
 * 于是词汇表必须用一种"两边都能读"的格式 —— CJS 满足这个条件：
 *   - preload 用 require() 读它
 *   - 主进程用 import 读它（Node 的 CJS→ESM 互操作支持具名导出）
 * 这一条已回写进 docs/04-项目审查报告.md（B2 项）。
 */

/** IPC 通道。命名规范：`域:动作`。 */
const IPC = {
  // 能力探测
  CAPABILITY_GET: 'capability:get',
  CAPABILITY_REPORT: 'capability:report', // M → R
  // ↑ M0 探针里**刻意未使用**：本工程用 capability:get 的"调用-返回"式拿探测结果就够了。
  //   保留它是为了与 docs/03-工程架构文档.md L188 的产品级定义保持一致
  //   （产品阶段由主进程主动推送启动探测结果，决定初始渲染形态 —— ADR-008 的开关）。
  //   2026-09-18 核对结论：**这是有意的前置声明，不是遗漏**。
  CAPABILITY_RENDERER_FACTS: 'capability:rendererFacts', // R → M（渲染进程回报自己的 devicePixelRatio 等）
  CONTRACT_PARITY: 'contract:parity', // R → M（词汇表一致性自检，见 preload/index.cjs 顶部说明）

  // 验收状态
  PROBE_STATE: 'probe:state', // M → R
  PROBE_PATCH: 'probe:patch', // R → M
  REPORT_EXPORT: 'report:export',

  // 卡片窗口
  WINDOW_GET_STATE: 'window:getState',
  WINDOW_SET_STATE: 'window:setState',
  WINDOW_SET_SURFACE: 'window:setSurface',
  WINDOW_SET_OPACITY: 'window:setOpacity',
  WINDOW_SNAP: 'window:snap',
  WINDOW_RECORD_POS: 'window:recordPos',
  WINDOW_MOVE_TO_DISPLAY: 'window:moveToDisplay',
  WINDOW_SET_VISIBLE: 'window:setVisible',
  WINDOW_SET_DIAG: 'window:setDiag',
  WINDOW_STATE_CHANGED: 'window:stateChanged', // M → R
  CARD_DIAG: 'card:diag', // M → R（卡片诊断模式开关）

  // 焦点测试
  FOCUS_TEST_START: 'focusTest:start',
  FOCUS_TEST_STATE: 'focusTest:state', // M → R

  LOG: 'app:log', // R → M
};

/** 卡片尺寸（设计规范 §4.2 的固定值） */
const CARD = {
  COLLAPSED: { w: 360, h: 44 },
  EXPANDED: { w: 360, h: 520 },
};

/** 渲染形态（ADR-008） */
const SURFACE = {
  GLASS: 'glass',
  OPAQUE: 'opaque',
};

/**
 * 透明度三档（设计规范 §3.3）
 * 默认值有且只有一个：quiet（安静 96%）。修正自审查报告 G1。
 */
const OPACITY = [
  { id: 'quiet', label: '安静', alpha: 0.96, isDefault: true },
  { id: 'normal', label: '标准', alpha: 0.94, isDefault: false },
  { id: 'sheer', label: '通透', alpha: 0.86, isDefault: false },
];

/** 卡片三态 */
const WINDOW_STATE = {
  COLLAPSED: 'collapsed',
  EXPANDED: 'expanded',
  HIDDEN: 'hidden',
};

module.exports = { IPC, CARD, SURFACE, OPACITY, WINDOW_STATE };
