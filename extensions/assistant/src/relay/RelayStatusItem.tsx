// The bottom status bar's relay readout (R54): absent outside a group,
// otherwise how many other machines are online, or why that is not shown.
import { useRelayView } from "./relayApi";

export interface RelayStatusContext {
  mobilePointer: boolean;
}

interface StatusInput {
  joined: boolean;
  inbound: string | null;
  connection: string | null;
  machines: { self: boolean; online: boolean }[];
}

// The readout split into what a compact bar keeps and the words around it.
export function relayStatusParts(state: StatusInput): { before: string; core: string; after: string } | null {
  if (!state.joined) return null;
  if (state.inbound === "off") return { before: "Relay · ", core: "inbound off", after: "" };
  if (state.connection !== "connected") return { before: "Relay · ", core: "reconnecting", after: "" };
  return { before: "Relay · ", core: String(state.machines.filter((m) => !m.self && m.online).length), after: " online" };
}

export function relayStatusText(state: StatusInput): string | null {
  const p = relayStatusParts(state);
  return p && p.before + p.core + p.after;
}

export function makeRelayStatusItem(open: () => void) {
  return function RelayStatusItem(_props: { context: RelayStatusContext }) {
    const view = useRelayView();
    const parts = view.kind === "ready" ? relayStatusParts(view.state) : null;
    if (!parts) return null;
    const full = parts.before + parts.core + parts.after;
    // The compact bar drops the wording (full-only) and keeps the icon and the
    // value; the label carries the whole sentence either way.
    return (
      <button type="button" className="status-bar-item relay-status-item" title="Relay group" aria-label={full} onClick={open}>
        <span className="codicon codicon-broadcast" aria-hidden="true" />
        <span aria-hidden="true">
          <span className="full-only">{parts.before}</span>
          {parts.core}
          <span className="full-only">{parts.after}</span>
        </span>
      </button>
    );
  };
}
