# Shared by the macOS launchers: where things are, how a phase is announced,
# and how the GptImg these launchers started is replaced. Sourced, not run.

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

# The launcher that starts GptImg records its process ID and executable here.
RECORD="$ROOT/.git/launcher-runtime-process"

# The executable a process runs, or nothing once it has ended.
executable_of() { ps -p "$1" -o comm= 2>/dev/null }

record_process() { print -r -- "$1"$'\n'"$2" > "$RECORD" }

# Ask the recorded GptImg to quit as a user would, only while that process still
# runs the recorded executable, so its quit confirmation can protect unsaved or
# running work. One started any other way is left to its single-instance lock,
# which brings its window forward instead of opening a second one.
stop_running() {
  [[ -f "$RECORD" ]] || return 0
  local pid executable
  { read -r pid; read -r executable } < "$RECORD"
  [[ "$pid" == <-> && -n "$executable" && "$(executable_of $pid)" == "$executable" ]] || return 0
  print "Asking the running GptImg (pid $pid) to quit."
  osascript -l JavaScript -e "ObjC.import('AppKit');
function run(args) {
  var running = \$.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
  if (running) running.terminate;
}" "$pid" >/dev/null
  local deadline=$(( SECONDS + 5 ))
  while [[ "$(executable_of $pid)" == "$executable" ]]; do
    if (( SECONDS >= deadline )); then
      print -u2 "GptImg is still open, perhaps finishing or asking about running work. Close it, then run this launcher again."
      return 1
    fi
    sleep 0.1
  done
}

# Open a new instance of the bundle through Launch Services, which gives it its
# bundle identity, and record it.
launch_built() {
  local pid
  pid=$(osascript -l JavaScript -e "ObjC.import('AppKit');
function run(args) {
  var running = \$.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError(
    \$.NSURL.fileURLWithPath(args[0]), \$.NSWorkspaceLaunchNewInstance, \$({}), null);
  return running.isNil() ? '' : String(running.processIdentifier);
}" "$APP")
  [[ "$pid" == <-> ]] || { print -u2 "GptImg could not be opened."; return 1 }
  record_process "$pid" "$(executable_of $pid)"
}

# Record the Electron that electron-vite (pid $1) starts, once it appears: the
# topmost descendant running the dev executable. Fails when the dev server ends
# first, as it does when the build fails.
record_dev_app() {
  local wrapper=$1 expected="$DEV_ELECTRON/Contents/MacOS/Electron"
  local pid parent executable up hops
  local -A parent_of
  local -a matches
  while kill -0 "$wrapper" 2>/dev/null; do
    parent_of=()
    matches=()
    while read -r pid parent executable; do
      parent_of[$pid]=$parent
      [[ "$executable" == "$expected" ]] && matches+=("$pid")
    done <<< "$(ps -axo pid=,ppid=,comm=)"
    for pid in $matches; do
      (( ${matches[(Ie)${parent_of[$pid]}]} )) && continue
      up=${parent_of[$pid]}
      for (( hops = 0; hops < 64 && up > 1; hops++ )); do
        if [[ "$up" == "$wrapper" ]]; then record_process "$pid" "$expected"; return 0; fi
        up=${parent_of[$up]:-0}
      done
    done
    sleep 0.2
  done
  print -u2 "The GptImg development runtime ended before the app started."
  return 1
}

build_age() {
  local built=$(stat -f %m "$APP")
  local minutes=$(( ($(date +%s) - built) / 60 ))
  if (( minutes < 60 )); then print "$minutes minutes"; else print "$(( minutes / 60 )) hours"; fi
}
