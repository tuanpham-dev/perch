// Mirrors VS Code / code-server's BrowserClipboardService.writeText: try the
// modern Clipboard API first, then fall back to a hidden-textarea copy
// command for contexts where it's unavailable (e.g. plain http over a LAN IP).
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // fall through to the legacy path below
  }
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textArea = document.createElement("textarea");
  textArea.setAttribute("aria-hidden", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("copy command failed");
    }
  } finally {
    textArea.remove();
    previouslyFocused?.focus();
  }
}
