// One row of the pick-from-list dialog (Dialog.tsx's "pick" type), the list
// behind ctx.app.pickItem and pickIcon.
export interface PickItem {
  id: string;
  label: string;
  // Codicon name drawn before the label.
  icon?: string;
  // Dimmer text after the label.
  detail?: string;
  // Extra words the filter matches but never shows (an icon's tags).
  keywords?: string[];
}

// Case-insensitive substring match over label, id and keywords. Rows whose
// label starts with the query come first, so typing "git" puts `git-commit`
// ahead of an icon that merely carries a "git" tag; the original order is
// kept within each group.
export function filterPickItems(items: readonly PickItem[], query: string): PickItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const leading: PickItem[] = [];
  const rest: PickItem[] = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    if (label.startsWith(q)) {
      leading.push(item);
    } else if (
      label.includes(q) ||
      item.id.toLowerCase().includes(q) ||
      (item.keywords ?? []).some((k) => k.toLowerCase().includes(q))
    ) {
      rest.push(item);
    }
  }
  return [...leading, ...rest];
}
