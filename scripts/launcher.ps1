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

# Ask the existing app to use its ordinary quit owner, then wait for the exact
# processes captured here. A declined quit leaves the current app running.
function Stop-Running {
  $Processes = @(Get-CimInstance Win32_Process)
  $Running = @($Processes | Where-Object { $_.ExecutablePath -eq $App -or $_.ExecutablePath -eq $DevElectron })
  if ($Running.Count -eq 0) { return }
  $Waiting = @($Running | ForEach-Object { [int]$_.ProcessId })
  foreach ($Process in $Running) {
    if ($Process.ExecutablePath -eq $DevElectron) {
      $Parent = $Processes | Where-Object { $_.ProcessId -eq $Process.ParentProcessId } | Select-Object -First 1
      # electron-vite exits when its Electron child closes, releasing Vite too.
      if ($Parent -and $Parent.CommandLine) {
        foreach ($Supervisor in @((Join-Path $Root "node_modules\.bin\electron-vite"),
                                  (Join-Path $Root "node_modules\electron-vite\bin\electron-vite.js"))) {
          if ($Parent.CommandLine.EndsWith("$Supervisor dev", [System.StringComparison]::OrdinalIgnoreCase) -or
              $Parent.CommandLine.EndsWith("`"$Supervisor`" dev", [System.StringComparison]::OrdinalIgnoreCase)) {
            $Waiting += [int]$Parent.ProcessId
            break
          }
        }
      }
    }
  }
  foreach ($Executable in @($Running.ExecutablePath | Select-Object -Unique)) {
    $Arguments = @("--gptimg-quit-for-replacement")
    if ($Executable -eq $DevElectron) { $Arguments = @("`"$Root`"", "--gptimg-quit-for-replacement") }
    $Request = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru
    $Waiting += $Request.Id
  }
  $Clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($Waiting.Count -gt 0) {
    $Waiting = @($Waiting | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($Waiting.Count -eq 0) { return }
    if ($Clock.Elapsed.TotalSeconds -ge 30) {
      throw "GptImg is still running. Finish or cancel its current work, accept Quit, then run this launcher again. No replacement was launched."
    }
    Start-Sleep -Milliseconds 100
  }
}

function Invoke-Launcher([string]$Name, [scriptblock]$Body) {
  try { & $Body }
  catch {
    Write-Host "`nGptImg: $Name failed: $_" -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
  }
}
