// Every place Perch's one version is written (plans/app-versioning.md R1).
// The root package.json is the source of truth; scripts/release.mjs writes
// the new version into all of these, and scripts/version.test.mjs fails when
// any of them disagree.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const json = (file, get, set) => ({
  file,
  read: () => get(JSON.parse(readFileSync(join(ROOT, file), "utf8"))),
  write: (version) => {
    const path = join(ROOT, file);
    const text = readFileSync(path, "utf8");
    const data = JSON.parse(text);
    set(data, version);
    writeFileSync(path, JSON.stringify(data, null, 2) + (text.endsWith("\n") ? "\n" : ""));
  },
});

// A TOML file's `version = "..."` line inside the block that starts with
// `start` (the [package] table, or a Cargo.lock package entry).
const toml = (file, start) => {
  const locate = (text) => {
    const at = text.indexOf(start);
    if (at === -1) throw new Error(`${file}: no ${start.trim()} block`);
    const m = /\nversion = "([^"]*)"/.exec(text.slice(at));
    if (!m) throw new Error(`${file}: no version after ${start.trim()}`);
    return { index: at + m.index, match: m };
  };
  return {
    file,
    read: () => locate(readFileSync(join(ROOT, file), "utf8")).match[1],
    write: (version) => {
      const path = join(ROOT, file);
      const text = readFileSync(path, "utf8");
      const { index, match } = locate(text);
      writeFileSync(path, text.slice(0, index) + `\nversion = "${version}"` + text.slice(index + match[0].length));
    },
  };
};

const pkg = (file) => json(file, (d) => d.version, (d, v) => { d.version = v; });

export const VERSION_FILES = [
  pkg("package.json"),
  pkg("server/package.json"),
  pkg("client/package.json"),
  pkg("mux/package.json"),
  pkg("desktop/package.json"),
  json(
    "package-lock.json",
    (d) => {
      const versions = new Set([d.version, ...["", "mux", "server", "client"].map((k) => d.packages[k].version)]);
      return versions.size === 1 ? [...versions][0] : `mixed (${[...versions].join(", ")})`;
    },
    (d, v) => {
      d.version = v;
      for (const k of ["", "mux", "server", "client"]) d.packages[k].version = v;
    },
  ),
  json(
    "desktop/package-lock.json",
    (d) => (d.version === d.packages[""].version ? d.version : `mixed (${d.version}, ${d.packages[""].version})`),
    (d, v) => {
      d.version = v;
      d.packages[""].version = v;
    },
  ),
  toml("desktop/src-tauri/Cargo.toml", "[package]"),
  toml("desktop/src-tauri/Cargo.lock", 'name = "perch-desktop"'),
  json("desktop/src-tauri/tauri.conf.json", (d) => d.version, (d, v) => { d.version = v; }),
];

/** The version every file should have: the root package.json's. */
export function currentVersion() {
  return VERSION_FILES[0].read();
}
