# 交接文档 · 考裁判（离线门禁）的修复 —— 2026-09-30

> **怎么用这份文件**：把它发给本项目里的新对话，说
> 「读 `D:\morning-brief\HANDOFF-考裁判.md`，按第 5 节继续」。
> 本文档是**自包含**的：这一轮审出了什么、修了什么、**怎么证的**、哪些没证、下一步。
>
> ⚠️ 最要紧的一句：这一轮修的东西**一件都不在产品界面上** ——
> 它们全在"**改坏了会不会被发现**"那一层。所以它的证据形态也不一样：
> 不是"功能能用了"，而是"**故意改坏一处，门禁真的红了**"。

---

## 0. 触发：一次针对"门禁自己"的审查（审查员，2026-09-30）

被审的不是产品代码，是**离线考裁判本身**。审出来的问题形状高度一致：

> **闸门坏了，而它读起来像"全都通过了"。**

这正是本项目记录过的那条教训（`HANDOFF-阶段B.md` 阶段 D 续第 4 节：
"闸门本身坏了，看起来和「全都通过」一样安静"）。这一轮又抓到五处，
其中两处**在审查之前一直是绿的**；另外两处是**修的过程里顺带抓出来的**：
② 的直接产物（两条 `expect` 指错了断言，见 2.⑥）与收尾时发现的
`%TEMP%` 漏了 8 GB（见 2.⑦）。

---

## 1. 开工先跑什么（确认状态）

```
cd /d D:\morning-brief
git log --oneline -3        # 最新应当是：考裁判修复（第二步）/（第二步·补）/ 本交接文档
git status --short          # 期望：干净（_commit-msg.txt 是 gitignore 的提交信息草稿）
npm test                    # test-all 232 + test-interaction 60 + test-ai-brief 37
npm run check               # sync-check + dist:check（隐私边界），必须绿
npm run test:mutants        # 83 个变异体 —— ⚠️ 全量约一小时，先看第 3 节的"分片跑法"
```

`npm test` 与 `npm run check` 是**两道独立**的门（前者考"改坏了会被抓住"，
后者考"发出去的东西干净"），两道都要跑。

---

## 2. 这一轮修的东西（症状 → 根因 → 修法 → 守它的东西）

### ① 变异测试被打断，会把变异体留在工作树里

- **症状**：Ctrl+C / 会话被掐之后，`src/` 下留着一个被改坏的函数，
  而 `git status` 只多一个 `M` —— **看起来像你自己的改动**。
- **根因**：`spawnSync` 是**阻塞**的。它跑着的那四十多秒里 Node 的事件循环不转，
  signal 处理函数一行都执行不到；而 SIGINT 的默认动作就是当场终止
  ⇒ `finally` 也不跑。
- **这不是假想**：`1a988db` 那次真的留下了 `hasMore = true`，而**打包用的正是那份源码**。
- **修法**：子进程换成**异步** spawn（事件循环活着）＋ 装
  `SIGINT / SIGTERM / SIGHUP`：先杀子进程 → 还原 → 清哨兵 → 以 130 退出。
  **哨兵保留** —— 它挡的是 SIGKILL / 断电这种连处理函数都跑不了的死法。
- **守它的东西**：`tools/test-all.mjs` 里一条源码断言
  （不许再用 `spawnSync(`、"杀子进程 → 还原 → 退出"的顺序、`inFlight` 登记必须先于写坏源码、
  `finally` 仍要还原、超时闸还在）。
- ⚠️ **照实写的一条平台事实**：Windows 上**只有真正的控制台 Ctrl+C** 会触发它
  （`process.kill(pid,'SIGTERM')` 在 Windows 上是 TerminateProcess，不可捕获）
  ⇒ 这条路径**机器复现不了**，只能由源码断言守着，不是由一次真跑证明的。

### ② 判据"失败的**正是**那条断言"只认一种输出格式 ⇒ 8 个变异体被误报成"漏网"

- **症状**：`npm run test:mutants` 里，指向 `tools/test-ai-brief.mjs` 的那些变异体
  全部报「✗ 漏网」，而它们的失败明细里**明明写着** `expect` 那串字。
- **根因**：两份考裁判的输出格式不一样 ——
  `test-all.mjs` 打 `  ✗ 名字`（两格缩进）+ 紧跟的缩进明细；
  `test-ai-brief.mjs` 打 `✗ 名字 —— 明细`（**顶格**、一行到底）。
  而上一步收紧判据时写的解析只认前者。
- **为什么这条最值得记**：它把"闸门坏了"伪装成"**断言不够**" ——
  你会去改本来正确的断言，而不是去修解析。
- **修法**：解析搬到 `tools/lib/fail-blocks.mjs`（两种格式一起认），
  `test-mutants.mjs` 只调 `failureMentions()`。
- **守它的东西**：`test-all.mjs` 里真跑三条断言 ——
  两种格式各解析一次 ＋ **"通过断言的文本不许参与匹配"**（这是整套判据的命门：
  83 条 `expect` 里有 31 条是某条 `✓` 的子串）。
- **实测**：把解析修好之后，那 8 条（`test-ai-brief` 那一组）从 8 条"漏网"
  → **8 条全部落网**。

### ③ 打包成功之后没人跑隐私边界核对（它此前只是一句提醒）

- **症状**：`npm run dist` 成功时只打印一句"下一步务必跑 `npm run dist:check`"。
- **为什么是缺陷**：`check-dist` 是**唯一的**隐私边界闸门
  （asar 不是加密归档 —— 一条 `asar extract` 就把 `data/` 里我的真实简报全取出来了），
  而"没人跑的门禁"与"没有门禁"在交付上是一回事。
  打包成功那一刻，正是最容易顺手把 exe 发出去的时刻。
- **修法**：`1/3 图标 → 2/3 打包 → 3/3 核对`，**退出码由核对结果决定**；
  打包**失败**时不跑核对（那时 `release/` 里躺的是上一次的产物，跑它只会给假绿）。
- **守它的东西**：`test-all` 里一条断言（真的调了 check-dist / `process.exit(check)` /
  且调用点在"打包失败"那条分支之前）。
- **怎么证的**：先在临时副本里放一个**假的** electron-builder，跑了两个用例
  （见第 3 节）——证明"3/3 真的会跑、退出码听核对的、失败时不跑"；
  **后来发 0.1.18 时真跑了一次**：`✓ 产物核对通过 —— 隐私边界干净，可以发出去了`，
  即这条链在真打包上也成立。

### ④ 真机自检按 `hidden` 属性判"藏没藏" ⇒ 自检跟着一起撒谎（审查 #3 的另一半）

- **症状**：`d88e202` 修掉了"`[hidden]` 被 `display:flex` 顶回来"这个真机 bug
  （「全部」下「编辑」「精选」还在显示、点下去没反应），
  **但自检的判据没跟着改**：它按 `el.hidden` 属性判 ⇒
  出事时它报 `hidden`，而用户眼里那个按钮就在屏幕上 ——
  **唯一的反馈通道给出的正好是相反的结论**（会把排查引去改本来正确的渲染逻辑）。
- **修法**：新增 `hiddenFacts()`（问 `getComputedStyle`）；
  `btnInfo` / `panelBox` 都按**渲染结果**判，并把"属性（模型的意图）"与
  "实际看不看得见"**分开报**；verdict 补上**反方向**：
  「该藏起来却还在显示（点了没反应）」；面板不一致时直接点出
  「查 card.css 那条 `[hidden]{display:none!important}` 还在不在」。
- **守它的东西**：`test-interaction` 两条 ——
  `card.css` 那条全局重置必须**恰好一条**且带 `!important`；
  `card.js` 里判"藏没藏"必须走 `getComputedStyle`（不许再出现 `n.hidden ? …`）。
- ⚠️ 离线装置（`tools/card-rig.mjs`）**没有 CSS**、也不跑 `domcheck` ⇒
  这一改动的效果只能在**真机**上看到 —— 已看到，见下。
- ✅ **真机证据**（2026-09-30 21:28，`node tools/service.mjs start` 之后的启动自检，
  `data/run.log`）：「全部」选中时 `buttons` 是
  `edit:"hidden(w=0,x=0,y=0)"`、`pick:"hidden(w=0,x=0,y=0)"` ——
  **真的 w=0**（不是"属性设了、元素还占着位置"），`expect.pick=false` 与之一致，
  全篇 verdict 里**没有** `该藏起来却还在显示` / `hidden 属性说…、实际却…` 这两条新判据。
  ⇒ ① `[hidden]` 那条 `!important` 在真机上确实生效；
    ② 自检与渲染结果一致（自检不再撒谎）。
- ★ **这次真机日志还抓出一个覆盖缺口**：自检的 `buttons` 里**只有 edit、没有 pick** ——
  而审查 #3 那个 bug 的两个按钮里**有一个正是「精选」**。
  ⇒ 已补 `pick: btnInfo('btnPick')`、`expect.pick`、两个方向的 verdict，
  并在 `test-interaction` 里加断言钉住"**出过事的那个元素必须在自检的覆盖范围内**"。
  （补完再重启一次，日志里就出现了 `精选=hidden(w=0,x=0,y=0)（应隐藏）`。）

### ⑤ 删掉 `test-all.mjs` 里 18 条"假变异体"（V1–V18）

- **症状**：`test-all` 的结论行写着「231 条断言全过，**18 个变异体全部落网**」。
- **为什么是假的**：那 18 条是"在用例里**手写一个坏实现**，再断言这个坏实现不满足某条性质"——
  改坏的是本地那个 `bad()`，**与 `src/` 下任何一行代码无关**。
  它证明的是"`assert` 会抛"，不是"这条断言抓得住 bug"。
  ⇒ 结论行里那个"18"**读起来像证据，其实不是证据**。
- **修法**：整表删除，连同只为它存在的 5 个同步夹具
  （`syncQuotaDb` / `syncDeleteCategory` / `syncSetCategorySources` /
  `syncSetCategorySourcesAppendOnly` / `syncDeleteCategoryWithItems`）；
  结论行不再报变异体数，改为指向**真的**变异测试
  （`npm run test:mutants`：83 条，真的改写 `src/` 下的源文件）。
- **口径**：本项目对"拆掉也没人发现的代码"一向是这么处理的 ——
  它不是防线，是噪音；而假的防线比没有防线更贵，因为它会**让人不去看**。

### ⑥ （② 的直接产物）全量复跑抓出**两条 `expect` 写错了**

收紧判据的目的从来不只是"修解析"，而是**让原先靠"无关失败蒙对"的那些露出来**。
全量 83 条复跑，露出来两条：

| 变异体 | 旧 `expect` | 实际红的是 | 为什么会蒙对 |
|---|---|---|---|
| 面板的源清单不再按类型过滤 | `面板的源清单只能列` | **源码**断言「main/index.js 里那段实现必须\*\*过滤\*\*源清单（副本对了不算数）」 | 行为断言的夹具里抄了一份 `impl` 副本，而变异体改的是 `main/index.js` ⇒ 副本没被改，那条永远是绿的 |
| 去掉"正文当标题"的兜底 | `不编造标题` | 「★★ 华尔街见闻：title 为空时用正文第一句…」 | 旧值只是失败断言**标签**里的一个词（"（不编造）"），字面对不上 |

⇒ 两条 `expect` 改成真正咬住它们的那条断言；单条复验都是
「✓ 落网 失败的正是那条断言=true」。
⚠️ 第一条还说明了一件事：**"行为断言 + 源码断言"这对组合里，expect 要指向真正会红的那一条**
（那条源码断言存在的理由正是"副本对了不算数"）。

### ⑦ （收尾时顺手发现的真缺陷）测试把临时目录漏在 `%TEMP%` 里 —— **7.3 万个 / 8 GB**

- **怎么发现的**：清理这一轮的分片副本时，顺手量了一下 `%TEMP%\mb-*` ——
  **73,175 个目录 / 8.0 GB**，全是测试留下的。
- **根因**：`tmpDbFile()`（`test-all.mjs`）每次 `mkdtempSync` 建一个目录、**从来不删**。
  平时一次 `npm test` 漏十几个；而变异测试一轮要跑几十次 test-all
  ⇒ **每跑一轮全量就再漏一千多个**（本会话的四轮分片跑了约 2500 次 test-all）。
- **为什么它跟门禁是一件事**：它不报错，只让**下一次测量**悄悄变差
  （`%TEMP%` 到十万级条目时，建目录本身都开始变慢）。
- **修法**：登记 + 退出时清理（`cleanupTmpDirs()` 放在**文件顶部** ——
  `tmpDbFile` 在它自己的定义之前就被调用了，`const` 不提升，本会话当场踩了一次
  "Cannot access 'TMP_DIRS' before initialization"）；
  `test-ai-brief.mjs` 那边是**另一种**失败：末尾本来就有一句 `rmSync`，
  但 SQLite 句柄还开着 ⇒ Windows 上删不动，所以要先 `close` 再删。
- **守它的东西**：`test-all` 新增一条断言（建一个目录 → 清理 → 断言它真的没了）。
- **实测**：跑完 `npm test`，`%TEMP%\mb-*` 目录数 **+0**（修之前每次 +15 左右）。

---

## 3. 数字与证据

| 门禁 | 本会话实测 |
|---|---|
| `npm test` · test-all | **232** 条断言（+4：中断还原、判据解析器、dist 串跑、临时目录清理） |
| `npm test` · test-interaction | **60** 条（+2：`[hidden]` 全局重置、自检按渲染结果判） |
| `npm test` · test-ai-brief | 37 条 |
| `npm run check` | 全绿（sync-check ＋ 隐私边界：asar 48 个文件 / 0.78 MB / 白名单严格相等） |
| 变异体 | **83 条全部落网 / 0 漏网**（4 分片并行跑，修订 `6cd3565`；跑法与原始收尾行见 3.2 / 3.3） |

⚠️ 上一轮（同样的 83 条、收紧判据后**第一次**全量跑）抓到的是 2 条"漏网"，
其中 0 条是真漏网 —— 见 2.⑥：两条都是 `expect` 指错了断言，改完即落网。
**"漏网"这个词本身在这里就是收获**：它就是用来找这种东西的。

### 3.1 dist 串跑的两个用例（假的 electron-builder，临时副本里跑）

```
用例 A：假 builder 退出 0 ⇒ 必须接着跑 3/3；核对失败（副本里没有 release/）
        ⇒ dist 的退出码 = 1（**听核对的**，不是 0）
用例 B：假 builder 退出 3 ⇒ 必须**不跑**核对；退出码 = 3
结论：✓ 两个用例都成立
```

### 3.2 全量变异体的**分片跑法**（本会话发明，实测把一小时压到十几分钟）

`tools/test-mutants.mjs` 会**就地改写** `src/` —— 所以分片跑法是：

1. **每个分片一份独立的工程副本**（排除 `node_modules`/`.git`/`release`/`data`），
2. 在**副本**的 runner 里打三行小补丁（只跑其中一片），
3. 每个分片给**各自的 `TMP`/`TEMP`**（⚠️ 见第 6 节第 3 条），并行跑，最后把结论并起来。

⚠️⚠️ **"一份副本跑四片"是错的 —— 2026-10-01 亲脚踩过一次**：
四个 runner 会同时在**同一批文件**上写变异体、又互相把对方写的还原掉；
而哨兵文件是按**工程路径**取名的 ⇒ 四片共用一份哨兵，启动时那句"陈旧哨兵还原"
会去覆盖别人**正在跑**的变异体。症状很有辨识度，**三条会同时冒出来**：

```
✗✗✗ src/xxx.js 没有还原干净，赶快修！      ← 别人的还原把我的变异体盖掉了
✗ 漏网  …（判据没抓到）                     ← 变异体根本不在场，测试当然过
✗ 变异体注入失败（找不到锚点）               ← 我读到的源码已经是别人改过的
```

⇒ 看到这三条一起出现，**先怀疑分片互相踩了**，别去改判据、也别怀疑断言。
（真工作树不受影响：变异体只跑在副本里，出事时 `git status` 仍然是空的 —— 这一点要当场核。）

那三行补丁（打在**每份副本**的 `tools/test-mutants.mjs` 上，**仓库里那份不要动**）：

```js
/* 把 `for (const m of MUTANTS) {` 换成下面这四行（按序号取模分片，比手写区间省事）：
   MB_SHARD=0..3 各跑一片。 */
let MB_I = -1
for (const m of MUTANTS) {
  MB_I += 1
  if (MB_I % 4 !== Number(process.env.MB_SHARD || 0)) continue
```

```powershell
# 四份独立副本（每片一份）+ 各自独立的临时目录
foreach ($i in 0..3) {
  robocopy D:\morning-brief "$env:TEMP\mb-mut-s$i" /E /XD node_modules .git release data .npm-cache build > $null
}
$env:MB_SHARD='0'; $env:TMP="$env:TEMP\mb-mut-s0\tmp0"; $env:TEMP=$env:TMP
cd "$env:TEMP\mb-mut-s0"; node tools/test-mutants.mjs
# 其余三片：目录换 s1/s2/s3、MB_SHARD 换 1/2/3
```

⚠️ 三点必须说清：
- 分片**只改"跑哪些"**（判据、还原、哨兵一字未改）；仓库里那份 runner **没有**分片代码。
- 分片只是**初筛**：真出现"漏网"要用**仓库里那份未打补丁的** runner 单独复验一条。
- `%TEMP%` 里那些"复制 + 打补丁"的小脚本**随时会被清掉**；
  照上面两步重建即可（约 40 行），别把 `%TEMP%` 里的路径写进任何文档当依赖。

### 3.3 分片结果的原始形态（可复核）

四个分片的收尾行（每个分片自己也会做"源码逐字节还原"的复检）：

```
s0（下标 [0:21)）：源码已还原且逐字节一致：✓（共 6 个文件） · 全部变异体落网 ✔（共 21 个）
s1（下标 [21:42)）：源码已还原且逐字节一致：✓（共 7 个文件） · 全部变异体落网 ✔（共 21 个）
s2（下标 [42:63)）：源码已还原且逐字节一致：✓（共 11 个文件） · 全部变异体落网 ✔（共 21 个）
s3（下标 [63:83)）：源码已还原且逐字节一致：✓（共 7 个文件） · 全部变异体落网 ✔（共 20 个）
```

四个分片进程的退出码都是 0（runner 只有在"全部落网 **且** 源码逐字节还原"时才给 0）。
`落网 / 漏网 / 无效 / 注入失败` 四项统计：**83 / 0 / 0 / 0**。

---

## 4. 没被证明的（照实写，别当成"都验过了"）

1. **Windows 上的 Ctrl+C 还原路径没法用机器复现**（见 2.① 的平台事实）。
   它由源码断言守着 —— 那是一条**结构性**证据，不是行为证据。
2. **`domcheck` 的改动跑不到离线装置**（card-rig 没有 CSS、也不跑 `domcheck`）
   ⇒ 只有源码断言 ＋ 真机自检（第 5 节第 1 条）。
3. ~~**`npm run dist` 的整条链没有真跑**~~ —— **后来真跑了**（见第 5 节第 2 条）：
   当时的判断是"0.1.17 已发布，本地再打一份同版本号的 exe 正是版本号守卫要防的事"，
   所以先用**假的** electron-builder 验接线（3.1）。
   等到**真要发下一版**时（版本号升到 0.1.18）才真跑 —— 3/3 那一步一次通过。
   ⚠️ 这条留着的价值是那个**判据**：`dist.mjs` 没有版本号守卫（只有 `release.mjs` 有），
   所以"想验证一下就顺手 dist 一次"在**已发布过的版本号**上是有害的。
4. 全量变异是**分片**跑的（3.2）；分片本身只影响"跑哪些"。

---

## 5. 下一步（按建议顺序）

1. ~~**真机上跑一次自检**~~ ✅ **本会话已做**（见 2.④ 的真机证据）：
   `node tools/service.mjs start` → 读 `data/run.log` 里的 `[domcheck]`。
   ⚠️ 还剩一件**只有你能做**的：选中一个**真实类型**（不是「全部」）时的自检 ——
   那时 `edit` / `pick` 应当变成 `shown(...)`；日志里若出现
   `❌ 精选：该显示却被藏了`，就是那次改动出了问题。
   （选类型要点界面，命令行做不到。）
2. ~~**升版本号并发布**~~ ✅ **本会话已做**（2026-09-30 晚）：
   `package.json` 0.1.17 → **0.1.18**（`58ef6e6`）→ `npm run dist`
   （**3/3 那一步第一次真跑通了**：`✓ 产物核对通过 —— 隐私边界干净，可以发出去了`，
   `MorningBrief Setup 0.1.18.exe` = 106.4 MB）→ `npm run release`（生成 `latest.json`，
   sha256 `da4389ac…`）→ `git tag v0.1.18` + `gh release create`。
   **发布后核对**：更新器的稳定地址
   `https://github.com/LiujYi0425/morning-brief/releases/latest/download/latest.json`
   取回来的文件与本地 `release/latest.json` **逐字节相同**（sha256 `544918…`），
   两个附件都是 `uploaded`。⇒ 装着的 0.1.17 下次启动就能看到这一版。
3. ~~**更新文档里的数字**~~ ✅ **本会话已做**（`947e406`）：`项目计划工程书.md`
   四处回填（§5.2c 两行、§5.3 C1/C2 行、§10 项目地图）＋ §7 加一行留痕。
   ⚠️ 依 **R-D05「回填进度数字属记账」⇒ 本文件不升版本号**（仍 1.6.0）、
   下游依 R-D03 无需核对 —— 这也是它有别于 1.5.0 / 1.6.0 那两次（各带一轮 8 份下游记账）的地方。
   `sync-check` 复查全绿。
   （`README.md` 里**没有**这些数字，核过了，无需改。）
4. （可选）把 3.2 的**分片跑法**做成 `tools/` 里的一条命令
   （现在是临时脚本 + 三行补丁；做成命令之后全量变异从一小时变成十几分钟）。

---

## 6. 这一轮新踩的坑

1. **"判据依赖输出格式"是本项目的新型静默故障**：一条只认一种缩进的解析，
   能让**一整份文件**的变异体集体误报"漏网"，而它的样子是"断言不够"。
   ⇒ 跨文件/跨脚本的判据，必须**两种格式各跑一条断言**（2.②就是这么修的）。
2. **不要把"验证 dist"当成顺手的事**：`dist.mjs` 没有版本号守卫，
   而 0.1.17 已发布（第 4 节第 3 条）。要验接线就用假的 builder（3.1）。
3. **分片跑变异时，每个分片必须给各自的 `TMP`/`TEMP`**：
   子进程日志文件是按 `os.tmpdir()` 取名的（`mb-mutant-child.log`），
   多个分片共用同一个临时目录 ⇒ 它们会**互相覆盖**，判据读到的是别人的输出。
   （同理：哨兵文件按工程路径取名，所以副本之间天然隔离。）
4. **变异跑完一定要 `git status` 复核**（`1a988db` 的教训），
   打包之前尤其要看一眼 —— 被打断的变异测试留下的改动**看起来像你自己的改动**。

---

## 7. 附：用户 2026-10-01 报的「现在无法更新」是怎么查的

**症状**：托盘气泡「检查更新失败：取不到清单：HTTP 504」，当前版本 0.1.16。

**查法（这套路径以后遇到"更新坏了"直接照抄）**——用户装的程序与开发态**不共用数据目录**：

```
%APPDATA%\morning-brief\data\run.log          ← 已安装那个程序的日志（本次的主证据）
%APPDATA%\morning-brief\data\update-state.json ← 最后一次**成功**检查的时间与线上版本
%APPDATA%\morning-brief\data\updates\download\ ← 历次下载下来的安装包（没人清）
```

日志里的事实（一眼定性）：`HTTP 404 / 502 / 504`、`清单不合格：…"<script>to"…`（取回来是个网页）
**与** `0.1.2 → 0.1.7 → 0.1.8 → 0.1.13 → 0.1.14` 一连串成功升级**交替出现**；
`update-state.json` 的 `lastCheck` 停在最后一次成功那次。
⇒ 结论不是"更新坏了"，而是**这条路时通时不通**，而当时的代码**一次不通就放弃**。

**修了什么**（`b477f3f`，随 v0.1.19 发布）：重试（5xx/超时/连接层；404 与"网页"不重试）、
`describeUpdateFailure` 说人话＋给手动下载页、偶发失败 15/60 分钟自动再试、
下载前清旧安装包（真机上攒了 **5×106MB=532MB**）。
判据：test-all 新增 5 条（含"假 net 前两次 504、第三次成功 ⇒ attempts=3"的真跑）。

**⚠️ 这一轮暴露的两件事，下一位要记住**：
1. **`npm run check` 里的 asar 自校验同时是个"产物 vs 源码"的新鲜度探针** ——
   它拿**磁盘上的 `src/main/index.js`** 与 asar 里那份逐字节比对；
   改了源码而没重打包，它就会红（这正是它该红的形状）。**看到它红先想"该打包了"**，
   别去修解析器。
2. 用户那台机器的程序装在 **`D:\morning-brief\MorningBrief\`（项目目录内部）**，
   `.gitignore` 第 30 行屏蔽了它。它不影响打包（`build.files` 是白名单），
   但**会让人分不清"我跑的是哪一份"** —— 排查时先确认 `MorningBrief.exe` 的版本与路径。

**★ 探针量出来的两件事**（`_probe-update-net.mjs`，真 Electron ＋ 真 `net` ＋ 真地址；跑完即删）：

```
[probe] fetchText 成功：4488 字节 / 25170ms     ← 冷进程里的**第一次**请求
[probe] checkForUpdate（同进程第二次）619ms      ← 紧接着的第二次
```

⇒ ① **那 25 秒是"第一次通话"的一次性代价**（代理自动探测 / DNS / 建连），不是 GitHub 慢。
两个推论都已写进代码：**超时不许缩短**（`MANIFEST_TIMEOUT_MS` 钉在 15s，
test-all 有一条断言守着这个数），而**重试恰好吸收这笔代价** ——
第一次超时的那次请求已经把连接摸热，紧接着的第二次是亚秒级的。
② **在本机跑任何 Electron 探针之前必须 `Remove-Item env:ELECTRON_RUN_AS_NODE`**：
这个会话环境里它是 `1`（DSH 自己就是 Electron），会让 `electron.cmd` **退化成纯 Node**
（`import('electron')` 的键只有 `default`/`module.exports`，`app`/`net` 全是 undefined），
于是量到的根本不是生产行为。另：**静态** `import { app, net } from 'electron'` 会当场
`SyntaxError: The requested module 'electron' does not provide an export named 'app'` ——
探针必须照抄生产代码那条路（动态 `await import('electron')`）。

---

## 8. 分发前审计：能不能直接打包发给别人（2026-10-01）

**用户的问题**（原话）：「告诉我此程序是否可以直接打包发送给别人使用了，若不能则需要你进行修复」。

**做法**：不靠读代码猜，而是**把打包好的程序当成"别人机器上的程序"来跑**。
判据只有一条：**陌生人拿到安装包之后会撞上什么。**

### 8.1 空数据目录的第一次启动（真机取证）

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE       # ⚠️ 本会话环境里它是 1；不清掉 exe 会退化成纯 Node
$fresh = "$env:TEMP\mb-fresh"              # 空目录 = 全新机器上的 userData
Start-Process 'release\win-unpacked\MorningBrief.exe' -ArgumentList "--user-data-dir=$fresh"
```

`boot.log` 的完整序列（**这就是"能跑"的形状**）：
`module-evaluated → heartbeat-written → update-watchdog ok → pidfile-written →
bootstrap-enter → db-opened → card-window-created → ipc-registered → tray-created →
level-applied "applied" → scheduler-started`

拿到的东西（`run.log` ＋ 直接读那份 `brief.db`）：

- `[startup] 可见性提示：首次运行，置顶 6000ms ＋ 托盘气泡`（不是"装完屏幕上什么都没有"）；
- `[scheduler] 启动判定：需要抓取 —— 从未成功抓取过` ⇒ **自动补抓**；
- `[ingest] 首次运行：写入 117 个预置源` ＋ `按预置清单写入 443 条「源 ↔ 类型」映射`；
- `[scheduler] 完成：成功 67 / 失败 0`；库里 **117 个源 / 29 个类别 / 3635 条**（读的时候还在抓），
  当天 `todayTotal=628`，卡片默认那屏「显示 15 条」；
- **没配 API Key 也有东西看**：卡片第一行如实写「未配置 API Key（点 ⚙ 设置）· 显示 15 条」，
  下面就是当天真实的 15 条（InfoQ 中文 / 华尔街见闻…）。
  代码侧口径：`buildAiState` 没有简报时 `briefView=false` ⇒ 退回普通列表（不是空白页）。

⚠️ 顺手记一条**本次踩到的坑**：改 `$env:APPDATA` 指向空目录**模拟不了全新机器** ——
Chromium 的 `app.getPath('appData')` 走 Windows shell API（`SHGetKnownFolderPath`）而不读进程环境变量。
正确的做法是 `--user-data-dir=<空目录>`（Chromium 认这个开关，`app.getPath('userData')` 跟着变）。
（第一次实验里 exe「6 秒内退出、退出码 0、什么都没写」其实是 `ELECTRON_RUN_AS_NODE=1` 让它退化成 Node 了，
`--user-data-dir` 成了非法 Node 选项 ⇒ 退出码 9。**先清那个环境变量，再谈现象。**）

### 8.2 另外两条环境轴

- **装在带空格＋中文的目录里**（模拟 `C:\Program Files\MorningBrief`、或中文用户名的
  `%LOCALAPPDATA%\Programs\...`）：整个 `win-unpacked` 复制到 `%TEMP%\mb 空格 测试 目录\MorningBrief`
  再跑 ⇒ 同样完整走到 `scheduler-started`，库与日志都落在指定目录 ✓。
  （置底脚本走 `-File`，而它是在 `-ExecutionPolicy Bypass -NoProfile -NonInteractive` 下调用的
  ⇒ 收件人的 PowerShell 执行策略拦不住它。）
- **双击两次**（别人的机器上最常见的动作）：见 8.3 —— 这是**唯一抓到的真毛病**。

### 8.3 抓到的毛病：主进程没有单实例锁（已修）

实测（同一份 `--user-data-dir` 起两次）：第二个实例**照样跑起来** ——
`boot.log` 多一条 `module-evaluated`、`run.log` 多一条 `[main] 就绪`，
屏幕上两个托盘图标、两张卡片窗，两个调度器在**同一个 `brief.db`** 上各抓一遍 117 个源。

修法（`src/main/index.js`）：

1. 模块顶部 `if (!app.requestSingleInstanceLock()) app.exit(0)`。
   ⚠️ 位置**必须在任何"写数据目录"的动作之前** —— 心跳、更新看门狗、`writePidFile`
   都在**模块求值阶段**跑；写心跳会骗过启动看门狗（"新版本起来了"的判据就是它），
   写 pid 会把**正在跑的那个实例**的登记抢走。
   ⚠️ 必须是 `app.exit(0)` 而不是 `app.quit()` —— 后者只是发起退出，本模块剩下的写入照做。
2. `bootstrap()` 里注册 `app.on('second-instance', …)`：把卡片叫到前面
   （复用 `announceWhereItIs`：不抢焦点、置顶几秒、再落回置底）。
   光有锁的话第二次双击会**毫无反应** —— 那正是这个项目反复栽过的"点了没反应"。

守它的判据（test-all ＋2 条）：锁必须先于那四处写入、必须与 `app.exit(0)` 配对、
`second-instance` 必须注册在 `bootstrap()` 里（`^app\.on\(` 不许出现在 bootstrap 之前＝那条 0xC0000005 铁律）。

**复验（打包之后又跑了一遍，判据是"第二次双击什么都不写"）**：

| 检查 | 实测 |
|---|---|
| 第一个实例的 `boot.log` | 完整走到 `scheduler-started` ✓（锁没把启动形状搞坏） |
| 第二次双击的那个进程 | 8 秒内退出、**退出码 0** ✓ |
| `boot.log` 里 `module-evaluated` 行数 | **1 → 1，不变** ✓（拿不到锁的那一个一个字节都没写） |
| 正在跑的那个实例的 `run.log` | 出现「又有人启动了一次：不再开第二个实例，把卡片叫到前面」✓ |
| `MorningBrief.exe` 进程数 | 只有一套（4 个：主进程 ＋ GPU/renderer）✓ |

### 8.4 顺手补的合规项：MIT 许可声明随包发

MIT 条款要求"随副本一起附上版权声明与许可"，而装到别人机器上的那份**就是副本**
⇒ `build.files` 白名单加 `LICENSE`，`tools/check-dist.mjs` 的 `ALLOWED` 同步放行 ＋ 新增 B3c 断言。
打包后核对：`✓ asar 含 LICENSE（MIT：许可声明随副本一起发）`、
`✓ asar 内容严格等于白名单（src/ + package.json + LICENSE）`。

### 8.5 剩下**没法**用代码解决的一条（照实说）

**安装包没有代码签名** ⇒ 别人第一次装会看到 Windows SmartScreen「已保护你的电脑 / 未知发布者」，
要点「更多信息 → 仍要运行」。这要买证书（或让 Windows 慢慢累计信誉），不是代码能修的。
发给别人时把这一句一起说清楚，对方就不会以为中了病毒。
（另：只出 **x64**；Electron 44 要求 **Windows 10 1809+**。）

### 8.6 审计里明确"验过没问题"的几处（免得下一位重做）

- 源码里没有本机路径、没有密钥；`keystore.bin` 只在 `userData` 下；**库里没有任何 key/api 列**；
- 置底脚本与托盘图标走 `extraResources`，打包态真的被调用到（`level-applied "applied"`）；
- 更新检查在"全新安装"上也是通的：`[update] 已经是最新（本地 0.1.21，清单 0.1.21）`；
- 卸载不删数据、安装不需要管理员（`perMachine:false`）、可自选目录（`oneClick:false`）、
  桌面与开始菜单快捷方式名都是「晨报机」。

### 8.7 追加审计项：首次运行引导窗（2026-10-02）

**为什么它算「分发前审计」的一条**：它是**陌生人拿到安装包之后看到的第一个东西**，
而且**只出现一次** —— 首屏没看全，就没有第二次机会。所以必须用**打包版**验，不能只验开发态。

**判据**：打包后的 exe，在**空数据目录**里第一次启动，会不会自己把这扇窗弹出来、弹成什么样。

```powershell
Remove-Item env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$ud   = "$env:TEMP\mb-a5-ud";   $data = "$env:TEMP\mb-a5-data"
Remove-Item -Recurse -Force $ud,$data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ud,$data | Out-Null
$env:MB_DATA_DIR = $data
Start-Process 'release\win-unpacked\MorningBrief.exe' -ArgumentList "--user-data-dir=$ud"
```

**实测读数**（`release\win-unpacked\MorningBrief.exe`，**246174720 字节**，2026-10-02 14:23 打包）：

| 检查 | 实测 |
|---|---|
| 窗口（`EnumWindows` 按标题） | `晨报机 · 第一次使用` · **460×560** @ (744,140) —— 与 `WELCOME_SIZE` **逐字相符** |
| 欢迎窗个数 | **1**（没有第二扇） |
| `boot.log` 序列 | `… → level-applied "applied" → scheduler-started at=07:30 → `**`welcome shown`** |
| 渲染层自检（`run.log`） | **9 条 verdict 零 ✗**，含 `✔ 首屏看得见 Key 输入框（358–389，正文视口 59–486）`、`✔ 正文一屏装得下（427≤427）` |
| 幂等标记 | `welcome_done = 1`（`node _scan-meta.mjs <data>\brief.db welcome`） |
| 截图 | `%TEMP%\mb-a5-packaged-welcome.png` |

⚠️ **这一条为什么值得单列**：开发态能弹**不等于**打包态能弹 —— `build.files` 白名单漏文件
正是这类事故的经典形态（漏了 `welcome.html` 就是「打包后一启动就失败」）。
`tools/check-dist.mjs` 的 B3 必备文件清单已把那三个文件写进去，本轮 dist 的 3/3 核对里
`✓ asar 含 src/renderer/welcome.html / welcome.js / styles/welcome.css` 三条都在。

⚠️ **顺带在这条审计里抓到并修掉一个真缺陷**（开发态真机复核时发现）：
窗高还是 420 的时候，正文内容 **410px** > 可见 **287px** ⇒ `#keyInput` 落在折线下方 **12px**，
首屏最后一行只剩「打开申请页面」按钮 —— 而这扇窗**只弹一次**。
修法：`WELCOME_SIZE.h` **420 → 560**（用户拍板），并给自检添一条**硬判据**
（旧的 `dirLine('Key 输入框', …)` 只判「有没有生成盒子」，**在故障状态下照样给 ✔**）。
**教训与 §8.6 那份审计同款**：「代码看着对」和「对方的屏幕上看得见」是两件事。

---

## 9. 与既有交接文档的关系

- `HANDOFF.md`（筛选栏功能）、`HANDOFF-阶段A.md`、`HANDOFF-阶段B.md`（阶段 B/C/D）
  都是**有效**的，别推翻它们；本文件只覆盖"门禁自己"这一层。
- 三份 HANDOFF 里那些"坑"仍然适用（PowerShell 引号 / 编码、`node:sqlite` 懒加载、
  注释里别出现 `*/`、渲染层不许 `import`、改完必须跑 `dist:check` …）。
