#!/usr/bin/env bash
# Perch installer — clones the repo, builds it, and installs it as a
# user service (systemd on Linux, launchd on macOS). No sudo; everything lives under
# $HOME. Safe to re-run: it updates an existing install instead of failing.
#
#   curl -fsSL https://raw.githubusercontent.com/tuanpham-dev/perch/main/install.sh | bash
#
# Override the source repo or install location for testing/forks:
#   PERCH_REPO=/path/to/repo PERCH_DIR=/tmp/tsv bash install.sh
set -euo pipefail

REPO_URL="${PERCH_REPO:-https://github.com/tuanpham-dev/perch.git}"
INSTALL_DIR="${PERCH_DIR:-$HOME/.local/share/perch}"
BIN_DIR="$HOME/.local/bin"

if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_RESET=""
fi
ok()   { printf '%s[ ok ]%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }
die()  { printf '%s[fail]%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }
heading() { printf '\n%s%s%s\n' "$C_BOLD" "$1" "$C_RESET"; }

heading "Checking dependencies"

command -v git >/dev/null 2>&1 || die "git not found — install it via your package manager"
ok "git found"

command -v node >/dev/null 2>&1 || die "node not found - install Node.js 23+ (https://nodejs.org)"
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+).*/\1/')"
[ "$NODE_MAJOR" -ge 23 ] 2>/dev/null || die "node $NODE_VERSION found, but 23+ is required - install Node.js 23+ (https://nodejs.org)"
ok "node $NODE_VERSION"

TOOLCHAIN_OK=1
{ command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1; } || TOOLCHAIN_OK=0
command -v make >/dev/null 2>&1 || TOOLCHAIN_OK=0
{ command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; } || TOOLCHAIN_OK=0
[ "$TOOLCHAIN_OK" -eq 1 ] || die "missing C/C++ toolchain (need a C compiler, make, and python3) — node-pty won't build. Debian/Ubuntu: apt install build-essential python3. macOS: xcode-select --install"
ok "C/C++ toolchain found"

heading "Installing to $INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  ok "existing install found — updating"
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR already exists and isn't a Perch checkout — remove it or set PERCH_DIR to a different path"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
ok "source ready"

heading "Building"
( cd "$INSTALL_DIR" && npm install && npm run build )
ok "build complete"

heading "Installing the perch command"
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/perch" "$BIN_DIR/perch"
chmod +x "$INSTALL_DIR/bin/perch"
ok "linked $BIN_DIR/perch -> $INSTALL_DIR/bin/perch"

heading "Service"
if { command -v systemctl >/dev/null 2>&1 && systemctl --user list-units >/dev/null 2>&1; } || command -v launchctl >/dev/null 2>&1; then
  "$INSTALL_DIR/bin/perch" enable
else
  warn "no systemd user session or launchd available - start it manually with: perch start"
fi

heading "Done"
PORT_LINE="$(sed -n 's/^PORT=//p' "$INSTALL_DIR/server/.env" 2>/dev/null | tail -n1 | tr -d '[:space:]')"
echo "Perch is at http://127.0.0.1:${PORT_LINE:-3001}"
echo "Config (PORT, AUTH_TOKEN, ALLOWED_HOSTS, NEW_SESSION_CWD) goes in $INSTALL_DIR/server/.env — see docs/INSTALL.md."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Run 'perch doctor' any time to check the install, or 'perch help' for all commands."
