<#
  attach-to-desktop-layer.ps1
  ------------------------------------------------------------------
  A10「桌面层挂载可行性」的**挂载实验**（第 1 步：只做侦察与「自己人」的挂载）。

  背景（已由 desktop-layer-facts.ps1 v3 判定，2026-09-21）：
    本机 = Windows 11 25H2 (build 26200.9457) = **24H2 派**，三条 modern 签名全中：
      s1 Progman 带 WS_EX_NOREDIRECTIONBITMAP           ✔
      s2 SHELLDLL_DefView 是 Progman 直属子窗口且 LAYERED ✔
      s3 Progman 内部有 WorkerW 子窗口                    ✔
    实测句柄：Progman = 65828 ／ DefView = 65836（其唯一子窗口 = SysListView32）
              Progman 内的 WorkerW = 131734（visible，exStyle 含 WS_EX_TRANSPARENT）

  A10 四条判据（任一不成立即回退 ADR-005）：
    ① 被覆盖     ② 仍能点击     ③ backdrop-filter 仍生效     ④ 缩放仍正确

  **当前进展（2026-09-22 08:40 实测，自建测试条 540×66 物理像素 = 360×44 DIP @150%）**：
    - 建窗口 / SetParent / SetLayered / 强制重绘：**全部成功**（`steps[].ok` 皆 true）。
    - 判据④：`sizePreserved = true` —— 挂载后物理尺寸没被系统改掉。**通过。**
    - 判据①：**不成立**。Z 序 = below（Ivy 原方案：排在 SHELLDLL_DefView 之下）时人眼看不见。
    - 判据②机器代理：**false** —— `WindowFromPoint(窗口中心)` 返回的是 `SHELLDLL_DefView`(65836)
      而不是我们 ⇒ 鼠标会打到 DefView。**这条是活查询、不受「桌面快照」影响**，
      所以「看不见」不是快照没冲掉，而是 DefView 确实压在我们上面。
    - ⇒ 故新增 `-ZOrder`，**默认改为 above**（排在 DefView 之上）。代价：卡片会盖住其区域内的
      桌面图标；收益：卡片真的显示在桌面上，而普通窗口仍盖在它上面 —— 这正是「桌面卡片」要的形态。

  为什么先拿「假窗口」试，而不是直接挂 Electron 卡片：
    挂载要同时赌两件独立的事 ——「桌面层收不收这个窗口」和「Electron 被跨进程
    重设父窗口之后还活不活」。两件一起赌，失败了分不清是哪件。所以第 1 步先用
    本进程自建的测试窗口（同进程 SetParent，风险为零），把第①条先问清楚。

  模式：
    -Mode probe     只读侦察。列出 Progman / 候选宿主 / 相关窗口状态。**不改任何东西。**
    -Mode mount     自建一条测试窗口并挂进桌面层，`-HoldSeconds` 秒后自动还原销毁。
                    需要人看一眼屏幕回答判据①。脚本会自己记录判据②④的机器判据。
    -Mode attach    把**指定的真实窗口**（-Hwnd）挂进桌面层。⚠️ 跨进程重设父窗口，
                    可能影响对方的输入队列 —— 第二步再用。
    -Mode detach    撤销 attach（还原父窗口与 WS_CHILD/WS_POPUP 样式与坐标）。

  Z 序（-ZOrder，只对 -Target progman 有意义）：
    above = 排在 SHELLDLL_DefView **之上** —— **默认**，2026-09-22 起
    below = 排在 SHELLDLL_DefView **之下** —— Ivy 原方案，**2026-09-22 实测看不见，已证伪**

  重要设计约束（吃过亏，别删）：
    ⚠️ 凡是返回数组的函数，调用点一律用 `@()` 包住 —— PowerShell 会把「只有一个
       元素的数组」解包成标量，`.Count` 就变成哈希表键数（上一版脚本因此输出过
       `defviewFromProgmanCount = 10` 这种看着很正常的假数字）。
    ⚠️ 不给「取不到句柄」设静默兜底。IntPtr.Zero 传给 FindWindowEx = 枚举整个桌面，
       会把垃圾伪装成数据。取不到就 `ok=false` 大声失败。
    ⚠️ 一切写操作（SetParent / SetWindowLongPtr / SetWindowPos / ShowWindow）
       都先快照原状态，且**在 finally 里还原**。

    ⚠️ 参数名不许叫 -Host（踩过，代价 = 脚本一行都跑不到）：
       $Host 是 PowerShell 的**只读自动变量**，`[string]$Host = 'x'` 会在
       **参数绑定阶段**直接抛 VariableNotWritable。
       同类危险名字：$Error / $Input / $Args / $MyInvocation / $PSScriptRoot /
       $PSCommandPath / $PWD / $HOME / $PID / $This / $Matches。
       ⇒ 已改用 -Target。离线检查见 tools/lint-ps1.ps1（纯 AST 解析，不编译 C#）。
  输出：JSON 到 -OutFile（默认 .\report\desktop-attach-<mode>.json —— **按模式分开**，
        免得 probe 的留痕被随后的 mount 整份覆盖，2026-09-21 真发生过）

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\attach-to-desktop-layer.ps1 -Mode probe
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\attach-to-desktop-layer.ps1 -Mode mount -HoldSeconds 25
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\attach-to-desktop-layer.ps1 -Mode mount -ZOrder below -HoldSeconds 25     # 复现 2026-09-22 那次"看不见"
    powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\attach-to-desktop-layer.ps1 -Mode mount -Target workerw -HoldSeconds 25   # A/B 对照

  ⚠️ 跑 mount 之前先按 **Win+D** 把所有窗口最小化露出桌面 —— 这条窗口挂在桌面层里，
     被别的窗口挡住就等于看不见，会把「挂载成功」误判成「被覆盖」。
  ⭐ 2026-09-22（revision 3）—— 追查「above 也看不见」，结论**不在桌面层**：
    真因在这条测试条自己身上：脚本全程在主线程 Start-Sleep，**从不抽消息**；
    而 "Button" 是系统控件，绘制由**本线程消息泵**驱动 ⇒ 收不到 WM_PAINT
    ⇒ 窗口存在（IsWindowVisible=true）、能被 WindowFromPoint 命中，但**屏幕上从未出现过**。
    ⇒ 此前 3 次（below x2 / above x1）的「人眼看不见」**都不是桌面层的结论**；
      判据① 的正确状态是 **UNABLE（未测到）**，此前记成「不成立」是错的。
    ⇒ revision 3 起新增：
       1) 真消息泵 PumpFor()（PeekMessage/TranslateMessage/DispatchMessage）；
       2) ForcePaint()（RedrawWindow + UpdateWindow），不再用裸 Start-Sleep 等重绘；
       3) **屏幕像素取样** SampleRegion()（GetDC(NULL)+GetPixel），把判据① 从
          「人眼看一眼」改成「机器读数 + 人眼复核」，人不再是唯一的传感器；
       4) **内建正对照**：建窗后、挂载前先采一次（此时还是顶层 popup）——
          若连这一次都采不到变化，说明是"我们画不出窗口"，那挂载后看不见就
          不能算桌面层的结论（判 UNABLE 而不是 FAIL）。
    判据① 三态：PASS / FAIL / UNABLE。**UNABLE 不许记成通过，也不许记成不成立。**

  ⭐⭐ 2026-09-22 最终实测结论（revision 3 · 6 次运行 · 判据的分辨力经过校准）：
    **判据① = FAIL。** 挂进桌面层的窗口**存在、尺寸不变、能被 WindowFromPoint 命中，
    但不会被合成到屏幕上。** 四种配置全部如此：
      progman+layered+above / progman+无layered+above / workerw+layered+above / progman+layered+below
    每次的"已知生效"正对照（同一窗口、同一段绘制代码、还没挂载时）都稳定读到 nearRatio 0.953；
    挂载后读到 0.491 = 该块区域的壁纸基准值，增量 0.000。
    ⇒ 「看不见」既不是绘制问题（正对照证真），也不只是 Z 序问题（above 的 ourIndex=0 在 DefView 之上）；
      是**这个桌面层根本不在屏幕上呈现子窗口**。
    ⇒ 机械成因**未确证**。推断与 Progman 带 WS_EX_NOREDIRECTIONBITMAP（无重定向位图 / DComp 合成）有关，
      但**这只是推测，不是已取证的结论**。
    ⇒ 覆盖缺口：只在本机（Win11 **25H2** build 26200.9457）验过。社区 24H2 配方（below + layered，
      见 rooger / lulu6432 的文章）在本机同样不成立 ⇒ **不能外推到其它 Windows 版本或显示器组合**。
    ⇒ 对 ADR-011 的含义：既然「挂进桌面层」不可行，退路是**置底顶层窗口（HWND_BOTTOM）**
      —— 不挂进 Progman，只保持顶层窗口 + 把自己压到顶层 Z 序的最底。

  ✅ 2026-09-22 追加实测（`-Placement bottom`）：**置底顶层窗口可行。**
    读数见 report/desktop-attach-mount.rev4b-bottom.json（stage=complete · errors 为空）：
      · 顶层 Z 序：ourIndex = 419 / progmanIndex = 420（共 421 个顶层窗口）
        => **紧贴桌面之上、排在其他所有窗口之下**（gapToDesktop = 1，placeBottomEffective = true）。
      · 判据① **PASS**：power = 0.462；挂载后 nearRatio = 0.950，比窗口前基准 0.491 高 0.459（阈值 0.231）。
      · 判据②（代理）**成立**：WindowFromPoint 命中中心点 = 我们（hitClass = Button，hitIsUsOrOurChild = true）。
      · sizePreserved = true；isTopLevelWindow = true（父窗口 = 0，没有挂进任何宿主）。
    ⇒ 与「桌面层」的关键差别：**它是个正常的顶层窗口，所以会被任何普通窗口盖住** ——
      这正是"桌面卡片"该有的行为（用户一开窗口它就让位），但也意味着除了 Win+D 露桌面之外，
      它随时可能被遮挡。这不是缺陷，是形态定义。
    ⚠️ 踩坑（第一次跑出来的是**假读数**）：`MoveTo()` 传的 `hWndInsertAfter` 是 NULL（= **HWND_TOP**），
      它会把刚压到底的窗口**重新提到最顶** ⇒ 顺序必须是「先定位、后压底」。第一次顺序写反，
      读数 ourIndex = 36 / progmanIndex = 422 —— 看着"也在桌面之上"，其实是普通顶层窗口，
      **根本没测到置底**。
      ⇒ 建规则：凡"置底"类实验，必须用 `gapToDesktop` 这种**距离**读数验收；
         `weAreAboveDesktop` 这个布尔对"排在最顶"和"排在最底"**同样为真**，单独看它会漏掉这个 bug。
    ⚠️ 覆盖缺口：仍只在本机 Win11 **25H2** 上验过，不可外推；且只测了"静止可见"，
      没测与 Win+D / 全屏 / 任务栏自动隐藏的交互。

    判定口径（2026-09-22 修正）：主判据用 nearRatio，参考系取**同一块矩形的"窗口前基准"**。
      分辨力自检 power = nearRatio(顶层 popup) - nearRatio(窗口前基准)：
        power < 0.20 => 判 UNABLE（壁纸太接近按钮面灰，这套判据本次没有分辨力，不许硬猜）
        PASS 规则：挂载后 nearRatio 相对基准的增量 >= power / 2
      端点实测（5 次）：已知生效 power = 0.422~0.459；已知失效 增量 = -0.003~+0.053。
      **不拿「抽到的消息数」当门槛**（ForcePaint 是同步绘制，0 条属正常）。
      **不拿"对照区"当参考**（它不是同一块壁纸，实测 nearRatio 漂到 0.789）。

#>

param(
    [ValidateSet('probe', 'mount', 'attach', 'detach')]
    [ValidateSet('probe', 'mount', 'attach', 'detach')]
    [string]$Mode = 'probe',

    # 宿主策略：progman = 直接挂 Progman，并把 Z 序排到 DefView 之下（Ivy 路线）—— **主路线**
    #           workerw = Progman 内部那个 WorkerW（Lively 路线）—— A/B 对照
    # ⚠️ 为什么默认 progman：实测 Progman 内部那个 WorkerW(131734) 的 style = 0x58000000，
    #    含 **WS_DISABLED**；父窗口 disabled 会压制子窗口输入 ⇒ 拿它当宿主，
    #    判据②「仍能点击」大概率不成立。Progman 自己是 enabled 的。
    [ValidateSet('workerw', 'progman')]
    [string]$Target = 'progman',

    # Z 序：above = 排在 SHELLDLL_DefView **之上**（卡片压住桌面图标，但**看得见**）
    #        below = 排在 SHELLDLL_DefView **之下**（Ivy 原方案）
    # ⚠️ 2026-09-22 实测：below 时人眼看不见，且 WindowFromPoint 命中 DefView 而非我们
    #    ⇒ below 这条路在本机（25H2 / 24H2 派桌面层）走不通，故默认改为 above。
    [ValidateSet('below', 'above')]
    [string]$ZOrder = 'above',

    # 落位方式（只对 -Mode mount 有意义）：
    #   wallpaper = 挂进桌面层（Progman / 它内部的 WorkerW）—— **A10 实测判据① FAIL**，保留以便复现
    #   bottom    = **保持顶层窗口**，只把自己压到 Z 序最底（HWND_BOTTOM）+ WS_EX_NOACTIVATE
    #               —— ADR-011 的退路：视觉上等同"贴在桌面上"，且**能收点击**。
    #               **2026-09-22 已实测可行**（详见文件头「追加实测」一节）。
    #               代价：任何普通窗口都会盖住它（这正是"桌面卡片"该有的行为）。
    #               注意：压底必须放在**定位之后** —— MoveTo 用 HWND_TOP，会把它顶回去。
    [ValidateSet('wallpaper', 'bottom')]
    [string]$Placement = 'wallpaper',

    # attach / detach 的目标窗口
    [string]$Hwnd = '',

    # 测试窗口几何（物理像素）。默认对齐卡片折叠态：360×44 DIP @150% = 540×66
    [int]$Width = 540,
    [int]$Height = 66,
    [int]$X = -1,
    [int]$Y = 120,

    # 挂上之后保持多久（秒），到点自动还原
    [int]$HoldSeconds = 25,

    # 不额外挂 WS_EX_LAYERED + SetLayeredWindowAttributes（用来做 A/B 对照）
    [switch]$NoLayered,

    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

# ⚠️ 文件名带 mode —— 2026-09-21 踩过：probe 与 mount 原先写同一个默认文件，
#    probe 的留痕被随后的 mount **整份覆盖**（正是项目里"要跑多次的验收必须先归档"那条教训）。
#    现在各模式各写各的，跑完不会互相吃掉。
if ($OutFile -eq '') {
    $OutFile = Join-Path (Split-Path -Parent (Split-Path -Parent $PSCommandPath)) ('report\desktop-attach-' + $Mode + '.json')
}

$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class DeskAttach {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindWindowExW(IntPtr hWndParent, IntPtr hWndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowEnabled(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    /* ⛔ 2026-09-21 真踩：这一行原来漏了 CharSet.Unicode。
       DllImport 的 CharSet **默认是 Ansi** ⇒ 按方法名仍能绑到 W 函数，但 string 参数会按
       **ANSI 字节** 编组后喂给一个**要 UTF-16 的** W 函数 ⇒ 类名 "Button" 变成一串乱码字符
       ⇒ 返回 NULL（ERROR_CANNOT_FIND_WND_CLASS 1407）。
       同一份 C# 里别的 DllImport 都老实写了 CharSet.Unicode，只有它漏了 ——
       结果就是"别的全对、只有建窗口这一步失败"，极难猜。tools/lint-ps1.ps1 的 C5 专盯这一类。 */
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateWindowExW(uint dwExStyle, string lpClassName, string lpWindowName,
        uint dwStyle, int X, int Y, int nWidth, int nHeight, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetModuleHandleW(string lpModuleName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetThreadDesktop(uint dwThreadId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetUserObjectInformationW(IntPtr hObj, int nIndex, StringBuilder pvInfo, uint nLength, out uint lpnLengthNeeded);

    /* 把本进程切成「per-monitor DPI 感知 v2」。
       返回 1 = 新 API 生效，2 = 退回旧 API 生效，0 = 两者都没成（可能已被别处设过）。 */
    public static int EnablePerMonitorDpi() {
        if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return 1;
        if (SetProcessDPIAware()) return 2;
        return 0;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint crKey, byte bAlpha, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr WindowFromPoint(POINT Point);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;

    public const long WS_CHILD   = 0x40000000L;
    public const long WS_POPUP   = 0x80000000L;
    public const long WS_VISIBLE = 0x10000000L;

    public const long WS_EX_LAYERED    = 0x00080000L;
    public const long WS_EX_TOOLWINDOW = 0x00000080L;

    public const uint SWP_NOSIZE       = 0x0001;
    public const uint SWP_NOMOVE       = 0x0002;
    public const uint SWP_NOACTIVATE   = 0x0010;
    public const uint SWP_SHOWWINDOW   = 0x0040;
    public const uint SWP_NOZORDER     = 0x0004;

    public const uint LWA_ALPHA = 0x0002;
    public const uint GA_ROOT   = 2;

    public const int SW_HIDE     = 0;
    public const int SW_SHOWNA   = 8;
    public const int SW_SHOWNORMAL = 1;

    /* 桌面窗口。24H2 上类名仍然是 "Progman"（本机实测 hwnd 65828，带 WS_EX_NOREDIRECTIONBITMAP）。
       ⚠️ 这个方法必须真的在这里声明出来 —— 调用点写的是 [DeskAttach]::Progman()，
       而 PowerShell 在**解析期不会**报「方法不存在」，只有真跑到那一行才炸
       MethodInvocationException。（tools/lint-ps1.ps1 的 C4 专查这一类。） */
    public static IntPtr Progman() { return FindWindowW("Progman", null); }

    public static string ClassOf(IntPtr h) {
        var sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }

    public static string TextOf(IntPtr h) {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    public static string RectStr(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return "ERR";
        return string.Join(",", new string[] {
            r.Left.ToString(), r.Top.ToString(), r.Right.ToString(), r.Bottom.ToString(),
            (r.Right - r.Left).ToString() + "x" + (r.Bottom - r.Top).ToString()
        });
    }

    /* 单行描述：hwnd|cls|text|visible|enabled|parent|style|exStyle|rect */
    public static string Desc(IntPtr h) {
        long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
        long ex    = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
        string t = TextOf(h);
        if (t.Length > 60) t = t.Substring(0, 60);
        return string.Join("\u0001", new string[] {
            h.ToString(),
            ClassOf(h),
            t,
            IsWindowVisible(h) ? "1" : "0",
            IsWindowEnabled(h) ? "1" : "0",
            GetParent(h).ToString(),
            "0x" + style.ToString("X8"),
            "0x" + ex.ToString("X8"),
            RectStr(h)
        });
    }

    public static string[] DirectChildDescs(IntPtr parent) {
        var res = new List<string>();
        if (parent == IntPtr.Zero) return res.ToArray();
        IntPtr c = IntPtr.Zero;
        while (true) {
            c = FindWindowExW(parent, c, null, null);
            if (c == IntPtr.Zero) break;
            res.Add(Desc(c));
        }
        return res.ToArray();
    }

    /* 第一个直接子窗口里匹配类名的；找不到返回 IntPtr.Zero。**绝不拿 0 当 parent 用。** */
    public static IntPtr FirstChildOfClass(IntPtr parent, string cls) {
        if (parent == IntPtr.Zero) return IntPtr.Zero;
        IntPtr c = IntPtr.Zero;
        while (true) {
            c = FindWindowExW(parent, c, cls, null);
            if (c == IntPtr.Zero) break;
            if (GetParent(c) == parent) return c;
        }
        return IntPtr.Zero;
    }

    public static string[] TopLevelByClass(string cls) {
        var res = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (ClassOf(h) == cls) res.Add(Desc(h));
            return true;
        }, IntPtr.Zero);
        return res.ToArray();
    }

    /* 建一条测试窗口。刻意用系统自带的 "Button" 类：
       它自己会画（有可见的 3D 面），**不需要我们写 WndProc / 注册窗口类** ——
       少写一段无法自测的 C#，就少一个坑。

       ⚠️ 2026-09-21：这个函数原先**只返回 0、不记原因**，于是阿木那边"跑完没报错"，
       而 JSON 里写的是 ok=false —— 失败的脚本装成了成功。⇒ 现在逐个候选尝试，
       **每一次都记 GetLastError**，并把「怎么建成功的 / 为什么全失败」原样回报。 */
    public static string CreateTestWindowEx(int x, int y, int w, int h, out IntPtr hwnd) {
        hwnd = IntPtr.Zero;
        var log = new List<string>();
        IntPtr hInst = GetModuleHandleW(null);
        string[] classes = new string[] { "Button", "Static" };
        for (int i = 0; i < classes.Length; i++) {
            for (int k = 0; k < 2; k++) {
                IntPtr inst = (k == 0) ? hInst : IntPtr.Zero;
                hwnd = CreateWindowExW((uint)WS_EX_TOOLWINDOW, classes[i], "M0 · A10 挂载测试条",
                    (uint)(WS_POPUP | WS_VISIBLE), x, y, w, h, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
                int err = Marshal.GetLastWin32Error();
                log.Add(classes[i] + "/hInst=" + ((k == 0) ? "module" : "null") +
                    " => hwnd=" + hwnd.ToString() + " GetLastError=" + err);
                if (hwnd != IntPtr.Zero) return string.Join(" | ", log.ToArray());
            }
        }
        return string.Join(" | ", log.ToArray());
    }

    /* 本进程挂在哪个桌面？正常应是 "Default"；若不然，说明会话/桌面环境本身有问题。 */
    public static string DesktopName() {
        IntPtr h = GetThreadDesktop(GetCurrentThreadId());
        if (h == IntPtr.Zero) return "GetThreadDesktop FAILED err=" + Marshal.GetLastWin32Error();
        var sb = new StringBuilder(256);
        uint need = 0;
        if (!GetUserObjectInformationW(h, 2, sb, 512, out need))
            return "GetUserObjectInformation FAILED err=" + Marshal.GetLastWin32Error();
        return sb.ToString();
    }

    /* 把 child 变成 parent 的 WS_CHILD 子窗口。返回是否成功（含复核）。 */
    public static bool Reparent(IntPtr child, IntPtr parent) {
        long st = GetWindowLongPtr(child, GWL_STYLE).ToInt64();
        long newSt = (st & ~WS_POPUP) | WS_CHILD;
        SetWindowLongPtr(child, GWL_STYLE, new IntPtr(newSt));
        IntPtr prev = SetParent(child, parent);
        return GetParent(child) == parent;
    }

    /* 还原成顶层 popup */
    public static bool Unparent(IntPtr child, IntPtr desktopRoot) {
        long st = GetWindowLongPtr(child, GWL_STYLE).ToInt64();
        long newSt = (st & ~WS_CHILD) | WS_POPUP;
        SetParent(child, IntPtr.Zero);
        SetWindowLongPtr(child, GWL_STYLE, new IntPtr(newSt));
        return GetParent(child) == IntPtr.Zero;
    }

    public static bool PlaceBelow(IntPtr child, IntPtr insertAfter) {
        return SetWindowPos(child, insertAfter, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    public static bool MoveTo(IntPtr child, int x, int y) {
        return SetWindowPos(child, IntPtr.Zero, x, y, 0, 0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    /* 24H2 上桌面上会盖一层「桌面快照」，强制 DefView 重绘把它冲掉 */
    public static bool ForceDefviewRepaint(IntPtr defview) {
        if (defview == IntPtr.Zero) return false;
        ShowWindow(defview, SW_HIDE);
        // 给 explorer 侧留一次消息循环的余量（rooger 的原始配方是 Sleep(0)，这里放宽到 30ms）
        System.Threading.Thread.Sleep(30);
        ShowWindow(defview, SW_SHOWNORMAL);
        return true;
    }

    /* exStyle 位测试。⚠️ 别拿 PowerShell 侧那个 "0x……" 字符串去做 -band，会炸。 */
    public static bool HasEx(IntPtr h, long flag) {
        return (GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64() & flag) != 0L;
    }

    public static IntPtr HitAt(int x, int y) {
        POINT p; p.X = x; p.Y = y;
        return WindowFromPoint(p);
    }

    /* ============ 2026-09-22 新增：消息泵 / 强制重绘 / 屏幕像素取样 ============ */

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public POINT pt;
    }

    [DllImport("user32.dll")]
    private static extern bool PeekMessageW(out MSG lpMsg, IntPtr hWnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessageW(ref MSG lpMsg);
    [DllImport("user32.dll")]
    public static extern bool UpdateWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprcUpdate, IntPtr hrgnUpdate, uint flags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")]
    private static extern uint GetPixel(IntPtr hdc, int x, int y);

    public const uint PM_REMOVE       = 0x0001;
    public const uint RDW_INVALIDATE  = 0x0001;
    public const uint RDW_ALLCHILDREN = 0x0080;
    public const uint RDW_UPDATENOW   = 0x0100;
    public const uint CLR_INVALID     = 0xFFFFFFFF;

    /* 真正的「抽消息」：PeekMessage -> TranslateMessage -> DispatchMessage。
       ⛔ 2026-09-22 追了三个回合才定位的真因：
          本脚本全程在主线程 Start-Sleep，**一次消息都不抽**；而测试窗口用的是系统自带的
          "Button" 类，它的**绘制由本线程的消息泵驱动** ⇒ 永远收不到 WM_PAINT
          ⇒ 窗口存在（IsWindowVisible=true）、能被 WindowFromPoint 命中，
            但**屏幕上从未出现过**。
          ⇒ 此前 3 次（below x2 / above x1）的「人眼看不见」**都不是桌面层的结论**，
            而是这条测试条自己没被画出来。判据① 的真实状态是 UNABLE（未测到）。
       返回值 = 抽掉并派发的消息条数。**0 是一个有效信号**：泵没跑起来，本次可见性判定无效。 */
    public static int PumpFor(int ms) {
        int n = 0;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        MSG m;
        while (sw.ElapsedMilliseconds < ms) {
            bool got = false;
            while (PeekMessageW(out m, IntPtr.Zero, 0, 0, PM_REMOVE)) {
                got = true;
                TranslateMessage(ref m);
                DispatchMessageW(ref m);
                n++;
            }
            if (!got) System.Threading.Thread.Sleep(10);
        }
        return n;
    }

    /* 立刻把重绘做完，不等消息队列轮询到我们 */
    public static void ForcePaint(IntPtr h) {
        RedrawWindow(h, IntPtr.Zero, IntPtr.Zero, RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
        UpdateWindow(h);
    }

    /* 屏幕像素取样。返回 "avgR,avgG,avgB,n,nearRatio,bad"：
         avg*      = 取样点的平均通道值
         n         = 成功取到的样本数
         nearRatio = 落在「参考色 +- tol」范围内的样本占比
         bad       = GetPixel 失败的样本数（失败返回 CLR_INVALID，**单独计数，不静默当黑**）
       取的是**屏幕**（GetDC(NULL)）—— 也就是 DWM 合成之后的真实画面，
       这正是判据①「有没有真的出现在屏幕上」要问的东西。 */
    public static string SampleRegion(int x, int y, int w, int h, int step,
                                      int refR, int refG, int refB, int tol) {
        if (step < 1) step = 1;
        IntPtr dc = GetDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return "DC_FAIL";
        long sr = 0, sg = 0, sb = 0;
        int n = 0, near = 0, bad = 0;
        for (int yy = y; yy < y + h; yy += step) {
            for (int xx = x; xx < x + w; xx += step) {
                uint c = GetPixel(dc, xx, yy);
                if (c == CLR_INVALID) { bad++; continue; }
                int r = (int)(c & 0xFF);
                int g = (int)((c >> 8) & 0xFF);
                int b = (int)((c >> 16) & 0xFF);
                sr += r; sg += g; sb += b; n++;
                if (Math.Abs(r - refR) <= tol && Math.Abs(g - refG) <= tol && Math.Abs(b - refB) <= tol) near++;
            }
        }
        ReleaseDC(IntPtr.Zero, dc);
        if (n == 0) return "NO_SAMPLE,bad=" + bad;
        return (sr / n) + "," + (sg / n) + "," + (sb / n) + "," + n + "," +
               ((double)near / (double)n).ToString("F3") + "," + bad;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetTopWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    public const uint GW_HWNDNEXT     = 0x0002;
    public const long WS_EX_NOACTIVATE = 0x08000000L;

    /* HWND_BOTTOM = 1：把自己压到**顶层 Z 序的最底**（但在桌面 Progman 之上，见 TopLevelZOrder）。
       这是 ADR-011 的候选退路：不挂进桌面层，只保持顶层 + 压到底。 */
    public static bool PlaceBottom(IntPtr h) {
        return SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    /* 顶层窗口的 Z 序清单（自顶向下）：hwnd \u0001 类名 \u0001 visible。
       用途：把"我们到底在桌面之上还是之下"变成**测出来的事实** —— 置底窗口若排在 Progman 之下，
       就必然被桌面盖住，那本次结论与绘制/消息泵无关。 */
    public static string[] TopLevelZOrder() {
        var res = new List<string>();
        IntPtr h = GetTopWindow(IntPtr.Zero);
        int guard = 0;
        while (h != IntPtr.Zero && guard < 4000) {
            res.Add(h.ToString() + "\u0001" + ClassOf(h) + "\u0001" + (IsWindowVisible(h) ? "1" : "0"));
            h = GetWindow(h, GW_HWNDNEXT);
            guard++;
        }
        return res.ToArray();
    }
    public static int ScreenW() { return GetSystemMetrics(0); }   // SM_CXSCREEN
    public static int ScreenH() { return GetSystemMetrics(1); }   // SM_CYSCREEN
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp

# ============ 环境自证：DPI 感知（必须抢在创建任何窗口之前） ============
# ⚠️ 为什么要先切 DPI：PowerShell 5.1 默认是 **DPI 不感知** 的 —— 在 150% 缩放下它会看到
#    一个 1707×1067 的"虚拟桌面"（= 实际 2560×1600 ÷ 1.5）。而 Electron 卡片是 DPI 感知的
#    ⇒ 若我们在虚拟坐标里量尺寸，判据④「缩放仍正确」的读数会差 1.5 倍、与真实卡片不可比。
#    （2026-09-21 实测 ScreenW() 返回 1707，就是这么来的。）
$screenBeforeDpi = [ordered]@{ cx = [DeskAttach]::ScreenW(); cy = [DeskAttach]::ScreenH() }
$dpiMode         = [DeskAttach]::EnablePerMonitorDpi()
$screenAfterDpi  = [ordered]@{ cx = [DeskAttach]::ScreenW(); cy = [DeskAttach]::ScreenH() }

function ConvertFrom-Desc {
    param([string]$Raw)
    if ([string]::IsNullOrEmpty($Raw)) { return $null }
    $p = $Raw -split ([char]1)
    if ($p.Count -lt 9) { return $null }
    return [ordered]@{
        hwnd      = $p[0]
        cls       = $p[1]
        text      = $p[2]
        visible   = ($p[3] -eq '1')
        enabled   = ($p[4] -eq '1')
        parent    = $p[5]
        style     = $p[6]
        exStyle   = $p[7]
        rect      = $p[8]
    }
}

function ConvertFrom-DescList {
    param($RawList)
    $res = @()
    foreach ($r in @($RawList)) {
        $d = ConvertFrom-Desc $r
        if ($d) { $res += $d }
    }
    return $res
}

function ConvertTo-Hwnd {
    param([string]$S)
    if ([string]::IsNullOrEmpty($S) -or $S -eq '0') { return [IntPtr]::Zero }
    return [IntPtr][int64]$S
}

# 解析 "l,t,r,b,WxH"
function Split-Rect {
    param([string]$S)
    if ([string]::IsNullOrEmpty($S) -or $S -eq 'ERR') { return $null }
    $p = $S -split ','
    if ($p.Count -lt 5) { return $null }
    return [ordered]@{
        left = [int]$p[0]; top = [int]$p[1]; right = [int]$p[2]; bottom = [int]$p[3]
        size = $p[4]
        cx = ([int]$p[2] - [int]$p[0]); cy = ([int]$p[3] - [int]$p[1])
    }
}

$rep = [ordered]@{
    ok         = $false
    script     = 'attach-to-desktop-layer.ps1'
    revision   = 3
    mode       = $Mode
    hostPolicy = $Target
    zOrder     = $ZOrder
    placement  = $Placement
    capturedAt = (Get-Date).ToString('s')
    layered    = (-not $NoLayered)
    geometry   = [ordered]@{ width = $Width; height = $Height; x = $X; y = $Y }
    screen     = [ordered]@{}
    hosts      = [ordered]@{}
    probe      = [ordered]@{}
    steps      = @()
    verdicts   = [ordered]@{}
    pixels     = [ordered]@{}
    humanNeeded = @()
    notes      = @()
    errors     = @()
}

function Add-Step {
    param([string]$Name, $Data)
    $script:rep.steps += [ordered]@{ step = $Name; data = $Data }
}

$testHwnd = [IntPtr]::Zero
$origState = $null

try {
    # ============ 公共：解析三个 shell 窗口 ============
    $progman = [DeskAttach]::Progman()
    if ($progman -eq [IntPtr]::Zero) { throw '找不到 Progman 窗口 —— 本次结论不可信，不猜。' }
    $defview = [DeskAttach]::FirstChildOfClass($progman, 'SHELLDLL_DefView')
    $progmanWorkerW = [DeskAttach]::FirstChildOfClass($progman, 'WorkerW')

    $rep.hosts = [ordered]@{
        progman         = (ConvertFrom-Desc ([DeskAttach]::Desc($progman)))
        defview         = $(if ($defview -ne [IntPtr]::Zero) { ConvertFrom-Desc ([DeskAttach]::Desc($defview)) } else { $null })
        progmanWorkerW  = $(if ($progmanWorkerW -ne [IntPtr]::Zero) { ConvertFrom-Desc ([DeskAttach]::Desc($progmanWorkerW)) } else { $null })
        progmanHwnd     = $progman.ToString()
        defviewHwnd     = $defview.ToString()
        workerwHwnd     = $progmanWorkerW.ToString()
    }
    $rep.screen = [ordered]@{ cx = $screenBeforeDpi.cx; cy = $screenBeforeDpi.cy }
    $rep.env = [ordered]@{
        desktopName              = [DeskAttach]::DesktopName()
        screenBeforeDpi          = $screenBeforeDpi
        screenAfterDpi           = $screenAfterDpi
        screenChangedAfterDpiSet = ($screenAfterDpi.cx -ne $screenBeforeDpi.cx)
        dpiMode                  = $dpiMode
    }

    if ($defview -eq [IntPtr]::Zero) {
        $rep.errors += '找不到 Progman 直属子窗口 SHELLDLL_DefView —— 桌面层次与预期不符，判据不可用。'
        throw 'DefView 缺失，中止。'
    }

    # 目标宿主
    $targetHost = if ($Target -eq 'workerw') { $progmanWorkerW } else { $progman }
    if ($targetHost -eq [IntPtr]::Zero) { throw "宿主策略 $Target 解析出的句柄为空，中止（不静默换成别的宿主）。" }
    $rep.hosts.targetHost = $targetHost.ToString()
    $rep.hosts.targetHostIsEnabled = [DeskAttach]::IsWindowEnabled($targetHost)

    # ============ probe ============
    $rep.probe = [ordered]@{
        progmanDirectChildren = @(ConvertFrom-DescList ([DeskAttach]::DirectChildDescs($progman)))
        defviewDirectChildClasses = @(ConvertFrom-DescList ([DeskAttach]::DirectChildDescs($defview)) | ForEach-Object { $_.cls })
        topLevelSHELLDLLDefViewCount = @([DeskAttach]::TopLevelByClass('SHELLDLL_DefView')).Count
        topLevelWorkerWCount = @([DeskAttach]::TopLevelByClass('WorkerW')).Count
    }
    # 旁证：真正的图标层里住着 SysListView32
    $rep.probe.defviewHasSysListView32 = (@($rep.probe.defviewDirectChildClasses) -contains 'SysListView32')

    if ($Mode -eq 'probe') {
        $rep.ok = $true
        $rep.notes += 'probe 模式只读，未改动任何系统状态。'
        # 目标宿主的关键约束，先摆出来（这两条直接决定判据②能不能过）
        $th = ConvertFrom-Desc ([DeskAttach]::Desc($targetHost))
        if (-not $th.enabled) {
            $rep.notes += '⚠️ 目标宿主是 **disabled** 的。子窗口的输入会受父窗口影响 ⇒ 判据②「仍能点击」大概率不成立 —— 这正是本实验要先验的事。'
        }
        if ([DeskAttach]::HasEx($targetHost, 0x20)) {
            $rep.notes += '注：目标宿主带 WS_EX_TRANSPARENT（鼠标穿透）—— 对它自己生效，子窗口另算，需实测。'
        }
    }

    # ============ mount / attach / detach ============
    if ($Mode -eq 'mount' -or $Mode -eq 'attach' -or $Mode -eq 'detach') {

        if ($Mode -eq 'detach') {
            if ($Hwnd -eq '') { throw 'detach 模式必须给 -Hwnd。' }
            $h = ConvertTo-Hwnd $Hwnd
            if ($h -eq [IntPtr]::Zero) { throw '‑Hwnd 解析为 0，中止。' }
            $before = ConvertFrom-Desc ([DeskAttach]::Desc($h))
            [void][DeskAttach]::Unparent($h, $progman)
            [void][DeskAttach]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x0001 -bor 0x0002)
            Add-Step 'detach' @{ before = $before; after = (ConvertFrom-Desc ([DeskAttach]::Desc($h))) }
            $rep.ok = $true
            $rep.notes += 'detach 只把父窗口还原为顶层并改回 WS_POPUP；若原状态更复杂，请拿 before 字段人工比对。'
        } else {
            # 解析要挂的窗口
            if ($Mode -eq 'mount') {
                if ($X -lt 0) { $X = [Math]::Max(0, [DeskAttach]::ScreenW() - $Width - 40) }
                $rep.geometry.x = $X
                $rep.geometry.y = $Y

                # ---- Placement=bottom 的前置条件：目标区域**必须没有被别的窗口占用** ----
                # 置底的窗口会被任何普通窗口盖住。若不先测这一条，"被别的窗口挡住"就会被
                # 误判成"置底不可行"。判据：窗口中心点 WindowFromPoint 命中桌面类
                #（Progman / SHELLDLL_DefView / SysListView32）即那块是桌面。
                if ($Placement -eq 'bottom') {
                    $cands = @(
                        [ordered]@{ x = -1; y = 120 }, [ordered]@{ x = -1; y = 1000 },
                        [ordered]@{ x = 120; y = 300 }, [ordered]@{ x = 240; y = 900 },
                        [ordered]@{ x = -1; y = 620 }
                    )
                    $chosen = $null
                    $scan = @()
                    foreach ($c in $cands) {
                        $tx = [int]$c.x
                        if ($tx -lt 0) { $tx = [Math]::Max(0, [DeskAttach]::ScreenW() - $Width - 40) }
                        $ty = [int]$c.y
                        $probH = [DeskAttach]::HitAt($tx + [int]($Width / 2), $ty + [int]($Height / 2))
                        $probCls = [DeskAttach]::ClassOf($probH)
                        $scan += ($tx.ToString() + ',' + $ty + ' => ' + $probCls + '(' + $probH.ToString() + ')')
                        if ($null -eq $chosen -and ($probCls -eq 'Progman' -or $probCls -eq 'SHELLDLL_DefView' -or $probCls -eq 'SysListView32')) {
                            $chosen = [ordered]@{ x = $tx; y = $ty }
                        }
                    }
                    $rep.pixels.placementPrecondition = [ordered]@{
                        scans  = $scan
                        chosen = $(if ($chosen) { ($chosen.x.ToString() + ',' + $chosen.y) } else { 'NONE' })
                        rule   = '窗口中心点 WindowFromPoint 命中 Progman/SHELLDLL_DefView/SysListView32 = 那块是桌面，没被别的窗口占用'
                    }
                    if ($null -eq $chosen) {
                        $rep.errors += 'Placement=bottom 前置条件不满足：候选位置**全都被别的窗口占着** => 置底窗口必然被盖住，本次不能得出结论。'
                        throw '置底前置条件不满足。'
                    }
                    $X = [int]$chosen.x
                    $Y = [int]$chosen.y
                    $rep.geometry.x = $X
                    $rep.geometry.y = $Y
                }

                # ---- 基准 a：建窗之前的桌面（先强制 DefView 重绘，冲掉 24H2 的桌面快照）----
                # ⭐ 这一步是**内建校准**：后面两次取样（顶层 popup / 挂载后）都要跟它比。
                #    没有它，「那块区域有没有变」就无从说起。
                $preRect = [ordered]@{
                    x = $X + 6; y = $Y + 6
                    w = [Math]::Max(8, $Width - 12); h = [Math]::Max(8, $Height - 12)
                }
                [void][DeskAttach]::ForceDefviewRepaint($defview)
                [void][DeskAttach]::PumpFor(400)
                $rep.pixels.sampleRect = $preRect
                $rep.pixels.beforeCreate = [ordered]@{
                    when   = '建窗之前（DefView 已强制重绘 + 抽消息 400ms）'
                    sample = [DeskAttach]::SampleRegion($preRect.x, $preRect.y, $preRect.w, $preRect.h, 10, 240, 240, 240, 20)
                }
                Write-Host ('    [机器读数 a · 建窗前 桌面基准] ' + $rep.pixels.beforeCreate.sample)

                $testHwnd = [IntPtr]::Zero
                $howCreated = [DeskAttach]::CreateTestWindowEx($X, $Y, $Width, $Height, [ref]$testHwnd)
                Add-Step 'createTestWindow' @{ how = $howCreated; hwnd = $testHwnd.ToString() }
                if ($testHwnd -eq [IntPtr]::Zero) {
                    throw ('CreateTestWindowEx 全部候选都失败（句柄为 0），中止。逐次尝试与 GetLastError：' + $howCreated)
                }
                $h = $testHwnd
            } else {
                if ($Hwnd -eq '') { throw 'attach 模式必须给 -Hwnd。' }
                $h = ConvertTo-Hwnd $Hwnd
                if ($h -eq [IntPtr]::Zero) { throw '-Hwnd 解析为 0，中止。' }
            }

            $origState = ConvertFrom-Desc ([DeskAttach]::Desc($h))
            Add-Step 'before' @{ window = $origState }

            # ---- 正对照 b：窗口刚建好、**还没挂任何桌面层**时先采一次 ----
            # ⭐ 这一次的用途是「考裁判」：若连顶层 popup 都采不到变化，说明问题在
            #    「我们根本画不出窗口」，那后面挂载后看不见就**不能算桌面层的结论**；
            #    反过来，若这次看得见、挂载后看不见，因果就干净地锁在桌面层上。
            if ($Mode -eq 'mount') {
                [void][DeskAttach]::ForcePaint($h)
                $pumpTopLevel = [DeskAttach]::PumpFor(400)
                $rep.pixels.topLevelAfterCreate = [ordered]@{
                    when   = '建窗之后（仍是顶层 popup，未挂桌面层）+ ForcePaint + 抽消息 400ms'
                    pump   = $pumpTopLevel
                    sample = [DeskAttach]::SampleRegion($preRect.x, $preRect.y, $preRect.w, $preRect.h, 10, 240, 240, 240, 20)
                }
                $ctrlRectTop = [ordered]@{
                    x = $preRect.x
                    y = [Math]::Min([DeskAttach]::ScreenH() - $preRect.h - 2, $preRect.y + $preRect.h + 40)
                    w = $preRect.w; h = $preRect.h
                }
                $rep.pixels.controlRect = $ctrlRectTop
                $rep.pixels.topLevelAfterCreate.control = [DeskAttach]::SampleRegion($ctrlRectTop.x, $ctrlRectTop.y, $ctrlRectTop.w, $ctrlRectTop.h, 10, 240, 240, 240, 20)
                Write-Host ('    [机器读数 b · 顶层popup 正对照] ' + $rep.pixels.topLevelAfterCreate.sample + '  (pump=' + $pumpTopLevel + ')')
            }

            if (-not $NoLayered) {
                $ex = [DeskAttach]::GetWindowLongPtr($h, -20).ToInt64()
                [void][DeskAttach]::SetWindowLongPtr($h, -20, [IntPtr]($ex -bor 0x00080000))
                $layeredOk = [DeskAttach]::SetLayeredWindowAttributes($h, 0, 255, 0x0002)
                Add-Step 'setLayered' @{ ok = $layeredOk; exStyle = ('0x' + [DeskAttach]::GetWindowLongPtr($h, -20).ToInt64().ToString('X8')) }
            }

            if ($Placement -eq 'wallpaper') {
                $reparentOk = [DeskAttach]::Reparent($h, $targetHost)
                Add-Step 'reparent' @{ ok = $reparentOk; parent = [DeskAttach]::GetParent($h).ToString(); want = $targetHost.ToString() }

                if (-not $reparentOk) {
                    $rep.errors += 'SetParent 后复核失败：GetParent 不等于目标宿主 => 挂载没成功，本次不产生任何判据。'
                    throw '挂载失败。'
                }

                if ($Target -eq 'progman' -and $ZOrder -eq 'below') {
                    $zoOk = [DeskAttach]::PlaceBelow($h, $defview)
                    Add-Step 'zorder' @{ order = 'below-defview'; ok = $zoOk }
                } else {
                    # above：SetWindowPos(HWND_TOP) 把窗口排到**父窗口子序的顶端**。
                    $zoOk = [DeskAttach]::MoveTo($h, $X, $Y)
                    Add-Step 'zorder' @{ order = $(if ($Target -eq 'progman') { 'above-defview' } else { 'top-of-workerw' }); ok = $zoOk }
                }

                $repaintOk = [DeskAttach]::ForceDefviewRepaint($defview)
                Add-Step 'forceDefviewRepaint' @{ ok = $repaintOk }

                # 把「我们到底排在 DefView 的上面还是下面」变成**测出来的事实**，而不是我们自己的声明。
                $childrenAfter = @(ConvertFrom-DescList ([DeskAttach]::DirectChildDescs($targetHost)))
                $ourIdx = -1
                $dvIdx  = -1
                for ($i = 0; $i -lt $childrenAfter.Count; $i++) {
                    if ($childrenAfter[$i].hwnd -eq $h.ToString()) { $ourIdx = $i }
                    if ($childrenAfter[$i].hwnd -eq $defview.ToString()) { $dvIdx = $i }
                }
                Add-Step 'zorderAfterMount' @{
                    hostChildrenInEnumOrder    = @($childrenAfter | ForEach-Object { $_.hwnd + ':' + $_.cls })
                    ourIndexInHostChildren     = $ourIdx
                    defviewIndexInHostChildren = $dvIdx
                    enumOrderAssumption        = 'FindWindowEx 的枚举顺序 = Z 序自顶向下（index 越小越靠上）'
                    enumOrderCrossCheckedBy    = 'hitHwnd（WindowFromPoint 是活查询）'
                }
            } else {
                # ---- Placement = bottom：**保持顶层窗口**，只把自己压到 Z 序最底 ----
                $ex2 = [DeskAttach]::GetWindowLongPtr($h, -20).ToInt64()
                [void][DeskAttach]::SetWindowLongPtr($h, -20, [IntPtr]($ex2 -bor 0x08000000))   # WS_EX_NOACTIVATE
                Add-Step 'setNoActivate' @{ ok = $true; exStyle = ('0x' + [DeskAttach]::GetWindowLongPtr($h, -20).ToInt64().ToString('X8')) }

                # ⚠️ 2026-09-22 实测踩中：`MoveTo` 传的 `hWndInsertAfter` 是 NULL（= **HWND_TOP**），
                #    它会把刚压到底的窗口**重新提到最顶** —— rev4-bottom 第一次跑出
                #    ourIndex=36 / progmanIndex=422，等于**根本没测到置底**。
                #    ⇒ 顺序必须是「先定位、后压底」，否则读数里那个「置底」是假的。
                $mvOk = [DeskAttach]::MoveTo($h, $X, $Y)
                Add-Step 'moveTo' @{ ok = $mvOk; x = $X; y = $Y }
                $bottomOk = [DeskAttach]::PlaceBottom($h)
                Add-Step 'placeBottom' @{ ok = $bottomOk; insertAfter = 'HWND_BOTTOM(=1)' }

                $repaintOk = [DeskAttach]::ForceDefviewRepaint($defview)
                Add-Step 'forceDefviewRepaint' @{ ok = $repaintOk }

                # 顶层 Z 序取证：我们排在 Progman（桌面）之上还是之下？index 越小越靠上。
                # 置底窗口若排在 Progman **之下** => 必然被桌面盖住，与绘制无关。
                $tl = @([DeskAttach]::TopLevelZOrder())
                $ourTL = -1
                $progmanTL = -1
                $nr = 0
                foreach ($rec in $tl) {
                    $q = $rec -split ([char]1)
                    if ($q.Count -ge 2) {
                        if ($q[0] -eq $h.ToString()) { $ourTL = $nr }
                        if ($q[0] -eq $progman.ToString()) { $progmanTL = $nr }
                    }
                    $nr++
                }
                Add-Step 'topLevelZOrder' @{
                    total             = $tl.Count
                    ourIndex          = $ourTL
                    progmanIndex      = $progmanTL
                    weAreAboveDesktop = ($ourTL -ge 0 -and $progmanTL -ge 0 -and $ourTL -lt $progmanTL)
                    # 「置底」是否真的生效：我们紧贴桌面之上（中间只隔极少数窗口）。
                    # 若 ourIndex 远小于 progmanIndex（差很大），说明被某个 HWND_TOP 操作顶回去了。
                    placeBottomEffective = ($ourTL -ge 0 -and $progmanTL -ge 0 -and ($progmanTL - $ourTL) -le 3)
                    gapToDesktop         = $(if ($ourTL -ge 0 -and $progmanTL -ge 0) { $progmanTL - $ourTL } else { -1 })
                    first12           = @($tl | Select-Object -First 12)
                    note              = '顶层 Z 序自顶向下（GetTopWindow + GW_HWNDNEXT）；index 越小越靠上'
                }
            }

            # ⛔ 原来是裸的 Start-Sleep -Milliseconds 400 —— 那 400ms 里消息泵一次都没转，
            #    窗口永远等不到 WM_PAINT。现在改成「强制重绘 + 真抽消息」。
            [void][DeskAttach]::ForcePaint($h)
            $pumpAfterMount = [DeskAttach]::PumpFor(400)
            Add-Step 'paintAndPump' @{ forcePaint = $true; messagesDispatched = $pumpAfterMount }
            $rep.pixels.pumpDispatchedAfterMount = $pumpAfterMount

            # ---- 机器判据 ----
            $after = ConvertFrom-Desc ([DeskAttach]::Desc($h))
            $afterRect = Split-Rect $after.rect
            if ($null -eq $afterRect) { throw "拿不到挂载后的窗口矩形（rect=$($after.rect)）—— 不拿它编判据，大声失败。" }
            $cx = [int]($afterRect.left + $afterRect.cx / 2)
            $cy = [int]($afterRect.top + $afterRect.cy / 2)
            $hit = [DeskAttach]::HitAt($cx, $cy)
            $hitRoot = [DeskAttach]::GetAncestor($hit, 2)   # GA_ROOT

            $rep.verdicts = [ordered]@{
                mounted_ok          = $(if ($Placement -eq 'wallpaper') { $reparentOk } else { $bottomOk })
                parentIsTargetHost  = $(if ($Placement -eq 'wallpaper') { ([DeskAttach]::GetParent($h) -eq $targetHost) } else { $false })
                isTopLevelWindow    = ([DeskAttach]::GetParent($h) -eq [IntPtr]::Zero)
                stillVisible        = [bool]$after.visible
                stillEnabled        = [bool]$after.enabled
                # 判据④：挂载后物理尺寸有没有被系统改掉
                sizePreserved       = ($afterRect.cx -eq $Width -and $afterRect.cy -eq $Height)
                sizeAfter           = $after.rect
                # 判据②的机器代理：命中测试能不能打到我们这条窗口（或其子窗口）
                hitHwnd             = $hit.ToString()
                hitRootHwnd         = $hitRoot.ToString()
                hitIsUsOrOurChild   = (($hit -eq $h) -or ($hitRoot -eq $h))
                hitClass            = [DeskAttach]::ClassOf($hit)
            }

            $rep.verdicts.notes_on_judgement = @(
                '判据②「仍能点击」的机器代理 = WindowFromPoint(中心点) 能否命中我们。'
                'WindowFromPoint 会跳过 hidden/disabled 窗口，所以它是「能不能被点到」的必要条件代理，不是充分条件。'
                '注：若宿主是 disabled，这条几乎注定失败 —— 那本身就是一个有价值的结论。'
            )

            $rep.humanNeeded = @(
                '⚠️ 前置动作：先按 **Win+D** 把所有窗口最小化、露出桌面 —— 这条窗口挂在桌面层里，'
                '   被别的窗口挡住就等于看不见，会把「挂载成功」误判成「被覆盖」。'
                '① 被覆盖：看屏幕**右上区域**是否出现了那条「M0 · A10 挂载测试条」（灰底按钮）。'
                '   - 本次 Z 序 = above（排在 SHELLDLL_DefView **之上**）。2026-09-22 已实测 below 看不见 ⇒ 换 above 再来。'
                '   - **看得见** ⇒ 判据① 成立；同时反证了「below 是被 DefView 盖住」这条推论。'
                '   - **仍看不见** ⇒ 说明不止 Z 序问题（渲染层还有别的机制），下一步该换 Electron 真卡片再验。'
                '   - 附带证据：JSON 里 `hitIsUsOrOurChild`。above 时它应变成 **true**（鼠标能打到我们）；'
                '     若它已是 true 而屏幕仍看不见，那就纯属渲染问题。'
                '③ backdrop-filter：本条测试条是系统按钮，测不了玻璃效果，需换真实卡片再验。'
            )

            # ---- Hold 后自动还原 ----
            if ($HoldSeconds -gt 0) {
                $rep.notes += "挂载已保持 $HoldSeconds 秒，请在此窗口期内看屏幕。到点自动还原。"
                Write-Host ''
                Write-Host ('>>> 现在是关键 ' + $HoldSeconds + ' 秒：请立刻按 Win+D 露出桌面，看屏幕右上区域有没有一条灰底按钮「M0 · A10 挂载测试条」（Z 序=' + $ZOrder + '） <<<')
                Write-Host '>>> 判据① 本次由**机器读数**给出（见下方「判据①(机器)」），你只需复核 —— 机器与你矛盾时以你为准 <<<'
                # ⭐ 保持期间**必须持续抽消息**，否则窗口又变回「存在但没被画」。
                #    同时做屏幕像素取样 —— 把判据① 从「人眼看一眼」改成
                #    「机器读数 + 人眼复核」，人不再是唯一的传感器。
                $sampleRect = $rep.pixels.sampleRect
                # 对照区沿用"顶层 popup 阶段"定的那个矩形 —— 两阶段必须是同一块区域才可比。
                $ctrlRect = $rep.pixels.controlRect
                if ($null -eq $ctrlRect) {
                    $ctrlRect = [ordered]@{
                        x = $sampleRect.x
                        y = [Math]::Min([DeskAttach]::ScreenH() - $sampleRect.h - 2, $afterRect.bottom + 40)
                        w = $sampleRect.w; h = $sampleRect.h
                    }
                    $rep.pixels.controlRect = $ctrlRect
                }
                $rep.pixels.referenceColor = 'button-face gray #F0F0F0 (240,240,240) +-20'

                $holdMs   = $HoldSeconds * 1000
                $elapsed  = 0
                $pumped   = 0
                $snap1    = $null
                $snap2    = $null
                $ctrlSnap = $null
                $t1       = [int]($holdMs / 3)
                $t2       = [int]($holdMs * 3 / 4)
                while ($elapsed -lt $holdMs) {
                    $chunk = [Math]::Min(500, $holdMs - $elapsed)
                    $pumped += [DeskAttach]::PumpFor($chunk)
                    $elapsed += $chunk
                    if ($null -eq $snap1 -and $elapsed -ge $t1) {
                        $snap1    = [DeskAttach]::SampleRegion($sampleRect.x, $sampleRect.y, $sampleRect.w, $sampleRect.h, 10, 240, 240, 240, 20)
                        $ctrlSnap = [DeskAttach]::SampleRegion($ctrlRect.x, $ctrlRect.y, $ctrlRect.w, $ctrlRect.h, 10, 240, 240, 240, 20)
                        Write-Host ('    [机器读数 c1 · 挂载中 t=' + $elapsed + 'ms] 窗口区=' + $snap1 + '   对照区=' + $ctrlSnap)
                    }
                    if ($null -eq $snap2 -and $elapsed -ge $t2) {
                        $snap2 = [DeskAttach]::SampleRegion($sampleRect.x, $sampleRect.y, $sampleRect.w, $sampleRect.h, 10, 240, 240, 240, 20)
                        Write-Host ('    [机器读数 c2 · 挂载中 t=' + $elapsed + 'ms] 窗口区(稳定性复核)=' + $snap2)
                    }
                }
                $rep.pixels.whileMounted = [ordered]@{
                    when           = '挂载中（持续抽消息）'
                    pumpDispatched = $pumped
                    sample1        = $snap1
                    sample2        = $snap2
                    control        = $ctrlSnap
                }
                $rep.pixels.holdSecondsActual = $HoldSeconds

                $rep.humanNeeded += @(
                    '★ 2026-09-22 修正（重要）：此前几次「看不见」的真因是**这条测试条自己没被绘制** ——',
                    '   脚本全程在主线程 Start-Sleep、**从不抽消息**，而系统自带的 Button 类要靠线程消息泵',
                    '   才能收到 WM_PAINT。所以「窗口存在、能被命中、却看不见」是必然的，与桌面层无关。',
                    '   ⇒ 判据① 的正确状态是 **UNABLE（未测到）**，此前记成「不成立」是错的。',
                    '   ⇒ 本次已加真消息泵；抽到的消息条数若为 0，本判据仍然判 UNABLE（不许当通过）。',
                    '② 现在请看屏幕：本次不用靠眼睛下结论 —— 下方「判据①(机器)」一行就是机器读数。',
                    '   若机器判 PASS 而你仍看不见（或反之）⇒ 以你为准，把这个矛盾告诉我。',
                    '③ backdrop-filter：本条测试条是系统按钮，测不了玻璃效果，需换真实卡片再验。'
                )
            }

            [void][DeskAttach]::Unparent($h, $progman)
            Add-Step 'restored' @{ window = (ConvertFrom-Desc ([DeskAttach]::Desc($h))) }
            $rep.ok = $true
        }
    }

} catch {
    $rep.ok = $false
    $rep.errors += $_.Exception.Message
} finally {
    # 自建窗口必须销毁；attach 的目标窗口只还原、绝不销毁
    if ($testHwnd -ne [IntPtr]::Zero) {
        [void][DeskAttach]::Unparent($testHwnd, [IntPtr]::Zero)
        [void][DeskAttach]::DestroyWindow($testHwnd)
        Add-Step 'destroyTestWindow' @{ hwnd = $testHwnd.ToString() }
        # 同一块区域、同一条代码路径再采一次 —— 与「挂载中」那次构成 A/B。
        # 先强制重绘桌面（否则销毁留下的"洞"可能不会被重画，会伪造出"没变"的假阴性）。
        if ($null -ne $defview) { [void][DeskAttach]::ForceDefviewRepaint($defview) }
        [void][DeskAttach]::PumpFor(400)
        if ($null -ne $rep.pixels.sampleRect) {
            $sr2 = $rep.pixels.sampleRect
            $rep.pixels.afterDestroy = [ordered]@{
                when   = 'unparent + destroy + 强制重绘 + 抽消息 400ms 之后'
                sample = [DeskAttach]::SampleRegion($sr2.x, $sr2.y, $sr2.w, $sr2.h, 10, 240, 240, 240, 20)
            }
        }
    }
    $rep.stage = 'partial(finally-only：判据① 结算尚未执行)'
    $json = $rep | ConvertTo-Json -Depth 10
    $dir = Split-Path -Parent $OutFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
}

# ============ 控制台摘要 + 退出码 ============
# ⛔ 2026-09-21 真实教训：这个脚本原先**只把结论写进 JSON、控制台一个字都不打**，
#    于是阿木跑完看到"没报错"就回报"没问题"，而 JSON 里写的是 ok=false。
#    **失败的脚本装成了成功** —— 这是本项目最不能容忍的形态。
#    ⇒ 现在：结论 / 错误 / 需要人做的事，全部打到控制台，并且**用退出码表达**（0 绿 · 1 红）。
# ============ 判据① 的机器读数结算（三态：PASS / FAIL / UNABLE） ============
# 阈值**先声明、再跑**（不许跑完再挑一个好看的阈值）：
#   STABLE_TOL = 8   同一区域两次采样的最大通道差 > 8 视为「画面在动」⇒ 读数不可用
#   DIFF_TOL   = 12  两次采样的最大通道差 > 12 视为「那块画面确实变了」
#   NEAR_RATIO = 0.6 区域内 >=60% 的取样点落在按钮面灰 +-20 内，视为「是按钮面」
# ⚠️ 【覆盖缺口】这三个阈值**没有端点数据**（没有"已知生效/已知失效"的对照标定），
#    属**未校准阈值** ⇒ 结论只能当参考，必须与人眼复核并列，不许单独当判据。
#    原始读数全部留在 JSON 的 pixels 字段里，允许别人自己重算。
function ConvertFrom-PixelSample {
    param([string]$Raw)
    if ([string]::IsNullOrEmpty($Raw)) { return $null }
    if ($Raw -eq 'DC_FAIL' -or $Raw -like 'NO_SAMPLE*') { return $null }
    $p = $Raw -split ','
    if ($p.Count -lt 6) { return $null }
    return [ordered]@{
        r = [int]$p[0]; g = [int]$p[1]; b = [int]$p[2]
        n = [int]$p[3]; nearRatio = [double]$p[4]; bad = [int]$p[5]
        raw = $Raw
    }
}
function Get-ChannelDistance {
    param($Pa, $Pb)
    if ($null -eq $Pa -or $null -eq $Pb) { return -1 }
    $d1 = [Math]::Abs($Pa.r - $Pb.r)
    $d2 = [Math]::Abs($Pa.g - $Pb.g)
    $d3 = [Math]::Abs($Pa.b - $Pb.b)
    return [Math]::Max($d1, [Math]::Max($d2, $d3))
}

$c1 = [ordered]@{
    state                       = 'UNABLE'
    why                         = '未进入挂载流程，本判据没有读数。'
    how                         = '屏幕像素取样（GetDC(NULL)+GetPixel）+ 内建正对照 + 人眼复核'
    thresholds                  = '见 calibration 字段（PASS 规则：deltaMounted >= power/2）'
    messagesDispatchedAfterMount = $(if ($null -ne $rep.pixels) { $rep.pixels.pumpDispatchedAfterMount } else { $null })
}

if ($null -ne $rep.pixels -and $null -ne $rep.pixels.whileMounted) {
    $sa = ConvertFrom-PixelSample $rep.pixels.beforeCreate.sample
    $sb = ConvertFrom-PixelSample $rep.pixels.topLevelAfterCreate.sample
    $s1 = ConvertFrom-PixelSample $rep.pixels.whileMounted.sample1
    $s2 = ConvertFrom-PixelSample $rep.pixels.whileMounted.sample2
    $sc = ConvertFrom-PixelSample $rep.pixels.whileMounted.control
    $sd = ConvertFrom-PixelSample $rep.pixels.afterDestroy.sample

    $dPaint   = Get-ChannelDistance $sa $sb      # 正对照：顶层 popup 能不能画出来
    $dMount   = Get-ChannelDistance $sa $s1      # 挂载后：桌面层上看得见吗
    $dStable  = Get-ChannelDistance $s1 $s2      # 稳定性
    $dRestore = Get-ChannelDistance $sa $sd      # 销毁后桌面有没有还原（用于解释 A/B 的可信度）

    $c1.pumpDispatchedDuringHold = $rep.pixels.whileMounted.pumpDispatched
    $c1.distances = [ordered]@{
        baselineToTopLevel   = $dPaint
        baselineToMounted    = $dMount
        mountedSample1To2    = $dStable
        baselineToAfterDestroy = $dRestore
    }
    $c1.nearRatios = [ordered]@{
        barRegion     = $(if ($s1) { $s1.nearRatio } else { -1 })
        topLevelRegion = $(if ($sb) { $sb.nearRatio } else { -1 })
        controlRegion = $(if ($sc) { $sc.nearRatio } else { -1 })
    }
    # ---- 主判据：与**同一时刻的对照区**比 nearRatio（可抵消壁纸 / 亮度漂移）----
    # 端点标定（2026-09-22 实测 4 次运行 · 同一台机器 · 同一个窗口）：
    #   [已知生效] 顶层 popup（没挂进任何桌面层）: nearRatio = 0.953   x 4 次一致
    #   [已知失效] 挂进桌面层之后:               nearRatio = 0.487 ~ 0.528
    #              同一时刻的对照区（窗口没盖到的壁纸）: nearRatio = 0.491 ~ 0.519
    #   => 阈值取 0.75，落在两端点之间（离失效端 +0.22、离生效端 -0.20）
    # 【覆盖缺口】只测过这两个端点；"半透明 / 部分可见"这类中间态没有数据，未做量程验证。
    # 【为什么不拿「抽到的消息数」当门槛】ForcePaint 走 RedrawWindow(RDW_UPDATENOW)
    #   + UpdateWindow，是**同步绘制、不需要派发队列消息** => 抽到 0 条属正常。
    #   拿它当门槛会把真 FAIL 误判成 UNABLE —— 这条最早写错过，2026-09-22 修正。
    # ---- 主判据（2026-09-22 标定）：与**同一块矩形的"窗口前基准"**比 nearRatio ----
    # 为什么不用对照区当参考：对照区与窗口区**不是同一块壁纸**，它的 nearRatio 会随壁纸内容
    #   大幅漂移（实测 0.491 ~ 0.789）=> 拿它当参考会误判。基准 a 采自**同一块矩形**（窗口还没建），
    #   是唯一可比的东西。
    # 内建分辨力自检：power = nearRatio(b: 顶层 popup) - nearRatio(a: 窗口前基准)
    #   这是"同一块区域、窗口可见 vs 不可见"的实测落差 => 它代表**本次壁纸下这套判据的分辨力**。
    #   power < 0.20 说明壁纸本身就很接近按钮面灰 => 判 UNABLE，**不许硬猜**。
    # 端点（2026-09-22 实测 5 次运行 · 同一机器同一窗口）：
    #   [已知生效] power = 0.422 ~ 0.459（b 恒为 nearRatio 0.953）
    #   [已知失效] 增量 = -0.003 ~ +0.053（挂载后与窗口前基准几乎一样）
    #   => PASS 规则：deltaMounted >= power / 2
    # 【覆盖缺口】只测过这两个端点；"半透明 / 部分可见"的中间态没有数据，未做量程验证。
    # 【为什么不拿「抽到的消息数」当门槛】ForcePaint 走 RedrawWindow(RDW_UPDATENOW)
    #   + UpdateWindow，是**同步绘制、不需要派发队列消息** => 抽到 0 条属正常。
    #   拿它当门槛会把真 FAIL 误判成 UNABLE —— 这条最早写错过，2026-09-22 修正。
    $powerMin     = 0.20
    $power        = $(if ($null -ne $sa -and $null -ne $sb) { [Math]::Round($sb.nearRatio - $sa.nearRatio, 3) } else { -1 })
    $deltaMounted = $(if ($null -ne $s1 -and $null -ne $sa) { [Math]::Round($s1.nearRatio - $sa.nearRatio, 3) } else { -1 })
    $passNeed     = [Math]::Round($power / 2, 3)
    $c1.calibration = [ordered]@{
        baselineRatio            = $(if ($sa) { $sa.nearRatio } else { -1 })
        topLevelKnownGoodRatio   = $(if ($sb) { $sb.nearRatio } else { -1 })
        power                    = $power
        powerMinRequired         = $powerMin
        deltaMountedVsBaseline   = $deltaMounted
        passThreshold            = $passNeed
        passRule                 = 'deltaMounted >= power / 2'
        knownGoodPowerRange      = '0.422~0.459（5 次实测）'
        knownBadDeltaRange       = '-0.003~+0.053（5 次实测）'
        controlRegionIsNotTheRef = '对照区与窗口区不是同一块壁纸，nearRatio 实测漂到 0.789 => 不当参考'
        coverageGap              = '只测过两个端点；部分可见 / 半透明的中间态没有数据，未做量程验证'
        pumpCountIsNotAGate      = 'ForcePaint 同步绘制 => 抽到 0 条消息属正常，不作门槛'
    }
    $c1.discriminatorHasPower = ($power -ge $powerMin)
    $c1.visibleOnDesktopLayer = ($power -ge $powerMin -and $deltaMounted -ge $passNeed)

    if ($null -eq $sa -or $null -eq $s1 -or $null -eq $sb) {
        $c1.state = 'UNABLE'
        $c1.why   = '像素取样没拿到有效读数（DC_FAIL / NO_SAMPLE）—— 不猜，标成未测到。'
    } elseif (-not $c1.discriminatorHasPower) {
        $c1.state = 'UNABLE'
        $c1.why   = ('【本次判据没有分辨力】power=' + $power + ' < ' + $powerMin + '（壁纸本身太接近按钮面灰）=> 测不出"画没画"，本次不得出结论。')
    } elseif ($c1.visibleOnDesktopLayer) {
        $c1.state = 'PASS'
        $c1.why   = ('挂载后窗口区 nearRatio=' + $s1.nearRatio + '，比窗口前基准 ' + $sa.nearRatio + ' 高出 ' + $deltaMounted + '（阈值 ' + $passNeed + '）=> 测试条确实出现在屏幕上 => 判据① 成立。')
    } else {
        $c1.state = 'FAIL'
        $c1.why   = ('分辨力足够（power=' + $power + '），但挂载后窗口区 nearRatio=' + $s1.nearRatio + ' 与窗口前基准 ' + $sa.nearRatio + ' 只差 ' + $deltaMounted + '（阈值 ' + $passNeed + '）=> 挂进桌面层之后确实看不见。')
    }
    $c1.deltaNearRatioVsControlAtSameInstant = $deltaNearRatio
}

$rep.verdicts.criterion1_visible = $c1

if ($null -ne $rep.pixels -and $null -ne $rep.pixels.afterDestroy) {
    $rep.notes += '【已知覆盖缺口】afterDestroy 与基准 a 的通道差只用来解释 A/B 是否可信：若桌面在销毁后没被重画，会伪造出"没变"的假阴性。原始读数在 pixels 字段里，可自行复核。'
}

if ($null -eq $rep) {
    Write-Host '脚本在建立报告对象之前就挂了 —— 请把控制台上方的报错原文整段发出来。'
    exit 1
}

$envLine = '(未采集 —— 脚本在采集环境信息之前就中止了)'
if ($null -ne $rep.env) {
    $envLine = ('桌面名=' + $rep.env.desktopName + ' · DPI模式=' + $rep.env.dpiMode +
        ' · screen ' + $rep.env.screenBeforeDpi.cx + 'x' + $rep.env.screenBeforeDpi.cy +
        ' => ' + $rep.env.screenAfterDpi.cx + 'x' + $rep.env.screenAfterDpi.cy)
}

$summary = @()
$summary += ''
$summary += '============ attach-to-desktop-layer · 结果 ============'
$summary += ('模式 / 宿主 : ' + $rep.mode + ' / ' + $rep.hostPolicy + ' · Z序=' + $rep.zOrder + '   （宿主 hwnd=' + $rep.hosts.targetHost + ' · enabled=' + $rep.hosts.targetHostIsEnabled + '）')
$summary += ('桌面 / DPI  : ' + $envLine)
$summary += ('结果        : ' + $(if ($rep.ok) { 'OK' } else { '**失败** —— 本次没产生任何判据，别把它当成"没事"' }))
$summary += ('JSON        : ' + $OutFile)
if (@($rep.errors).Count -gt 0) {
    $summary += '错误：'
    foreach ($e in @($rep.errors)) { $summary += ('  x ' + $e) }
}
if (@($rep.humanNeeded).Count -gt 0) {
    $summary += '需要你人眼看一眼：'
    foreach ($hn in @($rep.humanNeeded)) { $summary += ('  · ' + $hn) }
}
$summary += '======================================================'
if ($null -ne $rep.verdicts.criterion1_visible) {
    $v = $rep.verdicts.criterion1_visible
    $summary += ''
    $summary += '---------- 判据① 「被覆盖」的机器读数 ----------'
    $summary += ('结论        : ' + $v.state + '    (' + $v.why + ')')
    if ($null -ne $rep.pixels.whileMounted) {
        $summary += ('抽到消息数  : 挂载后=' + $v.messagesDispatchedAfterMount +
                     ' · 保持期间=' + $v.pumpDispatchedDuringHold + '   (仅供参考：ForcePaint 是同步绘制，0 条属正常，不作门槛)')
        $summary += ('桌面基准 a  : ' + $rep.pixels.beforeCreate.sample)
        $summary += ('顶层popup b : ' + $rep.pixels.topLevelAfterCreate.sample + '   <- 正对照：证明"画得出窗口"')
        $summary += ('挂载中  c1  : ' + $rep.pixels.whileMounted.sample1)
        $summary += ('挂载中  c2  : ' + $rep.pixels.whileMounted.sample2 + '   <- 稳定性复核')
        $summary += ('对照区      : ' + $rep.pixels.whileMounted.control + '   <- 同一时刻、窗口没盖到的区域')
        $summary += ('销毁后  d   : ' + $rep.pixels.afterDestroy.sample)
        $summary += ('通道差      : a->b=' + $v.distances.baselineToTopLevel +
                     ' · a->c1=' + $v.distances.baselineToMounted +
                     ' · c1->c2=' + $v.distances.mountedSample1To2 +
                     ' · a->d=' + $v.distances.baselineToAfterDestroy + '   (想变"可见"需要 a->c1 > 12)')
    }
    $summary += ('主判据      : power=' + $v.calibration.power + '（需 >= ' + $v.calibration.powerMinRequired + '）· 挂载后-基准=' + $v.calibration.deltaMountedVsBaseline + '（需 >= power/2 = ' + $v.calibration.passThreshold + '）')
    $summary += ('端点        : 已知生效 power ' + $v.calibration.knownGoodPowerRange + ' · 已知失效 增量 ' + $v.calibration.knownBadDeltaRange)
    $summary += '覆盖缺口    : 只测过两个端点；部分可见 / 半透明的中间态没有数据。'
    $summary += '---------------------------------------------'
}

Write-Host ($summary -join "`n")

# ⛔ 2026-09-22 真实踩中：JSON 是在 finally 里写的，而**判据① 的结算发生在 finally 之后**
#    => 只写那一次的话，机器判定（criterion1_visible）**永远不会进留痕**。
#    实测过一次：artifact 里没有 criterion1_visible，而我却以为有（还因为 $LASTEXITCODE 被上一条
#    命令的 0 残留，把一次静默失败读成了成功）。=> 结算完**再写一次**。
$rep.stage = 'complete'
[System.IO.File]::WriteAllText($OutFile, ($rep | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
if (-not $rep.ok) { exit 1 }
exit 0
