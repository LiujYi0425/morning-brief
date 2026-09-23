# set-window-level.ps1 —— 把窗口压到顶层 Z 序最底（ADR-012）并加上 WS_EX_NOACTIVATE
# =====================================================================
# 为什么需要它
# ---------------------------------------------------------------------
# ADR-012 定了「置底顶层窗口」：卡片**不挂桌面层**，保持普通顶层窗口，
# 只把自己压到 Z 序最底（HWND_BOTTOM）并加 WS_EX_NOACTIVATE。
# 这两件事都在 Win32 层，而 Electron 44 的公开 API 里没有：
#   · `setAlwaysOnTop(false)` 只是"取消置顶"，**不会**排到其它窗口之下；
#   · `win.moveTop()` 是**置顶**方向，正好相反；
#   · `setSkipTaskbar` / `setFocusable` 都不碰 Z 序。
# ⇒ 只能直接调 SetWindowPos / SetWindowLongPtr。
#
# 为什么是 PowerShell 而不是原生模块（node-gyp / N-API）：
#   本工程对"引依赖前先问三个问题"（R-B05）的答案是——不加。一个原生模块意味着
#   编译工具链、每个 Electron ABI 重新构建、以及一份安装包体积。而这条操作
#   **冷路径、调用次数极少**（启动一次、唤起卡片时一次），几百毫秒完全可接受。
#   本工程已有两个 P/Invoke 型 .ps1 先例（win-display-facts / attach-to-desktop-layer）。
#
# ⚠️ 与 attach-to-desktop-layer.ps1 的关键区别：本脚本**不 SetParent**。
#    ADR-011（挂进 Progman/WorkerW）已被 A10 实测证伪 —— 窗口会被创建、能被命中，
#    但**不会被合成到屏幕上**。本脚本只动 Z 序，不改父子关系。
#
# ⚠️ BOM 是硬要求：本工程 lint-ps1.ps1 的 C3 检查会判 FAIL ——
#    PowerShell 5.1 在无 BOM 时按 ANSI 解码，本文件的中文注释会全乱。
#    编码由 tools/lint-ps1.ps1 与 npm run check 一起守住。
#
# 用法
# ---------------------------------------------------------------------
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/set-window-level.ps1 `
#              -ProcessId 12345 -Mode bottom
#
#   -ProcessId 目标进程 id。**必填**：本机可能有多个 electron.exe（多个窗口互不干扰）。
#   -Mode   bottom  = WS_EX_NOACTIVATE | SetWindowPos(HWND_BOTTOM)   ← ADR-012 要的
#           top     = 清掉 WS_EX_NOACTIVATE | SetWindowPos(HWND_TOP) ← 回退（对照用）
#           clear   = 只清 WS_EX_NOACTIVATE，不动 Z 序              ← 诊断用
#   -OutFile 可选。给了就把结果 JSON 写进去；不给则打到 stdout。
#
# ⚠️ 参数名是 -ProcessId，**不是** -Pid。
#    PowerShell 的变量名大小写不敏感，而 `$PID` 是**只读自动变量** ——
#    叫 `-Pid` 会在参数绑定阶段直接抛 VariableNotWritable，**脚本一行都跑不到**。
#    这不是推测：本工程 `tools/lint-ps1.ps1` 的 C1 检查当场抓住了它。
#
# 输出（JSON）
# ---------------------------------------------------------------------
#   { ok, mode, processId, hwnd, title, noActivateApplied, setWindowPosOk,
#     hwndBottom, exStyleChanged, errors[] }
#   ok=false 时 errors 非空 —— 调用方（src/main/win-level.js）据此降级，
#   **不允许**把"没置底成功"当成"置顶成功"（本工程对这类静默失败极敏感）。
# =====================================================================

param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [ValidateSet('bottom', 'top', 'clear')][string]$Mode = 'bottom',
  [string]$OutFile = '',
  # ★ 显式窗口句柄（十进制字符串）。**优先于 -ProcessId 的自动查找**。
  #   为什么必须有它：一个 Electron 进程有**多个**顶层窗口，而
  #   `Get-Process.MainWindowHandle` 只给其中一个。2026-09-22 真机实测就因此
  #   **把控制台当成卡片压了底**（hwnd=1246134 = "M0 地基验证控制台"），
  #   而脚本照常返回 ok=true / SetWindowPos=成功 —— 一次完全静默的错位。
  #   详见 src/main/win-level.js 里 toHwndArg() 的说明。
  #
  # ⚠️⚠️ 名字是 -WindowHandle，**不能叫 -Hwnd**。
  #   PowerShell 的变量名大小写不敏感，而下面第 1 步要用 `$targetHwnd` 装 IntPtr。
  #   若参数叫 `$Hwnd`，那句赋值会**把参数本身覆盖掉**（同一个变量），
  #   随后 `$Hwnd.Trim()` 就变成对 IntPtr 取属性 —— PowerShell 返回 $null 而**不报错**，
  #   于是整个 -Hwnd 分支静默失效。这个 bug 在本轮真机测试里被当场抓到：
  #   传 `-Hwnd 999999999` 时脚本报的是 `-Hwnd '0' 解析失败`（值已被覆盖）。
  #   ⇒ 参数名与局部变量名**必须一眼能区分**。同理，本地变量一律用 `$targetHwnd`。
  [string]$WindowHandle = ''
)

$ErrorActionPreference = 'Stop'
$errors = New-Object System.Collections.ArrayList

Add-Type -Namespace MbLevel -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

[DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

[DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

[DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
public static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

[DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
public static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool IsWindow(IntPtr hWnd);

[DllImport("user32.dll", SetLastError = true)]
public static extern bool IsWindowVisible(IntPtr hWnd);

[DllImport("user32.dll", SetLastError = true)]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

// 读窗口标题只为**留痕**（证明动的是哪个窗口）。CharSet.Unicode 不能省 ——
// StringBuilder 参数按 string 编组，而默认是 Ansi，即使函数名带 W 后缀也会乱码。
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
'@

# 32/64 位都要能跑：使用 IntPtr 的那个入口在 32 位宿主上会抛，故按指针宽度分派。
$is64 = [IntPtr]::Size -eq 8

function Get-ExStyle([IntPtr]$h) {
  if ($is64) { return [MbLevel.Native]::GetWindowLongPtr64($h, -20).ToInt64() }
  return [int64][MbLevel.Native]::GetWindowLong32($h, -20)
}

function Set-ExStyle([IntPtr]$h, [int64]$v) {
  if ($is64) {
    [void][MbLevel.Native]::SetWindowLongPtr64($h, -20, [IntPtr]$v)
  } else {
    [void][MbLevel.Native]::SetWindowLong32($h, -20, [int]$v)
  }
}

$WS_EX_NOACTIVATE = 0x08000000L
$HWND_BOTTOM = [IntPtr]1
$HWND_TOP = [IntPtr]0
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010
$SWP_NOOWNERZORDER = 0x0200

$targetHwnd = [IntPtr]::Zero
$title = ''

# ---- 1. 找窗口：**显式句柄优先**，没有才退回 pid ---------------------------
# ★ 顺序不能反。退回 pid 是一条**会猜错**的路径（一个进程可能有好几个顶层窗口），
#   而它猜错时不会报错 —— 只会安静地动错窗口。见 -WindowHandle 参数处的说明。
# ⚠️ 本地变量名是 $targetHwnd 而不是 $targetHwnd —— 避免与参数撞名（见参数处说明）。
$hadExplicitHwnd = $false
try {
  $rawHandle = if ($null -eq $WindowHandle) { '' } else { ([string]$WindowHandle).Trim() }
  if ($rawHandle -ne '') {
    $hadExplicitHwnd = $true
    $parsed = 0L
    if ([long]::TryParse($rawHandle, [ref]$parsed) -and $parsed -gt 0) {
      $targetHwnd = [IntPtr]$parsed
      if (-not [MbLevel.Native]::IsWindow($targetHwnd)) {
        [void]$errors.Add("-WindowHandle $rawHandle 不是一个有效窗口句柄")
        $targetHwnd = [IntPtr]::Zero
      } else {
        $sb = New-Object System.Text.StringBuilder 512
        [void][MbLevel.Native]::GetWindowTextW($targetHwnd, $sb, $sb.Capacity)
        $title = $sb.ToString()
      }
    } else {
      [void]$errors.Add("-WindowHandle '$rawHandle' 解析失败（必须是十进制正整数）")
    }
  }

  if (-not $hadExplicitHwnd) {
    $proc = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
      $targetHwnd = $proc.MainWindowHandle
      $title = [string]$proc.MainWindowTitle
      # 走兜底路径时**必须留痕**：这条路径会猜错，而猜错是静默的
      [void]$errors.Add(
        "未提供 -WindowHandle，退回用 MainWindowHandle 自动查找 ⇒ 拿到 hwnd=$($targetHwnd.ToInt64()) " +
        "title='$title'。⚠️ 该进程若有多个顶层窗口，这个选择可能是错的 —— " +
        "建议调用方显式传 -WindowHandle。")
    } else {
      [void]$errors.Add("processId=$ProcessId 的 MainWindowHandle 为空（窗口可能还没出现，或只有子窗口）")
    }
  }
} catch {
  [void]$errors.Add("拿不到 processId=$ProcessId 的进程：$($_.Exception.Message)")
}

if ($targetHwnd -eq [IntPtr]::Zero) {
  $result0 = [ordered]@{
    ok = $false; mode = $Mode; processId = $ProcessId; hwnd = 0; title = ''
    noActivateApplied = $false; setWindowPosOk = $false; hwndBottom = $false
    exStyleBefore = 0; exStyleAfter = 0; exStyleChanged = $false
    errors = @($errors)
  }
  $json0 = ($result0 | ConvertTo-Json -Compress -Depth 4)
  if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, $json0, (New-Object System.Text.UTF8Encoding $false)) }
  Write-Output $json0
  exit 1
}

# ---- 2. 校验句柄确实是我们要的那个进程的窗口（防串到别的窗口上）---------------
try {
  $owner = [uint32]0
  [void][MbLevel.Native]::GetWindowThreadProcessId($targetHwnd, [ref]$owner)
  if ($owner -ne [uint32]$ProcessId) {
    [void]$errors.Add("句柄归属校验失败：hwnd 属于 pid=$owner，而请求的是 processId=$ProcessId")
  }
} catch {
  [void]$errors.Add("GetWindowThreadProcessId 失败：$($_.Exception.Message)")
}

# ---- 3. 改扩展样式（WS_EX_NOACTIVATE）--------------------------------------
$exBefore = 0
$exAfter = 0
$noActivateApplied = $false
try {
  $exBefore = Get-ExStyle $targetHwnd
  $exAfter = $exBefore
  if ($Mode -eq 'clear' -or $Mode -eq 'top') {
    # 清掉 NOACTIVATE 位。先取反再与，避免把别的扩展样式位误伤。
    $exAfter = $exBefore -band (-bnot $WS_EX_NOACTIVATE)
  } else {
    $exAfter = $exBefore -bor $WS_EX_NOACTIVATE
  }
  if ($exAfter -ne $exBefore) {
    Set-ExStyle $targetHwnd $exAfter
  }
  $readBack = Get-ExStyle $targetHwnd
  $noActivateApplied = (($readBack -band $WS_EX_NOACTIVATE) -ne 0)
} catch {
  [void]$errors.Add("改扩展样式失败：$($_.Exception.Message)")
}

# ---- 4. 动 Z 序 ------------------------------------------------------------
# ⚠️ 顺序很重要（2026-09-22 在 attach 脚本上踩过）：SetWindowPos 的
#    hWndInsertAfter 必须**明确**传 HWND_BOTTOM/HWND_TOP。
#    传 NULL 等于 HWND_TOP —— 会把刚压到底的窗口重新提到最顶，
#    而读数看起来还很正常（假读数）。
$setPosOk = $false
$isBottom = $false
try {
  switch ($Mode) {
    'bottom' {
      $setPosOk = [MbLevel.Native]::SetWindowPos(
        $targetHwnd, $HWND_BOTTOM, 0, 0, 0, 0,
        ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE -bor $SWP_NOOWNERZORDER))
      $isBottom = $setPosOk
    }
    'top' {
      $setPosOk = [MbLevel.Native]::SetWindowPos(
        $targetHwnd, $HWND_TOP, 0, 0, 0, 0,
        ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE -bor $SWP_NOOWNERZORDER))
    }
    'clear' {
      # 只清样式，不动 Z 序 —— 对照运行要用它把窗口留在原处
      $setPosOk = $true
    }
  }
  if (-not $setPosOk) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [void]$errors.Add("SetWindowPos 返回 false（Win32 错误码 $code）")
  }
} catch {
  [void]$errors.Add("SetWindowPos 抛错：$($_.Exception.Message)")
}

# ---- 5. 结论 ---------------------------------------------------------------
# 判据分开报：样式改了、Z 序动了，是两件独立的事，不能用一个布尔糊过去。
$ok = ($errors.Count -eq 0) -and $setPosOk
if ($Mode -eq 'bottom' -and -not $noActivateApplied) { $ok = $false }

$result = [ordered]@{
  ok = $ok
  mode = $Mode
  processId = $ProcessId
  hwnd = $targetHwnd.ToInt64()
  title = $title
  noActivateApplied = $noActivateApplied
  setWindowPosOk = $setPosOk
  hwndBottom = $isBottom
  exStyleBefore = ('0x{0:X8}' -f $exBefore)
  exStyleAfter = ('0x{0:X8}' -f $exAfter)
  exStyleChanged = ($exAfter -ne $exBefore)
  errors = @($errors)
}

$json = ($result | ConvertTo-Json -Compress -Depth 4)
if ($OutFile) {
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
}
Write-Output $json
if ($ok) { exit 0 } else { exit 1 }
