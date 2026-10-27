# Builds GptImg as it would be released (typecheck, bundle, unpacked app, no installer), then launches it.
. "$PSScriptRoot\launcher.ps1"
Invoke-Launcher "rebuild" {
  Set-Location $Root
  Require-Command npm
  Write-Step "Installing dependencies"
  Invoke-Native npm @("install", "--no-audit", "--no-fund")
  Write-Step "Removing the previous build"
  Remove-Item -Recurse -Force out, dist -ErrorAction SilentlyContinue
  Write-Step "Type-checking and bundling"
  Invoke-Native npm @("run", "build")
  Write-Step "Assembling the app"
  Invoke-Native npx @("electron-builder", "--dir", "--win", "--x64")
  Write-Step "Launching"
  Stop-Running
  $Started = Start-Process $App -PassThru
  Save-Launched $Started.Id $App
}
