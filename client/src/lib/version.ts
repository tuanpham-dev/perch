// Compares two dotted version strings ("1.2.10" vs "1.3.0") segment by
// segment, numerically where both segments parse as numbers and lexically
// otherwise — good enough for the semver-shaped versions extension
// manifests declare, without pulling in a semver dependency. Returns <0, 0,
// >0 like Array.prototype.sort's comparator.
export function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = as[i] ?? "0";
    const bv = bs[i] ?? "0";
    const an = Number(av);
    const bn = Number(bv);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) {
      if (an !== bn) return an - bn;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}
