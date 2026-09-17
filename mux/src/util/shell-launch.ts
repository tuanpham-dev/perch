// How a window's shell is started so it loads Perch's shell integration
// (written by the app server into the config dir, see the server's
// shellIntegration.ts) without the user editing any rc file — the same
// "the app sets it up" deal as the shim folder on PATH. zsh needs nothing
// here: it reads its rc files from ZDOTDIR, which the server puts in the
// daemon's environment. bash and PowerShell have no such variable, so they
// get a startup flag instead. Any other shell, or a script the server has
// not written, starts plain.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './paths.ts';

export function shellLaunchArgs(shell: string, dir: string = configDir(), exists: (p: string) => boolean = existsSync): string[] {
  // Either separator: a Windows shell path is set by the user as a plain string.
  const name = (shell.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (name === 'bash') {
    // --rcfile replaces the system bashrc and ~/.bashrc; the file reads both
    // before the integration.
    const init = join(dir, 'bash-init.sh');
    return exists(init) ? ['--rcfile', init] : [];
  }
  if (name === 'pwsh' || name === 'powershell') {
    // Profiles still load first (-Command runs after them), -NoExit keeps
    // the shell interactive, and the try/catch keeps a script-blocking
    // execution policy from printing an error at every new terminal.
    const script = join(dir, 'shell-integration.ps1');
    return exists(script) ? ['-NoExit', '-Command', `try { . '${script.replace(/'/g, "''")}' } catch {}`] : [];
  }
  return [];
}
