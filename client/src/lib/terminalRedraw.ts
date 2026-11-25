// "Redraw terminal": the tab bar's button asks the TerminalView attached to
// `attachName` to repaint itself (TerminalView listens for this).
const EVENT = "perch:redraw-terminal";

export function requestTerminalRedraw(attachName: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: attachName }));
}

export function onTerminalRedraw(attachName: string, cb: () => void): () => void {
  const handler = (e: Event) => {
    if ((e as CustomEvent<string>).detail === attachName) cb();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
