// `perch doctor` - dependencies, install health, runtime.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Exit, fail, heading, info, ok, warn } from './output.ts';
import { appUrl, BIN_DIR, REPO_DIR } from './paths.ts';
import { responding, succeeds, which } from './run.ts';
import { usableServiceManager } from './serviceManager.ts';

const NODE_MAJOR = 23;

export async function cmdDoctor(): Promise<void> {
  let failed = false;
  const need = (pass: boolean, good: string, bad: string) => {
    if (pass) ok(good);
    else {
      fail(bad);
      failed = true;
    }
  };

  heading('Required');
  const major = Number(process.versions.node.split('.')[0]);
  need(major >= NODE_MAJOR, `node v${process.versions.node} (>= ${NODE_MAJOR} required)`,
    `node v${process.versions.node} found, but ${NODE_MAJOR}+ is required - install Node.js ${NODE_MAJOR}+ (https://nodejs.org)`);
  const git = which('git');
  need(git !== null, `git found (${git})`, 'git not found - install it via your package manager');
  const cc = which('cc') ?? which('gcc') ?? which('clang');
  const toolchain = cc !== null && which('make') !== null && (which('python3') ?? which('python')) !== null;
  if (process.platform === 'win32') {
    // node-pty installs prebuilt on Windows; a compiler only matters when it can't.
    if (toolchain) ok('C/C++ toolchain found');
    else warn('no C/C++ toolchain on PATH - fine unless node-pty has to be built from source (then install Visual Studio Build Tools)');
  } else {
    need(toolchain, "C/C++ toolchain found (needed to build node-pty's native addon)",
      "missing C/C++ toolchain pieces (need a C compiler, make, and python3) - node-pty won't build. Debian/Ubuntu: apt install build-essential python3. macOS: xcode-select --install");
  }

  heading('Install health');
  need(existsSync(join(REPO_DIR, 'node_modules')), 'dependencies installed',
    `node_modules missing - run: perch update  (or cd ${REPO_DIR} && npm install)`);
  const ptyInstalled = ['node_modules/node-pty', 'mux/node_modules/node-pty', 'server/node_modules/node-pty'].some((p) => existsSync(join(REPO_DIR, p)));
  if (!ptyInstalled) need(false, '', 'node-pty not installed - run: perch update');
  else need(succeeds(process.execPath, ['-e', "require('node-pty')"], join(REPO_DIR, 'mux')), 'node-pty native addon loads',
    'node-pty is installed but fails to load - its native addon likely needs rebuilding for this Node version. Run: perch update');
  need(existsSync(join(REPO_DIR, 'client', 'dist', 'index.html')), 'client build present',
    `client/dist missing - run: cd ${REPO_DIR} && npm run build`);

  heading('Runtime');
  const manager = usableServiceManager();
  if (manager) {
    ok(`${manager.kind} available`);
    if (manager.installed()) {
      ok('service installed');
      if (manager.enabled()) ok('service enabled (starts on login)');
      else warn('service not enabled - run: perch enable');
      if (manager.active()) ok('service active');
      else warn('service not running - run: perch start');
    } else {
      warn('service not installed - run: perch enable');
    }
    manager.doctor({ ok, warn });
  } else {
    warn('no system service manager - running in the background instead (perch start/stop)');
  }
  if (await responding(new URL(appUrl()).port)) ok(`responding at ${appUrl()}`);
  else warn(`not responding at ${appUrl()} - is it started?`);
  if ((process.env.PATH ?? '').split(delimiter).includes(BIN_DIR)) ok(`${BIN_DIR} is on PATH`);
  else if (which('perch')) ok('perch is on PATH');
  else warn(`${BIN_DIR} is not on PATH - add it to your shell profile, e.g.: export PATH="${BIN_DIR}:$PATH"`);

  heading('Optional features');
  if (which('nvim')) ok('nvim found - opening files, diffs and merges in the terminal will work');
  else warn('nvim not found - the default editor for files, diffs and merges needs it. Install: https://neovim.io');
  if (which('lazygit')) ok('lazygit found - the FILES-panel branch pill will work');
  else warn("lazygit not found - the branch pill's lazygit integration needs it. Install: https://github.com/jesseduffield/lazygit");

  info('');
  if (failed) {
    fail('one or more required checks failed - see above');
    throw new Exit(1);
  }
  ok('all required checks passed');
}
