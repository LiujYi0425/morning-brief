/**
 * src/shared/day.js —— 「今天」只有一份定义（**纯函数**）
 * =====================================================================
 * ⚠️⚠️ 为什么值得单独一个文件：
 *   这个项目里"今天"至少被三个地方用到 —— 条目查询（`queryItems({todayOnly})`）、
 *   当日计数（`countItems`）、以及 AI 简报的候选范围。**三处只要有一处算法不同**，
 *   用户就会看到两个互相矛盾的"今天"（简报说 12 条，点「看今天全部」翻出 8 条），
 *   而两边单看都是对的、日志里什么都没有。
 *
 * ⚠️ 还有一个**真会错**的细节：本地日**不能**用 `toISOString().slice(0,10)` 取 ——
 *   `toISOString` 是 UTC。在东八区，本地 2026-09-25 07:30 的 UTC 是 09-24 23:30，
 *   于是"今天"会被算成**昨天**：早上生成的简报会被存到前一天那一份上。
 * =====================================================================
 */

/** 本地日的起点（00:00:00.000，本地时区） */
export function localDayStart(now = new Date()) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 本地日起点对应的 ISO 串 —— 查询与计数必须用**同一个** */
export function localDayStartIso(now = new Date()) {
  return localDayStart(now).toISOString();
}

/** 本地日的 YYYY-MM-DD */
export function localDay(now = new Date()) {
  const d = new Date(now.getTime());
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
