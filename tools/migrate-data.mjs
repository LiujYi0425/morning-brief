#!/usr/bin/env node
/**
 * 数据目录迁移（`npm run migrate-data`）—— 把简报数据在**开发态**和**打包态**之间搬。
 *
 * 为什么需要它：同一个应用有**两个合法的数据目录**，取决于它怎么启动：
 *   · 开发态（`npm start` / 三个 .vbs）→ `<项目>/data`
 *   · 打包态（装的那个 exe）        → `%APPDATA%\morning-brief\data`
 * 两边是**各自独立的库**，装了新版本之后旧数据不会自己跟过去。
 * 手动拿资源管理器拷贝有两个坑，这个脚本就是把它们堵上：
 *
 *   ① **应用还在跑的时候拷 = 拷到一个撕裂的库。**
 *      SQLite 在写的时候文件不是一致的快照，而 `-wal` 里可能还压着已提交但
 *      没并回主库的数据。表现是"搬完了，但最新的几条/已读标记丢了"。
 *      ⇒ 本脚本先查 pid 文件，任一边在跑就**拒绝执行**，不做"我猜应该没事"。
 *
 *   ② **"搬完了"没有证据。** 拷完不校验，你无法区分"成功"和"静默拷了一半"。
 *      ⇒ 本脚本对每个表算一个**内容指纹**（全表所有行的 JSON 串起来的 sha256），
 *        源和目标必须逐表相同；任一不同就报失败并列出是哪张表。
 *        （只比 COUNT(*) 是不够的 —— 行数一样而内容不同是可能的。）
 *
 * 用法：
 *   node tools/migrate-data.mjs --from <源目录> --to <目标目录> [--move] [--force]
 *
 *   --move   校验通过后**删掉源目录**。默认保留（强烈建议先留几天）。
 *   --force  目标目录已有非空的 brief.db 时覆盖它。默认拒绝。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readPidFile, isProcessAlive } from '../src/shared/runtime-state.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ── 参数 ── */
const argv = process.argv.slice(2)
const flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { flags[k] = next; i++ } else flags[k] = true
  }
}
const die = (msg, code = 2) => { console.error('\n✗ ' + msg + '\n'); process.exit(code) }

if (!flags.from || !flags.to) {
  console.error(`
用法：node tools/migrate-data.mjs --from <源目录> --to <目标目录> [--move] [--force]

  开发态数据目录：${path.join(ROOT, 'data')}
  打包态数据目录：%APPDATA%\\morning-brief\\data

  默认**保留**源目录（建议先留几天再自己删）。加 --move 才会删。
`)
  process.exit(2)
}
const FROM = path.resolve(String(flags.from))
const TO = path.resolve(String(flags.to))
const MOVE = flags.move === true
const FORCE = flags.force === true

if (FROM === TO) die('源目录和目标目录是同一个：' + FROM)
if (!fs.existsSync(FROM)) die('源目录不存在：' + FROM)
if (!fs.existsSync(path.join(FROM, 'brief.db'))) die('源目录里没有 brief.db —— 这看起来不是晨报机的数据目录：' + FROM)

/* ── ① 任一边在跑就拒绝 ──
 * 这一条是硬闸门，不是提醒：撕裂的库不会报错，只会悄悄少几条。 */
for (const [dir, name] of [[FROM, '源'], [TO, '目标']]) {
  const info = readPidFile(dir)
  if (info && Number.isInteger(Number(info.pid)) && isProcessAlive(Number(info.pid))) {
    die(`${name}目录正被一个运行中的实例占用（PID ${info.pid}，${info.image || '未知映像'}）。\n` +
        `  先停掉它：node tools/service.mjs stop --data-dir "${dir}"\n` +
        `  在写入过程中拷贝会得到一个**撕裂的数据库**，而且不会报任何错。`)
  }
}

/* ── ② 内容指纹 ──
 * 对每张表把全部行序列化后哈希。只比行数不够：行数相同、内容不同是可能的。 */
async function fingerprint(dbFile) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map((r) => r.name)
    const out = {}
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM "${t}"`).all()
      const h = crypto.createHash('sha256')
      /* 行序不保证稳定（没 ORDER BY），所以先按序列化结果排序再哈希 ——
         比的是"内容集合"，不是"物理存储顺序"。 */
      const serialized = rows.map((r) => JSON.stringify(r)).sort()
      for (const s of serialized) h.update(s).update('\n')
      out[t] = { rows: rows.length, hash: h.digest('hex') }
    }
    return out
  } finally {
    db.close()
  }
}

const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/* ── ③ 目标目录非空则要确认 ── */
const toDb = path.join(TO, 'brief.db')
if (fs.existsSync(toDb) && !FORCE) {
  let n = '?'
  try { const { DatabaseSync } = await import('node:sqlite')
    const d = new DatabaseSync(toDb, { readOnly: true })
    n = d.prepare('SELECT COUNT(*) c FROM item').get().c; d.close() } catch { /* 读不了就算了 */ }
  die(`目标目录已经有数据库了：${toDb}（${n} 条资讯）\n` +
      `  覆盖它会丢掉那边的数据。确认要覆盖就加 --force。`)
}

console.log(`源  ：${FROM}`)
console.log(`目标：${TO}`)
console.log(`模式：${MOVE ? '迁移（校验通过后删除源）' : '复制（保留源作为后备）'}`)

/* ── ④ 拷贝 ── */
fs.mkdirSync(TO, { recursive: true })

/* ★ 先清掉**目标目录里属于上一个实例的运行态痕迹**。
 *
 * ⚠️ 其中 `stop-request` 是真正危险的：它是"请退出"的信号文件。
 *   上一个实例留下的一个没被消费掉的 stop-request，会让**刚启动的新实例
 *   立刻自己退出** —— 表现就是"双击了，闪一下没了"，而且日志里理由充足
 *   （"收到停止请求"），查起来会往完全错误的方向走。 */
let cleaned = 0
for (const name of ['morning-brief.pid', 'stop-request', 'boot-heartbeat.txt']) {
  const p = path.join(TO, name)
  if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); cleaned++ }
}
if (cleaned) console.log(`清掉目标目录里 ${cleaned} 个上个实例的运行态痕迹（pid/停止请求/心跳）`)

const copied = []
for (const ent of fs.readdirSync(FROM, { withFileTypes: true })) {
  if (!ent.isFile()) continue
  const src = path.join(FROM, ent.name)
  /* 同样跳过源那边的运行态痕迹 —— 它们描述的是"那个进程"。 */
  if (/^(morning-brief\.pid|stop-request|boot-heartbeat\.txt)$/.test(ent.name)) {
    console.log(`  跳过运行态痕迹：${ent.name}`)
    continue
  }
  fs.copyFileSync(src, path.join(TO, ent.name))
  copied.push(ent.name)
}
console.log(`\n已复制 ${copied.length} 个文件`)

/* ── ⑤ 校验：内容指纹必须逐表相同 ── */
console.log('\n校验：')
const a = await fingerprint(path.join(FROM, 'brief.db'))
const b = await fingerprint(toDb)
const tables = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
let bad = 0
for (const t of tables) {
  const x = a[t], y = b[t]
  const same = x && y && x.rows === y.rows && x.hash === y.hash
  if (!same) bad++
  console.log(`  ${same ? '✓' : '✗'} ${t.padEnd(18)} 源 ${String(x ? x.rows : '-').padStart(6)} 行  目标 ${String(y ? y.rows : '-').padStart(6)} 行` +
    (same ? `  ${x.hash.slice(0, 16)}` : `  ⚠ 指纹不同：${x ? x.hash.slice(0, 12) : '-'} vs ${y ? y.hash.slice(0, 12) : '-'}`))
}
const srcDbHash = sha256File(path.join(FROM, 'brief.db'))
const dstDbHash = sha256File(toDb)
console.log(`  ${srcDbHash === dstDbHash ? '✓' : '·'} brief.db 文件级 sha256 ${srcDbHash === dstDbHash ? '相同' : '不同（正常：SQLite 页布局可能变，以内容指纹为准）'}`)

if (bad > 0) {
  die(`${bad} 张表的内容指纹不一致 —— **不要**删源目录，先查清楚。`, 1)
}
console.log('\n✓ 所有表的内容指纹逐表一致，迁移是完整的。')

/* ── ⑥ 删除源（只在 --move 且校验通过之后） ── */
if (MOVE) {
  fs.rmSync(FROM, { recursive: true, force: true })
  console.log(`✓ 已删除源目录：${FROM}`)
} else {
  console.log(`源目录保留在：${FROM}`)
  console.log('  确认新位置跑几天没问题之后，自己删掉它即可。')
}
