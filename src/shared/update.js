/**
 * 版本、更新清单、以及**回退状态机** —— 全部是纯函数，零依赖。
 *
 * ⚠️ 为什么单独一个模块、而且不许碰 electron / fs / 网络：
 *    "更新中途坏了要能回退"这套逻辑，是这个项目里**最难在真机上复现**的一类故障 ——
 *    你得先造一次真实的坏更新。所以它必须能被**离线穷举**：
 *    每一种状态组合都喂进去，断言它给出的判决。
 *    （同 `runtime-state.js` 的 `classifyRun`：真机上最难查的恰恰是那些组合。）
 *
 * 这里的核心不是"怎么下载更新"，而是**"更新完了之后，凭什么认为它是好的"**：
 *
 *   1. 装之前 → 记下 `pending`（从哪个版本升到哪个、退路快照在哪）
 *   2. 每次启动**最开头**（模块求值阶段，什么都还没做）→ `bumpAttempt()`
 *   3. 真正健康了（窗口建起来、托盘起来了）→ `settle()`
 *   4. 下次启动若发现 `pending` 还在、且 attempts 已达上限
 *      ⇒ 说明**连着几次启动都没走到第 3 步** ⇒ 自动回退
 *
 * ⚠️ 第 2 步必须在"最开头"：如果放在窗口建好之后，那么"窗口建不起来"
 *    这种最需要回退的故障，恰恰是**永远不会累加计数**的那种 —— 回退机制
 *    会在它唯一该起作用的场景里静默失效。
 *
 * ⚠️ 判据是"启动次数"而不是"运行时长"：坏更新的典型表现是崩在启动路径上，
 *    它可能连日志都写不出来（数据目录不可写时正是如此）。次数是唯一
 *    在那种情况下仍然可靠的信号 —— 因为它由**上一个**好版本写下的文件承载。
 */

/* ───────────────────────── 版本号 ───────────────────────── */

/**
 * 解析 `x.y.z`（允许 `v` 前缀与 `-预发布` 后缀，后缀只取出来不参与比较）。
 * 解析不了返回 `null` —— **不抛异常**，因为输入可能来自网络上的清单文件，
 * 一个畸形版本号不该让整个更新检查崩掉。
 * @param {string} s
 * @returns {{major:number,minor:number,patch:number,pre:string}|null}
 */
export function parseVersion(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
}

/**
 * 比较两个版本号。`a>b` 返回 1，`a<b` 返回 -1，相等返回 0。
 * ⚠️ 任意一边解析不了就返回 `null`，**不是**返回 0 ——
 *    "解析失败"和"版本相同"混为一谈，会让畸形清单被当成"已是最新"。
 * @returns {number|null}
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  /* 预发布版本低于同号正式版：1.0.0-rc1 < 1.0.0（对齐 semver 的直觉部分）。
     两条都带后缀时按字典序，够用且可预测。 */
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

/** `candidate` 是不是比 `current` 新。任一边解析不了 ⇒ false（宁可不更新）。 */
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

/* ───────────────────────── 更新清单 ───────────────────────── */

/**
 * 校验从网络取回来的更新清单。
 *
 * ⚠️ 这是**不可信输入**：它决定了要下载哪个 URL、以及下载完该是什么哈希。
 *    所以逐字段验，任何一项不合格就整份拒绝 —— 不要"缺 sha256 就先跳过校验"，
 *    那就等于没有校验：中间人只要把 sha256 字段删掉即可绕过。
 *
 * @param {string|object} raw JSON 文本或已解析对象
 * @returns {{ok:true, manifest:object}|{ok:false, error:string}}
 */
export function parseManifest(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch (e) {
      return { ok: false, error: '不是合法 JSON：' + (e && e.message) };
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: '清单不是对象' };

  const v = parseVersion(o.version);
  if (!v) return { ok: false, error: `version 不是 x.y.z 形式：${JSON.stringify(o.version)}` };

  if (typeof o.url !== 'string' || !/^https:\/\//i.test(o.url)) {
    return { ok: false, error: 'url 必须是 https 开头的字符串（http 会被中间人替换掉安装包）' };
  }
  const hex = typeof o.sha256 === 'string' ? o.sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    return { ok: false, error: 'sha256 缺失或不是 64 位十六进制 —— 没有它就无法证明下载到的是原件' };
  }
  const size = Number(o.size);
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, error: `size 不是正整数：${JSON.stringify(o.size)}` };
  }
  return {
    ok: true,
    manifest: {
      version: `${v.major}.${v.minor}.${v.patch}${v.pre ? '-' + v.pre : ''}`,
      url: o.url,
      sha256: hex,
      size,
      notes: typeof o.notes === 'string' ? o.notes.slice(0, 4000) : '',
      releasedAt: typeof o.releasedAt === 'string' ? o.releasedAt : '',
      /* `minFrom`：低于这个版本不能直接升（例如改了数据结构）。
         缺省表示任何版本都能升。 */
      minFrom: typeof o.minFrom === 'string' ? o.minFrom : '',
    },
  };
}

/**
 * 拿到清单之后该干什么。**纯判决**，不碰网络也不碰磁盘。
 * @returns {{action:'none'|'available'|'refuse', why:string, manifest?:object}}
 */
export function decideUpdate({ manifest, currentVersion, allowPrerelease = false }) {
  if (!manifest) return { action: 'none', why: '没有清单' };
  const cmp = compareVersions(manifest.version, currentVersion);
  if (cmp === null) {
    return { action: 'refuse', why: `版本号对不上：清单 ${manifest.version} / 本地 ${currentVersion}` };
  }
  if (cmp <= 0) return { action: 'none', why: `已经是最新（本地 ${currentVersion}，清单 ${manifest.version}）` };

  const pv = parseVersion(manifest.version);
  if (pv.pre && !allowPrerelease) {
    return { action: 'refuse', why: `清单是预发布版 ${manifest.version}，当前渠道不接受预发布` };
  }
  if (manifest.minFrom) {
    const c = compareVersions(currentVersion, manifest.minFrom);
    if (c === null) return { action: 'refuse', why: `minFrom 解析不了：${manifest.minFrom}` };
    if (c < 0) {
      return { action: 'refuse', why: `本地 ${currentVersion} 低于可直接升级的下限 ${manifest.minFrom}` };
    }
  }
  return { action: 'available', why: `有新版本 ${manifest.version}`, manifest };
}

/* ───────────────────────── 回退状态机 ───────────────────────── */

export const UPDATE_SCHEMA = 1;

/** 启动到"健康"之间允许的尝试次数。超过就判定这次更新是坏的。 */
export const DEFAULT_MAX_ATTEMPTS = 2;

/** 全新状态。`current` 是当前正在跑的版本。 */
export function createUpdateState(current, now = new Date()) {
  return {
    schema: UPDATE_SCHEMA,
    current: current || '0.0.0',
    /* pending 存在 = "刚装了新版本，但还没证明它健康" */
    pending: null,
    lastCheck: null,
    lastRollback: null,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * 读回来的状态可能是**旧版本写的**、或者被人手改坏了。
 * ⇒ 一律规整成合法形状，而不是让 `undefined` 一路漏到判决里去。
 */
export function normalizeState(raw, current) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return createUpdateState(current);
  if (raw.schema !== UPDATE_SCHEMA) return createUpdateState(current);
  const s = createUpdateState(typeof raw.current === 'string' ? raw.current : current);
  s.lastCheck = typeof raw.lastCheck === 'string' ? raw.lastCheck : null;
  s.lastRollback = raw.lastRollback && typeof raw.lastRollback === 'object' ? raw.lastRollback : null;
  s.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : s.updatedAt;
  const p = raw.pending;
  if (p && typeof p === 'object' && typeof p.to === 'string' && typeof p.from === 'string') {
    s.pending = {
      from: p.from,
      to: p.to,
      snapshotDir: typeof p.snapshotDir === 'string' ? p.snapshotDir : '',
      startedAt: typeof p.startedAt === 'string' ? p.startedAt : new Date(0).toISOString(),
      /* ⚠️ attempts 必须是非负整数：一个 NaN 会让 `attempts >= max` 永远为 false，
         于是**坏更新永远不会被回退** —— 一个静默失效的安全网。 */
      attempts: Number.isInteger(p.attempts) && p.attempts >= 0 ? p.attempts : 0,
      /* ⚠️ 这个字段是"白名单式重建"最容易吃掉的一个：它由 bumpAttempt 写、
          normalizeState 不认 ⇒ 每次落盘再读回来就没了，而"最后一次尝试是什么时候"
         恰恰是排查"到底试了几次、多久之前"的唯一依据。
         （这条是被"状态过一遍 JSON 再规整回来必须与原来完全相等"那条断言抓出来的。） */
      lastAttemptAt: typeof p.lastAttemptAt === 'string' ? p.lastAttemptAt : undefined,
    };
  }
  return s;
}

/**
 * 决定要装了：记下 `pending`。**必须在启动安装器之前调用并落盘** ——
 * 装完就晚了（新版本起不来时，没有机会再写这个文件）。
 */
export function beginUpdate(state, { toVersion, now = new Date(), snapshotDir = '' }) {
  return {
    ...state,
    pending: {
      from: state.current,
      to: String(toVersion),
      snapshotDir: String(snapshotDir || ''),
      startedAt: new Date(now).toISOString(),
      attempts: 0,
    },
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * 启动最开头调用：`pending` 还在就说明"上一次装在跑新版本"，
 * 于是这一次启动也算一次尝试。
 *
 * ⚠️ 没有 `pending` 时**原样返回**（不要无脑自增）—— 否则正常跑着的版本
 *    会把 attempts 越加越大，等哪天真装了更新，第一次就误判成"已经失败两次"。
 */
export function bumpAttempt(state, now = new Date()) {
  if (!state.pending) return state;
  return {
    ...state,
    pending: { ...state.pending, attempts: state.pending.attempts + 1, lastAttemptAt: new Date(now).toISOString() },
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * 真正健康了（窗口建起来 + 托盘起来了）⇒ 认可这次更新，清掉 `pending`。
 * 同时把 `current` 推到新版本号。
 */
export function settle(state, now = new Date()) {
  if (!state.pending) return state;
  return {
    ...state,
    current: state.pending.to,
    pending: null,
    updatedAt: new Date(now).toISOString(),
  };
}

/**
 * **判决**：这一次启动该不该触发回退。
 *
 * @returns {{action:'none'|'rollback', why:string, target?:string, snapshotDir?:string}}
 */
export function judgeStartup(state, { maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  if (!state.pending) return { action: 'none', why: '没有待验证的更新' };
  const p = state.pending;
  if (p.attempts < maxAttempts) {
    return {
      action: 'none',
      why: `待验证更新 ${p.from} → ${p.to}：第 ${p.attempts}/${maxAttempts} 次启动，继续观察`,
    };
  }
  if (!p.snapshotDir) {
    /* ★ 没有退路就**不许**回退 —— 假装回退了却无处可退，比不回退更糟：
       用户会以为已经退回去了。如实说"退不回去"。 */
    return {
      action: 'none',
      why: `更新 ${p.from} → ${p.to} 连续 ${p.attempts} 次启动都没走到健康，但**没有退路快照**，无法自动回退`,
    };
  }
  return {
    action: 'rollback',
    why: `更新 ${p.from} → ${p.to} 连续 ${p.attempts} 次启动都没走到健康 ⇒ 判定这次更新是坏的`,
    target: p.from,
    snapshotDir: p.snapshotDir,
  };
}

/** 回退完成之后的状态：退回 `from`，并**记下这件事**（不然没人知道发生过回退）。 */
export function finishRollback(state, { why, now = new Date() }) {
  const back = state.pending ? state.pending.from : state.current;
  return {
    ...state,
    current: back,
    pending: null,
    lastRollback: { to: back, at: new Date(now).toISOString(), why: String(why || '') },
    updatedAt: new Date(now).toISOString(),
  };
}

/** 人类可读的字节数（托盘/日志里显示下载进度用）。 */
export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '未知';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(1)} MB`;
}
