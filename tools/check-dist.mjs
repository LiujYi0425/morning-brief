#!/usr/bin/env node
/**
 * 打包产物核对 —— `npm run dist:check`
 *
 * ⚠️⚠️ 这个脚本存在的**唯一理由**是隐私边界，不是"打包成功没成功"。
 *
 *   electron-builder **不读 `.gitignore`**。不写 `build.files` 时它按"全匹配"打包，
 *   于是 `data/brief.db`（真实简报正文 + 我的已读标记）、带用户名的日志、
 *   `.npm-cache`(22MB)、`.env`、`*.pem` 会**一起进安装包**。
 *   而 asar **不是加密归档** —— 一条 `asar extract` 就全取出来了。
 *   发给同事的那个 exe，本质上是"我的数据 + 一份能读它的程序"。
 *
 *   所以每次 `npm run dist` 之后**必须**跑这个脚本。它做两件事：
 *     A. 静态核对 `package.json` 的 build 配置本身是否自洽（排除表有没有漏、资源在不在）
 *     B. 打开**真实产物**：解析 `app.asar` 的目录头，把里面每一个路径列出来逐个筛，
 *        再扫一遍 `win-unpacked/resources/` 和整个解包目录。
 *
 *   设计上刻意**零依赖**：asar 头是手写解析的（格式见下），
 *   不引 `@electron/asar` —— 那只是 electron-builder 的传递依赖，
 *   哪天它换了依赖树，这个脚本会跟着静默失效（"静默失效的守卫"是本工程反复踩过的坑）。
 *   手写解析的正确性由**自校验**保证：解析完立刻按算出来的偏移量读一个已知文件，
 *   和磁盘上的原文逐字节比对；对不上就直接判解析器坏了 —— 宁可报错，绝不静默放过。
 *
 * 用法：node tools/check-dist.mjs
 * 退出码：0 = 全部通过；1 = 有失败项（逐条列出）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RELEASE = path.join(ROOT, 'release')
const UNPACKED = path.join(RELEASE, 'win-unpacked')

const fails = []
const warns = []
const ok = (m) => console.log('  \u2713 ' + m)
const bad = (m) => { fails.push(m); console.log('  \u2717 ' + m) }
const warn = (m) => { warns.push(m); console.log('  ! ' + m) }
const head = (m) => console.log('\n' + m)

/* ─────────────────────────── A. 配置自检 ─────────────────────────── */

head('A. package.json 的 build 配置')

let pkg = null
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok('package.json 是合法 JSON')
} catch (e) {
  bad('package.json 解析失败：' + e.message)
}

const b = pkg && pkg.build
if (!b) {
  bad('package.json 里没有 build 段 —— electron-builder 会用默认 `**/*`，data/ 会进安装包')
} else {
  ok('build.appId = ' + b.appId + ' · productName = ' + b.productName)

  /* 排除表必须覆盖的目录：漏掉任何一个，真实数据就会被打进安装包发给别人。 */
  const MUST_EXCLUDE = [
    ['data/', '真实简报数据库（brief.db）+ 运行日志 + pidfile'],
    ['report/', '审计报告等过程产物'],
    ['release/', '上一次的打包输出（会自我嵌套）'],
    ['.git/', '完整仓库历史'],
    ['.npm-cache/', 'electron 下载缓存（几十 MB）'],
    ['tools/', '开发脚本（打包态用不到，且 .ps1 必须走 extraResources）'],
  ]
  const list = (b.files || []).join('\n')
  if (!Array.isArray(b.files) || b.files.length === 0) {
    bad('build.files 为空 ⇒ 退化成 `**/*`，data/ 会进安装包')
  } else {
    for (const [dir, why] of MUST_EXCLUDE) {
      const re = new RegExp('^!' + dir.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '', 'm')
      if (re.test(list)) ok('排除 ' + dir + '（' + why + '）')
      else bad('排除表漏了 ' + dir + ' —— ' + why)
    }
  }

  /* extraResources：必须在 asar 之外的两个东西。少一个，打包态就残。 */
  const extra = Array.isArray(b.extraResources) ? b.extraResources : []
  const extraTo = extra.map((r) => (typeof r === 'string' ? r : r.to || '')).join('\n')
  for (const [need, why] of [
    ['tools/win', '置底脚本：PowerShell 的 -File 读不了 asar 内的路径'],
    ['assets', '托盘图标：托盘 API 要真实文件路径'],
  ]) {
    if (extraTo.includes(need)) {
      const row = extra.find((r) => typeof r !== 'string' && (r.to || '') === need)
      const from = row && row.from ? path.join(ROOT, row.from) : null
      if (from && !fs.existsSync(from)) bad(`extraResources 的源目录不存在：${row.from}`)
      else ok('extraResources 含 ' + need + '（' + why + '）')
    } else {
      bad('extraResources 缺 ' + need + ' —— ' + why)
    }
  }

  /* 图标：不设 win.icon 时 electron-builder 用 Electron 默认的原子图标，
     桌面/任务栏/属性页全是别人的图标，一眼就看出是"没做完的东西"。 */
  if (b.win && b.win.icon) {
    const p = path.join(ROOT, b.win.icon)
    if (fs.existsSync(p)) ok(`win.icon = ${b.win.icon}（${fs.statSync(p).size} 字节）`)
    else bad(`win.icon 指向的文件不存在：${b.win.icon} —— 先跑 npm run icon`)
  } else {
    bad('win.icon 未设置 —— 安装后是 Electron 默认图标')
  }

  if (b.nsis && b.nsis.oneClick === false) ok('nsis.oneClick = false（用户可选安装目录）')
  else warn('nsis.oneClick 不是 false —— 双击会直接装、不给选路径')
}

/* ─────────────────── B. 真产物：解析 app.asar 目录头 ─────────────────── */

/**
 * 读 asar 的目录头。格式（全部小端）：
 *
 *   偏移 0   u32 = 4                ← 下面那个 size pickle 的载荷长度
 *   偏移 4   u32 = headerSize       ← 头 pickle 的总字节数（含自身对齐填充）
 *   偏移 8   u32 = 头 pickle 载荷长
 *   偏移 12  u32 = JSON 字符串字节长
 *   偏移 16  ...  JSON（目录树）
 *   偏移 8+headerSize ...          文件数据区起点
 *
 * 目录树节点：`{ files: { 名字: 节点 } }`；叶子是
 * `{ size, offset }`，其中 **offset 是字符串**（asar 用字符串存 64 位偏移，
 * 因为 JSON 的 number 精度不够），`unpacked:true` 的叶子没有 offset。
 */
function readAsarHeader(file) {
  const fd = fs.openSync(file, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  if (!(headerSize > 0 && headerSize < 64 * 1024 * 1024)) {
    fs.closeSync(fd)
    throw new Error(`asar 头长度不合理：${headerSize}`)
  }
  const headerBuf = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuf, 0, headerSize, 8)
  const strLen = headerBuf.readUInt32LE(4)
  const json = headerBuf.subarray(8, 8 + strLen).toString('utf8')
  return { fd, header: JSON.parse(json), baseOffset: 8 + headerSize }
}

function walkAsar(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (entry.files) walkAsar(entry, p, out)
    else out.push({ path: p, size: entry.size || 0, offset: entry.offset, unpacked: !!entry.unpacked })
  }
}

head('B. 真实产物')

if (!fs.existsSync(RELEASE)) {
  bad('release/ 不存在 —— 还没打过包。先跑：npm run dist')
} else {
  const asarFile = path.join(UNPACKED, 'resources', 'app.asar')
  const appExe = path.join(UNPACKED, 'MorningBrief.exe')
  const installers = fs.readdirSync(RELEASE).filter((f) => f.toLowerCase().endsWith('.exe'))

  if (fs.existsSync(appExe)) ok('win-unpacked/MorningBrief.exe 存在（' + (fs.statSync(appExe).size / 1048576).toFixed(1) + ' MB）')
  else bad('win-unpacked/MorningBrief.exe 不存在 —— 解包目录没生成')
  if (installers.length) ok('安装包：' + installers.join('、'))
  else warn('release/ 下没有 .exe 安装包（只做了 --dir 解包？那不算可交付产物）')

  /* ── B1. 自校验 + 列出 asar 内所有文件 ── */
  if (!fs.existsSync(asarFile)) {
    bad('resources/app.asar 不存在 —— 应用主体没打出来')
  } else {
    let asar = null
    let files = []
    try {
      asar = readAsarHeader(asarFile)
      walkAsar(asar.header, '', files)
    } catch (e) {
      bad('app.asar 目录头解析失败：' + e.message)
    }

    if (asar && files.length) {
      /* ★ 自校验：手写解析器必须证明自己是对的，否则后面所有"没找到违禁文件"都不算数
         —— 一个永远返回空列表的解析器同样会"通过"全部检查。 */
      const probePath = 'src/main/index.js'
      const probe = files.find((f) => f.path === probePath)
      const onDisk = path.join(ROOT, probePath)
      if (!probe || probe.offset === undefined) {
        bad(`自校验失败：asar 里找不到 ${probePath}（解析器可能读错了目录树）`)
      } else if (!fs.existsSync(onDisk)) {
        bad(`自校验失败：磁盘上没有 ${onDisk}`)
      } else {
        const want = fs.readFileSync(onDisk)
        const got = Buffer.alloc(probe.size)
        fs.readSync(asar.fd, got, 0, probe.size, asar.baseOffset + Number(probe.offset))
        if (got.equals(want)) {
          ok(`asar 解析器自校验通过（按偏移读出 ${probePath}，与磁盘逐字节一致，${want.length} 字节）`)
        } else {
          bad(`★ asar 解析器自校验失败：读出的 ${probePath} 与磁盘不一致 —— ` +
              `下面的"没找到违禁文件"结论**不可信**，先修解析器`)
        }
      }

      const total = files.reduce((s, f) => s + f.size, 0)
      ok(`asar 内 ${files.length} 个文件，解包后约 ${(total / 1048576).toFixed(2)} MB`)

      /* ★★ 体积闸门 —— 这条不是"优化建议"，是**兜底**。
       *
       * 起因是一次真事故：安装器有一次把应用装到了 `D:\morning-brief\MorningBrief\`
       * （项目**内部**）。那个目录有 235 MB，而排除表里原本没有它 ⇒
       * 下一次 `npm run dist` 会**把装好的应用再打包进安装包**，体积翻倍，
       * 而违禁文件清单里一条都匹配不上 —— 所有检查照样全绿。
       *
       * 这套源码只有 25 个文件、0.3 MB。**只有当别的东西混进来时才会大。**
       * 所以拿体积当闸门刚好：它不需要事先知道"混进来的是什么"。 */
      const SIZE_LIMIT_MB = 20
      if (total > SIZE_LIMIT_MB * 1048576) {
        bad(`★ asar 解包后有 ${(total / 1048576).toFixed(1)} MB，超过 ${SIZE_LIMIT_MB} MB 的闸门 —— ` +
            `这套源码本身只有约 0.3 MB，超这么多说明**有大东西混进去了**。按体积倒序：`)
        for (const f of [...files].sort((a, b) => b.size - a.size).slice(0, 10)) {
          console.log(`        ${(f.size / 1048576).toFixed(2)} MB  ${f.path}`)
        }
      } else {
        ok(`体积在闸门内（${(total / 1048576).toFixed(2)} MB < ${SIZE_LIMIT_MB} MB）`)
      }

      /* ── B2. 违禁文件 ── */
      const FORBIDDEN = [
        [/^data\//, '项目数据目录（真实简报数据库！）'],
        [/^report\//, '报告产物'],
        [/^release\//, '打包输出自我嵌套'],
        [/^\.git\//, '仓库历史'],
        [/^\.npm-cache\//, '下载缓存'],
        [/\.log$/i, '日志（含本机用户名、绝对路径）'],
        [/(^|\/)\.env(\.|$)/i, '环境变量文件'],
        [/\.(pem|key|p12|pfx)$/i, '私钥/证书'],
        [/\.(db|sqlite|sqlite3|db-wal|db-shm)$/i, '数据库文件'],
        [/^tools\//, '开发脚本（应走 extraResources 而非 asar）'],
        [/\.vbs$/i, '启动器（打包态没有 node，运行不了）'],
        [/\.bak$/i, '备份文件'],
      ]
      const hits = []
      for (const f of files) {
        for (const [re, why] of FORBIDDEN) {
          if (re.test(f.path)) hits.push(`${f.path}  ← ${why}`)
        }
      }
      if (hits.length) {
        bad(`★ asar 里混进了 ${hits.length} 个不该有的文件：`)
        for (const h of hits.slice(0, 40)) console.log('        ' + h)
        if (hits.length > 40) console.log(`        ...（还有 ${hits.length - 40} 个）`)
      } else {
        ok('asar 内没有 data/、日志、.env、密钥、数据库、.vbs、开发脚本')
      }

      /* ── B3. 必需文件 ── */
      const have = new Set(files.map((f) => f.path))
      for (const need of [
        'package.json',
        'src/main/index.js',
        'src/preload/index.cjs',
        'src/renderer/card.html',
        'src/renderer/card.js',
        'src/shared/runtime-state.js',
        'src/store/db.js',
      ]) {
        if (have.has(need)) ok('asar 含 ' + need)
        else bad('asar 缺 ' + need + ' —— 打包后应用会启动失败')
      }

      fs.closeSync(asar.fd)
    }
  }

  /* ── B4. asar 之外（resources/）── */
  const resourcesDir = path.join(UNPACKED, 'resources')
  if (fs.existsSync(resourcesDir)) {
    for (const [rel, why] of [
      [path.join('tools', 'win', 'set-window-level.ps1'), '置底脚本必须真实存在于文件系统'],
      [path.join('assets', 'tray-16.png'), '托盘图标必须真实存在于文件系统'],
    ]) {
      const p = path.join(resourcesDir, rel)
      if (fs.existsSync(p)) ok(`resources/${rel.replace(/\\/g, '/')} 存在（${fs.statSync(p).size} 字节）`)
      else bad(`resources/${rel.replace(/\\/g, '/')} 缺失 —— ${why}`)
    }
  } else {
    bad('win-unpacked/resources 不存在')
  }

  /* ── B5. 整个解包目录扫一遍违禁文件 ──
     光看 asar 不够：extraResources、unpacked 目录、以及 electron-builder
     自己的中间产物都在这棵树里，它们同样是"发出去的东西"。 */
  if (fs.existsSync(UNPACKED)) {
    const bad2 = []
    const stack = [UNPACKED]
    while (stack.length) {
      const dir = stack.pop()
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { stack.push(p); continue }
        const rel = path.relative(UNPACKED, p).replace(/\\/g, '/')
        if (/\.(log|db|sqlite3?|db-wal|db-shm|pem|key|p12|pfx)$/i.test(e.name) ||
            /^\.env(\.|$)/i.test(e.name) ||
            /(^|\/)data\/(brief|.*\.db)/i.test(rel)) {
          bad2.push(rel)
        }
      }
    }
    if (bad2.length) {
      bad('★ win-unpacked/ 里有不该出现的文件：')
      for (const h of bad2.slice(0, 40)) console.log('        ' + h)
    } else {
      ok('win-unpacked/ 全树扫描：无 .db / .log / .env / 密钥')
    }
  }
}

/* ─────────────────────────── 结论 ─────────────────────────── */

head('结论')
if (warns.length) {
  console.log(`  ${warns.length} 条提醒（不阻塞）：`)
  for (const w of warns) console.log('    ! ' + w)
}
if (fails.length) {
  console.log(`\n  ✗ ${fails.length} 项失败 —— 这个产物**不能发出去**：`)
  for (const f of fails) console.log('    · ' + f)
  process.exit(1)
}
console.log('\n  ✓ 全部通过：隐私边界干净，运行时资源齐全，可以交付。')
process.exit(0)
