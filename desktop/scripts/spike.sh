#!/usr/bin/env bash
# Linux webview spike harness (plans/desktop-app.md T2). Runs the debug app
# on a virtual display so a headless host can drive and photograph it.
#
#   spike.sh start <url> [profile-dir]   Xvfb :99 + D-Bus + the app, log in $OUT/app.log
#   spike.sh shot <name>                 screenshot to $OUT/<name>.png
#   spike.sh key <xdotool key args...>   send keys to the focused window
#   spike.sh js <code>                   run JS in the window (async body; r(name, ok, note) reports)
#   spike.sh stop                        stop the app, D-Bus and Xvfb
#
# $OUT defaults to ./spike-out. Point the app at a Perch you started yourself
# with its own PERCH_CONFIG_DIR/PERCH_STATE_DIR, never a production one.
set -euo pipefail
OUT=${OUT:-$PWD/spike-out}
DISPLAY_NUM=${DISPLAY_NUM:-99}
export DISPLAY=:$DISPLAY_NUM
HERE=$(cd "$(dirname "$0")/.." && pwd)
BIN=$HERE/src-tauri/target/debug/perch-desktop
mkdir -p "$OUT"

case "${1:-}" in
  start)
    url=${2:?url}
    profile=${3:-$OUT/profile}
    if ! [ -e /tmp/.X11-unix/X$DISPLAY_NUM ]; then
      Xvfb ":$DISPLAY_NUM" -screen 0 1600x1000x24 >"$OUT/xvfb.log" 2>&1 &
      echo $! >"$OUT/xvfb.pid"
      sleep 1
    fi
    eval "$(dbus-launch --sh-syntax)"
    echo "$DBUS_SESSION_BUS_PID" >"$OUT/dbus.pid"
    echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'" >"$OUT/dbus.env"
    mkdir -p "$OUT/eval"
    PERCH_DESKTOP_SPIKE_URL=$url PERCH_DESKTOP_SPIKE_DATA=$profile PERCH_DESKTOP_SPIKE_EVAL_DIR=$OUT/eval \
      nohup "$BIN" >"$OUT/app.log" 2>&1 &
    echo $! >"$OUT/app.pid"
    echo "app pid $(cat "$OUT/app.pid"), log $OUT/app.log"
    ;;
  shot)
    ffmpeg -loglevel error -y -f x11grab -video_size 1600x1000 -i "$DISPLAY" -frames:v 1 "$OUT/${2:?name}.png"
    echo "$OUT/$2.png"
    ;;
  js)
    shift
    f="$OUT/eval/$(date +%s%N).tmp"
    printf '%s' "$*" >"$f"
    mv "$f" "${f%.tmp}.js"
    sleep "${WAIT:-1}"
    tail -n "${LINES_BACK:-5}" "$OUT/app.log"
    ;;
  key)
    shift
    xdotool key --delay 80 "$@"
    ;;
  stop)
    for f in app dbus; do [ -f "$OUT/$f.pid" ] && kill "$(cat "$OUT/$f.pid")" 2>/dev/null || true; rm -f "$OUT/$f.pid"; done
    if [ -f "$OUT/xvfb.pid" ]; then kill "$(cat "$OUT/xvfb.pid")" 2>/dev/null || true; rm -f "$OUT/xvfb.pid"; fi
    ;;
  *)
    sed -n 2,14p "$0"
    exit 1
    ;;
esac
