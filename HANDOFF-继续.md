# 交接文档 · 「继续」工作单 —— 首次运行引导窗（欢迎窗）· 2026-10-01

> **怎么用**：新开一个对话，说一句「**继续**」。
> `AGENTS.md` §0 会指向本文，本文是**自包含**的：做到哪一步了、还剩哪几件、
> 怎么验收、哪些坑已经踩过。**读完之前不要改任何文件。**
>
> 上一轮的交接在 `HANDOFF-考裁判.md`（"门禁自身"的修复，已收尾）。
> 本文件与 `AGENTS.md` 都不进文档治理体系（无 frontmatter、不进 §6 同步矩阵）。

---

## 0. 一句话状态

功能**已全部落地并提交**（`65b9ed0`），**A1/A2 真机已验**，并在真机上抓到一处自检缺陷、已修并提交
（`30a928d`）；`npm test` = **245 / 69 / 37 全绿**；
`npm run check` **现在是红的 —— 而且这是预期的**（asar 里还是 0.1.21 那一版源码）。
剩下：**A3–A5 真机收尾（含一处要用户拍板的版式问题）→ B 文档回填 → C 升版打包发布**。

---

## 1. 用户要的是什么（原话与拍板）

- 原话：「我感觉，让陌生人装上第一件事就是弹窗让他们填写 API Key 更好」。
- 随后在给的选项里拍板两件事：**形态 = 另开一个真·弹窗小窗**（不是在卡片里再叠一层）；
  **频率 = 只弹第一次**。
- **为什么值得做**：现在首启只有「卡片置顶 6 秒 ＋ 一次托盘气泡」。陌生人装完看到的是一张卡片，
  卡片上写着「未配置 API Key」—— 但**没有任何地方告诉他去哪儿配**；
  而且那张卡片是 `HWND_BOTTOM` ＋ `WS_EX_NOACTIVATE`：**永远不抢焦点、也没有关闭按钮**，
  它当不了"请你做一件事"的首启提示。

---

## 2. 已做完的（代码 ＋ 判据：主体 `65b9ed0`，真机抓到的修复 `30a928d`）

| 文件 | 这一轮做了什么 |
|---|---|
| `src/renderer/welcome.html` ★新增 | 引导窗 DOM。CSP 与 `card.html` **一字不差**；**只一个 classic script**；标题栏（可拖）＋ ✕、`#pickCount`、`#applyRow`（"去拿 Key"）、`#keyInput`(password)、`#modeSel`(memory/plaintext)、两套脚注：`#footA`（保存／先不配）与 `#footB`（生成／测试／完成） |
| `src/renderer/welcome.js` ★新增 | 全部逻辑。`boot()` 读 `ai.getConfig()` ＋ `ai.keyStatus()`；`save()` **只读一次** `input.value`、成功即清空、失败保留；`#btnApply` → `openItem(null, applyUrl)`；Esc/✕/先不配/完成**全部**走唯一的 `leave()`；自检 `window.MB_WELCOME_CHECK`（**按渲染结果判可见性**，不按属性判） |
| `src/renderer/styles/welcome.css` ★新增 | `.sheet{position:absolute;inset:var(--win-pad)}`；`[hidden]{display:none!important}`（**独立文档没有 card.css 的兜底，必须自己再说一遍**） |
| `src/main/window.js:178` | `export const WELCOME_SIZE = { w: 460, h: 420 }`（内容区 420×380 ＋ 2×`WIN_PAD`，两个维度都是偶数） |
| `src/main/window.js:196` | `export function createWelcomeWindow()` —— 居中在 24% 高度、`alwaysOnTop`、`skipTaskbar:false`、`resizable:false`、`ready-to-show` 后 `show()` ＋ `focus()`（**抢焦点**） |
| `src/main/index.js:1003-1060` | `maybeShowWelcome()`：五种结局 `'shown' / 'already-open' / 'done-before' / 'already-configured' / 'failed'` |
| `src/main/index.js:1068` | 模块级 `let welcomeWin = null;`；`:1034` 的 `once('closed')` 置回 `null`（幂等：不会出现第二扇） |
| `src/main/index.js:2007` | 调用点 `setTimeout(() => mark('welcome', maybeShowWelcome()), 1200)` —— 在 `mark('ipc-registered')` **之后** |
| `tools/check-dist.mjs` | B3 必备文件清单加了三个 welcome 文件（**漏了 = 打包后一启动就失败**） |
| `tools/test-all.mjs:5771` | 【第二十二层】＋4 条（功能提交 `65b9ed0` 时的总数：**243**） |
| `tools/test-all.mjs:5877` | 【第二十三层】＋2 条：**接续契约**（`AGENTS.md` §0 必须点着 `HANDOFF-继续.md`；`AGENTS.md` 必须被文档治理豁免、且没被 `.gitignore` 吃掉）→ 总数 **245** |
| `tools/test-interaction.mjs:1765` | 【第一层之五】＋9 条 → 总数 **69**（静态断言：CSP 一字不差、id 双向对上、Key 明文边界、关闭路径唯一、窗口参数、禁止 `applyBottomLevel`；**第 9 条**见下一行） |
| `src/renderer/welcome.js:233-245` | **自检判"藏没藏"漏了祖先**（`facts()` 只看元素自己的 computed display）⇒ 真机上把"已经藏好了"的 `#btnGen` 报成"还在显示"。**修复 `30a928d`**：加 `el.getClientRects().length === 0`；判据 = `tools/test-interaction.mjs` 第 9 条（`facts()` 函数体必须含 `getClientRects`/`offsetParent`） |

---

## 3. 还剩什么（做完一格勾一格）

### A. 真机验收 —— ⚠️ 先读这段，否则你会以为"功能没做"

**在这台机器上直接开是看不到这扇窗的**：判断顺序是
`already-open` → `done-before` → **「已经有 Key」** → 才轮到"弹"，
而这台机器的 `%APPDATA%\<应用名>\keystore.bin` 里**已经有 Key** ⇒ 走 `already-configured`：
**写个标记就走，不弹**。这是**刻意的**（不打扰老用户），不是 bug。

⇒ 要看到它，必须同时给两样"干净身份"（缺一个都会出现"该弹却没弹"）：

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 否则 Electron 静默退化成纯 Node
$ud   = Join-Path $env:TEMP 'mb-welcome-ud'      # keystore.bin 住这儿（--user-data-dir）
$data = Join-Path $env:TEMP 'mb-welcome-data'    # brief.db 住这儿（MB_DATA_DIR）
Remove-Item -Recurse -Force $ud,$data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ud,$data | Out-Null
$env:MB_DATA_DIR = $data
$exe = (Resolve-Path 'node_modules\electron\dist\electron.exe').Path
# ★ 用 Start-Process **脱离**当前 shell —— 直接 `& electron.exe` 会被作业/管道的生命周期牵连
#   （后台作业一收，Electron 跟着消失，看起来像"应用自己退了"；我踩过一次）
$p = Start-Process -FilePath $exe -ArgumentList '.', "--user-data-dir=$ud" `
       -WorkingDirectory (Get-Location).Path -PassThru `
       -RedirectStandardOutput (Join-Path $env:TEMP 'mb-probe.log')
Start-Sleep -Seconds 15
if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }        # ★ 收尾只按 Id 杀
# ★ 兜底清扫**必须限定进程名**：只按 CommandLine 匹配，会把你**自己这条 pwsh**
#   （命令行里就含这个标记）和 DSH 一起杀掉 —— 我踩过，代价是一次 job runner 崩掉
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like '*mb-welcome-ud*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
```

- ⚠️ `--user-data-dir` 只管 `userData`（**keystore 在那儿**）；**开发态的数据目录是 `<项目>\data`**
  （`src/shared/runtime-state.js:83`），要用 `MB_DATA_DIR` 单独覆盖。两个都要给。
- ⚠️ `npm start`（`tools/launch.mjs:63` 的 `spawn(EXE, [ROOT])`）**不透传额外命令行参数**
  ⇒ 上面直接调 `electron.exe`。（顺手给 `launch.mjs` 加上参数透传也可以，但那要带一条判据。）
- ⚠️ **截图要按 DPI 换算**：PowerShell 是 **DPI-unaware**，`CopyFromScreen` 抓的是**物理**像素，
  而 `Screen.Bounds` 给的是**虚拟**坐标 ⇒ 150% 缩放下按虚拟尺寸抓会**少截右下约 1/3**
  （我第一张整屏图就是这样，看着像"窗口被切了"，其实是图被切了）。
  物理分辨率取 `Get-CimInstance Win32_VideoController` 的
  `CurrentHorizontalResolution`，比例 = 物理 ÷ 虚拟，抓完按比例裁窗口。

**A1 干净首启** ✅ **已验（2026-10-01，本会话）** —— 窗自己弹出来、在最上面、拿到焦点。证据：
- `[welcome] 首次运行：弹出「配一个 API Key」窗口（只弹这一次，关掉不影响使用）`
- 窗口 HWND（`EnumWindows` 抓的）：标题 **`晨报机 · 第一次使用`**，**460×420 @ (744,174)**
  —— 尺寸与 `WELCOME_SIZE` 声明**逐字相符**（屏 2560×1600 @150%，虚拟坐标 1707×1067）。
- 自检 **9 条 verdict 零 ✗**：`✔ 底栏在面板内（346–399，面板 20–400）`、
  `✔ 面板按 --win-pad 居中（四周留白 20）`、`✔ Key 输入框=shown(w=379,y=358)`、
  `✔ 保存 Key=shown(w=80,y=357)`、`✔ 先不配，先看新闻=shown(w=133,y=357)`、
  `· 生成今天的精选（保存成功后才该出现）=hidden`、`· 存法选择=hidden`。
- `meta.welcome_done = 1`（`node _scan-meta.mjs "<data>\brief.db" welcome`）。
- 截图：`%TEMP%\mb-welcome-window3.png`（窗口裁剪）／`mb-shot-08s.png`（整屏）。
- ⚠️ 这一次顺带抓到并修掉一处真缺陷（**自检把被父行藏起来的按钮报成"还在显示"**）
  ⇒ 见 §2 末两行与提交 `30a928d`。
**A2 「只弹第一次」** ✅ **已验（走"标记幂等"这条路，没点按钮）**：同一 `$ud` / `$data` 再起一次 ⇒
`[welcome]` 行数 **0**、没有自检、卡片走「常规启动，置顶 1500ms」（首次是 6000ms）。
⚠️ **`#btnSkip → leave() → window.close()` 这条按钮路径没有真点过**：它目前只有源码断言守着。
人点一下就行（想自动化就 Pick 那个 HWND 再点）。
**A3 存 Key**（**待做，且只有你能做**）：填一把**真 Key** → 保存 →「测试」→「完成」
⇒ `$ud\keystore.bin` 必须出现，重开不弹，卡片上 AI 总览能用。**我不动你的真 Key。**
**A4 幂等/单实例**（待做）：运行中再起一次（或双击第二次）不许出现第二扇窗。
**A5 打包版首启**：见 §C 第 6 条。

> ⚠️ **一处需要你拍板的版式问题（真机截图看出来的）**
> 正文 `scrollH=410 > clientH=287` ⇒ **首屏看不到 `API Key` 输入框**
> （它的 `top=358` 落在底栏 `346–399` 的后面），得点一下滚动条才露出来。
> 而自检那条 `✔ Key 输入框=shown` **只判"有没有生成盒子"，不判"在不在视口内"**
> —— 别把它读成"用户看得见"（这也说明"只弹一次"的窗，**首屏该看见的东西要人眼过一遍**）。
> 两条路：
> **①** `WELCOME_SIZE` 高 `420 → 560`（首屏不用滚；改一个数，`test-interaction` 里那几条
> 尺寸/parity 判据跟着改）；
> **②** 压短「三步拿到 Key」或把输入框挪到正文最前面（动文案 ⇒ 属**设计**改动，
> 按 R-D04 该由 `agents/design-critic.md` / 用户拍板）。
> **没拍板之前不要自己改文案。**

### B. 文档回填（R-D03 / R-D05）

1. `项目计划工程书.md`（现 **1.6.0**）四处：
   - §5.2c **:430** 那行 `239 ＋ 60 ＋ 37` ⇒ **`245 ＋ 69 ＋ 37`**；
   - §5.3 **:465**（C1 / C2 行）同上；
   - §10 项目地图 **:1082**（`test-all.mjs ← … 239 条断言`）⇒ **245**；
   - §7 变更记录：在 **:601** 那一行**上面**加新行。
     ⚠️ **这一轮是实质变更**（产品界面多了一屏、设计口径变了、多了一个窗口组件）
     ⇒ 按 **R-D05 必须升版本号**（`1.6.0 → 1.7.0`），级别照既有行的 P2 格式写。
     升版后**必须**跑 `node tools/sync-check.mjs`，看它点出谁还没核对
     （下游很可能含 `docs/02-设计研究与页面架构规范.md` —— 多了"欢迎窗"这个组件；
     与 `docs/03-工程架构文档.md` —— 多了一个窗口 ＋ 三个文件），逐个核对并写留痕，
     **留痕里要出现确切版本号字面量**（只写"已核对"不算）。
2. `README.md`（不进治理体系）：§「装到别人机器上（分发须知）」的
   「对方第一次打开会发生什么」（**:188-190**）与「三件要提前告诉对方的事」第 2 条（**:196-198**）——
   补一句：**第一次打开会弹一屏「配一个 API Key」的小窗，只弹这一次，点「先不配」以后不再出现**。
3. `HANDOFF-考裁判.md` §8 分发前审计（**:375** 起）：追加"首次运行引导窗"这一条
   （该文件不进治理体系，不必升版）。
4. ⚠️ 文档里写的数字**必须是本轮实跑的输出**，不许照抄本文。

### C. 升版 → 打包 → 发布

1. `package.json` `0.1.21` → **`0.1.22`**。
2. `npm test`（245 / 69 / 37）＋ `node tools/sync-check.mjs` 绿。
3. `npm run dist` —— 第 **3/3** 步就是隐私核对；`npm run check` 必须**全绿**
   （asar 新鲜度 ＋ 白名单严格相等，现在红的就是这两项）。
4. `npm run release` → `git tag v0.1.22` → `gh release create`（附件口径与 0.1.21 一致）。
5. 发布后核对：稳定地址
   `https://github.com/LiujYi0425/morning-brief/releases/latest/download/latest.json`
   取回的文件与本地 `release/latest.json` **逐字节相同**。
6. **最要紧的一条**：用**打包版**确认欢迎窗真能弹 —— 开发态能弹**不等于**打包态能弹，
   `build.files` 白名单漏文件正是这类事故的经典形态（`tools/check-dist.mjs` 的 B3 就是为它准备的）。
7. 留一份"空 `userData` 的打包版首启"证据（截图/读数）→ 回填 §7 记账行。

---

## 4. 验收标准（DoD）

- [ ] A1–A4 都有**可复现的命令 ＋ 读数/截图**（A5 可选；没做的部分照实写"没验"）
- [ ] `npm test` 245 / 69 / 37 全绿；`node tools/sync-check.mjs` 绿；`npm run check` 绿
- [ ] 文档四处数字与实跑一致；§7 有留痕且含**确切版本号**；被点名的下游都核对了
- [ ] **打包版**真机弹得出来（截图存档）
- [ ] v0.1.22 已发布，稳定地址的 `latest.json` 与本地逐字节核对过

---

## 5. 关键决策（别在下一轮"顺手统一"掉）

- **欢迎窗故意反着卡片窗的三条约定**：`alwaysOnTop: true`、`skipTaskbar: false`、`show()` 抢焦点。
  理由写在 `src/main/window.js:196` 的注释里：卡片窗是 `HWND_BOTTOM` ＋ `WS_EX_NOACTIVATE`，
  永远不抢焦点、也没有关闭按钮 —— 它当不了首启提示。
  ⚠️ 考裁判里有断言禁止给欢迎窗套 `applyBottomLevel()`。
- **`welcome_done` 写在窗口创建之后**（`src/main/index.js:1055`）：断电、被强杀也不会重复弹。
- **「已经有 Key」的老用户不弹**、只写标记（`:1028`）。
- **一个 IPC 通道都没加**：全部走既有的 `ai.keyStatus / setKey / testKey / generate / getConfig`
  ＋ `openItem` ＋ `log`；也**没有**"把 Key 读回来"的通道（R-E05）。Key 绝不进日志/DOM 文本。
- **「只弹第一次」= 不做**"设置里再叫出来"的入口（真要做，等用户提）。
- 这 8 条判据是**静态**断言（读源码 ＋ 跨文件比对）；"到底长什么样"交给**真机自检**
  （`welcome.js` 的 `MB_WELCOME_CHECK`，与卡片 2026-09-30 那轮同一套：**按渲染结果判，不按属性判**）。

---

## 6. 环境坑（本轮真正踩到的 ＋ 老坑）

- **注释里的正则**：`/\/\/[^\n]*/` 写在块注释里，里面的 `*/` 会**提前关掉块注释** ⇒
  `node --check` 报 `SyntaxError: Invalid or unexpected token`（`tools/test-interaction.mjs` 中过招）。
- **负向断言必须先剥注释**：这一轮四条"源码里不许出现 X"的断言同时红，
  根因是**自己写的注释**里就有 X。test-interaction 里已有 `stripJs` / `stripHtml` / `stripCss` 三个帮手 ＋ `W_HTML_C` / `W_JS_C` / `W_CSS_C`。
- PowerShell 读 UTF-8 文件会乱码 ⇒ 判内容用 read / grep 工具。
- 提交信息别用带换行的 `-m`（PS 会搅烂）：写 `_commit-msg.txt` 再 `git commit -F`。
- **变异体分片**：每片要有**自己的工程副本** ＋ **自己的 `$env:TMP`/`$env:TEMP`**（共用会三连坏）。
- `npm run dist` 报 `EPERM ... release\win-unpacked\...`：只杀 `ExecutablePath` 匹配
  `*release\win-unpacked*` 的进程，**别碰用户装好的那份**。

---

## 7. 锚点速查

```powershell
cd /d D:\morning-brief
git log --oneline -5        # 顶部应当是 65b9ed0（欢迎窗）＋ 一条接续脚手架提交
git status --short          # 期望干净
npm test                    # 245 / 69 / 37
node tools/sync-check.mjs   # 文档治理
npm run check               # 现在红 4 项：asar 陈旧 ＋ 缺 3 个 welcome 文件（重打包后绿）
```

- 欢迎窗逻辑：`src/renderer/welcome.js`；DOM：`src/renderer/welcome.html`；样式：`src/renderer/styles/welcome.css`
- 窗口：`src/main/window.js:178`（尺寸）／`:196`（`createWelcomeWindow`）
- 弹出时机与五种结局：`src/main/index.js:1003-1060`；调用点 `:2007`
- 判据：`tools/test-all.mjs:5771`（第二十二层）／`tools/test-interaction.mjs:1765`（第一层之五）
- 打包白名单与必备文件：`package.json` 的 `build.files`／`tools/check-dist.mjs`
