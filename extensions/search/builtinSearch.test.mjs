// The built-in engine is the only search a machine without rg or grep has;
// its globbing and matching are checked here against a real folder.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { globToRegExp, searchWithBuiltin, searchWithGrep } from "./server.js";

const base = { isRegex: false, caseSensitive: false, wholeWord: false, include: [], exclude: [], maxResults: 100, respectGitignore: true };

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "search-"));
  mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
  mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(dir, "dist"));
  writeFileSync(path.join(dir, "src", "app.ts"), "const needle = 1;\r\n  // Needle again\n");
  writeFileSync(path.join(dir, "src", "deep", "x.js"), "needle();\n");
  writeFileSync(path.join(dir, "node_modules", "pkg", "i.js"), "needle\n");
  writeFileSync(path.join(dir, "dist", "out.js"), "needle\n");
  writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  return dir;
}

test("globs read the way grep's do", () => {
  assert.ok(globToRegExp("*.ts").test("src/app.ts"));
  assert.ok(!globToRegExp("*.ts").test("src/app.tsx"));
  assert.ok(globToRegExp("src/**").test("src/deep/x.js"));
  assert.ok(globToRegExp("dist").test("dist/out.js"));
  assert.ok(!globToRegExp("dist").test("distance.js"));
  assert.ok(globToRegExp("src/").test("src/deep/x.js"));
  assert.ok(globToRegExp("deep/").test("src/deep/x.js"));
});

test("outside a repository it walks the folder, skipping node_modules and binaries", async () => {
  const dir = fixture();
  try {
    const { results } = await searchWithBuiltin(dir, { ...base, query: "needle", exclude: ["dist"] });
    assert.deepEqual(results.map((r) => r.file), ["src/app.ts", "src/deep/x.js"]);
    const app = results.find((r) => r.file === "src/app.ts");
    assert.deepEqual(app.matches.map((m) => [m.line, m.column, m.lineText]), [[1, 7, "const needle = 1;"], [2, 4, "// Needle again"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in a repository .gitignore applies", async () => {
  const dir = fixture();
  try {
    writeFileSync(path.join(dir, ".gitignore"), "dist/\nnode_modules/\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const { results } = await searchWithBuiltin(dir, { ...base, query: "needle", caseSensitive: true, include: ["*.js"] });
    assert.deepEqual(results.map((r) => r.file), ["src/deep/x.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stops at the result limit", async () => {
  const dir = fixture();
  try {
    const { results, limitHit } = await searchWithBuiltin(dir, { ...base, query: "needle", maxResults: 1, respectGitignore: false });
    assert.equal(limitHit, true);
    assert.equal(results.flatMap((r) => r.matches).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the grep fallback takes path globs, not just file and folder names", async () => {
  const dir = fixture();
  try {
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "a.txt"), "needle\n");
    writeFileSync(path.join(dir, "docs", "b.md"), "needle\n");
    const files = async (opts) => (await searchWithGrep(dir, { ...base, query: "needle", exclude: ["node_modules", "dist"], ...opts })).results.map((r) => r.file).sort();
    assert.deepEqual(await files({ include: ["src/**"] }), ["src/app.ts", "src/deep/x.js"]);
    assert.deepEqual(await files({ include: ["src"] }), ["src/app.ts", "src/deep/x.js"]);
    assert.deepEqual(await files({ include: ["docs/*.txt"] }), ["docs/a.txt"]);
    assert.deepEqual(await files({ exclude: ["node_modules", "dist", "src/"] }), ["docs/a.txt", "docs/b.md"]);
    assert.deepEqual(await files({ include: ["*.js"] }), ["src/deep/x.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
