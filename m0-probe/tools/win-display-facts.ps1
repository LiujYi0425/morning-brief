<#
  win-display-facts.ps1
  ------------------------------------------------------------------
  M0 验收 9 的"独立裁判"。

  为什么需要它：
    验收 9 要回答「Electron 的 scaleFactor 读数可不可靠」。
    如果只用 Electron 自己的 API 去验证 Electron 自己的读数，
    等于自己给自己判卷 —— 读数错了也测不出来。

    所以这里绕过 Electron，直接调 Windows 的 EnumDisplaySettings，
    拿到每个显示器的【真实物理分辨率】与【物理坐标】，作为外部基准。

  判定逻辑（在 Electron 侧使用）：
    physical_expected = display.size(DIP) × display.scaleFactor
    physical_truth    = 本脚本给出的 width × height
    相等 → scaleFactor 可信；不等 → scaleFactor 是错的

  实现说明：
    用 C# 完整声明 DEVMODEW，让 CLR 自己算字段布局，
    dmSize 取 Marshal.SizeOf 的真实值 —— 不手算偏移（手算容易错且难以自证）。
    Windows 只要求 dmSize >= 自身最小值，所以即便结构体略小于系统版本也能拿到需要的字段。
    最后用 pelsWidth > 0 做自校验，异常时明确报错而不是静默给错数。

  输出：
    - 若给了 -OutFile，把 UTF-8 JSON 写到该文件（Electron 侧用这个，绕开控制台代码页）
    - 否则打到 stdout
#>

param(
    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

$csharp = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class WinDisp {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAY_DEVICE {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]  public string DeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
        public int StateFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODEW {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public ushort dmSpecVersion;
        public ushort dmDriverVersion;
        public ushort dmSize;
        public ushort dmDriverExtra;
        public uint   dmFields;
        public int    dmPositionX;
        public int    dmPositionY;
        public uint   dmDisplayOrientation;
        public uint   dmDisplayFixedOutput;
        public short  dmColor;
        public short  dmDuplex;
        public short  dmYResolution;
        public short  dmTTOption;
        public short  dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public ushort dmLogPixels;
        public uint   dmBitsPerPel;
        public uint   dmPelsWidth;
        public uint   dmPelsHeight;
        public uint   dmDisplayFlags;
        public uint   dmDisplayFrequency;
        public uint   dmICMMethod;
        public uint   dmICMIntent;
        public uint   dmMediaType;
        public uint   dmDitherType;
        public uint   dmPanningWidth;
        public uint   dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplayDevicesW(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool EnumDisplaySettingsW(string lpszDeviceName, int iModeNum, ref DEVMODEW lpDevMode);

    public const int ENUM_CURRENT_SETTINGS = -1;
    public const int ATTACHED_TO_DESKTOP   = 0x00000001;

    public static int StructSize { get { return Marshal.SizeOf(typeof(DEVMODEW)); } }
    public static int DdSize     { get { return Marshal.SizeOf(typeof(DISPLAY_DEVICE)); } }

    public static string[] Names() {
        var list = new List<string>();
        uint i = 0;
        while (i < 64) {
            var dd = new DISPLAY_DEVICE();
            dd.cb = DdSize;
            if (!EnumDisplayDevicesW(null, i, ref dd, 0)) break;
            if ((dd.StateFlags & ATTACHED_TO_DESKTOP) != 0) {
                list.Add(dd.DeviceName + "\u0001" + dd.DeviceString);
            }
            i++;
        }
        return list.ToArray();
    }

    public static int[] Mode(string deviceName) {
        var dm = new DEVMODEW();
        dm.dmSize = (ushort)StructSize;
        bool ok = EnumDisplaySettingsW(deviceName, ENUM_CURRENT_SETTINGS, ref dm);
        return new int[] {
            dm.dmSize,
            dm.dmPositionX,
            dm.dmPositionY,
            (int)dm.dmPelsWidth,
            (int)dm.dmPelsHeight,
            dm.dmLogPixels,
            (int)dm.dmBitsPerPel,
            ok ? 1 : 0
        };
    }
}
'@

Add-Type -TypeDefinition $csharp -Language CSharp

$out = [ordered]@{
    ok              = $true
    devmodeSize     = [WinDisp]::StructSize
    displayDeviceSize = [WinDisp]::DdSize
    monitors        = @()
    registry        = [ordered]@{ LogPixels = $null; perMonitor = @() }
    errors          = @()
}

try {
    $names = [WinDisp]::Names()
    $mons = @()
    foreach ($n in $names) {
        $parts = $n -split ([char]1)
        $devName = $parts[0]
        $adapter = if ($parts.Count -gt 1) { $parts[1] } else { '' }
        try {
            $m = [WinDisp]::Mode($devName)
            if ($m[7] -ne 1 -or $m[3] -le 0 -or $m[4] -le 0) {
                $out.errors += ("枚举 {0} 返回无效数据（enumOk={1}, {2}x{3}）" -f $devName, $m[7], $m[3], $m[4])
            }
            $mons += [ordered]@{
                device    = $devName
                adapter   = $adapter
                x         = $m[1]
                y         = $m[2]
                width     = $m[3]
                height    = $m[4]
                logPixels = $m[5]
                bitsPerPel= $m[6]
                enumOk    = ($m[7] -eq 1)
            }
        } catch {
            $out.errors += "枚举 $devName 抛异常: $($_.Exception.Message)"
        }
    }
    $out.monitors = $mons
} catch {
    $out.ok = $false
    $out.errors += "P/Invoke 失败: $($_.Exception.Message)"
}

# 注册表里的缩放设置（作为第二路参考证据）
#
# 注意：LogPixels 有时会被系统存成带符号的怪值（实测见到 -2147483642）。
# 用 TryParse + 合理区间过滤，拿不到就当没有 —— 不允许因为一个参考值而整个脚本失败。
function Get-IntOrNull($raw, [int]$min, [int]$max) {
    if ($null -eq $raw) { return $null }
    $n = 0
    if ([int]::TryParse(([string]$raw).Trim(), [ref]$n)) {
        if ($n -ge $min -and $n -le $max) { return $n }
    }
    return $null
}

try {
    $desk = Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue
    if ($desk) {
        # 正常的 LogPixels 是 96/120/144/168/192
        $lp = Get-IntOrNull $desk.LogPixels 72 480
        if ($null -ne $lp) { $out.registry.LogPixels = $lp }
        else { $out.registry.LogPixelsRaw = [string]$desk.LogPixels }
    }

    $pmsRoot = 'HKCU:\Control Panel\Desktop\PerMonitorSettings'
    if (Test-Path $pmsRoot) {
        $pm = @()
        Get-ChildItem $pmsRoot -ErrorAction SilentlyContinue | ForEach-Object {
            $v = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
            if ($v) {
                $dv = Get-IntOrNull $v.DpiValue 0 4
                if ($null -ne $dv) {
                    $pct = switch ($dv) { 0 {100} 1 {125} 2 {150} 3 {175} 4 {200} default {$null} }
                    $pm += [ordered]@{ id = $_.PSChildName; dpiValue = $dv; percent = $pct }
                }
            }
        }
        $out.registry.perMonitor = $pm
    }
} catch {
    $out.errors += "读注册表缩放设置失败: $($_.Exception.Message)"
}

$json = $out | ConvertTo-Json -Depth 6
if ($OutFile -ne '') {
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding $false))
} else {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    Write-Output $json
}
