// crypto.randomUUID only exists in secure contexts (HTTPS or localhost), so
// opening perch over plain http:// on a LAN address throws "is not a
// function". getRandomValues has no such restriction - build the same
// RFC 4122 v4 string from it when randomUUID is missing.
export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
