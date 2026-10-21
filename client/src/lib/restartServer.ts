// "Restart Perch Server": asks the server to restart itself (server
// restart.ts), covers the page while it's away, and reloads the page once
// it answers again. Terminals keep running in the terminal daemon, so the
// reloaded page reattaches to them.
import * as api from "../api";

const WAIT_MS = 90_000;
const POLL_MS = 700;
// A restart can be quick enough that a poll never sees the server down;
// after this long answering again counts as back.
const ASSUME_BACK_AFTER_MS = 8_000;

function overlay(): { text: (t: string, error?: boolean) => void; remove: () => void } {
  const el = document.createElement("div");
  el.className = "restart-overlay";
  el.setAttribute("role", "status");
  const box = document.createElement("div");
  box.className = "restart-overlay-box";
  el.append(box);
  document.body.append(el);
  return {
    text: (t, error = false) => {
      box.textContent = t;
      box.classList.toggle("error", error);
      if (error) {
        const close = document.createElement("button");
        close.className = "dialog-button";
        close.textContent = "Close";
        close.onclick = () => el.remove();
        box.append(document.createElement("br"), close);
      }
    },
    remove: () => el.remove(),
  };
}

export async function restartPerch(): Promise<void> {
  const view = overlay();
  view.text("Restarting Perch…");
  try {
    await api.restartServer();
  } catch (err) {
    view.text(`Couldn't restart: ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }
  const started = Date.now();
  let wentDown = false;
  while (Date.now() - started < WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      const res = await fetch("/api/restart", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      if (wentDown || Date.now() - started > ASSUME_BACK_AFTER_MS) {
        window.location.reload();
        return;
      }
    } catch {
      wentDown = true;
    }
  }
  view.text("Perch didn't come back within 90 seconds. Check it on the server with perch status.", true);
}
