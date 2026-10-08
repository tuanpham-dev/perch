#!/usr/bin/env bash
# Perch installer — clones the repo, builds it, and installs it as a
# user service (systemd on Linux, launchd on macOS). No sudo; everything lives under
# $HOME. Safe to re-run: it updates an existing install instead of failing.
#
#   curl -fsSL https://raw.githubusercontent.com/tuanpham-dev/perch/main/install.sh | bash
#
# It installs the latest release. PERCH_CHANNEL=beta includes pre-releases,
# and PERCH_REF=main installs the main branch instead.
#
# Override the source repo or install location for testing/forks:
#   PERCH_REPO=/path/to/repo PERCH_DIR=/tmp/tsv bash install.sh
set -euo pipefail

REPO_URL="${PERCH_REPO:-https://github.com/tuanpham-dev/perch.git}"
INSTALL_DIR="${PERCH_DIR:-$HOME/.local/share/perch}"
CHANNEL="${PERCH_CHANNEL:-stable}"
REF="${PERCH_REF:-}"

# The newest vX.Y.Z tag in `git ls-remote --tags` output on stdin (pre-releases
# only with "beta"), by SemVer order - the same order perch update uses.
PICK_TAG='const ch=process.argv[1];const P=/^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;const key=t=>{const m=P.exec(t);return m&&{n:[+m[1],+m[2],+m[3]],p:m[4]?m[4].split('.'):[]}};const cmp=(a,b)=>{for(let i=0;i<3;i++)if(a.n[i]!==b.n[i])return a.n[i]-b.n[i];if(!a.p.length||!b.p.length)return b.p.length-a.p.length;for(let i=0;i<Math.max(a.p.length,b.p.length);i++){const x=a.p[i],y=b.p[i];if(x===undefined)return -1;if(y===undefined)return 1;if(x===y)continue;const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return x-y;if(xn)return -1;if(yn)return 1;return x<y?-1:1}return 0};let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{let best=null;for(const l of input.split('\n')){const r=(l.split('\t')[1]||'').trim().replace('refs/tags/','').replace('^{}','');const k=key(r);if(!k||(ch!=='beta'&&k.p.length))continue;if(!best||cmp(k,best.k)>0)best={r,k}}if(best)console.log(best.r)});'

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
  # perch update knows the rest: which release, never moving backwards,
  # reinstalling, rebuilding and restarting.
  UPDATE_FLAGS=()
  [ "$REF" = "main" ] && UPDATE_FLAGS+=(--main)
  [ "$CHANNEL" = "beta" ] && UPDATE_FLAGS+=(--beta)
  node "$INSTALL_DIR/bin/perch" update "${UPDATE_FLAGS[@]}"
elif [ -e "$INSTALL_DIR" ]; then
  die "$INSTALL_DIR already exists and isn't a Perch checkout — remove it or set PERCH_DIR to a different path"
else
  if [ -z "$REF" ]; then
    REF="$(git ls-remote --tags "$REPO_URL" | node -e "$PICK_TAG" "$CHANNEL")"
    if [ -z "$REF" ]; then
      warn "no ${CHANNEL} release yet — installing the main branch"
      REF="main"
    fi
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git -c advice.detachedHead=false clone --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  git -C "$INSTALL_DIR" config perch.track "$([ "$REF" = "main" ] && echo main || echo release)"
  ok "source ready ($REF)"

  heading "Building"
  # ci, not install: install rewrites package-lock.json, which perch update
  # would then see as a local change.
  ( cd "$INSTALL_DIR" && npm ci && npm run build )
  ok "build complete"
fi

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
# A fresh install has no server/.env yet: with pipefail, sed's "no such file"
# would end the script here, before the address below is printed.
PORT_LINE=""
if [ -f "$INSTALL_DIR/server/.env" ]; then
  PORT_LINE="$(sed -n 's/^PORT=//p' "$INSTALL_DIR/server/.env" | tail -n1 | tr -d '[:space:]')"
fi
echo "Perch is at http://127.0.0.1:${PORT_LINE:-3001}"
echo "Config (PORT, AUTH_TOKEN, ALLOWED_HOSTS, NEW_SESSION_CWD) goes in $INSTALL_DIR/server/.env — see docs/INSTALL.md."
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Run 'perch doctor' any time to check the install, or 'perch help' for all commands."
