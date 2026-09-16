// On-device input-event tracer for the local-echo/IME pipeline. Enabled
// only when the page URL contains "inputdebug" (e.g. https://host/?inputdebug):
// desktop emulation cannot reproduce Android IME behavior (recomposition,
// commit ordering, autocorrect rewrites), so when a phone-only input bug
// strikes, this overlay is the ground truth for what bursts actually
// arrived and what the router did with them. Also mirrored to
// window.__inputLog (full ring buffer, last 300 entries) for copying out.
const enabled =
  typeof location !== "undefined" && /inputdebug/.test(location.search + location.hash);

const ring: string[] = [];
let panel: HTMLDivElement | null = null;

// Control bytes and NBSP made visible so a log line is unambiguous about
// what was really in the string.
function visualize(payload: string): string {
  return payload
    .replace(/\x7f/g, "⌫")
    .replace(/\r/g, "␍")
    .replace(/\n/g, "␊")
    .replace(/\x1b/g, "␛")
    .replace(/ /g, "⍽")
    .replace(/[\x00-\x1f]/g, (c) => "^" + String.fromCharCode(64 + c.charCodeAt(0)));
}

export function inputDebug(kind: string, payload: string): void {
  if (!enabled) return;
  ring.push(`${(performance.now() / 1000).toFixed(2)} ${kind}: "${visualize(payload)}"`);
  if (ring.length > 300) ring.shift();
  (window as unknown as { __inputLog?: string[] }).__inputLog = ring;
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "input-debug-overlay";
    document.body.appendChild(panel);
  }
  panel.textContent = ring.slice(-16).join("\n");
}
