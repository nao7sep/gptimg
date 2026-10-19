#!/bin/zsh
# Launches the existing production build without rebuilding it: strict CSP,
# packaged layout. Replaces any GptImg this checkout is running.
LAUNCHER_NAME=run-built
source "${0:A:h}/launcher.sh"
set -e
if [[ ! -d "$APP" ]]; then
  print -u2 "No build yet. Run rebuild.command first."
  exit 1
fi
log_step "Launching the build from $(build_age) ago"
stop_running
open -n "$APP"
