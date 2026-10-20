# Shared by the macOS launchers: where things are, how a phase is announced,
# and how an earlier GptImg from this checkout is replaced. Sourced, not run.

SCRIPT_DIR="${0:A:h}"
ROOT="${SCRIPT_DIR:h}"
APP="$ROOT/dist/mac-arm64/GptImg.app"
DEV_ELECTRON="$ROOT/node_modules/electron/dist/Electron.app"

log_step() { print -P "\n%F{208}==>%f %B$1%b" }

require_command() {
  command -v "$1" >/dev/null 2>&1 || { print -u2 "GptImg launcher: $1 is required but not installed."; exit 1 }
}

on_exit() {
  local code=$?
  # 130 is an interrupt: the reader stopped it on purpose.
  if (( code != 0 && code != 130 )); then
    print -u2 "\nGptImg: ${LAUNCHER_NAME:-launcher} failed (exit $code)."
    read -k 1 "?Press any key to close."
  fi
}
trap on_exit EXIT

# Replaces whatever GptImg this checkout already runs, in either mode, by its
# executable path; never by port, and never another app's process.
stop_running() {
  local pattern
  for pattern in "$APP/Contents/MacOS/GptImg" "$DEV_ELECTRON/Contents/MacOS/Electron" "$ROOT/node_modules/.bin/electron-vite"; do
    pkill -f "^$pattern" 2>/dev/null || true
  done
  local waited=0
  while pgrep -f "^($APP/Contents/MacOS/GptImg|$DEV_ELECTRON/Contents/MacOS/Electron)" >/dev/null 2>&1 && (( waited < 50 )); do
    sleep 0.1
    (( waited++ ))
  done
}

build_age() {
  local built=$(stat -f %m "$APP")
  local minutes=$(( ($(date +%s) - built) / 60 ))
  if (( minutes < 60 )); then print "$minutes minutes"; else print "$(( minutes / 60 )) hours"; fi
}
