// Extension ids are "publisher.name" (server/src/extensions.ts's resolveId) —
// derives the publisher half for display when no explicit publisher field is
// available (an installed ExtensionInfo has none; a registry entry does).
export function parsePublisher(id: string): string | undefined {
  const dot = id.indexOf(".");
  return dot === -1 ? undefined : id.slice(0, dot);
}

// The first-party publisher. Extensions authored by it — bundled builtins and
// the official registry alike — get the verified-author badge; third-party
// authors don't. Drives the checkmark shown next to the author name.
export const OFFICIAL_PUBLISHER = "perch";

export function isOfficialPublisher(publisher: string | undefined): boolean {
  return publisher === OFFICIAL_PUBLISHER;
}
