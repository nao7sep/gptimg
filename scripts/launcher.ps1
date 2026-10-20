# Shared by the Windows launchers: where things are, how a phase is announced,
# and how an earlier GptImg from this checkout is replaced. Dot-sourced.
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Root "dist\win-unpacked\GptImg.exe"
$DevElectron = Join-Path $Root "node_modules\electron\dist\electron.exe"

# Runs a native command and stops on a non-zero exit, which PowerShell 5.1 does not do itself.
function Invoke-Native([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') exited with $LASTEXITCODE." }
}

function Write-Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor DarkYellow }

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "$Name is required but not installed." }
}

# Replaces whatever GptImg this checkout already runs, by executable path.
function Stop-Running {
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $App -or $_.Path -eq $DevElectron } | Stop-Process -Force
  Start-Sleep -Milliseconds 300
}

function Invoke-Launcher([string]$Name, [scriptblock]$Body) {
  try { & $Body }
  catch {
    Write-Host "`nGptImg: $Name failed: $_" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
  }
}
