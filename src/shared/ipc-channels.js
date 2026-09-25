/**
 * src/shared/ipc-channels.js —— IPC 通道白名单（**唯一一份能被离线断言的**）
 * =====================================================================
 * 一句话：**主进程与 preload 之间的那个"有哪些通道"的约定，住在这里。**
 *
 * ---------------------------------------------------------------------
 * 为什么它必须从这个文件以外的地方搬过来（阶段 B · 收掉"死守卫"）
 * ---------------------------------------------------------------------
 * 这份表原先住在 `src/main/ipc.js` 里的一个 `expected` 数组，
 * 而比对函数 `checkChannelParity` **定义了却从来没被调用过** ——
 * 因为 ipc.js 第一行就是 `import { ipcMain, shell } from 'electron'`，
 * 离线跑不起来 ⇒ 没有任何断言能碰到它，它只是一个"看起来在守门"的摆设。
 * （这是阶段 A 记下来的三处"文档与代码不符"之一。）
 *
 * ⇒ 搬到这里（零依赖、不 import electron），由 `tools/test-all.mjs`
 *   拿它去逐项比对 `src/preload/index.cjs` 里那份**内联副本**。
 *
 * ---------------------------------------------------------------------
 * ⚠️ 通道名在这里有**两份物理副本**，这是被迫的，也是刻意的
 * ---------------------------------------------------------------------
 *   `sandbox: true` 下 preload 的 `require` 是受限 polyfill，
 *   **不能 require 本地文件** ⇒ 它必须自己内联一份。
 *   既然消不掉重复，就把它变成**被机器检查的不变量**：
 *   两份对不上 = 断言直接红（而不是等用户点上那个按钮才发现没反应）。
 *
 * ⚠️ 只加一处会怎么坏（写在这里，免得下次又忘）：
 *   · 只加到 preload：渲染层那个方法存在、invoke 也发出去了，
 *     而主进程没有 handler ⇒ 返回一个**永远 pending** 的 promise
 *     （界面表现是"点了没反应"，日志里什么都没有）。
 *   · 只加到主进程：渲染层根本没有那个方法 ⇒ TypeError。
 * =====================================================================
 */

/**
 * 全部 IPC 通道名（R→M 的请求 + M→R 的推送）。
 * ⚠️ 改动这里时**必须同时改** `src/preload/index.cjs` 的 IPC 常量 ——
 *    离线断言会当场抓住不同步（见 tools/test-all.mjs 的"通道表两份必须逐字一致"）。
 */
export const IPC_CHANNELS = Object.freeze([
  'brief:get', // R → M：取当前简报（首页 N 条 + 健康度 + 统计）
  'brief:more', // R → M：翻页（游标式）
  'brief:ingest', // R → M：手动触发抓取（可带当前类型）
  'brief:updated', // M → R：抓完推新数据
  'brief:generate', // R → M：生成/重新生成今天的简报（AI 摘要，会花钱）
  'ai:config', // R → M：读 AI 设置（端点 / 模型 / 条数）—— **不含 Key**
  'ai:setConfig', // R → M：写 AI 设置 —— **不含 Key**（Key 只走下面那四条）
  'apikey:status', // R → M：Key 是否已配置 —— **永不返回明文**
  'apikey:set', // R → M：写入 Key（主进程内 safeStorage 加密后落盘）
  'apikey:clear', // R → M：清除已存 Key
  'apikey:test', // R → M：一次最小连通性测试（会真的发一个请求）
  'category:list',
  'category:create',
  'category:delete', // ★ 只删分类与绑定，绝不删条目
  'category:sources', // 读「这个类型包含哪些源」
  'category:setSources', // 写「这个类型包含哪些源」
  'category:setPref', // 喜欢 / 中性 / 不喜欢
  'source:add', // ★ 用户粘一个 feed 地址加源（主进程先验再存）
  'card:setState',
  /* ⚠️ 这里原来是 `card:minimize` —— 它在**渲染层一次都没被调用过**
     （阶段 A 记下来的第二处"死通道"）。
     它唯一做的事是 `setCardExpanded(false)`，而那正是 `card:setState('collapsed')`。
     ⇒ 阶段 B 把它删掉了：留着的代价是"通道表里有一条永远没人用的通道"，
        下一个照着它写代码的人会以为界面上真有"最小化"这个动作。 */
  'card:drag', // ★ 坐标只有 x/y/phase
  'item:open', // ★ 需求 3：跳转详情页（主进程做协议白名单）
  'level:apply',
  'app:log',
]);

/**
 * 把通道表与从 preload 里读出来的那份逐项比对。
 *
 * @param {string[]} rendererChannels preload 导出的 `__channels`
 * @returns {{ok:boolean, expected:string[], missing:string[], extra:string[]}}
 *   missing = 表里有、preload 没有（渲染层没有这个方法）
 *   extra   = preload 有、表里没有（主进程没有这个 handler）
 */
export function checkChannelParity(rendererChannels) {
  const expected = IPC_CHANNELS.slice().sort();
  const actual = (rendererChannels || []).slice().sort();
  const missing = expected.filter((c) => !actual.includes(c));
  const extra = actual.filter((c) => !expected.includes(c));
  return { ok: missing.length === 0 && extra.length === 0, expected, missing, extra };
}
