// OSC 7 — "ESC ] 7 ; file://host/path ST" — is how a shell says which directory
// it's in. It's the only way to learn a Windows shell's working directory from
// outside, and it's cheaper than asking the OS anywhere else.

/**
 * The directory an OSC 7 payload names, or null for anything that isn't a
 * file URL. Percent-escapes are decoded. A Windows drive path comes back in
 * Windows form ("/C:/Users/me" -> "C:\\Users\\me"); anything else keeps its
 * slashes.
 */
export function directoryFromOsc7(payload: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(payload.trim());
  if (!m) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  if (drive) return `${drive[1]!.toUpperCase()}${(drive[2] ?? '/').replace(/\//g, '\\')}`;
  return path;
}
