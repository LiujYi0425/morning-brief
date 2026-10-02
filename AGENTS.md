# AGENTS.md · 晨报机（MorningBrief）—— 给 AI 助手的开工须知

> 这是本仓库给 AI 助手的**唯一入口**：只写「每一次开工都必须知道」的事。
> 具体某一轮要做什么，在交接文档 `HANDOFF-*.md` 里，**不在本文**。
> （本项目还有一整套文档治理：规则见 `项目规则.md`，进度见 `项目计划工程书.md`。）

---

## 0. 用户说「继续」→ 第一件事

1. **读根目录 `HANDOFF-继续.md`** —— 当前这一轮的**自包含**工作单：
   做到哪一步了、还剩哪几件、怎么验收、哪些坑已经踩过。
   **读完之前不要改任何文件。**
2. 没有这个文件时：`git log --oneline -8`，找最近一份 `HANDOFF-*.md`，读它的
   「下一步」一节，从那里接。
3. 然后跑基线，**先确认环境是好的**：`git status --short` → `npm test`。
   基线不绿就先修基线，**别叠新活**。

---

## 1. 工程与门禁（三道，全部离线：不联网、不花钱）

工程根 `D:\morning-brief`：Electron 44 ＋ Node 24，`type: module`，
**零运行时依赖**，渲染层是 CSP `default-src 'none'` 下的 **classic script**。

| 命令 | 考什么 | 基线（2026-10-01） |
|---|---|---|
| `npm test` | 「改坏了会不会被抓住」：三套离线考裁判 | test-all **245** ＋ test-interaction **69** ＋ test-ai-brief **37** |
| `npm run test:mutants` | 83 个变异体逐个注入坏实现，看门禁红不红 | **83/83 落网**；全量约一小时 ⇒ 用分片跑法（§4） |
| `npm run check` | 「发出去的东西干不干净」：`sync-check`（文档治理）＋ `check-dist`（隐私边界 ＋ asar 白名单） | 未重打包时**按设计是红的**（asar 里还是上一版源码） |

⚠️ 前两道与第三道是**互相独立**的门，**都要跑**。

---

## 2. 硬约束（踩了就是事故）

- **不许加运行时依赖**，不许引入打包/构建步骤；渲染层不许用 `type="module"`（会被 CSP 拦）。
- **Key 边界**：Key 只进 `userData/keystore.bin`（加密存储）；**不许**出现在日志、DOM 文本、
  错误信息、提交信息里；**没有**「把 Key 读回来」的 IPC 通道（R-E05）。
  新增 IPC 通道必须同步 `src/shared/ipc-channels.js`（考裁判里有「两份通道表逐字一致」的断言）。
- **数据不出本机**：网络只用于抓 RSS 与查更新；不许加任何上报、统计、埋点。
- 动了 `src/`，`release/` 里的 asar 就过期了 ⇒ 要发布**必须**先 `npm run dist`
  （它第 3/3 步就是隐私核对，**退出码由核对结果决定**）。
- 提交信息**不要**用带换行的 `-m`（PowerShell 会把中文多行搅烂）：
  写进 `_commit-msg.txt`（已在 `.gitignore` 登记）再 `git commit -F _commit-msg.txt`。

---

## 3. 文档治理（改任何文档前先看 `项目规则.md` 的 D 节）

- **R-D03**：上游升版 → 下游必须重新核对，并在自己的 `## 变更记录` 写一行留痕，
  **留痕里必须出现确切版本号字面量** `上游DOC-ID@x.y.z`（只写「已核对」＝没写）。
- **R-D05**：**只**改 `depends_on`、回填进度数字/同步矩阵、补留痕 ＝ **记账 ⇒ 不升版本号**；
  规则、契约、职责边界、设计口径、代码行为变了 ＝ **实质 ⇒ 必须升版本号**。
  **不许把实质改动伪装成记账**（那会让下游以为上游没变）。
- 入口：`node tools/sync-check.mjs`（绿 ＝ 9 份文档 ＋ 4 个代理定义全过）。
- **不进治理体系**的文件（没有 frontmatter、不进 §6 同步矩阵）：
  `README.md`、`AGENTS.md`、`HANDOFF*`、`_` 开头的模板。

---

## 4. 环境坑（本项目实打实踩过的，别重复踩）

- 本机 shell 里可能带着 `ELECTRON_RUN_AS_NODE=1` ⇒ Electron 会退化成纯 Node。
  要真跑 Electron：先 `Remove-Item env:ELECTRON_RUN_AS_NODE`。
- 改 `$env:APPDATA` **不会**改变 Electron 的 `userData`。要干净的「首次运行」环境请用
  `npx electron . --user-data-dir=<一个空目录>`。
- 主进程里**静态** `import { app } from 'electron'` 会抛
  `does not provide an export named 'app'` ⇒ 用动态 `await import('electron')`。
- PowerShell 读 UTF-8 文件会乱码 ⇒ 判内容用 read/grep 工具，别用 `cat` / `Get-Content`。
- **变异体分片跑法**：每个分片必须有**自己的工程副本** ＋ **自己的 `$env:TMP`/`$env:TEMP`**。
  共用一份副本会「漏网 ＋ 注入失败 ＋ 没还原干净」三连。
- `npm run dist` 报 `EPERM ... release\win-unpacked\...` ＝ 有测试实例正跑在 `release\win-unpacked` 里；
  **只杀** `ExecutablePath` 匹配 `*release\win-unpacked*` 的进程，别碰用户装好的那份。
- **GUI 探针别挂在后台作业里前台 `&` 跑**：作业一收尾，Electron 会跟着一起消失
  （看着像「应用自己退了」，其实是被作业生命周期带走的）。用 `Start-Process` 脱离当前 shell，
  收尾只按 `$p.Id` 杀。
- **按命令行清扫进程必须限定进程名**：
  `Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*<标记>*' }`。
  只按 `CommandLine` 匹配会把**你自己这条 pwsh**（命令行里就含那个标记）连同 DSH 一起杀掉。
- **PowerShell 截图是"物理像素"**（DPI-unaware）：`CopyFromScreen` 抓的是物理分辨率，
  而 `Screen.Bounds` 给的是**虚拟**坐标 ⇒ 150% 缩放下只按虚拟尺寸抓，会少截右下约 1/3
  （看着像「窗口被切了一半」，其实是被截图尺寸切了）。比例 = 物理 ÷ 虚拟
  （取 `Win32_VideoController.CurrentHorizontalResolution`）。`New-Object System.Drawing.Bitmap`
  的两个尺寸参数要 `[int]` 强转，否则报「参数无效」。

---

## 5. 交付节奏（一轮改动的标准路径）

真机验证 → `npm test` → `npm run check` → 升 `package.json` 版本号 → 文档留痕（R-D03/D05）
→ `npm run dist`（3/3 隐私核对必须绿）→ `npm run release` → `git tag vX.Y.Z` ＋ `gh release create`
→ **发布后核对**：稳定地址
`https://github.com/LiujYi0425/morning-brief/releases/latest/download/latest.json`
取回的文件与本地 `release/latest.json` **逐字节相同**。

**证据要求**：说「验过了」必须带**可复现的命令/读数**；没验的部分照实写「没验」，
别把「代码看起来对」写成「验证通过」。
