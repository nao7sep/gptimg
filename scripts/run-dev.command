#!/bin/zsh
# Runs GptImg from source with live reload (electron-vite dev): the loose
# configuration, for coding. Replaces any GptImg this checkout is running.
LAUNCHER_NAME=run-dev
source "${0:A:h}/launcher.sh"
set -e
cd "$ROOT"
require_command npm
log_step "Installing dependencies"
npm install --no-audit --no-fund
log_step "Replacing a running GptImg"
stop_running
DEV_PORT=$(node -p "require('./package.json').config.devPort")
if lsof -nP -iTCP:$DEV_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "Port $DEV_PORT is held by another process; GptImg's dev server needs it."
  lsof -nP -iTCP:$DEV_PORT -sTCP:LISTEN
  exit 1
fi
log_step "Starting the dev server"
npx electron-vite dev
