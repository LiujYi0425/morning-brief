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

/* ------------------------------------------------------------------ */
/* 一轮全失败之后：当天要重试，不能等到明天                              */
/* ------------------------------------------------------------------ */

/**
 * 全失败后的重试间隔（退避）。
 *
 * ⚠️⚠️ 这一段补的是一个**产品级的洞**，不是代码洁癖：
 *
 *   原来 `scheduleNext()` 永远排"下一个 07:30 墙钟点"，**与成败无关**。
 *   于是：早上 7:30 路由器正在重启 / 宽带还没拨上来 → 19 个源全失败
 *   → 程序把下一次排到**明天 7:30** → 网络 7:31 就恢复了，它也不会再试。
 *
 *   用户到工位看到的是一屏旧条目（`headline` 照常说"今天共 N 条"，
 *   因为库里有昨天的数据），**没有任何一句话说"今天还没抓到"**。
 *   对一个"每天一次"的产品，那等于当天没有产品。
 *
 * ⚠️ 为什么退避而不是固定 10 分钟一直试：
 *   断网一整天时，固定间隔会打 144 轮 × 19 个源 ≈ 2700 次请求 ——
 *   那是拿用户的路由器出气。退避到 1 小时之后，一天最多 24 轮。
 *
 * ⚠️ 为什么有上限而不是指数增长到很大：
 *   这个产品的价值窗口只有早上那两三个小时。间隔超过 1 小时，
 *   等于"今天就这样了"，不如让用户中午回来时至少看到一份新的。
 */
export const RETRY_STEPS_MS = [10 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];

/**
 * 第 `failStreak` 次连续全失败之后该等多久。
 * @param {number} failStreak 连续"全部源都失败"的轮数（1 表示刚刚失败第一轮）
 * @returns {number} 毫秒；0 表示不需要重试
 */
export function retryDelayMs(failStreak) {
  const n = Number(failStreak);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return RETRY_STEPS_MS[Math.min(n - 1, RETRY_STEPS_MS.length - 1)];
}

/**
 * 决定"下一次抓取在什么时候"——**纯函数**，所以离线考裁判能穷举它。
 *
 * 这是本轮修复的核心判据：把所有输入摆出来，输出一个时刻 + 一个理由。
 * 原来这段逻辑散在 `scheduleNext()` 里、只能靠跑 Electron 才能观察。
 *
 * @param {object} o
 * @param {Date} o.now
 * @param {number} o.hour
 * @param {number} o.minute
 * @param {number} [o.lastOk]       上一轮成功的源数
 * @param {number} [o.lastFailed]   上一轮失败的源数
 * @param {number} [o.failStreak]   连续全失败轮数（含上一轮）
 * @returns {{at:Date, retry:boolean, delayMs:number, reason:string}}
 */
export function nextRunPlan(o) {
  const { now, hour = DEFAULT_FETCH_HOUR, minute = DEFAULT_FETCH_MINUTE } = o;
  const scheduled = nextRunAt(now, hour, minute);
  const lastOk = Number(o.lastOk ?? 0);
  const lastFailed = Number(o.lastFailed ?? 0);

  /* "全失败"的判据：这一轮跑了、有源失败、**且一个源都没成功**。
     ⚠️ 单个源挂掉是常态，绝不能因此触发重试 —— 那会让正常的机器每 10 分钟
        打一遍全部源。只有"一个都没成"才说明多半是网络断了。 */
  const totalFailure = lastFailed > 0 && lastOk === 0;
  if (!totalFailure) {
    return { at: scheduled, retry: false, delayMs: 0, reason: '正常：按每天的时刻排下一次' };
  }

  const delay = retryDelayMs(o.failStreak ?? 1);
  const retryAt = new Date(now.getTime() + delay);
  /* 重试时刻越过了下一个定时点就直接等定时 —— 不要为了一次重试把
     明天 07:30 那一次挤掉（用户最在意的恰恰是那一次）。 */
  if (retryAt.getTime() >= scheduled.getTime()) {
    return {
      at: scheduled,
      retry: false,
      delayMs: 0,
      reason: `重试时刻（${retryAt.toLocaleString()}）已越过下次定时，直接等它`,
    };
  }
  return {
    at: retryAt,
    retry: true,
    delayMs: delay,
    reason: `上一轮 ${lastFailed} 个源全部失败（连续第 ${o.failStreak ?? 1} 轮），${Math.round(delay / 60000)} 分钟后重试`,
  };
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
  let retries = 0;
  let lastError = null;
  let nextAtIso = null;
  /** 连续"全部源都失败"的轮数；任何一次有源成功就清零 */
  let failStreak = 0;
  /** 上一轮的战绩（用来决定下一轮排什么时候） */
  let lastRun = { ok: null, failed: null };

  function state() {
    return {
      stopped,
      running,
      runs,
      failures,
      skippedTooSoon,
      retries,
      failStreak,
      lastError,
      nextAt: nextAtIso,
      at,
    };
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
      //    全部失败通常意味着断网 —— 那要留痕，**而且要重试**。
      if (r && r.ok === 0 && r.failed > 0) {
        failures += 1;
        failStreak += 1;
        lastError = `全部 ${r.failed} 个源都失败了（通常是断网）`;
        log(`[scheduler] ⚠️ ${lastError}（连续第 ${failStreak} 轮）`);
      } else {
        lastError = null;
        failStreak = 0; // ★ 有源成功就清零 —— 退避的"连续"口径靠这一句
        log(`[scheduler] 完成：成功 ${r ? r.ok : '?'} / 失败 ${r ? r.failed : '?'}`);
      }
      lastRun = { ok: r ? (r.ok ?? 0) : 0, failed: r ? (r.failed ?? 0) : 0 };
      return r;
    } catch (err) {
      failures += 1;
      failStreak += 1;
      lastRun = { ok: 0, failed: 1 };
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
    /* ★ 排什么时候**由战绩决定**（见 nextRunPlan 的说明）：
       全失败 → 退避重试，而不是等明天 07:30。
       这一段原来是写死的 `nextRunAt(...)`，与成败无关 ——
       于是早上断网一次，卡片空一整天。 */
    const plan = nextRunPlan({
      now: n,
      hour,
      minute,
      lastOk: lastRun.ok,
      lastFailed: lastRun.failed,
      failStreak,
    });
    const next = plan.at;
    nextAtIso = next.toISOString();
    const ms = Math.max(1000, next.getTime() - n.getTime());
    if (plan.retry) retries += 1;
    log(
      `[scheduler] 下次抓取：${next.toLocaleString()}（${Math.round(ms / 60000)} 分钟后）` +
        (plan.retry ? '【全失败重试】' : '') +
        ` —— ${plan.reason}`,
    );
    timerId = setTimer(async () => {
      /* ⚠️ 到点了也要过一遍防抖闸：7:25 刚开机补抓过、7:30 定时器又到点，
         不该再打一遍 19 个源。这是"防抖只接了一半"的典型形态 ——
         只拦开机路径、不拦定时路径，等于没拦。
         ⚠️ 但**重试不经过这道闸**：重试的前提就是"刚刚全失败"，
            用"距上次成功不足 1 小时"去拦它，正好会把唯一该做的事拦掉。 */
      const gap = sinceLastSuccess();
      if (!plan.retry && Number.isFinite(gap) && gap >= 0 && gap < minGapMs) {
        skippedTooSoon += 1;
        log(`[scheduler] 到点了但 ${Math.round(gap / 60000)} 分钟前刚抓过（不足 ${Math.round(minGapMs / 60000)} 分钟），跳过这一轮`);
      } else {
        await execute(plan.retry ? 'retry' : 'schedule');
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
