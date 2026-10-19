# Launches the existing production build without rebuilding it.
. "$PSScriptRoot\launcher.ps1"
Invoke-Launcher "run-built" {
  if (-not (Test-Path $App)) { throw "No build yet. Run rebuild.ps1 first." }
  $age = (Get-Date) - (Get-Item $App).LastWriteTime
  Write-Step ("Launching the build from {0:N0} minutes ago" -f $age.TotalMinutes)
  Stop-Running
  Start-Process $App
}
