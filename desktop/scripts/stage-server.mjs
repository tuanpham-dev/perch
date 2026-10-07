// Stages the Perch server the desktop app bundles (plans/desktop-app.md T14)
// into desktop/src-tauri/resources/perch, for the platform this runs on:
//
//   node/                  a Node.js runtime (only the node binary)
//   package.json, package-lock.json
//   server/, mux/          their sources, as the server runs them (tsx)
//   client/dist/           the built web app
//   extensions/<name>/     the bundled extensions, built
//   cli/tunnel.mjs
//   node_modules/          production dependencies, native ones built for
//                          that Node
//   server-bundle.json     { version, commit } - a changed commit makes the
//                          app restart an older running server
//
// The layout matches the repo's, so the server's own relative paths
// (client/dist, extensions, cli/tunnel.mjs) resolve unchanged.
//
//   node desktop/scripts/stage-server.mjs [--skip-build]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_MAJOR = 24;
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(desktop, "..");
const out = join(desktop, "src-tauri", "resources", "perch");
const cache = join(desktop, ".cache");
const skipBuild = process.argv.includes("--skip-build");

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const log = (msg) => console.log(`[stage-server] ${msg}`);

// ---- Node runtime ----------------------------------------------------------

function nodeTarget() {
  const arch = { x64: "x64", arm64: "arm64" }[process.arch];
  if (!arch) throw new Error(`unsupported architecture: ${process.arch}`);
  if (process.platform === "linux") return { name: `linux-${arch}`, ext: "tar.xz" };
  if (process.platform === "darwin") return { name: `darwin-${arch}`, ext: "tar.gz" };
  if (process.platform === "win32") return { name: `win-${arch}`, ext: "zip" };
  throw new Error(`unsupported platform: ${process.platform}`);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

// The newest release of NODE_MAJOR, downloaded once into desktop/.cache and
// checked against the release's SHASUMS256.txt. Returns its extracted dir.
async function nodeRuntime() {
  const releases = JSON.parse(await fetchText("https://nodejs.org/dist/index.json"));
  const release = releases.find((r) => r.version.startsWith(`v${NODE_MAJOR}.`));
  if (!release) throw new Error(`no Node ${NODE_MAJOR} release found`);
  const { name, ext } = nodeTarget();
  const base = `node-${release.version}-${name}`;
  const dir = join(cache, base);
  if (existsSync(join(dir, ".complete"))) return { dir, version: release.version };

  mkdirSync(cache, { recursive: true });
  const file = `${base}.${ext}`;
  const archive = join(cache, file);
  log(`downloading ${file}`);
  const res = await fetch(`https://nodejs.org/dist/${release.version}/${file}`);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sums = await fetchText(`https://nodejs.org/dist/${release.version}/SHASUMS256.txt`);
  const expected = sums.split("\n").find((l) => l.endsWith(`  ${file}`))?.split(" ")[0];
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${file}`);
  writeFileSync(archive, bytes);
  rmSync(dir, { recursive: true, force: true });
  // tar reads .tar.xz, .tar.gz and (bsdtar, as on Windows) .zip alike. On
  // Windows, name the system's own bsdtar: Git's GNU tar is often first on
  // PATH there, and it can't read a zip.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  run(tar, ["-xf", archive, "-C", cache]);
  rmSync(archive);
  writeFileSync(join(dir, ".complete"), "");
  return { dir, version: release.version };
}

// ---- Perch -----------------------------------------------------------------

const ignoredNames = new Set(["node_modules", "src", "test", ".DS_Store"]);
function copyExtension(name) {
  const from = join(repo, "extensions", name);
  cpSync(from, join(out, "extensions", name), {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(from.length + 1);
      const top = rel.split(/[\\/]/)[0];
      return !(rel && ignoredNames.has(top)) && !/\.test\.m?js$/.test(src);
    },
  });
}

// Extension workspaces whose server-side code needs npm packages at run
// time (the tasks extension's fast-glob, for one).
function extensionWorkspacesWithServerDeps() {
  return readdirSync(join(repo, "extensions"))
    .filter((name) => existsSync(join(repo, "extensions", name, "server.js")))
    .filter((name) => {
      const pkg = JSON.parse(readFileSync(join(repo, "extensions", name, "package.json"), "utf8"));
      return Object.keys(pkg.dependencies ?? {}).length > 0;
    })
    .map((name) => `extensions/${name}`);
}

// npm links each workspace into node_modules, but the app bundler drops
// symlinks, and Node would then look further up the disk for them. The
// server needs only perch-mux as a package, and its sources can't move
// into node_modules: Node won't strip TypeScript types there, and the
// terminal daemon runs them with plain Node. So perch-mux becomes a small
// JS package re-exporting each entry from mux/, and the other links (the
// server and extensions load from their own folders) and node_modules/.bin
// go.
function muxShim(dir) {
  const pkg = JSON.parse(readFileSync(join(out, "mux", "package.json"), "utf8"));
  mkdirSync(dir, { recursive: true });
  const exportsMap = {};
  for (const [key, target] of Object.entries(pkg.exports)) {
    const name = key.replace(/^\.\//, "");
    exportsMap[key] = `./${name}.js`;
    writeFileSync(join(dir, `${name}.js`), `export * from "../../mux/${target.replace(/^\.\//, "")}";\n`);
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, type: "module", exports: exportsMap }, null, 2) + "\n",
  );
}

function unlinkWorkspaces() {
  const modules = join(out, "node_modules");
  const entries = readdirSync(modules).flatMap((name) =>
    name.startsWith("@") ? readdirSync(join(modules, name)).map((sub) => `${name}/${sub}`) : [name],
  );
  for (const name of entries) {
    const link = join(modules, name);
    if (!lstatSync(link).isSymbolicLink()) continue;
    rmSync(link);
    if (name === "perch-mux") muxShim(link);
  }
  rmSync(join(modules, ".bin"), { recursive: true, force: true });
  const leftover = symlinksUnder(out);
  if (leftover.length) throw new Error(`symlinks left in the bundle:\n${leftover.join("\n")}`);
}

function symlinksUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) found.push(p);
    else if (st.isDirectory()) found.push(...symlinksUnder(p));
  }
  return found;
}

// node-pty ships prebuilt binaries for every platform and its own sources;
// the bundle needs only what loads here.
function prune() {
  const pty = join(out, "node_modules", "node-pty");
  if (!existsSync(pty)) return;
  const here = `${process.platform}-${process.arch}`;
  const prebuilds = join(pty, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const name of readdirSync(prebuilds)) if (name !== here) rmSync(join(prebuilds, name), { recursive: true });
  }
  for (const dir of ["deps", "src", "scripts"]) rmSync(join(pty, dir), { recursive: true, force: true });
  if (process.platform !== "win32") rmSync(join(pty, "third_party"), { recursive: true, force: true });
  const build = join(pty, "build");
  if (existsSync(build)) {
    for (const name of readdirSync(build)) if (name !== "Release") rmSync(join(build, name), { recursive: true, force: true });
    const release = join(build, "Release");
    if (existsSync(release)) {
      for (const name of readdirSync(release)) {
        if (!/\.(node|exe|dll)$/.test(name) && name !== "spawn-helper") rmSync(join(release, name), { recursive: true, force: true });
      }
    }
  }
  // node-pty's tarball ships spawn-helper without its execute bit, and
  // without it no terminal starts on macOS ("posix_spawnp failed.").
  for (const helper of [join(prebuilds, here, "spawn-helper"), join(build, "Release", "spawn-helper")]) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

function commitId() {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const head = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain", "--", "server", "mux", "client", "extensions", "cli");
  // An uncommitted build gets a fresh id each time, so the app always
  // restarts a server staged before it.
  return dirty ? `${head}-dirty-${Date.now().toString(36)}` : head;
}

async function main() {
  if (!skipBuild) {
    log("building the client and extensions");
    run("npm", ["run", "build"], { cwd: repo, shell: process.platform === "win32" });
  }
  const node = await nodeRuntime();
  log(`staging into ${out}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const file of ["package.json", "package-lock.json"]) cpSync(join(repo, file), join(out, file));
  const noTests = (src) => !/\.test\.[cm]?[jt]s$/.test(src) && !src.includes(`${"node_modules"}`);
  cpSync(join(repo, "server", "package.json"), join(out, "server", "package.json"));
  cpSync(join(repo, "server", "src"), join(out, "server", "src"), { recursive: true, filter: noTests });
  cpSync(join(repo, "mux", "package.json"), join(out, "mux", "package.json"));
  cpSync(join(repo, "mux", "src"), join(out, "mux", "src"), { recursive: true, filter: noTests });
  cpSync(join(repo, "client", "package.json"), join(out, "client", "package.json"));
  cpSync(join(repo, "client", "dist"), join(out, "client", "dist"), { recursive: true });
  cpSync(join(repo, "cli", "tunnel.mjs"), join(out, "cli", "tunnel.mjs"));
  for (const name of readdirSync(join(repo, "extensions"))) {
    const dir = join(repo, "extensions", name);
    if (statSync(dir).isDirectory() && existsSync(join(dir, "package.json"))) copyExtension(name);
  }

  // npm from the downloaded release, run by its node: native modules
  // (node-pty) are built for exactly the runtime that ships.
  const nodeBin = process.platform === "win32" ? join(node.dir, "node.exe") : join(node.dir, "bin", "node");
  const npmCli =
    process.platform === "win32"
      ? join(node.dir, "node_modules", "npm", "bin", "npm-cli.js")
      : join(node.dir, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const workspaces = ["server", "mux", ...extensionWorkspacesWithServerDeps()];
  log(`installing production dependencies for ${workspaces.join(", ")}`);
  run(nodeBin, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund", ...workspaces.flatMap((w) => ["-w", w])], {
    cwd: out,
    env: { ...process.env, PATH: `${dirname(nodeBin)}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
  });

  unlinkWorkspaces();
  prune();

  const target = process.platform === "win32" ? join(out, "node", "node.exe") : join(out, "node", "bin", "node");
  mkdirSync(dirname(target), { recursive: true });
  cpSync(nodeBin, target);
  for (const file of ["LICENSE"]) if (existsSync(join(node.dir, file))) cpSync(join(node.dir, file), join(out, "node", file));
  // Debug symbols are most of an official Linux node binary. (macOS's is
  // signed, and stripping would break the signature.)
  if (process.platform === "linux") run("strip", [target]);

  const version = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version;
  writeFileSync(join(out, "server-bundle.json"), JSON.stringify({ version, commit: commitId(), node: node.version }, null, 2) + "\n");
  log(`done (Node ${node.version})`);
}

main().catch((err) => {
  console.error(`[stage-server] ${err.message}`);
  process.exit(1);
});
