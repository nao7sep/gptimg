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

# Ask the existing app to use its ordinary quit owner, then wait for the exact
# processes captured here. A declined quit leaves the current app running.
stop_running() {
  local snapshot pid parent executable parent_command request_pid
  local built_running=0 dev_running=0
  local -a waiting remaining
  snapshot=$(ps -axo pid=,ppid=,comm=) || return 1
  while read -r pid parent executable; do
    if [[ "$executable" == "$APP/Contents/MacOS/GptImg" ]]; then
      built_running=1
      waiting+=("$pid")
    elif [[ "$executable" == "$DEV_ELECTRON/Contents/MacOS/Electron" ]]; then
      dev_running=1
      waiting+=("$pid")
      # electron-vite exits on its Electron child's close; wait for it to
      # release the dev server as well, without signalling the supervisor.
      parent_command=$(ps -p "$parent" -o command= 2>/dev/null) || parent_command=""
      if [[ "$parent_command" == *"$ROOT/node_modules/.bin/electron-vite dev" ||
            "$parent_command" == *"$ROOT/node_modules/electron-vite/bin/electron-vite.js dev" ]]; then
        waiting+=("$parent")
      fi
    fi
  done <<< "$snapshot"
  (( ${#waiting} == 0 )) && return 0

  if (( built_running )); then
    "$APP/Contents/MacOS/GptImg" --gptimg-quit-for-replacement >/dev/null 2>&1 &
    request_pid=$!
    waiting+=("$request_pid")
  fi
  if (( dev_running )); then
    "$DEV_ELECTRON/Contents/MacOS/Electron" "$ROOT" --gptimg-quit-for-replacement >/dev/null 2>&1 &
    request_pid=$!
    waiting+=("$request_pid")
  fi
  local deadline=$(( SECONDS + 30 ))
  while (( ${#waiting} > 0 )); do
    remaining=()
    for pid in "${waiting[@]}"; do
      if ps -p "$pid" -o pid= >/dev/null 2>&1; then remaining+=("$pid"); fi
    done
    waiting=("${remaining[@]}")
    (( ${#waiting} == 0 )) && return 0
    if (( SECONDS >= deadline )); then
      print -u2 "GptImg is still running. Finish or cancel its current work, accept Quit, then run this launcher again. No replacement was launched."
      return 1
    fi
    sleep 0.1
  done
}

build_age() {
  local built=$(stat -f %m "$APP")
  local minutes=$(( ($(date +%s) - built) / 60 ))
  if (( minutes < 60 )); then print "$minutes minutes"; else print "$(( minutes / 60 )) hours"; fi
}
