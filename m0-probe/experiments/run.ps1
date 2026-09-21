# experiments/run.ps1  (ASCII only on purpose: PS 5.1 mis-decodes UTF-8 .ps1 without BOM)
#
# Batch runner for the M0 forensic scripts.
# Usage:
#   .\run.ps1                 # run every experiment in order
#   .\run.ps1 exp-window-size # run just one
#
# Why this exists: every experiment must be launched through tools/launch-electron.mjs,
# because this machine presets ELECTRON_RUN_AS_NODE=1, which silently turns
# electron.exe into plain Node (see docs/04-项目审查报告.md B11).

param(
  [string]$Only = ""
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$ALL = @(
  "experiments/diag-electron-api.mjs",
  "experiments/diag-tla-deadlock.mjs",
  "experiments/exp-window-size.mjs",
  "experiments/exp-size-timeline.mjs",
  "experiments/exp-position-matrix.mjs"
)

$targets = if ($Only) { $ALL | Where-Object { $_ -like "*$Only*" } } else { $ALL }
if (-not $targets) {
  Write-Host "no experiment matched '$Only'"
  exit 1
}

foreach ($t in $targets) {
  Write-Host ""
  Write-Host ("=== " + $t + " ===")

  # kill leftovers so a previous hung run cannot pollute this one
  Get-Process -Name electron -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 400

  node tools/launch-electron.mjs $t
  Write-Host ("exit = " + $LASTEXITCODE + "  (see report/ for the raw output)")
}

Write-Host ""
Write-Host "done. raw outputs are in report/"
