// Makes a Perch release (plans/app-versioning.md R20):
//
//   npm run release -- 0.2.0          (or 0.2.0-rc.1 for a pre-release)
//
// Sets the version in every manifest (scripts/version-files.mjs), drafts a
// CHANGELOG.md entry from the commit subjects since the last release, lets
// you edit it, then commits "Release X.Y.Z" and tags vX.Y.Z. It doesn't push:
// pushing the tag is what builds and drafts the GitHub release.
//
//   --yes    don't stop for editing the changelog (for scripts)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { compare, highest, valid } from "../server/src/semver.ts";
import { ROOT, VERSION_FILES, currentVersion } from "./version-files.mjs";

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const CHANGELOG = join(ROOT, "CHANGELOG.md");
const HEADER = `# Changelog

What changed in each Perch release. The newest is first; each entry is
drafted from the commit subjects by \`npm run release\`, then edited.
`;

/** The entry for a version: a heading and one line per commit subject. */
export function draftEntry(version, subjects, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  const lines = subjects.filter((s) => s && !/^Release \d/.test(s)).map((s) => `- ${s}`);
  return `## ${version} - ${day}\n\n${lines.length ? lines.join("\n") : "- No changes recorded."}\n`;
}

/** The changelog with `entry` added above the newest existing one. */
export function insertEntry(changelog, entry) {
  const text = changelog?.trim() ? changelog : HEADER;
  const at = text.search(/^## /m);
  if (at === -1) return `${text.replace(/\s*$/, "")}\n\n${entry}`;
  return `${text.slice(0, at)}${entry}\n${text.slice(at)}`;
}

async function main(argv) {
  const yes = argv.includes("--yes");
  const version = argv.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
  if (!version) die("usage: npm run release -- <version> [--yes]   (e.g. 0.2.0 or 0.2.0-rc.1)");
  if (!valid(version)) die(`"${version}" isn't a version (MAJOR.MINOR.PATCH, optionally -pre.release)`);
  if (git("status", "--porcelain")) die("the working tree has changes - commit or stash them first");

  const tags = git("tag", "--list", "v*").split("\n").filter((t) => valid(t));
  const current = currentVersion();
  const tag = `v${version}`;
  if (tags.includes(tag)) die(`${tag} already exists`);
  // The first release may keep the version the repo already has.
  const cmp = compare(version, current);
  if (tags.length ? cmp <= 0 : cmp < 0) die(`${version} isn't newer than the current version, ${current}`);

  for (const f of VERSION_FILES) f.write(version);

  const previous = highest(tags);
  const subjects = git("log", "--format=%s", previous ? `${previous}..HEAD` : "HEAD").split("\n");
  writeFileSync(CHANGELOG, insertEntry(existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : "", draftEntry(version, subjects)));
  console.log(`release: drafted the ${version} entry in CHANGELOG.md from ${subjects.filter(Boolean).length} commit(s)${previous ? ` since ${previous}` : ""}`);

  if (!yes && process.stdin.isTTY) {
    const editor = process.env.VISUAL || process.env.EDITOR;
    if (editor) {
      spawnSync(editor, [CHANGELOG], { stdio: "inherit", shell: true });
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question("Edit CHANGELOG.md now, then press Enter to commit (Ctrl+C to stop) ");
      rl.close();
    }
  }

  git("add", "CHANGELOG.md", ...VERSION_FILES.map((f) => f.file));
  git("commit", "-q", "-m", `Release ${version}`);
  git("tag", "-a", tag, "-m", `Perch ${version}`);
  console.log(`release: committed "Release ${version}" and tagged ${tag}. To publish:\n  git push origin HEAD ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
