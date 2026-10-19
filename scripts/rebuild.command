#!/bin/zsh
# Builds GptImg as it would be released (typecheck, bundle, packaged .app,
# ad-hoc seal, no installer), then launches it.
LAUNCHER_NAME=rebuild
source "${0:A:h}/launcher.sh"
set -e
cd "$ROOT"
require_command npm
log_step "Installing dependencies"
npm install --no-audit --no-fund
log_step "Removing the previous build"
rm -rf out dist
log_step "Type-checking the shipped sources"
npm run typecheck:app
log_step "Bundling"
npx electron-vite build
log_step "Assembling GptImg.app"
npx electron-builder --dir --mac --arm64
log_step "Launching"
stop_running
open -n "$APP"
