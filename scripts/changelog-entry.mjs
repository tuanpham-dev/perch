// Prints one release's CHANGELOG.md entry, without its heading - the release
// workflow uses it as the GitHub release's notes.
//
//   node scripts/changelog-entry.mjs v0.2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./version-files.mjs";

export function entryFor(changelog, version) {
  const v = version.replace(/^v/, "");
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${v} `) || l === `## ${v}`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/changelog-entry.mjs <version>");
    process.exit(1);
  }
  const entry = entryFor(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version);
  if (entry === null) {
    console.error(`no ${version} entry in CHANGELOG.md`);
    process.exit(1);
  }
  console.log(entry);
}
