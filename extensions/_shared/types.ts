// Structurally identical to client/src/types.ts's MenuItem — see
// extensions/_shared's module comment on why this is a copy. TypeScript's
// structural typing means this interops with the real MenuItem the host
// passes into showMenu without either side importing the other.
export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
  // Leading check icon (the host's ContextMenu); any item setting it, true
  // or false, reserves the gutter so labels stay aligned.
  checked?: boolean;
}
