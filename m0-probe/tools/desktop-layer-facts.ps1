<#
  desktop-layer-facts.ps1
  ------------------------------------------------------------------
  A10「桌面层挂载可行性」的**前置侦察**（纯只读，不改动任何系统状态）。

  为什么需要它：
    A10 要回答「卡片窗口能不能挂进桌面层（壁纸层）」。ADR-011 把它列为
    M0 的第二个收尾条件，四项判据是：被覆盖 / 仍能点击 / backdrop-filter
    仍生效 / 缩放仍正确。

    但在动手写挂载实验之前，必须先判定**这台机器属于哪一派** —— 因为微软
    在 Windows 11 24H2（build 26100）重写了桌面窗口层次：

      23H2 及之前                24H2 起
      底层 Progman                底层 Progman（新增 WS_EX_NOREDIRECTIONBITMAP）
      中层 WorkerW  ← 壁纸层挂这儿  中层 SHELLDLL_DefView（直接当绘制平面）
      顶层 SHELLDLL_DefView       顶层 应用窗口

    后果：业界沿用多年的那句咒语 `SendMessage(Progman, 0x052C)` 用来催生
    WorkerW，在 24H2+ 上**已失效**。照着旧教程写挂载代码，会把「环境变了」
    误判成「我实现错了」，白白烧掉一轮。

  ⚠️ 修正记录：

  【第 1 版 → 第 2 版】判据**采样口径**错了。
    第 1 版用 `EnumWindows`（**只枚举顶层窗口**）去找 SHELLDLL_DefView，
    但在 24H2 上它是 **Progman 的子窗口** ⇒ 采样永远为 0，判据全 false，
    再被 `workerwCount > 0` 兜底吞掉，得出**错误的 `legacy`**。
    且那条兜底本身不成立：本机有 14 个**隐形的顶层 WorkerW**，它们只是第三方
    程序借这个类名造的辅助窗口，与桌面层次毫无关系。
    ⇒ 第 2 版：① 采样改为「Progman 的直接子窗口 ＋ 顶层 WorkerW 的子窗口」；
              ② 删掉「有顶层 WorkerW 就是 legacy」这条废话判据，改成
                 「**顶层 WorkerW 里真的住着 SHELLDLL_DefView**」才是 legacy；
              ③ 每个信号单独上报，允许出现 `mixed`（证据打架就如实说打架）。

  【第 2 版 → 第 3 版】撞上 **PowerShell 单元素数组解包**，数字全是假的。
    症状（第 2 版真跑出来的）：`defviewFromProgmanCount = 10`、
    `defviewFromProgmanLayered = false`、`signals.s2 = false` —— **但同一份
    JSON 里 `progmanChildren[0]` 明写着 `layered = true`**，自己打自己。
    根因三条、一个源头：
      ① `return @(单个对象)` 从函数出来会被 **PowerShell 解包成标量**；
      ② 标量不是数组时，`.Count` 返回的是**哈希表的键数**（本脚本 Desc 正好
         10 个字段 ⇒ 恰好 10），**看着像个合法数字**，所以没人报警；
      ③ `$dict[0]` 走 OrderedDictionary 的**整数索引器**，取到的是**第一个
         值**（`hwnd` 字符串）而不是第一个元素 ⇒ `.layered` 读成 null ⇒ false。
    最狠的连带事故：那个标量的 `.hwnd` 取成 `null` ⇒ `ConvertTo-IntPtr` **静默**
    返回 `IntPtr.Zero` ⇒ `FindWindowEx(parent=0, …)` 的语义是
    **「枚举桌面窗口的子窗口」** ⇒ `defviewChildrenClasses` 悄悄变成了
    **全系统顶层窗口清单**（里面居然有 `Shell_TrayWnd`、`Progman`、
    `MyDockFinder` —— 一眼可知不可能是 DefView 的子窗口）。
    ⇒ 第 3 版：① 所有返回数组的函数，**调用点一律用 `@()` 包住**；
              ② 新增 **`sanity` 自洽性守卫**：一旦「树里明明有 DefView、函数却
                 取回 0 个」或「取到的句柄为空」，立刻 `ok=false` + `verdict=unknown`，
                 **绝不静默降级**；
              ③ 旁证改为「子窗口数 ＋ 是否含 `SysListView32` ＋ 去重样本前 12 个」，
                 免得又倒出一屏垃圾还看不出是垃圾。

  判定信号（全部只读观察，不发送任何窗口消息）：
    s1  Progman 带 WS_EX_NOREDIRECTIONBITMAP            → modern（24H2 签名 ①）
    s2  Progman 的直接子窗口里有 SHELLDLL_DefView 且带 WS_EX_LAYERED
                                                        → modern（24H2 签名 ②）
    s3  Progman 的直接子窗口里有 WorkerW                → modern（24H2 签名 ③）
    s4  某个**顶层** WorkerW 里住着 SHELLDLL_DefView     → legacy（23H2 及之前）

    verdict：s4 与 (s1|s2|s3) 同时为真 → mixed（如实报打架）
             s4 为真                    → legacy
             (s1|s2|s3) 为真            → modern-24h2
             全假                       → unknown（不猜）
             sanity 守卫被触发          → unknown（结论不可信，宁可说不确定）

  实现说明：
    与 tools/win-display-facts.ps1 同一套路：用 C# 声明 P/Invoke，让 CLR
    自己处理指针宽度，不手算偏移。
    ⚠️ 本脚本**只调用 Get/Enum 类 API**，不调用任何 Set/Send 类 API，
       因此重复运行是安全的、可随时中断的。

  输出：
    - 给了 -OutFile → 写 UTF-8 JSON 到该文件（绕开控制台代码页）
    - 否则打到 stdout

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\desktop-layer-facts.ps1 `
      -OutFile .\report\desktop-layer-facts.json
#>

param(
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class DeskLayer {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindowExW(IntPtr hWndParent, IntPtr hWndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;

    public const long WS_EX_TRANSPARENT        = 0x00000020L;
    public const long WS_EX_TOOLWINDOW         = 0x00000080L;
    public const long WS_EX_LAYERED            = 0x00080000L;
    public const long WS_EX_NOREDIRECTIONBITMAP = 0x00200000L;

    public static string ClassOf(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }

    /* 用 \u0001 做分隔符，PowerShell 侧再 split —— 避免中文与空格干扰 */
    public static string Desc(IntPtr h) {
        long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
        long ex    = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
        return string.Join("\u0001", new string[] {
            h.ToString(),
            ClassOf(h),
            IsWindowVisible(h) ? "1" : "0",
            GetParent(h).ToString(),
            "0x" + style.ToString("X8"),
            "0x" + ex.ToString("X8"),
            ((ex & WS_EX_NOREDIRECTIONBITMAP) != 0L) ? "1" : "0",
            ((ex & WS_EX_LAYERED) != 0L) ? "1" : "0",
            ((ex & WS_EX_TRANSPARENT) != 0L) ? "1" : "0",
            ((ex & WS_EX_TOOLWINDOW) != 0L) ? "1" : "0"
        });
    }

    /* 只枚举顶层窗口（EnumWindows 的语义边界 —— 子窗口不在其中） */
    public static string[] TopLevelByClass(string target) {
        var res = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (ClassOf(h) == target) res.Add(Desc(h));
            return true;
        }, IntPtr.Zero);
        return res.ToArray();
    }

    /* 直接子窗口，按 Z 序（FindWindowEx 的返回顺序） */
    public static string[] Children(IntPtr parent) {
        var res = new List<string>();
        IntPtr c = IntPtr.Zero;
        while (true) {
            c = FindWindowExW(parent, c, null, null);
            if (c == IntPtr.Zero) break;
            res.Add(Desc(c));
        }
        return res.ToArray();
    }

    /* 只取类名。⚠️ parent 传 0 的语义是「枚举桌面的子窗口」= 所有顶层窗口，
       所以绝不能拿它当「取不到句柄」的兜底 —— 那会把满屏垃圾伪装成旁证。 */
    public static string[] ChildClassNames(IntPtr parent) {
        var res = new List<string>();
        IntPtr c = IntPtr.Zero;
        while (true) {
            c = FindWindowExW(parent, c, null, null);
            if (c == IntPtr.Zero) break;
            res.Add(ClassOf(c));
        }
        return res.ToArray();
    }

    public static IntPtr Progman() {
        return FindWindowW("Progman", null);
    }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp

function ConvertTo-IntPtr {
    param([string]$Hwnd)
    if ([string]::IsNullOrEmpty($Hwnd)) { return [IntPtr]::Zero }
    return [IntPtr][int64]$Hwnd
}

function Convert-Desc {
    param([string]$Raw)
    if ([string]::IsNullOrEmpty($Raw)) { return $null }
    $p = $Raw -split ([char]1)
    if ($p.Count -lt 10) { return $null }
    return [ordered]@{
        hwnd        = $p[0]
        cls         = $p[1]
        visible     = ($p[2] -eq '1')
        parent      = $p[3]
        style       = $p[4]
        exStyle     = $p[5]
        noRedirBmp  = ($p[6] -eq '1')
        layered     = ($p[7] -eq '1')
        transparent = ($p[8] -eq '1')
        toolWindow  = ($p[9] -eq '1')
    }
}

function Convert-DescList {
    param($RawList)
    $res = @()
    foreach ($r in @($RawList)) {
        $d = Convert-Desc $r
        if ($d) { $res += $d }
    }
    return $res
}

# 取某窗口「直接子窗口」里指定类名的那些（Desc 数组）。
# ⚠️⚠️ 它返回的可能是「只有一个元素的数组」，而 PowerShell 会把函数返回值解包成
#   标量。所以**所有调用点都必须写 `$x = @(Get-DirectChildByClass ...)`**。
#   不包的话：`.Count` 会变成哈希表键数（10）、`[0]` 会取到第一个字段的值。
#   第 2 版就是死在这里（详见文件头修正记录）。
function Get-DirectChildByClass {
    param([string]$ParentHwnd, [string]$Cls)
    if ([string]::IsNullOrEmpty($ParentHwnd) -or $ParentHwnd -eq '0') { return @() }
    $kids = [DeskLayer]::Children((ConvertTo-IntPtr $ParentHwnd))
    return @(Convert-DescList $kids | Where-Object { $_.cls -eq $Cls })
}

$out = [ordered]@{
    ok         = $true
    script     = 'desktop-layer-facts.ps1'
    revision   = 3
    purpose    = 'A10 前置侦察：判定本机桌面层属于 legacy / modern-24h2 / mixed（只读）'
    capturedAt = (Get-Date).ToString('s')
    windows    = [ordered]@{}
    verdict    = 'unknown'
    confidence = ''
    signals    = [ordered]@{}
    sanity     = [ordered]@{}
    evidence   = [ordered]@{}
    progman    = $null
    progmanChildren = @()
    defviewFromProgman = @()
    defviewChildCount = 0
    defviewChildHasSysListView32 = $false
    defviewChildClassSample = @()
    topLevelDefviews = @()
    workerWHostingDefview = @()
    topLevelWorkerW = @()
    notes      = @()
    errors     = @()
}

try {
    $v = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
    if ($v) {
        $out.windows = [ordered]@{
            productName    = $v.ProductName
            displayVersion = $v.DisplayVersion
            build          = [string]$v.CurrentBuildNumber
            ubr            = [string]$v.UBR
            buildFull      = ([string]$v.CurrentBuildNumber + '.' + [string]$v.UBR)
            edition        = $v.EditionID
        }
        # ProductName 在 Win11 上仍写着 "Windows 10"，是微软的历史遗留 —— 以 build 为准
        if ($out.windows.productName -like 'Windows 10*' -and [int]$v.CurrentBuildNumber -ge 22000) {
            $out.notes += 'ProductName 写着 Windows 10，但 build >= 22000 ⇒ 实为 Windows 11（注册表字符串未更新）'
        }
    }
} catch {
    $out.errors += "读注册表版本失败: $($_.Exception.Message)"
}

try {
    $progmanHwnd = [DeskLayer]::Progman()
    $out.evidence.progmanHwnd = $progmanHwnd.ToString()

    # ---- Progman 自身 + 它的直接子窗口（Z 序） ----
    $allProgman = @(Convert-DescList ([DeskLayer]::TopLevelByClass('Progman')))
    if ($allProgman.Count -gt 0) { $out.progman = $allProgman[0] }

    $progmanChildren = @(Convert-DescList ([DeskLayer]::Children($progmanHwnd)))
    $out.progmanChildren = $progmanChildren

    # ---- 关键修正：DefView 要从「Progman 的直接子窗口」里找，不是从顶层找 ----
    $defviewFromProgman = @(Get-DirectChildByClass $out.evidence.progmanHwnd 'SHELLDLL_DefView')
    $out.defviewFromProgman = $defviewFromProgman

    # ---- 自洽性守卫：不许静默降级 ----
    $progmanDefviewInTree = @($progmanChildren | Where-Object { $_.cls -eq 'SHELLDLL_DefView' })
    $samplingSuspect = $false
    if ($progmanDefviewInTree.Count -gt 0 -and $defviewFromProgman.Count -eq 0) {
        $samplingSuspect = $true
        $out.errors += "自洽性失败：progmanChildren 里有 $($progmanDefviewInTree.Count) 个 SHELLDLL_DefView，但 Get-DirectChildByClass 取回 0 个 —— 采样或数组解包出问题了，本次结论不可信。"
    }
    if ($defviewFromProgman.Count -gt 0) {
        $dvh = [string]$defviewFromProgman[0].hwnd
        if ([string]::IsNullOrEmpty($dvh) -or $dvh -eq '0') {
            $samplingSuspect = $true
            $out.errors += '自洽性失败：取到的 SHELLDLL_DefView 句柄为空 —— 继续拿它去枚举会退化成「枚举桌面子窗口」，旁证会变成垃圾。'
        }
    }
    if ($samplingSuspect) { $out.ok = $false }

    # ---- 旁证：真正的桌面图标层应该住着 SysListView32（防「同名假窗口」误判） ----
    # ⚠️ 只有句柄有效才枚举；否则 FindWindowEx(parent=0) 会去枚举桌面，产出满屏垃圾。
    if ($defviewFromProgman.Count -gt 0 -and -not $samplingSuspect) {
        $dvClasses = @([DeskLayer]::ChildClassNames((ConvertTo-IntPtr $defviewFromProgman[0].hwnd)))
        $out.defviewChildCount = $dvClasses.Count
        $out.defviewChildHasSysListView32 = ($dvClasses -contains 'SysListView32')
        $out.defviewChildClassSample = @($dvClasses | Select-Object -Unique | Select-Object -First 12)
    }

    # ---- 顶层窗口：DefView 与 WorkerW ----
    $topDefviews = @(Convert-DescList ([DeskLayer]::TopLevelByClass('SHELLDLL_DefView')))
    $out.topLevelDefviews = $topDefviews

    $topWorkerWs = @(Convert-DescList ([DeskLayer]::TopLevelByClass('WorkerW')))
    $out.topLevelWorkerW = $topWorkerWs

    # ---- 只有「顶层 WorkerW 里真的住着 DefView」才算 legacy 的家 ----
    $hostingWorkerWs = @()
    foreach ($w in $topWorkerWs) {
        $dv = @(Get-DirectChildByClass $w.hwnd 'SHELLDLL_DefView')
        if ($dv.Count -gt 0) { $hostingWorkerWs += $w }
    }
    $out.workerWHostingDefview = $hostingWorkerWs

    # ---- 信号 ----
    $progmanNoRedir = ($null -ne $out.progman) -and $out.progman.noRedirBmp
    $defviewLayeredVal = $false
    if ($defviewFromProgman.Count -gt 0) { $defviewLayeredVal = [bool]$defviewFromProgman[0].layered }
    $s2 = ($defviewFromProgman.Count -gt 0) -and $defviewLayeredVal
    $progmanChildWorkerWs = @($progmanChildren | Where-Object { $_.cls -eq 'WorkerW' })
    $s3 = $progmanChildWorkerWs.Count -gt 0
    $s4 = $hostingWorkerWs.Count -gt 0

    $out.signals = [ordered]@{
        s1_progmanHasNoRedirBitmap              = [bool]$progmanNoRedir
        s2_defviewIsDirectChildOfProgmanLayered = [bool]$s2
        s3_workerWIsDirectChildOfProgman        = [bool]$s3
        s4_topLevelWorkerWHostsDefview          = [bool]$s4
    }

    $defviewHwndVal = ''
    if ($defviewFromProgman.Count -gt 0) { $defviewHwndVal = [string]$defviewFromProgman[0].hwnd }

    $out.sanity = [ordered]@{
        samplingSuspect                = [bool]$samplingSuspect
        progmanChildrenCount           = $progmanChildren.Count
        progmanChildrenDefviewCount    = $progmanDefviewInTree.Count
        defviewFromProgmanIsArray      = ($defviewFromProgman -is [array])
        defviewFromProgmanCount        = $defviewFromProgman.Count
        emptyArrayCountIsZeroNotTen    = ((@()).Count -eq 0)
    }

    $out.evidence += [ordered]@{
        progmanHasNoRedirBitmap       = [bool]$progmanNoRedir
        defviewFromProgmanCount       = $defviewFromProgman.Count
        defviewFromProgmanLayered     = [bool]$defviewLayeredVal
        defviewFromProgmanHwnd        = $defviewHwndVal
        progmanChildWorkerWCount      = $progmanChildWorkerWs.Count
        progmanChildWorkerWVisible    = @($progmanChildWorkerWs | Where-Object { $_.visible }).Count
        topLevelDefviewCount          = $topDefviews.Count
        topLevelWorkerWCount          = $topWorkerWs.Count
        topLevelWorkerWVisibleCount   = @($topWorkerWs | Where-Object { $_.visible }).Count
        topLevelWorkerWHostingDefview = $hostingWorkerWs.Count
    }

    # ---- 判决 ----
    $modern = ($progmanNoRedir -or $s2 -or $s3)
    if ($samplingSuspect) {
        $out.verdict = 'unknown'
        $out.confidence = 'n/a'
        $out.notes += '⛔ 自洽性守卫被触发：采样数字与窗口树自相矛盾 ⇒ 宁可报 unknown，也不拿一个可能是假象的结论去指导挂载实现。先修脚本再跑。'
    } elseif ($s4 -and $modern) {
        $out.verdict = 'mixed'
        $out.confidence = 'low'
        $out.notes += '证据打架：既有 24H2 签名，又有顶层 WorkerW 真正住着 DefView —— 如实报 mixed，不要挑一个顺眼的当结论。'
    } elseif ($s4) {
        $out.verdict = 'legacy'
        $out.confidence = 'high'
        $out.notes += '判定为 23H2 及之前架构：顶层 WorkerW 里住着 SHELLDLL_DefView，传统 WorkerW 方案可试。'
    } elseif ($modern) {
        $out.verdict = 'modern-24h2'
        $out.confidence = $(if ($s2) { 'high' } else { 'medium' })
        $out.notes += '判定为 24H2+ 新架构：传统 0x052C + WorkerW 方案大概率失效。'
        $out.notes += '挂载路径应改走「SetParent 进 Progman 的直属子窗口（WorkerW / 排在 SHELLDLL_DefView 之下）」，或 WS_EX_LAYERED 子窗口方案。'
        $out.notes += '⚠️ 24H2 桌面上可能盖着一层「桌面快照」，挂载后需强制 DefView 重绘（SW_HIDE → SW_SHOWNORMAL）才看得见。'
    } else {
        $out.verdict = 'unknown'
        $out.confidence = 'n/a'
        $out.notes += '所有信号都不成立 —— 如实报 unknown，不用猜测填坑。'
    }

    if (-not $progmanNoRedir -and $modern) {
        $out.notes += '注：本机 Progman 未带 WS_EX_NOREDIRECTIONBITMAP（该条 modern 签名不成立），但另两条成立 —— 别把「单条不成立」当成「不是 24H2」。'
    }
    if (@($topWorkerWs | Where-Object { $_.visible }).Count -eq 0 -and $topWorkerWs.Count -gt 0) {
        $out.notes += "注：$($topWorkerWs.Count) 个顶层 WorkerW 全部 visible=false 且 parent=0 ⇒ 它们只是第三方程序借这个类名造的辅助窗口，与桌面层次无关，不可用来判 legacy。"
    }
} catch {
    $out.ok = $false
    $out.errors += "枚举窗口失败: $($_.Exception.Message)"
}

$json = $out | ConvertTo-Json -Depth 8
if ($OutFile -ne '') {
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
} else {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $json
}
