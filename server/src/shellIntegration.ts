// Shell integration (plans/warp-features.md Phase 1): a generated snippet —
// shell-integration.sh for zsh and bash, shell-integration.ps1 for
// PowerShell. Inside the app's terminals it emits OSC 133 prompt marks (the
// app's prompt jumps) and OSC 7 (the working directory), and reports command
// start/end (command line, cwd, exit code) to POST
// /api/command-events/report for the command-history UI and
// finished-command notifications. Reports are fire-and-forget and never
// block the prompt; with the server down they do nothing.
//
// The app's terminals source it without any rc edit, the way the shim
// folder is put on PATH: zsh starts with ZDOTDIR pointing at the wrapper
// directory written here (mux.ts's terminalEnv), whose rc files read the
// user's own and then the snippet; bash starts with `--rcfile bash-init.sh`
// and PowerShell with `-Command` dot-sourcing the .ps1 (the daemon's
// shell-launch.ts). The source line the Settings card shows stays as the
// manual route for any other setup.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { configDir } from "./configDir.js";


// Canonical path users source. Port-independent path with the port baked
// into the body, last-boot-wins across instances — same trade-off as
// openUrl.ts's shim, accepted in the plan.
export const shellIntegrationPath = path.join(configDir, "shell-integration.sh");

function shortHome(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export const powershellIntegrationPath = path.join(configDir, "shell-integration.ps1");

// The ZDOTDIR the app's zsh terminals start with, and the --rcfile its bash
// terminals start with. The daemon finds bash-init.sh by this name
// (mux/src/util/shell-launch.ts).
export const zshDotDir = path.join(configDir, "zsh");
export const bashInitPath = path.join(configDir, "bash-init.sh");

const posixSourceLine = `[ -f ${shortHome(shellIntegrationPath)} ] && . ${shortHome(shellIntegrationPath)}`;
const powershellSourceLine = `if (Test-Path '${powershellIntegrationPath}') { . '${powershellIntegrationPath}' }`;

// The line users add, and where — surfaced by the Settings card and the
// README so both render the exact same line. On Windows the shell is
// PowerShell; elsewhere zsh or bash.
export const shellIntegrationSourceLine = process.platform === "win32" ? powershellSourceLine : posixSourceLine;
export const shellIntegrationProfile = process.platform === "win32" ? "your PowerShell profile ($PROFILE)" : "your ~/.zshrc or ~/.bashrc";

// Every reference to a possibly-unset variable uses the \${VAR-} default
// form: the snippet runs inside arbitrary user rc environments, including
// interactive shells with `set -u`, where a bare "$UNSET" would abort
// sourcing with "unbound variable".
function scriptBody(port: number): string {
  return `# Perch shell integration — written by Perch at startup; edits
# are overwritten. The app's own zsh and bash terminals source it
# automatically; for any other setup, source it from your shell rc:
#   ${posixSourceLine}
#
# Inside Perch's terminals this emits OSC 133 prompt marks (for jumping
# between prompts), reports the working directory (OSC 7) and reports command
# start/end to the local Perch for command history and finished-command
# notifications. Everything is a no-op in other terminals or in
# non-interactive shells; reports are backgrounded and never block the prompt.

case $- in *i*) ;; *) return 0 2>/dev/null || exit 0 ;; esac
# A pane of the tmux backend has no PERCH_WINDOW; its id comes from tmux's.
[ -z "\${PERCH_WINDOW-}" ] && [ -n "\${TMUX_PANE-}" ] && PERCH_WINDOW="tmux-\${TMUX_PANE#%}"
[ -n "\${PERCH_WINDOW-}" ] || return 0
[ -n "\${_PERCH_INTEGRATION-}" ] && return 0
_PERCH_INTEGRATION=1

# The subshell keeps the backgrounded curl out of the interactive shell's job
# table (no "[1] 1234" noise, nothing for the shell to reap). The custom
# header is the CSRF guard (same idea as the open-url shim): a cross-origin
# browser request carrying it needs a CORS preflight the server never
# approves, while a local curl sends it freely.
# shell=$$ + a per-shell sequence number let the server pair each end with
# its start: the two reports are independent backgrounded curls, and for a
# fast command the end can genuinely arrive first — without the pair key the
# end would attach to whatever start happened to be latest (observed live
# with nested shells in one pane). The end also re-sends the command text so
# it stands alone when it wins that race.
_perch_report() {
  ( command curl -s -m 1 -X POST -H 'X-Perch-Events: 1' \\
      --data-urlencode "pane=$PERCH_WINDOW" \\
      --data-urlencode "shell=$$" \\
      --data-urlencode "seq=\${_PERCH_SEQ-0}" \\
      --data-urlencode "event=$1" \\
      --data-urlencode "command=$2" \\
      --data-urlencode "cwd=$PWD" \\
      --data-urlencode "exit=$3" \\
      "http://127.0.0.1:${port}/api/command-events/report" >/dev/null 2>&1 & )
}

# $1 = the command line about to run.
_perch_on_preexec() {
  _PERCH_SEQ=$(( \${_PERCH_SEQ-0} + 1 ))
  _PERCH_CMD="$1"
  _PERCH_RAN=1
  printf '\\033]133;C\\033\\\\'
  _perch_report start "$1" ""
}

# $1 = the exit status of the command that just finished. The end report is
# gated on _PERCH_RAN so the first prompt after sourcing (no preceding
# command) and empty-line Enters report nothing.
_perch_on_precmd() {
  printf '\\033]133;D;%s\\033\\\\\\033]7;file://%s%s\\033\\\\' "$1" "\${HOSTNAME-}" "$PWD"
  # The prompt-start mark. zsh carries it inside the prompt instead (below):
  # it draws its PROMPT_SP line after precmd runs, so a mark printed here
  # would land a line above the prompt it belongs to.
  [ -n "\${ZSH_VERSION-}" ] || printf '\\033]133;A\\033\\\\'
  if [ -n "\${_PERCH_RAN-}" ]; then
    _PERCH_RAN=
    _perch_report end "\${_PERCH_CMD-}" "$1"
  fi
}

if [ -n "\${ZSH_VERSION-}" ]; then
  _perch_zsh_preexec() { _perch_on_preexec "$1"; }
  # $? must be captured before anything else runs in the hook body; earlier
  # precmd hooks registered by other tools may still have clobbered it — a
  # known limitation every OSC 133 integration shares.
  # Also (re)prefixes the prompt with the mark: prompt themes rebuild PROMPT
  # in their own precmd, and ours is registered after theirs, so it runs
  # last. %{ %} tells zsh the mark takes no width.
  _perch_zsh_precmd() {
    _perch_on_precmd $?
    case "$PROMPT" in
      *$'\\e]133;A'*) ;;
      *) PROMPT=$'%{\\e]133;A\\e\\\\%}'"$PROMPT" ;;
    esac
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec _perch_zsh_preexec
  add-zsh-hook precmd _perch_zsh_precmd

elif [ -n "\${BASH_VERSION-}" ]; then
  # Full command line from history — BASH_COMMAND alone would give only the
  # first simple command of a pipeline/compound.
  _perch_bash_command() {
    HISTTIMEFORMAT= builtin history 1 2>/dev/null | sed '1 s/^ *[0-9][0-9]*[* ] *//'
  }

  if declare -p preexec_functions >/dev/null 2>&1; then
    # bash-preexec is loaded — compose with it instead of owning the DEBUG
    # trap ourselves. It passes the command as $1 and preserves $? for
    # precmd functions.
    _perch_bp_preexec() { _perch_on_preexec "$1"; }
    _perch_bp_precmd() { _perch_on_precmd $?; }
    preexec_functions+=(_perch_bp_preexec)
    precmd_functions+=(_perch_bp_precmd)
  else
    # Minimal preexec emulation: PROMPT_COMMAND provides precmd; a DEBUG
    # trap provides preexec. _PERCH_AT_PROMPT arms exactly one DEBUG
    # firing per displayed prompt — the user's command — and the guards
    # below reject the firings that aren't it (our own hook functions, the
    # user's pre-existing PROMPT_COMMAND entries re-running on an empty-line
    # Enter, and subshells like PS1 command substitutions).
    _perch_bash_preexec() {
      [ -n "\${_PERCH_AT_PROMPT-}" ] || return 0
      [ "$BASH_SUBSHELL" = 0 ] || return 0
      case "$BASH_COMMAND" in _perch_*) return 0 ;; esac
      case ";\${PROMPT_COMMAND-};" in *";$BASH_COMMAND;"*) return 0 ;; esac
      _PERCH_AT_PROMPT=
      _perch_on_preexec "$(_perch_bash_command)"
    }
    _perch_bash_precmd() {
      _perch_on_precmd $?
    }
    _perch_arm() {
      _PERCH_AT_PROMPT=1
    }
    # Ours first so $? is still the user command's status; arm last so the
    # DEBUG firings for the intervening PROMPT_COMMAND entries can't pass
    # the at-prompt guard.
    PROMPT_COMMAND="_perch_bash_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND};_perch_arm"

    # Chain any pre-existing DEBUG trap rather than clobbering it. trap -p
    # prints "trap -- '<shell-quoted body>' DEBUG"; the eval unquotes the
    # body safely regardless of embedded quotes.
    _perch_prev_trap=$(trap -p DEBUG)
    if [ -n "$_perch_prev_trap" ]; then
      _perch_prev_trap=\${_perch_prev_trap#trap -- }
      _perch_prev_trap=\${_perch_prev_trap% DEBUG}
      eval "_PERCH_PREV_DEBUG=$_perch_prev_trap"
    fi
    unset _perch_prev_trap
    _perch_debug_hook() {
      _perch_bash_preexec
      if [ -n "\${_PERCH_PREV_DEBUG-}" ]; then eval "$_PERCH_PREV_DEBUG"; fi
    }
    trap '_perch_debug_hook' DEBUG
  fi
fi
`;
}

const WRITTEN_BY = "# Perch shell integration — written by Perch at startup; edits are overwritten.";

// A zsh startup file that reads the user's own copy with ZDOTDIR set to
// where that copy lives (rc files refer to $ZDOTDIR themselves), then puts
// ZDOTDIR back on this directory so zsh keeps reading the wrappers.
// PERCH_USER_ZDOTDIR is the user's real ZDOTDIR: terminalEnv sets it when
// the server started with one, and .zshenv updates it in case the user's
// .zshenv is what sets ZDOTDIR (a common way to keep ~ clean).
function zshWrapper(file: string, extra = ""): string {
  return `${WRITTEN_BY}
# Perch starts zsh with ZDOTDIR here so it can source the shell integration
# after your own ${file}, read from your ZDOTDIR (or ~) as usual.
_perch_zdotdir=$ZDOTDIR
ZDOTDIR=\${PERCH_USER_ZDOTDIR:-$HOME}
[ -f "$ZDOTDIR/${file}" ] && . "$ZDOTDIR/${file}"
${extra}ZDOTDIR=$_perch_zdotdir
unset _perch_zdotdir
`;
}

export function zshWrapperFiles(): Record<string, string> {
  return {
    ".zshenv": zshWrapper(".zshenv", '[ "$ZDOTDIR" = "$HOME" ] || export PERCH_USER_ZDOTDIR=$ZDOTDIR\n'),
    ".zprofile": zshWrapper(".zprofile"),
    // The integration comes last, after the user's .zshrc and any prompt
    // theme it sets up. ZDOTDIR is then left as the user had it (unset when
    // they had none), so anything started from this shell sees their setup
    // rather than Perch's — a nested zsh is plain, same as in VS Code.
    ".zshrc": `${WRITTEN_BY}
# Perch starts zsh with ZDOTDIR here so it can source the shell integration
# after your own .zshrc, read from your ZDOTDIR (or ~) as usual.
ZDOTDIR=\${PERCH_USER_ZDOTDIR:-$HOME}
[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"
${posixSourceLine}
if [ -n "\${PERCH_USER_ZDOTDIR-}" ]; then ZDOTDIR=$PERCH_USER_ZDOTDIR; else unset ZDOTDIR; fi
`,
    ".zlogin": zshWrapper(".zlogin"),
  };
}

// `bash --rcfile FILE` reads FILE instead of both the system bashrc and
// ~/.bashrc, so this one reads those first. The system file is where bash
// was built to look: /etc/bash.bashrc on Debian-style Linux, /etc/bashrc on
// macOS (Fedora's /etc/bashrc is sourced by its ~/.bashrc, not by bash).
export function bashInitBody(platform: NodeJS.Platform = process.platform): string {
  const systemRc = platform === "darwin" ? "/etc/bashrc" : "/etc/bash.bashrc";
  return `${WRITTEN_BY}
# Perch starts bash with --rcfile naming this file, which stands in for the
# files bash reads on its own, so those come first, then the integration.
[ -f ${systemRc} ] && . ${systemRc}
[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
${posixSourceLine}
`;
}

// Best-effort at boot, same contract as ensureOpenShim: a read-only config
// dir just disables the feature (index.ts logs and continues). index.ts
// waits for this before the engine starts, so a terminal opened right after
// boot already finds the zsh wrappers ZDOTDIR points at.
export async function ensureShellIntegration(port: number): Promise<string> {
  await mkdir(zshDotDir, { recursive: true });
  await writeFile(shellIntegrationPath, scriptBody(port));
  await writeFile(powershellIntegrationPath, await powershellScriptBody(port));
  for (const [name, body] of Object.entries(zshWrapperFiles())) await writeFile(path.join(zshDotDir, name), body);
  if (process.platform !== "win32") await writeFile(bashInitPath, bashInitBody());
  return shellIntegrationPath;
}

// The PowerShell script lives beside this file as a template: it is full of
// backslashes and dollar signs that would all need escaping in a string here.
export async function powershellScriptBody(port: number): Promise<string> {
  const template = await readFile(path.join(import.meta.dirname, "shell-integration.ps1"), "utf8");
  return template.replaceAll("__PORT__", String(port)).replaceAll("__SOURCE_LINE__", powershellSourceLine);
}
