# Runs GptImg from source with live reload (electron-vite dev).
. "$PSScriptRoot\launcher.ps1"
Invoke-Launcher "run-dev" {
  Set-Location $Root
  Require-Command npm
  Write-Step "Installing dependencies"
  Invoke-Native npm @("install", "--no-audit", "--no-fund")
  # electron-vite reads Electron's binary location without installing it; Electron's
  # installer fetches the binary if it is missing and does nothing otherwise.
  Invoke-Native node @("node_modules/electron/install.js")
  Write-Step "Replacing a running GptImg"
  Stop-Running
  $DevPort = [int](node -p "require('./package.json').config.devPort")
  if (Get-NetTCPConnection -LocalPort $DevPort -State Listen -ErrorAction SilentlyContinue) { throw "Port $DevPort is held by another process; GptImg's dev server needs it." }
  Write-Step "Starting the dev server"
  Invoke-Native npx @("electron-vite", "dev")
}
