#!/usr/bin/env node
/**
 * 打包入口（`npm run dist`）。
 *
 * 为什么不直接 `electron-builder --win`：
 *
 *   本机 **github.com 在 Node 的 TLS 栈下握手失败**
 *   （`unable to get local issuer certificate` —— 系统根证书 Node 不认，
 *     但浏览器和 PowerShell 走的是 Windows 证书库，所以"网页能打开"不代表 Node 能连）。
 *   而 electron-builder 和 @electron/get 默认恰恰都去 github releases 取东西：
 *     · electron 运行时  `electron-v<ver>-win32-x64.zip`
 *     · NSIS 工具链      `nsis-3.0.4.1.7z` 等（`%LOCALAPPDATA%\electron-builder\Cache` 是空的）
 *   ⇒ 直接跑会卡在下载，报出来的还是一句跟打包毫无关系的 TLS 错误。
 *
 *   实测（2026-09，本机）：
 *     github.com                    ✗ unable to get local issuer certificate
 *     registry.npmjs.org            ✓ 200
 *     registry.npmmirror.com        ✓ 200
 *     npmmirror.com/mirrors/electron/ ✓ 302 → cdn 200，
 *                                      electron-v44.4.2-win32-x64.zip = 158218669 字节，
 *                                      与 `%LOCALAPPDATA%\electron\Cache` 里那份**字节数一致**
 *
 *   ⇒ 这里把两个镜像设成默认值。**已经设过同名环境变量的不覆盖**，
 *     所以能连通 github 的机器上不会因为这段代码被强制走镜像。
 *
 * 另外它把"先生成图标"这一步也收进来了：win.icon 指向 build/icon.ico，
 * 文件不在时 electron-builder **不报错**，它直接退回 Electron 的默认图标 ——
 * 又一处"静默降级"，所以这步必须是硬前置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ─────────────── 镜像 ───────────────
   末尾的斜杠不能省：@electron/get 是直接做字符串拼接的（`${mirror}${version}/${file}`），
   少了斜杠会拼成 `.../electron44.4.2/...`。 */
const MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

const env = { ...process.env }
for (const [k, v] of Object.entries(MIRRORS)) {
  if (env[k]) console.log(`[dist] ${k} 已有值，沿用：${env[k]}`)
  else {
    env[k] = v
    console.log(`[dist] ${k} = ${v}`)
  }
}

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' })
    p.on('close', (code) => resolve(code === null ? 1 : code))
    p.on('error', (e) => {
      console.error(`[dist] 起不来：node ${args.join(' ')} —— ${e.message}`)
      resolve(1)
    })
  })
}

/* ─────────────── 1/2 图标（硬前置） ─────────────── */
console.log('[dist] 1/2 生成图标与托盘图标')
let code = await run([path.join(ROOT, 'tools', 'make-icon.mjs')])
if (code !== 0) {
  console.error('[dist] ✗ 图标生成失败 —— 中止。继续打包会用 Electron 默认图标。')
  process.exit(code)
}
const ico = path.join(ROOT, 'build', 'icon.ico')
if (!fs.existsSync(ico)) {
  console.error(`[dist] ✗ 图标脚本"成功"了但没产出 ${ico} —— 中止`)
  process.exit(1)
}
console.log(`[dist]    build/icon.ico 就位（${fs.statSync(ico).size} 字节）`)

/* ─────────────── 2/2 electron-builder ───────────────
   CLI 入口从 electron-builder 自己的 package.json `bin` 字段读，
   不硬编码路径 —— 那属于"两份口径"，它换个目录就静默失效。 */
console.log('[dist] 2/2 electron-builder --win')
const ebDir = path.join(ROOT, 'node_modules', 'electron-builder')
const ebPkgFile = path.join(ebDir, 'package.json')
if (!fs.existsSync(ebPkgFile)) {
  console.error('[dist] ✗ 没装 electron-builder。先跑：npm install')
  process.exit(1)
}
const ebPkg = JSON.parse(fs.readFileSync(ebPkgFile, 'utf8'))
const binRel = (ebPkg.bin && (ebPkg.bin['electron-builder'] || ebPkg.bin)) || null
if (!binRel || typeof binRel !== 'string') {
  console.error('[dist] ✗ electron-builder 的 package.json 里读不到 bin 入口')
  process.exit(1)
}
const cli = path.resolve(ebDir, binRel)
if (!fs.existsSync(cli)) {
  console.error(`[dist] ✗ bin 指向的入口不存在：${cli}`)
  process.exit(1)
}
console.log(`[dist]    electron-builder ${ebPkg.version} · ${path.relative(ROOT, cli)}`)

code = await run([cli, '--win'])
if (code === 0) {
  console.log('\n[dist] ✓ 打包完成 → release/')
  console.log('[dist]   下一步务必跑：npm run dist:check（核对隐私边界，不发出去之前必须过）')
} else {
  console.error(`\n[dist] ✗ electron-builder 退出码 ${code}`)
}
process.exit(code)
