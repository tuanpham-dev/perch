export const isMac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);

// Secondary-open modifier for a click gesture (preview instead of editor,
// or a row's non-default action): Shift+click, same as Shift+Enter
// elsewhere. Held alongside Ctrl it's still Shift as far as this check is
// concerned, so Ctrl+Shift+click also works anywhere Ctrl/Cmd isn't already
// claimed for something else at that click site (the FILES tree's
// Ctrl/Cmd+click "toggle select" branches on ctrlKey/metaKey directly
// instead, ahead of this check).
export function isSecondaryClick(e: { shiftKey: boolean }): boolean {
  return e.shiftKey;
}
