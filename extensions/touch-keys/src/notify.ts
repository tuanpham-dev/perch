// The app's error banner (ctx.app.showError), for a key tap that can't do
// what it says. Set from activate(); its own module so the key bar can use
// it without importing the extension's entry (which imports the bar).
let handler: ((message: string) => void) | null = null;

export function setTouchKeyErrorHandler(next: ((message: string) => void) | null): void {
  handler = next;
}

export function showTouchKeyError(message: string): void {
  handler?.(message);
}
