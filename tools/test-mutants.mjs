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
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = 'src/shared/runtime-state.js'
const UPDATE = 'src/shared/update.js'

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
]

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
  fs.writeFileSync(abs, original.replace(m.from, m.to), 'utf8')
  let out = ''
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test-all.mjs')], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    out = (r.stdout || '') + (r.stderr || '')
  } finally {
    fs.writeFileSync(abs, original, 'utf8')
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
console.log(`\n源码已还原且逐字节一致：${restored ? '✓' : '✗✗✗'}（共 ${originals.size} 个文件）`)
if (!restored || !allCaught) process.exit(1)
console.log('全部变异体落网 ✔')
