/**
 * 变异测试：证明"打包态数据目录"与"可写性探测"那几条断言**真的抓得住 bug**，
 * 而不是永远为真的摆设。
 *
 * ⚠️ 为什么这两条值得单独做变异测试：它们的失败**看不见**。
 *   · 数据目录落进只读的 app.asar ⇒ 双击没反应（GUI 无控制台、窗口还没建）
 *   · 探测永远说"可以写"          ⇒ 同上
 *   普通断言只能证明"现在是对的"，证明不了"改坏了会被发现"。
 *
 * ⚠️ 本脚本会**临时改写 src/shared/runtime-state.js**（跑完在 finally 里还原，
 *   并逐字节校验还原结果）。所以它**不进 `npm test`**，是单独一条命令 ——
 *   万一有人正好在改写的那几秒里重启应用，会加载到变异体。
 *   想跑就明确地跑：`npm run test:mutants`
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(ROOT, 'src', 'shared', 'runtime-state.js')
const original = fs.readFileSync(TARGET, 'utf8')

const MUTANTS = [
  {
    why: '打包态分支删掉 ⇒ 数据目录退回项目内（打包后落在只读 app.asar 里，双击没反应）',
    from: '  if (ctx.packagedUserData) return path.join(ctx.packagedUserData, DEFAULT_DATA_DIR_NAME);',
    to: '  /* 变异体：打包态分支被删掉 */',
    expect: '打包态的数据目录必须落在 userData',
  },
  {
    why: 'probeWritable 永远说"可以写" ⇒ 不可写时应用以"双击没反应"的形式死掉',
    from: '    fs.mkdirSync(dir, { recursive: true });',
    to: '    return { ok: true };',
    expect: '目录不可写必须在',
  },
  {
    why: 'probeWritable 失败时不带系统错误码 ⇒ 错误框里说不出所以然',
    from: '    return { ok: false, error: `${(err && err.code) || \'\'} ${(err && err.message) || err}`.trim() };',
    to: '    return { ok: false, error: \'写不进去\' };',
    expect: '目录不可写必须在',
  },
  {
    why: '归属校验退回"必须是 electron" ⇒ 打包版被判成没在运行，stop 报成功却什么都不做',
    from: '    const recorded = pidInfo.image ? String(pidInfo.image).trim() : \'\';',
    to: '    const recorded = \'\';',
    expect: 'classifyRun 穷举',
  },
]

let allCaught = true
for (const m of MUTANTS) {
  if (!original.includes(m.from)) {
    console.log(`\n✗ 变异体注入失败（找不到锚点）：${m.why}`)
    allCaught = false
    continue
  }
  fs.writeFileSync(TARGET, original.replace(m.from, m.to), 'utf8')
  let out = ''
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test-all.mjs')], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    out = (r.stdout || '') + (r.stderr || '')
  } finally {
    fs.writeFileSync(TARGET, original, 'utf8')
  }
  const failed = /结论：❌ FAIL/.test(out)
  const named = out.includes(m.expect)
  const caught = failed && named
  if (!caught) allCaught = false
  console.log(`\n${caught ? '✓ 落网' : '✗ 漏网'}  ${m.why}`)
  console.log(`   测试确实失败=${failed}  失败的正是那条断言=${named}`)
  if (!caught) {
    const line = out.split('\n').filter((l) => l.includes('✗')).slice(0, 4).join('\n   ')
    console.log('   实际失败项：\n   ' + line)
  }
}

/* 还原后必须确认文件**逐字节**回到原样 —— 变异测试污染源码是很危险的 */
const restored = fs.readFileSync(TARGET, 'utf8') === original
console.log(`\n源码已还原且逐字节一致：${restored ? '✓' : '✗✗✗ 赶快修！'}`)
if (!restored || !allCaught) process.exit(1)
console.log('全部变异体落网 ✔')
