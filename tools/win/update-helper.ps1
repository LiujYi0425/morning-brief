# update-helper.ps1 -- does the file swapping that the running app cannot do to itself.
#
# WHY THIS FILE EXISTS
#   Windows locks the files of a running program.  So neither "install the new
#   version" nor "restore the old version" can be done by the app while it is
#   alive -- the app must spawn something that OUTLIVES it, then quit.
#   This script is that something: it waits for the app's PID to disappear,
#   performs exactly one action, then optionally relaunches the app.
#
# MODES
#   -Mode apply     run the downloaded installer silently, then relaunch
#   -Mode rollback  mirror a snapshot back over the install dir, then relaunch
#
# WHY THIS FILE IS PURE ASCII (no Chinese, unlike the other scripts here)
#   PowerShell 5.1 reads a .ps1 WITHOUT a UTF-8 BOM as ANSI, which mangles
#   non-ASCII comments into parse errors.  Every other .ps1 in this project is
#   UTF-8-with-BOM for that reason.  This one sidesteps the whole class of
#   problem by staying ASCII: it is a mechanical helper with no user-facing text
#   (all user-facing strings come from the app, not from here).
#
# EXIT / RESULT
#   Writes a small JSON result file so the NEXT launch can tell the user what
#   happened ("the update to 0.2.0 failed and you were rolled back to 0.1.0").
#   Without that file, a rollback is invisible -- and an invisible rollback is
#   indistinguishable from "the app randomly went back to an old version".
param(
  [Parameter(Mandatory = $true)][int]$WaitPid,
  [Parameter(Mandatory = $true)][ValidateSet('apply', 'rollback')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$ExePath = '',
  [string]$Installer = '',
  [string]$SnapshotDir = '',
  [string]$ResultFile = '',
  [int]$WaitTimeoutSec = 90
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$fields) {
  if (-not $ResultFile) { return }
  try {
    $obj = [ordered]@{ mode = $Mode; at = (Get-Date).ToUniversalTime().ToString('o') }
    foreach ($k in $fields.Keys) { $obj[$k] = $fields[$k] }
    $json = ($obj | ConvertTo-Json -Compress)
    [IO.File]::WriteAllText($ResultFile, $json, (New-Object Text.UTF8Encoding($false)))
  } catch {
    # A missing result file only costs us the "here is what happened" message.
    # It must never abort the rollback itself.
  }
}

# ---- 1. wait for the app to actually exit -------------------------------
# The app quits immediately after spawning us, but file handles are released
# slightly later.  Copying over a half-released file is how you get a corrupted
# install, so wait for the process to be really gone rather than just assuming.
$deadline = (Get-Date).AddSeconds($WaitTimeoutSec)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $WaitPid -ErrorAction SilentlyContinue
  if (-not $p) { break }
  Start-Sleep -Milliseconds 400
}
# Even after the process object is gone, give the OS a moment to drop locks.
Start-Sleep -Milliseconds 1200

$stillAlive = $null -ne (Get-Process -Id $WaitPid -ErrorAction SilentlyContinue)
if ($stillAlive) {
  Write-Result @{ ok = $false; error = "timed out waiting for pid $WaitPid to exit" }
  exit 1
}

# ---- 2. act -------------------------------------------------------------
$ok = $false
$err = ''
if ($Mode -eq 'apply') {
  if (-not $Installer -or -not (Test-Path -LiteralPath $Installer)) {
    Write-Result @{ ok = $false; error = "installer not found: $Installer" }
    exit 1
  }
  try {
    # /S = silent.  The installer was built with oneClick:false, but silent mode
    # still honours the recorded install dir, so we do NOT pass /D: letting the
    # installer reuse its own idea of where it lives is safer than us guessing.
    $proc = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
    $ok = ($proc.ExitCode -eq 0)
    if (-not $ok) { $err = "installer exit code $($proc.ExitCode)" }
  } catch {
    $err = "installer threw: $($_.Exception.Message)"
  }
} else {
  if (-not $SnapshotDir -or -not (Test-Path -LiteralPath $SnapshotDir)) {
    Write-Result @{ ok = $false; error = "snapshot not found: $SnapshotDir" }
    exit 1
  }
  try {
    # robocopy /MIR mirrors the snapshot over the install dir and deletes extras.
    # Exit codes 0..7 are success for robocopy (it uses bits for "files copied",
    # "extras deleted" and so on) -- treating non-zero as failure is a classic
    # mistake that would report a perfectly good rollback as broken.
    $out = & robocopy $SnapshotDir $InstallDir /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1
    $code = $LASTEXITCODE
    $ok = ($code -lt 8)
    if (-not $ok) { $err = "robocopy exit code $code" }
  } catch {
    $err = "robocopy threw: $($_.Exception.Message)"
  }
}

# ---- 3. relaunch --------------------------------------------------------
# Relaunch even when the action failed: leaving the user with nothing running is
# worse than leaving them on the version that at least starts.
$relaunched = $false
if ($ExePath -and (Test-Path -LiteralPath $ExePath)) {
  try {
    Start-Process -FilePath $ExePath | Out-Null
    $relaunched = $true
  } catch {
    if (-not $err) { $err = "relaunch failed: $($_.Exception.Message)" }
  }
}

Write-Result @{ ok = $ok; error = $err; relaunched = $relaunched }
if ($ok) { exit 0 } else { exit 1 }
