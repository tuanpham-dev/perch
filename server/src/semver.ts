// SemVer ordering for Perch's own version (plans/app-versioning.md). No
// imports, so the CLI (cli/perch/update.ts) and the release script can load
// it straight from the repo too.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  // Dot-separated pre-release identifiers ("rc.1" -> ["rc", "1"]); empty for
  // a release.
  prerelease: string[];
}

const PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** The parsed version, or null for anything that isn't SemVer. A leading "v" is accepted. */
export function parse(version: string): SemVer | null {
  const m = PATTERN.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? m[4].split(".") : [] };
}

export function valid(version: string): boolean {
  return parse(version) !== null;
}

export function isPrerelease(version: string): boolean {
  return (parse(version)?.prerelease.length ?? 0) > 0;
}

/**
 * SemVer precedence: <0 when a sorts before b, 0 when equal, >0 after.
 * 0.2.0-rc.1 < 0.2.0 < 0.2.1. Throws on an invalid version.
 */
export function compare(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (pa[key] !== pb[key]) return pa[key] - pb[key];
  }
  // A release sorts after any of its pre-releases.
  if (!pa.prerelease.length || !pb.prerelease.length) return pb.prerelease.length - pa.prerelease.length;
  const len = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The highest version in `versions`, ignoring invalid ones; null when none is valid. */
export function highest(versions: string[]): string | null {
  return versions.filter(valid).reduce<string | null>((best, v) => (best === null || compare(v, best) > 0 ? v : best), null);
}
