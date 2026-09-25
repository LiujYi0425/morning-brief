#!/usr/bin/env node
/**
 * 发布一步到位（`npm run release`）：生成更新清单 `latest.json`，并打印发布命令。
 *
 * 为什么需要它：更新器要能发现新版本，就必须有一个**稳定的清单地址**。
 * 这里定的口径是 GitHub Release 的附件 `latest.json` ——
 *   https://github.com/LiujYi0425/morning-brief/releases/latest/download/latest.json
 * `releases/latest/download/<附件名>` 是 GitHub 提供的稳定别名，永远指向
 * **最新那个 release** 的同名附件。好处是升级时不需要往仓库里提交任何东西，
 * 清单跟着 release 走，旧版本的安装包也自然留在各自的 release 里当退路。
 *
 * ⚠️ 清单里的 sha256 是**更新器唯一的安全依据**：它决定了下载完的东西
 *    是不是原件。所以这里必须对**最终要发出去的那个文件**算哈希，
 *    而不是对中间产物算 —— 差一个字节，装上之后就是"校验失败"，
 *    而那时用户已经点过"更新"了。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const RELEASE = path.join(ROOT, 'release')

const exeName = `${pkg.build.productName} Setup ${version}.exe`
const exe = path.join(RELEASE, exeName)
if (!fs.existsSync(exe)) {
  console.error(`\n✗ 找不到安装包：release/${exeName}\n  先跑：npm run dist\n`)
  process.exit(1)
}

/* ★★ 版本号守卫（阶段 C 补丁）：这个版本**已经发过**就不许再生成清单。
 *
 * ⚠️ 真机上的隐患：`npm run dist` 不会动 package.json 的 version，
 *    所以「改了代码 → 直接 dist → release」会用**同一个版本号**再打一份，
 *    而装了那个版本的人比较版本号时会判「已是最新」⇒ **永远收不到这次的东西**；
 *    更糟的是安装包换了、sha256 变了，而清单里的版本号没变，两边对不上。
 *
 * ⇒ 在生成清单**之前**查一下本地 tag：`v<version>` 已经存在就红着脸退出。
 *    为什么用本地 tag 当判据：发版流程的最后一步就是
 *    `git tag -a v<version>`（本脚本自己打印的那两条命令），所以它是最可靠的信号，
 *    而且**只用 fs 读 .git**，不需要起 git 子进程。
 *
 * ⚠️ 确实要重发同一个版本（上一次传坏了）：加 `--force` 跳过这道闸。
 */
function tagExistsLocally(v) {
  const name = 'v' + v;
  if (fs.existsSync(path.join(ROOT, '.git', 'refs', 'tags', name))) return true;
  try {
    const packed = fs.readFileSync(path.join(ROOT, '.git', 'packed-refs'), 'utf8');
    return packed.split('\n').some((l) => l.trim().endsWith('refs/tags/' + name));
  } catch {
    return false;
  }
}
if (!process.argv.includes('--force') && tagExistsLocally(version)) {
  console.error(
    `\n✗ v${version} 这个版本**已经发布过**了（本地有 tag v${version}）。\n` +
      `  同一个版本号再发一次，装了它的机器比版本号时会判「已是最新」，永远收不到这次的内容。\n\n` +
      `  正确做法：把 package.json 的 version 改成新版本（比如 ${version.split('.').slice(0, 2).join('.')}.` +
      `${Number(version.split('.')[2] || 0) + 1}），再跑一次 npm run dist 和本命令。\n` +
      `  确实要重发同一版：加 --force。\n`,
  );
  process.exit(1);
}

const buf = fs.readFileSync(exe)
const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
const size = buf.length

/* 附件名里**不能有空格**：更新器用 URL 拼下载地址，空格必须转义，
   而转义写错就是 404。安装包本名带空格（"MorningBrief Setup 0.1.0.exe"），
   所以这里另存一份不带空格的文件名，用它当 release 附件。
   ⚠️ 两份内容必须一模一样 —— 所以是复制，不是重新打包。 */
const assetName = `${pkg.build.productName}-Setup-${version}.exe`
const asset = path.join(RELEASE, assetName)
fs.copyFileSync(exe, asset)

/* 附件名按 GitHub 的规矩做百分号编码后拼进 URL */
const url = `https://github.com/LiujYi0425/morning-brief/releases/download/v${version}/` +
  encodeURIComponent(assetName)

const notesFile = path.join(ROOT, '.git', 'release-notes.md')
let notes = ''
try {
  notes = fs.readFileSync(notesFile, 'utf8')
} catch {
  notes = `晨报机 ${version}`
}

const manifest = {
  version,
  releasedAt: new Date().toISOString(),
  url,
  sha256,
  size,
  /* 低于这个版本不能直接升（改了数据结构时才用），留空 = 任何版本都能升 */
  minFrom: '',
  notes: notes.slice(0, 4000),
}
const manifestFile = path.join(RELEASE, 'latest.json')
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log('发布清单已生成：')
console.log('  release/latest.json')
console.log(`    version = ${version}`)
console.log(`    sha256  = ${sha256}`)
console.log(`    size    = ${size}  (${(size / 1048576).toFixed(1)} MB)`)
console.log(`    url     = ${url}`)
console.log(`  release/${assetName}`)
console.log('')
console.log('核对：附件与安装包必须逐字节相同 ——',
  fs.readFileSync(asset).equals(buf) ? '✓ 相同' : '✗✗ 不同！')
console.log('')
console.log('接下来发布（需要已 gh auth login）：')
console.log('')
console.log(`  git tag -a v${version} -m "v${version}" && git push origin main --tags`)
console.log(`  gh release create v${version} \\`)
console.log(`    "release/${assetName}" \\`)
console.log(`    "release/latest.json" \\`)
console.log(`    --title "晨报机 v${version}" \\`)
console.log(`    --notes-file .git/release-notes.md`)
console.log('')
console.log('发布之后，已装好的旧版本下一次启动就会看到这个版本。')
