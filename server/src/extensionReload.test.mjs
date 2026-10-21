// Reloading an extension's server code in place: an updated extension runs
// from a fresh copy of its folder, so its entry and its own modules load
// anew, whatever the loader caches by URL.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "perch-reload-"));
process.env.PERCH_CONFIG_DIR = path.join(root, "config");
const { clearServerCopies, freshServerCopy, serverFolder } = await import("./extensionReload.ts");

test("an update runs from a fresh copy, with fresh modules", async () => {
  const ext = path.join(root, "ext");
  mkdirSync(path.join(ext, "lib"), { recursive: true });
  writeFileSync(path.join(ext, "lib", "value.mjs"), "export const value = 'v1';\n");
  writeFileSync(path.join(ext, "server.mjs"), "import { value } from './lib/value.mjs';\nexport const read = () => value;\n");
  const load = () => import(pathToFileURL(path.join(serverFolder("qa.probe", ext), "server.mjs")).href);

  assert.equal((await load()).read(), "v1");
  writeFileSync(path.join(ext, "lib", "value.mjs"), "export const value = 'v2';\n");
  assert.equal((await load()).read(), "v1", "the same folder is cached");

  const copy = await freshServerCopy("qa.probe", ext);
  assert.notEqual(copy, ext);
  assert.equal((await load()).read(), "v2", "the copy loads the new code");

  await clearServerCopies();
  assert.equal(serverFolder("qa.probe", ext), ext);
});
