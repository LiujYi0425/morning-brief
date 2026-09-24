/**
 * 变异测试：证明那些"最要紧的断言"**真的抓得住 bug**，而不是永远为真的摆设。
 *
 * ⚠️ 为什么需要它：普通断言只能证明"现在是对的"，证明不了"改坏了会被发现"。
 *    而这里挑出来做变异的那几条，失败的样子都是**看不见**的 ——
 *      · 数据目录落进只读的 app.asar ⇒ 双击没反应（GUI 无控制台、窗口还没建）
 *      · 更新坏了却不回退       ⇒ 用户卡在一个起不来的版本上
 *      · 版本号解析失败当成"相同" ⇒ 永远收不到更新，且不报错
 *    这几类问题在真机上极难复现，所以必须靠"故意改坏一处、看断言抓不抓得住"来证。
 *
 * ⚠️ 本脚本会**临时改写 src/ 下的源文件**（每个变异体跑完立刻还原，
 *    最后再逐字节校验一遍）。所以它**不进 `npm test`**，是单独一条命令 ——
 *    万一有人正好在改写的那几秒里重启应用，会加载到变异体。
 *    想跑就明确地跑：`npm run test:mutants`
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ─────────────────────────────────────────────────────────────────────
 * ★★ 崩溃安全：这个脚本会**真的改写** `src/` 下的源文件
 * ─────────────────────────────────────────────────────────────────────
 * 正常路径上还原写在 `finally` 里（见文件末尾）—— 但 `finally` 只在进程
 * **还活着**的时候才跑。外面把进程杀掉（会话被中断、Ctrl+C、任务管理器、
 * OOM）时，源码就永久停在被改坏的那一行上。
 *
 * ⚠️ 这不是假想：本次会话里它**真的发生了一次** ——
 *    一次被中断的运行把 `src/shared/runtime-state.js`（打包态数据目录分支）
 *    和 `src/main/index.js`（`prefByCategory` 被改成 `null`）留在工作树里，
 *    而这两个都**看起来像正常的改动**：`git status` 只多两行 M，
 *    真去查的时候很容易以为是自己写的。
 *
 * ⇒ 每次动文件**之前**，把"正在改哪个文件 + 它原来的内容"写进一个哨兵文件；
 *   还原之后把它删掉。**下次启动时哨兵还在 = 上一次是横死的** ——
 *   直接按哨兵里存的原文还原，并大声报出来（而不是带着坏源码接着跑）。
 *
 * ⚠️ 哨兵放在系统临时目录（按项目路径取名字），**不放进仓库**：
 *    放仓库里会污染 `git status`，而 `git status` 正是发现这件事的地方。
 */
const SENTINEL = path.join(
  os.tmpdir(),
  'mb-mutants-inflight-' + ROOT.replace(/[^A-Za-z0-9]+/g, '_') + '.json',
)
if (fs.existsSync(SENTINEL)) {
  try {
    const saved = JSON.parse(fs.readFileSync(SENTINEL, 'utf8'))
    for (const [rel, text] of Object.entries(saved.files || {})) {
      fs.writeFileSync(path.join(ROOT, rel), text, 'utf8')
      console.log(`⚠️ 上一次变异测试是**被中断**的（没走到还原），已按哨兵还原：${rel}`)
    }
    fs.unlinkSync(SENTINEL)
    console.log('   接着跑之前先看一眼 `git diff` —— 确认剩下的改动确实是你自己的。\n')
  } catch (e) {
    console.log(`✗ 哨兵文件在，但读不出来（${e.message}）：${SENTINEL}`)
    console.log('  手动处理：确认 src/ 下没有变异体残留，然后删掉这个文件。\n')
    process.exit(1)
  }
}
const RUNTIME = 'src/shared/runtime-state.js'
const UPDATE = 'src/shared/update.js'
/* 本次功能（筛选栏）的三个靶子 —— 都是"改坏了用户会以为功能没做"的地方 */
const QUOTA = 'src/shared/quota.js'
const DB = 'src/store/db.js'
const INGEST = 'src/ingest/fetch-feeds.js'
const MAIN = 'src/main/index.js'
const FEEDURL = 'src/main/feed-url.js'

const MUTANTS = [
  /* ── 打包态数据目录与可写性探测（P0-2）── */
  {
    file: RUNTIME,
    why: '打包态分支删掉 ⇒ 数据目录退回项目内（打包后落在只读 app.asar 里，双击没反应）',
    from: '  if (ctx.packagedUserData) return path.join(ctx.packagedUserData, DEFAULT_DATA_DIR_NAME);',
    to: '  /* 变异体：打包态分支被删掉 */',
    expect: '打包态的数据目录必须落在 userData',
  },
  {
    file: RUNTIME,
    why: 'probeWritable 永远说"可以写" ⇒ 不可写时应用以"双击没反应"的形式死掉',
    from: '    fs.mkdirSync(dir, { recursive: true });',
    to: '    return { ok: true };',
    expect: '目录不可写必须在',
  },
  {
    file: RUNTIME,
    why: '错误提示不带系统错误码 ⇒ 错误框里说不出所以然',
    from: '    return { ok: false, error: (code && !msg.startsWith(code) ? `${code} ${msg}` : msg).trim() };',
    to: '    return { ok: false, error: \'写不进去\' };',
    expect: '目录不可写必须在',
  },
  {
    file: RUNTIME,
    why: '错误提示无脑拼 code ⇒ "EEXIST EEXIST: …"，用户以为出了两个错',
    from: '    return { ok: false, error: (code && !msg.startsWith(code) ? `${code} ${msg}` : msg).trim() };',
    to: '    return { ok: false, error: `${code} ${msg}`.trim() };',
    expect: '目录不可写必须在',
  },
  {
    file: RUNTIME,
    why: '归属校验退回"必须是 electron" ⇒ 打包版被判成没在运行，stop 报成功却什么都不做',
    from: '    const recorded = pidInfo.image ? String(pidInfo.image).trim() : \'\';',
    to: '    const recorded = \'\';',
    expect: 'classifyRun 穷举',
  },

  /* ── 更新与回退 ── */
  {
    file: UPDATE,
    why: '版本号解析失败返回 0（="版本相同"）⇒ 畸形清单被当成"已是最新"，永远收不到更新',
    from: '  if (!x || !y) return null;',
    to: '  if (!x || !y) return 0;',
    expect: '版本比较',
  },
  {
    file: UPDATE,
    why: '缺 sha256 时放行 ⇒ 等于没有校验，中间人删掉该字段即可绕过',
    from: "  if (!/^[0-9a-f]{64}$/.test(hex)) {\n    return { ok: false, error: 'sha256 缺失或不是 64 位十六进制 —— 没有它就无法证明下载到的是原件' };\n  }",
    to: '  /* 变异体：不校验 sha256 */',
    expect: '更新清单是不可信输入',
  },
  {
    file: UPDATE,
    why: 'attempts 不做整数规整 ⇒ NaN 让 `attempts >= max` 永远为假，坏更新永远不回退',
    from: '      attempts: Number.isInteger(p.attempts) && p.attempts >= 0 ? p.attempts : 0,',
    to: '      attempts: p.attempts,',
    expect: '坏状态必须被规整',
  },
  {
    file: UPDATE,
    why: '没有退路快照也返回 rollback ⇒ 上层去"恢复"一个不存在的东西，用户以为退回去了',
    from: "  if (!p.snapshotDir) {",
    to: '  if (false) {',
    expect: '没有退路快照时',
  },
  {
    file: UPDATE,
    why: '没有 pending 也照常自增 ⇒ 正常版本攒出假计数，一装更新就误判失败',
    /* ⚠️ 这个变异体是"只删掉那句提前返回"，保持语法完整。
       早先写成 `pending: state.pending ? {...}` 是**语法错误**（三元少了冒号分支），
       结果整个测试脚本起不来 —— 而当时的判据只看"有没有 ❌ FAIL 那行"，
       于是把一个"根本没跑起来"当成了"漏网"。见下面 caught 的判定。 */
    from: '  if (!state.pending) return state;\n',
    to: '',
    expect: '回退状态机走一遍',
  },

  /* ══════════════════════════════════════════════════════════════════
   * 筛选栏（本次功能）—— 四处"改坏了就白做"的地方
   *
   * 这四条共同的特征是：**用户侧看不见**。
   *   · 配额上限被拆 → 界面照样有 15 条，只是"不喜欢"占了 8 条
   *   · 偏好读不到   → 界面照样有 15 条，只是设置完全不起作用
   *   · 播种守卫被拆 → 用户改完映射，下次启动被代码里的清单冲掉
   *   · 打标签读清单 → 用户在界面上勾的东西完全不参与抓取
   * 所以它们必须靠"故意改坏一处、看断言抓不抓得住"来证。
   * ══════════════════════════════════════════════════════════════════ */
  {
    file: QUOTA,
    why: '「不喜欢」的配额上限被拆掉 ⇒ "少放"变成"全放进来"（界面照样 15 条，看不出来）',
    from: "    if (cls === PREF.dislike && counts.dislike >= cap) return false;",
    to: '    if (false) return false;',
    expect: '不超过 K 条',
  },
  {
    file: MAIN,
    why: '偏好表没传进精选（全按中性处理）⇒ 喜欢/不喜欢完全不起作用，而条数一切正常',
    from: 'prefByCategory: prefs, quota: effQuota });',
    to: 'prefByCategory: null, quota: effQuota });',
    expect: 'selectByQuota 收到的不是库里那份偏好表',
  },
  {
    file: MAIN,
    why: '面板的源清单不再按类型过滤（把库里全部源都倒给界面）⇒ 真机上几十行把按钮挤出面板',
    /* ⚠️ 这条对应一个**真机上量出来的**缺陷：本机库里 36 个源，
       「开源与工程」只绑了 9 个，而面板列出了 36 行 ⇒ 内容 397px、
       可视 155px ⇒「喜欢程度」与「删除类型」用户点不到。
       离线考裁判当时**一声都不响**（假清单只有 9 个源，装得下）。 */
    from: '          .filter((s) => boundSet.has(Number(s.id)))\n',
    to: '',
    expect: '面板的源清单只能列',
  },
  {
    file: INGEST,
    why: '新登记的源不再播种（不把新增名单交给播种）⇒ 新加的预置源拿不到类型绑定，条目全都不打标签',
    /* ⚠️ 这条是**真机上撞到过**的：新加的「澎湃新闻」在库里没有任何类型绑定，
       它的条目一条都不打标签 ⇒ 按类型筛选时完全看不到（像没抓到），
       而日志里一切正常（`✓ 澎湃新闻 20 条（新增 20）`）。
       ⚠️ 靶子打在**接线处**：判定逻辑本身（`seedSourceCategories`）有单测，
          但"有没有把新增名单接上去"只有这里能咬住。 */
    from: '      if (toSeed.length) {',
    to: '      if (false) {',
    /* ⚠️ `expect` 要写**最先咬住它的那条**断言：实测这个变异体是
       "首次抓取应当播种出映射"先红（"新加进来的预置源…"那条排在后面，
       根本轮不到执行）。写成后者的话会误报"漏网"。 */
    expect: '首次抓取应当播种出映射，实得 0',
  },
  {
    file: DB,
    why: '播种不再看「用户主动摘干净」的记号 ⇒ 用户取消掉的源又自己勾上了',
    from: '    if (removedByUser.has(sid)) continue; // ★ 用户把它摘干净过：绝不加回来',
    to: '    if (false) continue;',
    expect: '这次抓取把用户摘掉的源加回来了',
  },
  {
    file: QUOTA,
    why: '配额不随筛选范围的占比缩放 ⇒ 点进那个类型本身时被砍到 3 条（"配比"变成了"过滤"）',
    /* ⚠️ 靶子要打在**真正决定缩放结果**的那条算式上。我第一版改的是
       `if (pool <= want) return want;` —— 变异体"漏网"了：那条分支只对
       小池子生效，缩放本身还在，于是"点进类型里"的结论其实仍然对。 */
    from: '  const scaled = Math.ceil((want * hit) / pool);',
    to: '  const scaled = quotaOf(want); // 变异体：不缩放，永远用基础配额',
    expect: '配额要随**筛选范围**的占比缩放',
  },
  /* ⚠️ 这里原本有一条变异体："补标签不再看『一条标签都没有』这个判据"。
     实测它**必然存活**，因此删掉而不是留着充数：`tagExistingItemsOfSource` 里
     那段 `if (orphan === 0) return` 只是**性能短路** —— 即便拆掉它，
     后面的 `INSERT OR IGNORE … WHERE` 也插不进任何行（没有条目处于"零标签"状态），
     行为与原来**逐字等价**。一个拆掉也没人发现的靶子会让人误以为那里有防线。
     ⇒ "用户手动摘掉的标签不许被重打"这条性质由上面那条（记号）与
        `backfill_tags` 的记账共同保证，不是靠这个短路。 */
  {
    file: INGEST,
    why: '孤儿源补了映射却不补标签 ⇒ 它已有的条目在类型里完全看不到（像没抓到）',
    from: '        const r = tagExistingItemsOfSource(db, sid, `backfill_tags:${sid}`);',
    to: '        const r = { tagged: 0 };',
    expect: '已有的条目一条标签都没有',
  },
  {
    file: DB,
    why: '摘干净的源不留记号 ⇒ 下次抓取按预置清单把它绑回来（"我取消了，重启又回来了"）',
    from: '      if (stillBound === 0) setMeta(db, `unbound_by_user:${sid}`, \'1\');',
    to: '      if (false) setMeta(db, `unbound_by_user:${sid}`, \'1\');',
    expect: '摘干净一个源之后没有留下记号',
  },
  {
    file: DB,
    why: '`openDb` 又按整份清单播一遍（把"用户改过的不被覆盖"这条承诺作废）',
    /* ⚠️ 这个变异体是**返工回来的**：我一开始写的靶子是"删掉 `hasBinding` 那道兜底"，
       而它**存活** —— 实测过：把那一行改成 `if (false) continue;`，
       169 条断言一条都不红。原因是 `runIngest` 传进来的 `only` **已经只是新增的源**，
       兜底那一行在真实路径上永远轮不到（它只在"调用方把老源也放进 only"时才起作用）。
       ⇒ 一段拆掉也没人发现的代码不是防线，是噪音：靶子换成**真正在起作用的
         "openDb 不再播种"**（把它加回去 ⇒ 4 条断言红）；
         `hasBinding` 那一行留在源码里当**契约**，并在注释里写明它为什么留着。 */
    from: '  ensureColumns(db);',
    to: '  ensureColumns(db);\n  seedSourceCategories(db, new Date().toISOString(), { only: DEFAULT_SOURCES });',
    /* ⚠️ `expect` 要写**最先咬住它的那条**：实测是"老库里已经改过的映射不许被播种覆盖"
       先红（v1 迁移那条也红），而"用户摘掉的源被加回来了"那句排在别的断言后面。 */
    expect: '老库里用户改过的映射被预置清单覆盖了',
  },
  {
    file: DB,
    why: '「不在清单里就停用」不再区分预置源与用户自加的源 ⇒ 用户加的源过一天自己消失',
    /* ⚠️ 这条守的是一处**真会丢用户数据**的口径：退役逻辑是给"我从代码里
       删掉一个源"设计的，而用户自己加的源**天生不在预置清单里** ——
       少判一个 origin，用户今天粘进来的地址下次抓取就被静默关掉，
       而界面上没有任何提示。 */
    from: "    if (row.origin !== 'preset') continue; // ★ 用户自己加的源，永不因为清单而停用\n",
    to: '',
    expect: '不会被预置清单停用',
  },
  {
    file: DB,
    why: '补列时忘了把既有源标回 preset（默认值是 custom）⇒ 代码里删源的退役逻辑永久失效',
    /* ⚠️ 这个退化极其隐蔽：列默认值写成 'custom'、补齐时忘了改回来，
       于是老库里**全部**预置源都被当成"用户自加的" ⇒
       以后从预置清单里删任何一个源，用户机器上它都会被永远抓下去。
       而代码看起来完全正确、其它断言也全绿。 */
    from: "    const n = db.prepare(\"UPDATE source SET origin = 'preset' WHERE origin IS NULL OR origin = 'custom'\").run();",
    to: '    const n = { changes: 0 };',
    expect: '既有源必须被标成「预置」',
  },
  {
    file: MAIN,
    why: '添加源不再校验地址（本机/内网、非 http、畸形地址都会被收下）',
    /* ⚠️ 这条咬的是"判定有没有真的接上"：纯判定在 feed-url.js 里
       （那一份有 12 条断言逐条穷举），但**接不上就是没做** ——
       所以我额外断言了 main/index.js 里"确实调了那两个校验"。 */
    from: '      const v = validateNewSource(p);',
    to: '      const v = { ok: true, name: p.name, feedUrl: p.feedUrl };',
    expect: '添加源必须**真的**调用那两个校验',
  },
  {
    file: MAIN,
    why: '失败返回不带 reason（用户看到"点了没反应"，不知道为什么加不进去）',
    /* ⚠️ 这条盯的是那条**契约**断言而不是某个 if：
       这个文件 import 了 electron，离线跑不起来 ⇒
       "解析失败的分支还在不在"只能靠源码判据咬。
       把 reason 换成 success 字段之后，理由就从界面上消失了。 */
    from: '        return { ok: false, reason: `抓不到这个地址：${fetchErr}` };',
    to: '        return { ok: false, detail: `抓不到这个地址：${fetchErr}` };',
    expect: '有一条失败返回没带 reason',
  },
  {
    file: FEEDURL,
    why: '本机 / 内网地址不再拦（程序会变成一个被外部数据牵着走的探测器）',
    /* ⚠️ 锚点必须跟着源码走：这一行在阶段 B 变成了
       `isPrivateHost(...) && !allowLocal`（多了一个开关），
       锚点没跟着改的那次，这条变异体报的是"注入失败"——
       而"守卫还在不在"和"锚点过没过期"是两件事，**注入失败必须当成红的看**。 */
    from: '  if (isPrivateHost(u.hostname) && !allowLocal) {',
    to: '  if (false) {',
    expect: '应当拒绝本机/内网地址',
  },
  {
    file: FEEDURL,
    why: '172.16-31 的私有网段判错（把整个 172 段都当内网 / 或都不当）⇒ 要么误伤公网、要么放行内网',
    from: '  if (a === 172 && b >= 16 && b <= 31) return true;',
    to: '  if (a === 172) return true;',
    expect: '172.15 属于公网，被误伤了',
  },
  /* ── 阶段 B：把"本机地址"这道边界开成一个**显式开关**（接自建 RSSHub）──
   *
   * 这一组守的是同一条边界的**两端**，两端都会以"用户以为做了、其实没做"的形式坏掉：
   *   · 开关形同虚设 ⇒ 阶段 B 的 RSSHub 永远接不进来（用户按文档设了变量也没用）；
   *   · 开关判成 truthy ⇒ 用户明明写的是 `=0`，程序却仍然去打本机端口。
   * ⚠️ 这个开关**只放开"本机地址"**，协议白名单那些一条都不放松 —— 见第三个变异体。 */
  {
    file: FEEDURL,
    why: '放行本机地址的那个开关被读掉了（接自建 RSSHub 时设了环境变量也没用，而报错只说"不能是本机地址"）',
    /* ⚠️ 注意这条**不是**"把安全检查删掉"，是"把例外删掉"：
       删掉例外之后默认行为逐字不变（本机地址照样拒绝），
       所以任何只测"默认必须拒绝"的用例都抓不住它 ——
       必须有一条**开着开关要放行**的断言，否则这个功能等于没做。 */
    from: '  if (isPrivateHost(u.hostname) && !allowLocal) {',
    to: '  if (isPrivateHost(u.hostname)) {',
    expect: '开了开关之后应当放行本机地址',
  },
  {
    file: FEEDURL,
    why: '开关用 truthy 判断 ⇒ 用户设成 `=0` / `=false` 以为关掉了，程序却仍然去打本机端口',
    /* ⚠️ 方向很重要：这是**放开一条安全边界**的开关，
       "判错"的两个方向不等价 —— 把关闭读成打开是危险的，
       所以必须逐字等于 '1'（而不是 `Boolean(v)`）。 */
    from: "  return String(e[ALLOW_LOCAL_ENV] == null ? '' : e[ALLOW_LOCAL_ENV]).trim() === '1';",
    to: "  return String(e[ALLOW_LOCAL_ENV] == null ? '' : e[ALLOW_LOCAL_ENV]).trim() !== '';",
    expect: '开关取值 "0" 不该被当成',
  },
  {
    file: FEEDURL,
    why: '拒绝本机地址时不说那个环境变量名 ⇒ 用户被卡在"不能用"上，而唯一的出路没人告诉他',
    /* ⚠️ 这条守的是**可发现性**：开关是刻意不做进界面的（要用户明确知道自己在开什么服务），
       那么"怎么开"就**只能**从这条报错里知道。删掉之后功能还在、但没人找得到。 */
    from:
      "        '本机 / 内网地址不能作为源（程序会定期去抓它）。' +\n" +
      '        `如果你确实在本地跑了一个 feed 服务（比如自建 RSSHub），把环境变量 ${ALLOW_LOCAL_ENV}=1 打开再用。`,',
    to: "        '本机 / 内网地址不能作为源（程序会定期去抓它）。',",
    expect: '拒绝理由里要写明那个环境变量名',
  },
  {
    file: FEEDURL,
    why: '开关被当成"什么都放行" ⇒ 开了它之后 ftp:/file: 这些协议也一起被收下（边界从"放开本机"滑成"放开一切"）',
    /* ⚠️ 这条守的是**例外的范围**：开关的语义是"我信任本机那个服务"，
       不是"我信任任何地址"。真实写法里协议判定在本机判定**之前**、
       而且不带这个开关 —— 所以只要有人"顺手"把开关接到协议那行上，
       这条就会红。没有它的话，`ftp://127.0.0.1/x` 会被静默收下。 */
    from: "  if (u.protocol !== 'http:' && u.protocol !== 'https:') {",
    to: "  if (!allowLocal && u.protocol !== 'http:' && u.protocol !== 'https:') {",
    expect: '开了开关之后 ftp://127.0.0.1/x 仍然必须被拒',
  },
  {
    file: INGEST,
    why: '打标签改回读代码里的预置清单 ⇒ 用户在界面上勾的源完全不参与抓取（功能等于没做）',
    from: '              const ids = catOfSource.get(src.id) || [];',
    to: "              const ids = ((DEFAULT_SOURCES.find((d) => d.feedUrl === src.feed_url) || {}).categories || []).map((n) => catIdByName.get(n)).filter((x) => x != null);",
    expect: '抓取打标签读的是 DB 里的映射',
  },
]

/* ⚠️⚠️ 所有替换都必须用**函数形式**的 replacer，不能用字符串形式。
 *
 *    原因：`String.prototype.replace` 会把替换串里的 `$&` / `$1` / `` $` `` 等
 *    当成**特殊模式**来解释（MDN 的 "Specifying a string as the replacement"）。
 *    我这个变异体要改的那一行里有模板字符串 `${fetchErr}` ——
 *    用字符串形式替换时它被改写成 `\$&{fetchErr}`，
 *    于是注入之后的文件是**语法错误**的，而表现是
 *    "变异体注入失败/测试起不来"，看起来像锚点写错了。
 *    （这一条踩过一次：报的是 `SyntaxError: Invalid or unexpected token`，
 *      指向的位置离真正的原因很远。）
 * ⚠️ 下面**两处** `replace` 都要用这个函数（注入与还原各一处）。 */
const replaceLiteral = (src, from, to) => {
  const i = src.indexOf(from);
  if (i < 0) return src;
  return src.slice(0, i) + to + src.slice(i + from.length);
};

/* 每个被改过的文件都留一份原文，最后逐字节校验还原 */
const originals = new Map()
const readOrig = (rel) => {
  if (!originals.has(rel)) originals.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  return originals.get(rel)
}

let allCaught = true
for (const m of MUTANTS) {
  const original = readOrig(m.file)
  const abs = path.join(ROOT, m.file)
  if (!original.includes(m.from)) {
    console.log(`\n✗ 变异体注入失败（找不到锚点）：${m.why}`)
    console.log(`   文件：${m.file}`)
    allCaught = false
    continue
  }
  /* ⚠️⚠️ 必须用 replaceLiteral（按字面替换），不能用 `String.replace(from, to)`。
   *
   *    后者会把**替换串**里的 `$&` / `` $` `` / `$'` / `$1` 当特殊模式解释
   *    （MDN: "Specifying a string as the replacement"）——
   *    而本项目几乎每个变异体改的那一行里都有模板字符串或正则，
   *    于是一部分变异体被改写成**语法错误**的文件，
   *    表现是"变异体注入失败/测试起不来"，看起来像锚点写错了。
   *    （实测：`to` 里带 `${fetchErr}` 的那条直接被改成 `\$&{fetchErr}`。）
   *    ⚠️ 这个坑在本脚本里踩过两次，所以下面这行旁边留着这段注释。 */
  /* ⚠️ 哨兵必须落在**写坏源码之前** —— 顺序反了就等于没写：
     进程如果在"已经改了文件、还没写哨兵"的那一瞬间横死，
     下次启动看不到哨兵，于是带着变异体继续跑（正是要防的那件事）。 */
  fs.writeFileSync(SENTINEL, JSON.stringify({ file: m.file, files: { [m.file]: original } }), 'utf8')
  fs.writeFileSync(abs, replaceLiteral(original, m.from, m.to), 'utf8')
  let out = ''
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test-all.mjs')], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    out = (r.stdout || '') + (r.stderr || '')
  } finally {
    fs.writeFileSync(abs, original, 'utf8')
    fs.rmSync(SENTINEL, { force: true })
  }
  const ranAtAll = /结论：/.test(out)
  const failed = /结论：❌ FAIL/.test(out)
  const named = out.includes(m.expect)
  const caught = failed && named
  if (!caught) allCaught = false

  /* ⚠️ 必须把"变异体本身是坏的"和"漏网"分开报。
     判据只看"有没有 ❌ FAIL"的话，一个**语法错误**的变异体会让测试脚本整个起不来
     —— 没有 FAIL 那行 ⇒ 被判成"漏网"。于是"我的变异体写错了"和
     "断言抓不住这个 bug"混成一句，而这两件事要修的地方完全不同。
     （这不是假想：本脚本真的这么错过一次。） */
  if (!ranAtAll) {
    console.log(`\n✗ 变异体无效（测试根本没跑起来）  ${m.why}`)
    console.log(`   文件：${m.file}`)
    const err = out.split('\n').filter((l) => /SyntaxError|TypeError|ReferenceError/.test(l)).slice(0, 2)
    console.log('   ' + (err.join('\n   ') || '(没有明显的语法/运行错误行，看完整输出)'))
    continue
  }

  console.log(`\n${caught ? '✓ 落网' : '✗ 漏网'}  ${m.why}`)
  console.log(`   测试确实失败=${failed}  失败的正是那条断言=${named}`)
  if (!caught) {
    const line = out.split('\n').filter((l) => l.includes('✗')).slice(0, 4).join('\n   ')
    console.log('   实际失败项：\n   ' + line)
  }
}

/* 还原后必须确认每个文件都**逐字节**回到原样 —— 变异测试污染源码是很危险的 */
let restored = true
for (const [rel, text] of originals) {
  if (fs.readFileSync(path.join(ROOT, rel), 'utf8') !== text) {
    restored = false
    console.log(`\n✗✗✗ ${rel} 没有还原干净，赶快修！`)
  }
}
/* 走到这里说明没有任何一个变异体还挂在文件上 ⇒ 哨兵必须已经清掉。
   留着它的话，下一次运行会以为"上一次是横死的"，去还原一批
   **本来就是原文**的内容 —— 无害，但会报一句吓人的警告。 */
fs.rmSync(SENTINEL, { force: true })
console.log(`\n源码已还原且逐字节一致：${restored ? '✓' : '✗✗✗'}（共 ${originals.size} 个文件）`)
if (!restored || !allCaught) process.exit(1)
console.log('全部变异体落网 ✔')
