# Shared by the Windows launchers: where things are, how a phase is announced,
# and how the GptImg these launchers started is replaced. Dot-sourced.
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

# The launcher that starts GptImg records its process ID and executable here.
$Record = Join-Path $Root ".git\launcher-runtime-process"

function Save-Launched([int]$ProcessId, [string]$Executable) {
  Set-Content -Path $Record -Value @("$ProcessId", $Executable) -Encoding UTF8
}

# The executable a process runs, or "" once it has ended.
function Get-ExecutableOf([int]$ProcessId) {
  $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($Process -and $Process.Path) { return $Process.Path }
  return ""
}

# Ask the recorded GptImg to close its window as a user would, only while that
# process still runs the recorded executable, so its quit confirmation can
# protect unsaved or running work. One started any other way is left to its
# single-instance lock, which brings its window forward instead.
function Stop-Running {
  if (-not (Test-Path $Record)) { return }
  $Lines = @(Get-Content $Record)
  $ProcessId = 0
  if ($Lines.Count -lt 2 -or -not [int]::TryParse($Lines[0], [ref]$ProcessId) -or -not $Lines[1]) { return }
  $Executable = $Lines[1]
  if ((Get-ExecutableOf $ProcessId) -ne $Executable) { return }
  Write-Host "Asking the running GptImg (pid $ProcessId) to quit."
  $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($Process) { $null = $Process.CloseMainWindow() }
  $Clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ((Get-ExecutableOf $ProcessId) -eq $Executable) {
    if ($Clock.Elapsed.TotalSeconds -ge 5) {
      throw "GptImg is still open, perhaps finishing or asking about running work. Close it, then run this launcher again."
    }
    Start-Sleep -Milliseconds 100
  }
}

# Record the Electron that electron-vite starts, once it appears: the topmost
# descendant of the wrapper running the dev executable, since Electron's own
# child processes share it. Fails when the wrapper ends first.
function Save-DevApp([int]$WrapperId) {
  while (Get-Process -Id $WrapperId -ErrorAction SilentlyContinue) {
    $Processes = @(Get-CimInstance Win32_Process)
    $ParentOf = @{}
    foreach ($Item in $Processes) { $ParentOf[[int]$Item.ProcessId] = [int]$Item.ParentProcessId }
    $Found = @($Processes | Where-Object { $_.ExecutablePath -eq $DevElectron } | ForEach-Object { [int]$_.ProcessId })
    foreach ($Candidate in $Found) {
      if ($Found -contains $ParentOf[$Candidate]) { continue }
      $Up = $ParentOf[$Candidate]
      for ($Hops = 0; $Hops -lt 64 -and $Up; $Hops++) {
        if ($Up -eq $WrapperId) { Save-Launched $Candidate $DevElectron; return }
        $Up = $ParentOf[$Up]
      }
    }
    Start-Sleep -Milliseconds 200
  }
  throw "The GptImg development runtime ended before the app started."
}

function Invoke-Launcher([string]$Name, [scriptblock]$Body) {
  try { & $Body }
  catch {
    Write-Host "`nGptImg: $Name failed: $_" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
  }
}
