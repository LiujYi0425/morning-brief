<#
  lint-ps1.ps1 —— 本工程 PowerShell 脚本的**离线静态检查**。
  ------------------------------------------------------------------
  为什么需要它：
    本工程的 Windows 侧取证工具都是 .ps1（P/Invoke + C#），而 AI 侧**跑不了它们**
    （安全策略禁止运行时编译 C#）。于是"写完 → 交给阿木跑 → 报错 → 改"成了
    一轮一轮的来回，代价极高：2026-09-21 一晚就因此浪费了两轮。

    但这个空档并不是不能补 —— **不编译 C#、只做 AST 解析的脚本，AI 侧跑得动**。
    这个 lint 就是那条缝：把「能在静态阶段发现」的错误拦在自己这边。

  五条检查（每一条都是真金白银换来的）：
    C1 FAIL  参数名撞「只读 / 常量自动变量」
             实测：`[string]$Host = 'x'` ⇒ 参数绑定阶段直接抛 VariableNotWritable，
             **脚本一行都跑不到**。（$Host 是 PowerShell 的只读自动变量。）
    C2 WARN  可能只返回一个元素的函数，调用点没写 `@( ... )`
             实测：PowerShell 会把单元素数组解包成标量 ⇒ `.Count` 变成**哈希表键数**
             （曾输出 `defviewFromProgmanCount = 10` 这种看着很正常的假数字）。
    C3 FAIL  .ps1 缺 UTF-8 BOM
             实测：PS 5.1 无 BOM 时按 ANSI 解码 ⇒ 中文注释全乱。
    C4 FAIL  调用了内嵌 C# 类上**根本没声明**的成员
             实测（2026-09-21 第二次踩）：attach-to-desktop-layer.ps1 里写了
             `[DeskAttach]::Progman()`，而 C# 类里只有 FindWindowW、压根没有 Progman。
             PowerShell 不会在解析期报错 ⇒ **只有真跑起来才炸**，而 AI 侧跑不了
             （Add-Type 被禁）⇒ 这类错 100% 会先砸在阿木头上。
             本检查把「真跑才知道」变成「写完就知道」。
             ⚠️ 本检查第 1 版自己就栽过一次：块识别正则要求 here-string 开头必须出现在**行首**，
             而本工程实际写的是「变量 = 空格 + 开头符」⇒ **一个块都没认出来**，却照常打出
             「本文件无内嵌 C# 块 —— 跳过」这行**看着完全正常的字**。⇒ 现在会一并报出
             「C# here-string N 个」，让「一个都没扫到」不能再伪装成「没有可扫的」。
    C5 FAIL  [DllImport] 带 string 参数却没写 CharSet.Unicode
             实测（2026-09-21 第三次踩，代价 = 阿木白跑一轮）：attach 脚本里 CreateWindowExW
             漏了 CharSet.Unicode。**DllImport 的 CharSet 默认是 Ansi** ⇒ 按名字仍能绑到 W 函数，
             但 string 会按 **ANSI 字节** 编组后喂给**要 UTF-16 的** W 函数 ⇒ 类名 "Button" 变乱码
             ⇒ CreateWindowExW 返回 NULL（ERROR_CANNOT_FIND_WND_CLASS 1407）。
             同一份 C# 里别处都写了、只有它漏了 ⇒ "别的全对、只有建窗口失败"，极难猜。
             解析期不报错、只有真跑才知道 ⇒ 必须静态查。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\lint-ps1.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\lint-ps1.ps1 -Path .\tools -OutFile .\tools\lint-report.txt

  退出码（沿用本工程的 0/1/2 三态）：
    0 = 全绿   1 = 有 FAIL   2 = 只有 WARN（**灰色不等于绿色**，请人看一眼）
#>

param(
    [string]$Path = '',
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

if ($Path -eq '') { $Path = Split-Path -Parent $PSCommandPath }
if (-not (Test-Path -LiteralPath $Path)) { Write-Output "路径不存在: $Path"; exit 1 }

$targets = @()
if ((Get-Item -LiteralPath $Path).PSIsContainer) {
    $targets = @(Get-ChildItem -LiteralPath $Path -Filter '*.ps1' -File | Sort-Object Name)
} else {
    $targets = @(Get-Item -LiteralPath $Path)
}

# ---- C1 用到的「危险名字」清单 ----
# 一部分当场从会话里捞（只读=1 / 常量=2），一部分硬编码兜底
#  —— 有些自动变量要等第一次用到才存在，光靠 Get-Variable 捞不全。
$reservedLive = @(
    Get-Variable -ErrorAction SilentlyContinue |
    Where-Object { ($_.Options -band 1) -ne 0 -or ($_.Options -band 2) -ne 0 } |
    ForEach-Object { $_.Name }
)
$reservedExtra = @(
    'Error', 'Host', 'HOME', 'PID', 'ExecutionContext', 'ShellId', 'ConsoleFileName',
    'PSHOME', 'PSCulture', 'PSEdition', 'PSUICulture', 'PSVersionTable', 'true', 'false', '?',
    'Input', 'Args', 'MyInvocation', 'PSScriptRoot', 'PSCommandPath', 'PWD', 'Matches',
    'This', 'LASTEXITCODE', 'OFS', 'NULL', 'PSDefaultParameterValues'
)
$reserved = @($reservedExtra + $reservedLive | Select-Object -Unique)

# ---- C4 用到的：把脚本内嵌的 C# 块解析成「类名 → 已声明成员名集合」 ----
# ⚠️ 只用正则 + 纯文本，不做语义分析。宁可多认几个成员名（假阴性），
#    也绝不漏报真缺失（假阳性）—— 本项目头号教训：假阳性会让人再也不看报告。
function Get-CsMemberMap {
    param([string]$Text)

    $map = @{}
    # 只认本工程约定的「单引号 here-string」C# 块（@' 起、行首 '@ 止）
    $blocks = [regex]::Matches($Text, "(?ms)@'[ \t]*\r?\n(?<body>.*?)\r?\n[ \t]*'@")
    $script:csBlocks = $blocks.Count
    foreach ($b in $blocks) {
        $body = $b.Groups['body'].Value
        if ($body -notmatch 'public\s+static\s+class\s') { continue }

        $clsMatches = [regex]::Matches($body, 'public\s+static\s+class\s+(?<n>[A-Za-z_][A-Za-z0-9_]*)')
        for ($i = 0; $i -lt $clsMatches.Count; $i++) {
            $start = $clsMatches[$i].Index
            $end = $(if ($i + 1 -lt $clsMatches.Count) { $clsMatches[$i + 1].Index } else { $body.Length })
            $seg = $body.Substring($start, $end - $start)

            $names = New-Object 'System.Collections.Generic.HashSet[string]'
            # 方法 / 属性 / extern(P/Invoke) 声明：<modifiers> <返回类型> <名字> ( ; { => =
            $mPat = '(?:public|internal)\s+(?:static\s+)?(?:extern\s+)?[A-Za-z_][A-Za-z0-9_\.<>\[\],\s]*?\s+(?<n>[A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|;|=>|\{|=)'
            foreach ($m in [regex]::Matches($seg, $mPat)) {
                [void]$names.Add($m.Groups['n'].Value)
            }
            # const 字段
            foreach ($m in [regex]::Matches($seg, 'public\s+const\s+[A-Za-z_][A-Za-z0-9_]*\s+(?<n>[A-Za-z_][A-Za-z0-9_]*)')) {
                [void]$names.Add($m.Groups['n'].Value)
            }
            $map[$clsMatches[$i].Groups['n'].Value] = $names
        }
    }
    return , $map
}

$lines  = @()
$fails  = 0
$warns  = 0
$csRefsChecked = 0
$dllCheckedTotal = 0

$lines += '=== lint-ps1.ps1 · PowerShell 静态检查 ==='
$lines += ("扫描: " + $Path + "  （" + $targets.Count + " 个 .ps1 文件）")
$lines += ("只读/常量名字清单: " + $reserved.Count + " 个")
$lines += ''

foreach ($f in $targets) {
    $bytes  = [System.IO.File]::ReadAllBytes($f.FullName)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)
    $text   = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8)

    $errs = $null; $toks = $null
    $ast  = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$toks, [ref]$errs)

    $lines += ('--- ' + $f.Name + '  (' + $bytes.Length + ' B · BOM=' + $hasBom + ' · 语法错 ' + @($errs).Count + ' · tokens ' + @($toks).Count + ')')

    # C3 缺 BOM
    if (-not $hasBom) {
        $lines += '  [C3 FAIL] 缺 UTF-8 BOM ⇒ PS 5.1 会按 ANSI 解码，中文注释与字符串全乱'
        $fails++
    }

    # 语法错误先报（有语法错时后面的 AST 检查可信度下降）
    if (@($errs).Count -gt 0) {
        foreach ($e in @($errs)) { $lines += ('  [语法 FAIL] L' + $e.Extent.StartLineNumber + ': ' + $e.Message) }
        $fails++
    }

    if ($null -eq $ast) { $lines += '  (AST 为空，跳过结构检查)'; $lines += ''; continue }

    # ---- C1 参数名撞只读自动变量 ----
    $paramNames = @()
    if ($null -ne $ast.ParamBlock) {
        $paramNames = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    }
    $clash = @($paramNames | Where-Object { $reserved -contains $_ })
    if ($clash.Count -gt 0) {
        foreach ($c in $clash) {
            $lines += ('  [C1 FAIL] 参数 -' + $c + ' 撞上只读/常量自动变量 $' + $c + ' ⇒ 参数绑定阶段就会抛 VariableNotWritable，脚本一行都跑不到')
        }
        $fails++
    }
    $lines += ('  param: ' + $(if ($paramNames.Count -gt 0) { ($paramNames -join ', ') } else { '(无)' }))

    # ---- C2 数组返回函数的调用点是否包了 @() ----
    # ⚠️ 这条检查的第 1 版有个大毛病：只要调用点没包 @() 就报，于是把
    #    `$x = ConvertFrom-Desc (...)` 这种**本来就只想要一个对象**的写法也全报了
    #    —— 14 条 WARN 里 13 条是假阳性。**假阳性会让人再也不看这份报告。**
    #    第 2 版收窄成：只有当**返回值真的被当成集合用**（后面出现 `.Count` /
    #    `.Length` / `[n]`）且调用点没包 @() 时才报 —— 那才是会产出假数字的场景。
    $arrayFns = @()
    $fns = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
    foreach ($fn in $fns) {
        $bt = $fn.Body.Extent.Text
        if ($bt -match 'return\s+@\(' -or $bt -match 'return\s+\$[A-Za-z_]') { $arrayFns += $fn.Name }
    }
    $arrayFns = @($arrayFns | Select-Object -Unique)

    if ($arrayFns.Count -gt 0) {
        $cmds = @($ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true))
        foreach ($cmd in $cmds) {
            $n = $null
            try { $n = $cmd.GetCommandName() } catch { $n = $null }
            if ([string]::IsNullOrEmpty($n)) { continue }
            if (-not ($arrayFns -contains $n)) { continue }

            # 已经包了 @( ... ) 的，直接放过
            $wrapped = $false
            $up = $cmd
            for ($i = 0; $i -lt 4 -and $null -ne $up; $i++) {
                $up = $up.Parent
                if ($null -eq $up) { break }
                if ($up -is [System.Management.Automation.Language.ArrayExpressionAst]) { $wrapped = $true; break }
            }
            if ($wrapped) { continue }

            # 只有「左边这个东西后来被当成集合用」才是真风险
            $lhs = $null
            $pl = $cmd.Parent
            if ($null -ne $pl -and $pl -is [System.Management.Automation.Language.PipelineAst] -and
                $null -ne $pl.Parent -and $pl.Parent -is [System.Management.Automation.Language.AssignmentStatementAst]) {
                $lhs = $pl.Parent.Left.Extent.Text
            }
            if ([string]::IsNullOrEmpty($lhs)) { continue }

            $pat = [regex]::Escape($lhs) + '\s*(\.\s*(Count|Length)|\[)'
            if ($text -match $pat) {
                $lines += ('  [C2 WARN] L' + $cmd.Extent.StartLineNumber + ': `' + $n + '` 可能只返回一个元素（会被解包成标量），而 `' + $lhs + '` 后面又被当成集合用（.Count/.Length/[n]）⇒ 会得到「哈希表键数」这种**看着很正常的假数字**。调用点请写成 `' + $lhs + ' = @(' + $n + ' ...)`')
                $warns++
            }
        }
        $lines += ('  可能返回数组的函数: ' + ($arrayFns -join ', '))
    }

    # ---- C4 调用了 C# 类上不存在的成员 ----
    # 说明：只检查**本文件自己声明的** C# 类型 ⇒ 不会拿 [IntPtr]/[Math]/[regex] 之类
    # 的 BCL 类型来误报。没有任何 C# 块时明确打出「跳过」，不留静默空档。
    $csMap = Get-CsMemberMap $text
    if ($csMap.Count -eq 0) {
        $lines += '  C4: 本文件无内嵌 C# 块 —— 跳过（非静默：此处本无可查）'
    } else {
        # 先记下 C# 块在原文本里的**区间**，用来跳过落在块内的引用。
        # ⚠️ 第 1 版是「把块剃掉再找引用」，结果**行号整体前移**（报 L165，实际在 L396）——
        #    一个错行号会直接浪费读者一次翻找。⇒ 改为按区间排除，行号取原文。
        $csRanges = @()
        foreach ($r in [regex]::Matches($text, "(?ms)@'[ \t]*\r?\n.*?\r?\n[ \t]*'@")) {
            $csRanges += , @($r.Index, $r.Index + $r.Length)
        }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]'
        $fileRefs = 0
        foreach ($r in [regex]::Matches($text, '\[(?<c>[A-Za-z_][A-Za-z0-9_]*)\]::(?<m>[A-Za-z_][A-Za-z0-9_]*)')) {
            $cn = $r.Groups['c'].Value
            $mn = $r.Groups['m'].Value
            if (-not $csMap.ContainsKey($cn)) { continue }
            $inCs = $false
            foreach ($rg in $csRanges) { if ($r.Index -ge $rg[0] -and $r.Index -lt $rg[1]) { $inCs = $true; break } }
            if ($inCs) { continue }
            $fileRefs++
            if ($csMap[$cn].Contains($mn)) { continue }
            $key = $cn + '::' + $mn
            if (-not $seen.Add($key)) { continue }
            $ln = ($text.Substring(0, $r.Index) -split "`n").Count
            # ⚠️ 别把 60 个成员全倒出来 —— 那是噪音。只给「你是不是想写……」。
            $near = @($csMap[$cn] | Where-Object { $_ -like ('*' + $mn + '*') -or $mn -like ('*' + $_ + '*') } | Sort-Object)
            if ($near.Count -gt 6) { $near = @($near[0..5]) }
            $hint = $(if ($near.Count -gt 0) { '名字相近的成员: ' + ($near -join ', ') } else { '没有任何成员名与它相近 ⇒ 多半是**少写了声明**' })
            $lines += ('  [C4 FAIL] L' + $ln + ': PowerShell 调用了 `[' + $cn + ']::' + $mn + '`，但 C# 类 ' + $cn + ' **没有声明**它 ⇒ 真跑起来必炸 MethodInvocationException（解析期不报错，所以只有真跑才知道）。该类共 ' + $csMap[$cn].Count + ' 个成员，' + $hint)
            $fails++
        }
        $csRefsChecked += $fileRefs
        $lines += ('  C4: 已核对 ' + $fileRefs + ' 处成员引用（文件内 C# here-string ' + $script:csBlocks + ' 个 · 类型 ' + (($csMap.Keys | Sort-Object) -join ', ') + '）')
    }

    # ---- C5 [DllImport] 带 string 参数却没写 CharSet.Unicode ----
    # ⛔ 2026-09-21 真踩：attach-to-desktop-layer.ps1 的 CreateWindowExW 漏了 CharSet.Unicode。
    #    DllImport 的 CharSet **默认是 Ansi** ⇒ 按名字仍绑到 W 函数，但 string 按 ANSI 字节编组
    #    ⇒ 类名变乱码 ⇒ CreateWindowExW 返回 NULL（ERROR_CANNOT_FIND_WND_CLASS 1407）。
    #    解析期不报错，只有真跑才炸 —— 而我这边跑不了，所以必须静态查。
    $dllFound = 0
    $dllChecked = 0
    foreach ($blk in [regex]::Matches($text, "(?ms)@'[ \t]*\r?\n(?<body>.*?)\r?\n[ \t]*'@")) {
        $base = $blk.Groups['body'].Index
        foreach ($m in [regex]::Matches($blk.Groups['body'].Value, "(?ms)\[DllImport\((?<args>[^\]]*)\)\]\s*(?<decl>[^;]*?;)")) {
            $dllFound++
            $decl = $m.Groups['decl'].Value
            if ($decl -notmatch 'string') { continue }
            $dllChecked++
            if ($m.Groups['args'].Value -match 'CharSet\s*=\s*CharSet\.Unicode') { continue }
            $ln = ($text.Substring(0, $base + $m.Index) -split "`n").Count
            $head = (($decl -split "`n")[0]).Trim()
            $lines += ('  [C5 FAIL] L' + $ln + ': ' + $head + ' —— 有 string 参数却没写 CharSet.Unicode（默认 Ansi ⇒ 按 ANSI 编组喂给 W 函数，名字会变乱码；解析期不报错，只有真跑才知道）')
            $fails++
        }
    }
    if ($script:csBlocks -gt 0) {
        $dllCheckedTotal += $dllChecked
        $lines += ('  C5: 已核对 ' + $dllChecked + ' 个带 string 参数的 [DllImport]（本文件共扫到 ' + $dllFound + ' 个 [DllImport]）')
    }

    $lines += ''
}

$lines += ('合计: 文件 ' + $targets.Count + ' · FAIL ' + $fails + ' · WARN ' + $warns + ' · C4 已核对引用 ' + $csRefsChecked + ' 处 · C5 已核对 ' + $dllCheckedTotal + ' 个带 string 的 [DllImport]')
$code = 0
if ($fails -gt 0) { $code = 1 } elseif ($warns -gt 0) { $code = 2 }
$lines += ('结论: ' + $(if ($code -eq 0) { '全绿' } elseif ($code -eq 1) { '有 FAIL —— 别拿去跑' } else { '只有 WARN（灰 ≠ 绿，请人看一眼）' }) + '  · 退出码 ' + $code)

$txt = $lines -join "`n"
if ($OutFile -ne '') {
    [System.IO.File]::WriteAllText($OutFile, $txt, (New-Object System.Text.UTF8Encoding $false))
} else {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $txt
}
exit $code
