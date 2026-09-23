/**
 * src/main/scheduler.js —— 定时抓取（每天一次 + 错过就补）
 * =====================================================================
 * 需求 1 的落点。三件事：
 *
 * ### ① 每天一次，**对齐到一个时刻**（默认 07:30）
 * 用户要的是"每天早上看到今天的简报"，不是"每隔 24 小时同一时刻"。
 * 差别在于：昨晚 23:00 关机的机器，今天 8:00 开机后应当**立刻补抓**，
 * 而不是等到 23:00 才抓。
 *
 * ⚠️ 为什么从 6:00 改成 7:30（用户提出的，我同意）：
 *    6:00 太早 —— 那个点很多早间内容还没发出来，抓到的其实是"昨晚的存量"，
 *    用户 8～9 点到工位看到的第一屏里，最新一条可能还是前一天傍晚的。
 *    7:30 落在"早间内容已经发出、人还没到工位"之间，是这份简报真正的价值窗口。
 *    抓取耗时几十秒，所以 7:30 抓、8:00 看，中间有足够余量。
 *
 * ⚠️ 分钟是**必须**支持的：最初只有 `hour` 一个旋钮，改成 7:30 时才发现
 *    它表达不了。这种"参数位数不够"的问题不会报错，只会让人把需求改成
 *    7:00 或 8:00 然后告诉自己"差不多"。⇒ 现在直接收 hour + minute。
 *
 * ### ② 错过就补（catch-up）
 * 常驻程序会被关机、休眠、崩溃打断。所以判定口径是
 * "**到了今天的抓取时刻而今天还没成功抓过，就补一次**"，
 * 而不是"等下一个 7:30"。
 *
 * ### ③ 抓取失败不退出、下个周期再试
 * 抓取失败是常态（源挂、断网、休眠）。定时器**不许因为一次失败就停摆** ——
 * 那会让程序看起来还在跑、其实再也不更新了（静默失败）。
 *
 * ⚠️ 关于"唤醒时补抓"：Electron 的 `powerMonitor` 能拿到 resume / unlock 事件。
 *    本文件**通过注入的回调**使用它，于是这个调度器**不需要 Electron 就能被测试**。
 * =====================================================================
 */

/** 默认抓取时刻（本地时间，24 小时制） */
export const DEFAULT_FETCH_HOUR = 7;
export const DEFAULT_FETCH_MINUTE = 30;

/**
 * 两次抓取之间的最小间隔（防抖）。
 *
 * ⚠️ 这个常量原来就写在这里，但**从来没有任何地方用它** —— 一句死代码。
 *    真正把它接上是因为一个具体场景：7:00 打开程序（开机补抓跑一轮）、
 *    7:30 定时器到点又跑一轮、中间如果重启两次就是四轮。
 *    对一个"每天只需要更新一次"的看板来说，这纯属白打人家的服务器。
 *
 *    接上之后的语义：**距上次成功抓取不足这个间隔，就不重复抓**。
 *    注意它只会让抓取**变少**，不会让"今天该抓的那一次"被永久跳过 ——
 *    因为间隔只有 1 小时，而周期是 24 小时。
 */
export const MIN_GAP_MS = 60 * 60 * 1000; // 1 小时

/** 把 hour/minute 夹到合法范围（非法输入不许静默变成 0 点） */
function clampHour(h) {
  const n = Number(h);
  return Number.isFinite(n) ? Math.max(0, Math.min(23, Math.floor(n))) : DEFAULT_FETCH_HOUR;
}
function clampMinute(m) {
  const n = Number(m);
  return Number.isFinite(n) ? Math.max(0, Math.min(59, Math.floor(n))) : DEFAULT_FETCH_MINUTE;
}

/** `07:30` 这样的可读形式（日志与断言都用它，避免各处自己拼） */
export function formatHm(hour, minute) {
  const h = clampHour(hour);
  const m = clampMinute(minute);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

/**
 * 从环境变量解析抓取时刻。
 *
 * ⚠️ 为什么这段逻辑放在**本文件**而不是 `index.js`：
 *    它是纯函数（字符串进、数字出），而 `index.js` 因为 import 了 electron
 *    **在离线侧根本加载不了** —— 留在那儿就等于没有测试的可能。
 *    这是项目里已经写死的一条规矩：**不需要 Electron 的逻辑必须放进零依赖模块**，
 *    否则它只能在真机上被验证，而真机验证的成本高到实际上不会发生。
 *
 * ⚠️ 为什么读了环境变量还要**自己校验**：`MB_FETCH_HOUR=25`、或者很自然地
 *    写成 `MB_FETCH_HOUR=7:30`，都会得到 NaN。而 `setHours(NaN, ...)` 会让
 *    Date 变成 Invalid Date ⇒ `nextRunAt(...).getTime()` 是 NaN ⇒
 *    `setTimeout(fn, NaN)` 被当成 0 ⇒ **立刻疯狂抓取**。
 *    这是"配置写错 → 变成攻击别人的服务器"的经典形态，必须挡住。
 *
 * ⇒ 非法值一律退回默认，并**把话带出去**（静默回退等于让人以为自己配上了）。
 *
 * @param {{MB_FETCH_HOUR?:string, MB_FETCH_MINUTE?:string}} env
 * @returns {{hour:number, minute:number, notes:string[], overridden:boolean}}
 */
export function parseFetchTime(env = {}) {
  const notes = [];
  const pick = (raw, dflt, max, name) => {
    if (raw == null || String(raw).trim() === '') return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > max) {
      notes.push(`${name}=${JSON.stringify(String(raw))} 不是 0–${max} 的整数，已按默认值处理`);
      return dflt;
    }
    return n;
  };

  const rawH = env.MB_FETCH_HOUR;
  const rawM = env.MB_FETCH_MINUTE;
  const hour = pick(rawH, DEFAULT_FETCH_HOUR, 23, 'MB_FETCH_HOUR');
  const minute = pick(rawM, DEFAULT_FETCH_MINUTE, 59, 'MB_FETCH_MINUTE');
  const overridden =
    (rawH != null && String(rawH).trim() !== '') || (rawM != null && String(rawM).trim() !== '');
  return { hour, minute, notes, overridden };
}

/**
 * 算"下一次该在什么时候抓"。
 *
 * @param {Date} now
 * @param {number} hour 目标小时（0–23）
 * @param {number} minute 目标分钟（0–59）
 * @returns {Date}
 */
export function nextRunAt(now, hour = DEFAULT_FETCH_HOUR, minute = DEFAULT_FETCH_MINUTE) {
  const t = new Date(now.getTime());
  t.setHours(clampHour(hour), clampMinute(minute), 0, 0); // 当天 hour:minute
  if (t.getTime() <= now.getTime()) {
    t.setDate(t.getDate() + 1); // 已过点（含正好等于）→ 明天
  }
  return t;
}

/**
 * 距上次成功抓取是否已经该再抓一次。
 *
 * 与 `nextRunAt` 的分工：
 *   · `nextRunAt` 管"正常情况下下次什么时候"（对齐到 07:30）
 *   · 本函数管"**现在启动要不要立刻补一轮**"
 *
 * 判定顺序（**顺序不能换**，见下面两条注释）：
 *   ① 今天的目标时刻**已经到了**，而且今天已经成功抓过 → 不补
 *   ② 距上次成功抓取不足 `minGapMs` → 不补（防"反复重启反复抓"）
 *   ③ 其余 → 补
 *
 * @param {string|null} lastIso 上次**成功**抓取时间
 * @param {Date} now
 * @param {number} hour
 * @param {number} minute
 * @param {number} [minGapMs]
 * @returns {{due:boolean, reason:string, overdueMs:number}}
 */
export function catchUpDecision(
  lastIso,
  now = new Date(),
  hour = DEFAULT_FETCH_HOUR,
  minute = DEFAULT_FETCH_MINUTE,
  minGapMs = MIN_GAP_MS,
) {
  const h = clampHour(hour);
  const m = clampMinute(minute);
  const at = formatHm(h, m);

  if (!lastIso) return { due: true, reason: `从未成功抓取过（目标 ${at}）`, overdueMs: 0 };
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) {
    return { due: true, reason: '上次抓取时间不可解析（当作从未抓过，宁可多抓一次）', overdueMs: 0 };
  }

  // ① 今天该抓的那一刻
  const todayTarget = new Date(now.getTime());
  todayTarget.setHours(h, m, 0, 0);
  const targetPassed = now.getTime() >= todayTarget.getTime();
  if (targetPassed && last >= todayTarget.getTime()) {
    return { due: false, reason: `今天 ${at} 已经抓过`, overdueMs: 0 };
  }

  /* ② 防抖闸：为什么放在"目标时刻"判定**之后**——
     放前面的话，"今天 07:30 已经抓过、现在 08:00 又启动一次"会被这条
     判成"距上次不足 1 小时 → 不补"，结论碰巧也对；
     但"昨天 07:30 抓过、今天 08:00 启动"也会被它拦掉（差 24h > 1h，不会），
     真正会被它误伤的是**跨过目标时刻但间隔很短**的情形。
     顺序反过来更简单：先问"今天这份到底抓了没有"，再用间隔兜"抓得太频"。 */
  const sinceMs = now.getTime() - last;
  if (sinceMs >= 0 && sinceMs < minGapMs) {
    return {
      due: false,
      reason: `距上次成功抓取只有 ${Math.round(sinceMs / 60000)} 分钟（不足 ${Math.round(minGapMs / 60000)} 分钟），不重复抓`,
      overdueMs: 0,
    };
  }

  return {
    due: true,
    reason: targetPassed
      ? `今天 ${at} 还没抓过（上次 ${new Date(last).toLocaleString()}）`
      : `还没到今天 ${at}，但上次成功抓取是 ${new Date(last).toLocaleString()}（早于今天），先补一份`,
    overdueMs: targetPassed ? now.getTime() - todayTarget.getTime() : 0,
  };
}

/**
 * 创建调度器。
 *
 * @param {object} o
 * @param {() => Promise<{ok:number, failed:number}>} o.run        跑一轮抓取
 * @param {() => string|null} o.lastSuccessIso                     读上次成功时间
 * @param {(msg:string)=>void} [o.log]
 * @param {number} [o.hour]
 * @param {number} [o.minute]
 * @param {number} [o.minGapMs]
 * @param {() => Date} [o.now]                                     可注入的时钟（测试用）
 * @param {(fn:()=>void, ms:number)=>number} [o.setTimer]          默认 setTimeout（可注入便于测试）
 * @param {(id:number)=>void} [o.clearTimer]
 * @returns {{start:()=>void, stop:()=>void, checkNow:(t?:string)=>Promise<object>, state:()=>object}}
 */
export function createScheduler(o) {
  const {
    run,
    lastSuccessIso,
    log = () => {},
    hour = DEFAULT_FETCH_HOUR,
    minute = DEFAULT_FETCH_MINUTE,
    minGapMs = MIN_GAP_MS,
    now = () => new Date(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = o;

  const at = formatHm(hour, minute);
  let timerId = null;
  let stopped = true;
  let running = false;
  let runs = 0;
  let failures = 0;
  let skippedTooSoon = 0;
  let lastError = null;
  let nextAtIso = null;

  function state() {
    return { stopped, running, runs, failures, skippedTooSoon, lastError, nextAt: nextAtIso, at };
  }

  /** 跑一轮，并把结果如实记下来 */
  async function execute(trigger) {
    if (running) {
      log(`[scheduler] 上一轮还在跑，跳过这次（${trigger}）`);
      return { skipped: true };
    }
    running = true;
    log(`[scheduler] 开始抓取（触发：${trigger}）`);
    try {
      const r = await run();
      runs += 1;
      // ⚠️ 抓取"全部失败"与"部分失败"要分开看：
      //    部分失败是常态（某个源挂了），不该让调度器报警；
      //    全部失败通常意味着断网 —— 那要留痕。
      if (r && r.ok === 0 && r.failed > 0) {
        failures += 1;
        lastError = `全部 ${r.failed} 个源都失败了（通常是断网）`;
        log(`[scheduler] ⚠️ ${lastError}`);
      } else {
        lastError = null;
        log(`[scheduler] 完成：成功 ${r ? r.ok : '?'} / 失败 ${r ? r.failed : '?'}`);
      }
      return r;
    } catch (err) {
      failures += 1;
      lastError = err && err.message ? err.message : String(err);
      /* ⚠️ **不许因为一次异常就停摆**。这是"常驻程序静默死掉"的典型成因：
         定时器里抛一次、没接住、于是再也不排下一次，而进程还活着。 */
      log(`[scheduler] ✗ 抓取抛异常（调度继续）：${lastError}`);
      return { error: lastError };
    } finally {
      running = false;
    }
  }

  /** 距上次成功抓取多少毫秒（不可解析时为 NaN） */
  function sinceLastSuccess() {
    const iso = lastSuccessIso();
    if (!iso) return NaN;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? now().getTime() - t : NaN;
  }

  /** 排下一次 */
  function scheduleNext() {
    if (stopped) return;
    const n = now();
    const next = nextRunAt(n, hour, minute);
    nextAtIso = next.toISOString();
    const ms = Math.max(1000, next.getTime() - n.getTime());
    log(`[scheduler] 下次抓取：${next.toLocaleString()}（${Math.round(ms / 60000)} 分钟后）`);
    timerId = setTimer(async () => {
      /* ⚠️ 到点了也要过一遍防抖闸：7:25 刚开机补抓过、7:30 定时器又到点，
         不该再打一遍 19 个源。这是"防抖只接了一半"的典型形态 ——
         只拦开机路径、不拦定时路径，等于没拦。 */
      const gap = sinceLastSuccess();
      if (Number.isFinite(gap) && gap >= 0 && gap < minGapMs) {
        skippedTooSoon += 1;
        log(`[scheduler] 到点了但 ${Math.round(gap / 60000)} 分钟前刚抓过（不足 ${Math.round(minGapMs / 60000)} 分钟），跳过这一轮`);
      } else {
        await execute('schedule');
      }
      scheduleNext(); // 无论成败（也无论跳没跳）都排下一次
    }, ms);
  }

  return {
    /** 启动：先做一次"要不要补"的判定，再排下一次 */
    start() {
      stopped = false;
      const d = catchUpDecision(lastSuccessIso(), now(), hour, minute, minGapMs);
      log(`[scheduler] 启动判定：${d.due ? '需要抓取' : '暂不需要'} —— ${d.reason}`);
      if (d.due) {
        // 补抓不阻塞启动（窗口要先出来）
        execute('catchup').then(() => scheduleNext());
      } else {
        scheduleNext();
      }
    },

    stop() {
      stopped = true;
      if (timerId !== null) clearTimer(timerId);
      timerId = null;
      nextAtIso = null;
    },

    /** 外部手动触发（界面上"立即刷新"、或系统唤醒时调用） */
    async checkNow(trigger = 'manual') {
      return execute(trigger);
    },

    state,
  };
}
