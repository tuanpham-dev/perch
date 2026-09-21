// What a process is actually called.
//
// The operating system's own answer is often useless: Linux renames Node's
// main thread, so /proc's comm — and therefore ss's and lsof's process
// column, and anything else reading it — says "node-MainThread" for every
// Node program on the box. Electron and some Python runtimes do the same with
// a bare "MainThread". Even without the rename, "node", "python3" or "bun" only
// names the runtime, never the program it was asked to run.
//
// Package runners hide the answer a second way: npm (and npx, pnpm, yarn,
// bun) replaces its whole command line with a title — "npm run dev", "npm
// exec vite --port 3000" — as ONE argv entry, spaces and all, which comm
// then shows cut to its 15-character limit ("npm exec chrome"). So neither
// the name nor the command line answers on its own; the word after
// run/exec does.
//
// The command line says the rest, and this module is the one place that reads
// it: the terminal daemon names windows and foreground commands with it (see
// Window.displayName), and the server labels listening ports with it (see
// server/src/ports.ts). Pure — callers bring the argv and the working
// directory, however their platform hands those over.

/** Runtimes that are named after themselves rather than what they run. */
const RUNTIMES = new Set([
  "node", "deno", "bun", "electron",
  "python", "python2", "python3", "ruby", "php", "perl", "java", "dotnet",
]);

// Flags whose value is the NEXT argv entry, so the value isn't mistaken for
// the script. Node takes --require/--import/--loader this way.
const VALUE_FLAGS = new Set([
  "-r", "--require", "--import", "--loader", "--experimental-loader",
  "--env-file", "--conditions", "-e", "--eval",
]);
// `python3 -m http.server` has no script: the module IS the name.
const MODULE_FLAGS = new Set(["-m", "--module"]);
// A script named after its position rather than its job: the folder it runs
// in says far more than "index.ts" does.
const GENERIC_SCRIPT = /^(index|main|server|app|start|cli|run|__main__)\.\w+$/;
// Folders that are equally a position rather than a name — qualified with
// their parent ("perch/server") to stay tellable apart across checkouts.
const GENERIC_DIR = new Set(["src", "server", "client", "app", "api", "web", "backend", "frontend", "lib"]);

// A package runner's rewritten title, up to and including the subcommand.
// Deliberately loose at the end (no word boundary): comm hands this over
// truncated, and "npm run-script build" has to match on "run" alone. npx
// takes its package straight after the name, with no subcommand.
const RUNNER_TITLE = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run|exec|dlx)|npx)\s*/;
// The lifecycle shorthands, where the subcommand IS the script: "npm start"
// runs the same thing as "npm run start" and should read the same way.
// Deliberately not "install" or "ci" — npm doing its own work is already
// named after itself.
const RUNNER_LIFECYCLE = /^(?:npm|pnpm|yarn|bun)\s+(start|stop|test|restart)\b/;

const base = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? p;

// Drops a version spec from a package argument: "vite@7" → "vite". A scoped
// package leads with its own "@", so the search starts past it.
function stripVersion(spec: string): string {
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

// What a package-runner title is actually running, or null when this isn't
// one. Flags are skipped, so "npm exec -- vite" and "npm run-script build"
// (whose "-script" remainder reads as a flag) both land on the real word.
function runnerTarget(title: string): string | null {
  const lifecycle = RUNNER_LIFECYCLE.exec(title);
  if (lifecycle) return lifecycle[1]!;
  const m = RUNNER_TITLE.exec(title);
  if (!m) return null;
  for (const token of title.slice(m[0].length).split(/\s+/)) {
    if (!token || token.startsWith("-")) continue;
    const spec = stripVersion(token);
    // A scoped package keeps its whole name; a path to a script doesn't.
    return spec.startsWith("@") ? spec : base(spec);
  }
  return null;
}

// The folder a process runs in, as a name — the answer when nothing it was
// invoked with is worth showing.
function folderLabel(cwd: string | null | (() => string | null)): string | null {
  const dir = typeof cwd === "function" ? cwd() : cwd;
  if (!dir) return null;
  const name = base(dir);
  if (!GENERIC_DIR.has(name)) return name;
  const parent = base(dir.slice(0, dir.length - name.length - 1));
  return parent ? `${parent}/${name}` : name;
}

/**
 * Whether the OS's own name for a process is a non-answer, so the command
 * line has to be read. Three kinds: a renamed main thread
 * ("node-MainThread"), a plain runtime name ("node", "python3") — the same
 * non-answer without the rename — and a package runner's title, which comm
 * hands over truncated and so must never be parsed from comm itself.
 */
export function needsCommandLine(name: string): boolean {
  if (/(^|-)MainThread$/.test(name) || RUNTIMES.has(withoutThreadName(name))) return true;
  return RUNNER_TITLE.test(name) || RUNNER_LIFECYCLE.test(name);
}

/** Drops Node's main-thread rename: "node-MainThread" → "node". */
export function withoutThreadName(name: string): string {
  return name.replace(/-MainThread$/, "") || name;
}

/**
 * The name to show for a process, from its argv and working directory.
 *
 * `cwd` may be a function, consulted only when the argv alone can't name the
 * process — reading a working directory costs an lsof on macOS, and most
 * processes are named long before it's needed.
 */
export function processLabel(argv: string[], cwd: string | null | (() => string | null)): string | null {
  const raw = argv[0];
  if (!raw) return null;
  const exe = base(raw);
  // Both shapes of a package runner: the rewritten single-entry title, which
  // is one argv entry and must be read whole (basenaming it would cut a
  // scoped package at its "/"), and the plain argv it had before rewriting
  // it ("/usr/bin/npm", "run", "dev").
  const target = runnerTarget(argv.length === 1 ? raw : [exe, ...argv.slice(1)].join(" "));
  // A runner title is the whole answer — never fall through to the runtime
  // handling below, whose script scan would pick the subcommand out of
  // ["bun", "run", "index.ts"] and call the process "run".
  if (target) return GENERIC_SCRIPT.test(target) ? (folderLabel(cwd) ?? target) : target;
  if (!needsCommandLine(exe)) return exe;
  let script: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (MODULE_FLAGS.has(arg) && argv[i + 1]) return argv[i + 1]!;
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    script = arg;
    break;
  }
  if (script) {
    // A dependency's CLI (vite, next, nodemon…) is named by its bin entry.
    const bin = /(?:^|\/)node_modules\/\.bin\/([^/]+)$/.exec(script);
    if (bin) return bin[1]!;
    // Anything else out of node_modules is named after the package that owns
    // it: a package's own entry file is called bin.js or index.js far more
    // often than it is called anything useful.
    const pkg = /(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^@][^/]*)\//g;
    let owner: string | null = null;
    for (let m = pkg.exec(script); m; m = pkg.exec(script)) owner = m[1]!;
    if (owner && owner !== ".bin") return owner;
    const name = base(script);
    if (!GENERIC_SCRIPT.test(name)) return name;
  }
  return folderLabel(cwd) ?? (script ? base(script) : withoutThreadName(exe));
}
