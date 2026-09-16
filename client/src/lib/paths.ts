// Path shapes the client has to tell apart. The server sends every path with
// forward slashes (server/src/clientPaths.ts), so on Windows they arrive as
// "C:/Users/me/proj" and splitting on "/" works; what differs is the root.

const DRIVE = /^[A-Za-z]:/;

/** "/x", "~", "~/x", or a drive path "C:/x". */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || p === "~" || p.startsWith("~/") || /^[A-Za-z]:\//.test(p);
}

/** The top of a filesystem: "/" or a drive root ("C:/", or bare "C:"). */
export function isRootPath(p: string): boolean {
  return p === "/" || /^[A-Za-z]:\/?$/.test(p);
}

/**
 * The folder containing `p`, or null at a root. A drive's parent keeps its
 * slash: "C:" alone means "the current folder on drive C" to Windows.
 */
export function parentPath(p: string): string | null {
  if (isRootPath(p)) return null;
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return null;
  const parent = trimmed.slice(0, idx);
  if (parent === "") return "/";
  if (DRIVE.test(parent) && parent.length === 2) return `${parent}/`;
  return parent;
}

/** `name` inside folder `dir`, without doubling a root's slash. */
export function childPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
