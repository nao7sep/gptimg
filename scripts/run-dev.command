#!/bin/zsh
# Runs GptImg from source with live reload (electron-vite dev): the loose
# configuration, for coding. Replaces the GptImg these launchers started.
LAUNCHER_NAME=run-dev
source "${0:A:h}/launcher.sh"
set -e
cd "$ROOT"
require_command npm
log_step "Installing dependencies"
npm install --no-audit --no-fund
# electron-vite reads Electron's binary location without installing it; Electron's
# installer fetches the binary if it is missing and does nothing otherwise.
node node_modules/electron/install.js
log_step "Replacing a running GptImg"
stop_running
DEV_PORT=$(node -p "require('./package.json').config.devPort")
if lsof -nP -iTCP:$DEV_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "Port $DEV_PORT is held by another process; GptImg's dev server needs it."
  lsof -nP -iTCP:$DEV_PORT -sTCP:LISTEN
  exit 1
fi
log_step "Starting the dev server"
npx electron-vite dev &
DEV_PID=$!
record_dev_app $DEV_PID
wait $DEV_PID
