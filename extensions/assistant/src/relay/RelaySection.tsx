// Settings → Extensions → Assistant → Relay: join or create a relay group,
// and once in one, manage this machine, the others, invites and the activity
// list. Every action goes through relayApi; the server stays the authority and
// its error sentences are shown in place.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { copyText } from "../../../_shared/clipboard";
import {
  afterAction,
  applyState,
  requestStateNow,
  getRelayHost,
  relayApi,
  useRelayActivity,
  useRelayView,
  type Inbound,
  type RelayActivityRow,
  type RelayInvite,
  type RelayMachine,
  type RelayState,
} from "./relayApi";

// R52, verbatim.
const SHARING_SENTENCE =
  "Machines in this group will be able to read this machine's terminals and type into its AI agents. Change this under Relay → Others may.";

const EXPIRY_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 10, label: "10 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 1440, label: "24 hours" },
  { minutes: 10080, label: "7 days" },
];

const INBOUND_CHOICES: { value: Inbound; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "read", label: "Read-only" },
  { value: "send", label: "Read and send" },
];

const ACCEPTS_TEXT: Record<string, string> = {
  off: "off",
  read: "read-only",
  send: "read and send",
  unknown: "unknown",
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Today's rows show the time; older ones add the date.
function stamp(ms: number): string {
  return new Date(ms).toDateString() === new Date().toDateString()
    ? clock(ms)
    : dateTime(ms);
}

function dateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(ms)}`;
}

function ago(ms: number | null): string {
  if (ms === null) return "offline";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "seen just now";
  const m = Math.round(s / 60);
  if (m < 60) return `seen ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `seen ${h} h ago`;
  return `seen ${Math.round(h / 24)} d ago`;
}

function isInsecureRemote(address: string): boolean {
  const a = address.trim();
  if (!/^ws:\/\//i.test(a)) return false;
  try {
    const host = new URL(a).hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]");
  } catch {
    return true;
  }
}

// The relay address inside a pasted invite (perch-invite:1:<base64url JSON>), or null when it does not decode.
function inviteRelay(invite: string): string | null {
  const m = /^perch-invite:1:([A-Za-z0-9_-]+)/.exec(invite.trim());
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) =>
        c.charCodeAt(0),
      ),
    );
    const relay = (JSON.parse(json) as { relay?: unknown }).relay;
    return typeof relay === "string" ? relay : null;
  } catch {
    return null;
  }
}

// After a create, join or leave the section changes shape; the new one takes
// focus on its status line so keyboard focus never falls back to the page body.
let focusStatusNext = false;

// Set when leaving could not delete this machine's entry on the relay (it was unreachable).
let relayEntryRemains = false;
const ENTRY_REMAINS =
  "Left the group here. The relay could not be reached, so this machine's entry is still on the relay; ask a member to remove it.";
function useStatusFocus() {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusStatusNext) {
      focusStatusNext = false;
      ref.current?.focus();
    }
  }, []);
  return ref;
}

function FormError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="settings-hint settings-error relay-error" role="alert">
      {text}
    </p>
  );
}

// ---- Not in a group ----

function NotJoined({ state }: { state: RelayState }) {
  const [mode, setMode] = useState<"join" | "create">("join");
  const [invite, setInvite] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [name, setName] = useState(state.defaultName);
  const [touchedName, setTouchedName] = useState(false);
  const [address, setAddress] = useState("");
  const [adminSecret, setAdminSecret] = useState("");
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removedBy = state.removedBy?.by;
  const statusRef = useStatusFocus();
  const [entryRemains] = useState(relayEntryRemains);

  useEffect(() => {
    if (!touchedName) setName(state.defaultName);
  }, [state.defaultName, touchedName]);

  const ready =
    mode === "join" ? !!invite.trim() : !!address.trim() && !!adminSecret;
  // Enter submits, as the host's own secret fields do; there is no <form>, so a
  // browser has nothing to offer to save.
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };
  const insecure = isInsecureRemote(
    mode === "join" ? (inviteRelay(invite) ?? "") : address,
  );

  const submit = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const next =
        mode === "join"
          ? await relayApi.join({
              invite: invite.trim(),
              name: name.trim(),
              allowInsecure: insecure && allowInsecure,
            })
          : await relayApi.create({
              relayUrl: address.trim(),
              adminSecret,
              name: name.trim(),
              allowInsecure: insecure && allowInsecure,
            });
      // Nothing secret outlives a successful submit.
      setInvite("");
      setAdminSecret("");
      setAllowInsecure(false);
      relayEntryRemains = false;
      focusStatusNext = true;
      applyState(next);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const nameField = (
    <label className="settings-row">
      <span className="settings-label">Machine name</span>
      <input
        className="dialog-input relay-input"
        value={name}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setTouchedName(true);
          setName(e.target.value);
        }}
        onKeyDown={onEnter}
      />
    </label>
  );

  return (
    <div className="relay-section">
      <div className="settings-row">
        <span className="settings-label">Status</span>
        {removedBy && (
          <p className="settings-hint settings-error relay-removed">
            Removed from the group by {removedBy}
          </p>
        )}
        <p className="relay-text" tabIndex={-1} ref={statusRef}>
          Not connected
        </p>
        {entryRemains && (
          <p className="relay-text relay-entry-remains">{ENTRY_REMAINS}</p>
        )}
        <p className="relay-text relay-muted">
          Connect this Perch to others so their agents can work together.
        </p>
      </div>
      {mode === "join" ? (
        <div className="settings-row">
          <label className="settings-label" htmlFor="relay-invite">
            Invite
          </label>
          <span className="relay-line">
            <input
              id="relay-invite"
              className="dialog-input relay-input"
              type={showInvite ? "text" : "password"}
              value={invite}
              placeholder="paste an invite"
              autoComplete="new-password"
              spellCheck={false}
              onChange={(e) => setInvite(e.target.value)}
              onKeyDown={onEnter}
            />
            <button
              type="button"
              className="dialog-button secondary"
              aria-pressed={showInvite}
              onClick={() => setShowInvite((v) => !v)}
            >
              {showInvite ? "Hide" : "Show"}
            </button>
          </span>
        </div>
      ) : (
        <>
          <label className="settings-row">
            <span className="settings-label">Relay address</span>
            <input
              className="dialog-input relay-input"
              value={address}
              placeholder="wss://relay.example.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
          <label className="settings-row">
            <span className="settings-label">Admin secret</span>
            <input
              className="dialog-input relay-input"
              type="password"
              value={adminSecret}
              autoComplete="new-password"
              onChange={(e) => setAdminSecret(e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
        </>
      )}
      {nameField}
      {insecure && (
        <div className="settings-row">
          <label className="settings-row checkbox-row">
            <input
              type="checkbox"
              checked={allowInsecure}
              onChange={(e) => setAllowInsecure(e.target.checked)}
            />
            <span>Allow unencrypted connection</span>
          </label>
          <p className="settings-hint settings-error">
            Secrets will cross the network unprotected.
          </p>
        </div>
      )}
      <p className="settings-hint relay-sentence">{SHARING_SENTENCE}</p>
      <FormError text={error} />
      <div className="relay-buttons">
        <button
          type="button"
          className="dialog-button primary"
          disabled={busy || !ready}
          onClick={() => void submit()}
        >
          {mode === "join" ? "Join" : "Create"}
        </button>
        <button
          type="button"
          className="dialog-button secondary"
          disabled={busy}
          onClick={() => {
            setMode(mode === "join" ? "create" : "join");
            setError(null);
          }}
        >
          {mode === "join" ? "Create a new group…" : "Back"}
        </button>
      </div>
      {mode === "join" && (
        <p className="settings-hint">
          Create asks for relay address and admin secret instead of an invite.
        </p>
      )}
    </div>
  );
}

// ---- Joined ----

function InlineEdit({
  label,
  value,
  empty,
  action,
  clear,
  onSave,
}: {
  label: string;
  value: string;
  empty: string;
  action: string;
  clear?: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [refocus, setRefocus] = useState(0);
  // Leaving edit mode (or Clear, which removes the focused button) takes the
  // focus away; the action button gets it back.
  useEffect(() => {
    if (refocus > 0) actionRef.current?.focus();
  }, [refocus]);
  const cancel = () => {
    setEditing(false);
    setRefocus((n) => n + 1);
  };
  const run = async (next: string) => {
    // An unchanged value sends nothing (and logs nothing).
    if (next === value) return cancel();
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
      setRefocus((n) => n + 1);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-row">
      <span className="settings-label">{label}</span>
      {editing ? (
        <span
          className="relay-line"
          onKeyDown={(e) => {
            // Escape cancels the edit; the value comes back from props when it is reopened.
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              cancel();
            }
          }}
        >
          <input
            className="dialog-input relay-input"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-label={label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void run(draft.trim());
              }
            }}
          />
          <button
            type="button"
            className="dialog-button primary"
            disabled={busy}
            onClick={() => void run(draft.trim())}
          >
            Save
          </button>
          <button
            type="button"
            className="dialog-button secondary"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setRefocus((n) => n + 1);
            }}
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="relay-line">
          <span className={value ? "relay-value" : "relay-value relay-muted"}>
            {value || empty}
          </span>
          <button
            type="button"
            ref={actionRef}
            className="dialog-button secondary"
            onClick={() => {
              setDraft(value);
              setError(null);
              setEditing(true);
            }}
          >
            {action}
          </button>
          {clear && value && (
            <button
              type="button"
              className="dialog-button secondary"
              disabled={busy}
              onClick={() => void run("")}
            >
              Clear
            </button>
          )}
        </span>
      )}
      <FormError text={error} />
    </div>
  );
}

// While this machine is not connected, what it last heard about the others is stale.
// This machine's own row follows the status line; the others are "unknown".
function stateText(m: RelayMachine, link: LinkLabel): string {
  if (link !== "connected") {
    return m.self
      ? link === "refused"
        ? "refused"
        : "reconnecting"
      : "unknown";
  }
  return m.online ? "online" : ago(m.lastSeen);
}

type LinkLabel = "connected" | "reconnecting" | "refused";

function MachinesTable({
  machines,
  link,
  onRemove,
  busy,
}: {
  machines: RelayMachine[];
  link: LinkLabel;
  onRemove: (m: RelayMachine) => void;
  busy: boolean;
}) {
  return (
    <div
      className="relay-table-wrap"
      role="region"
      aria-label="Machines in this group"
      tabIndex={0}
    >
      <table className="relay-table relay-fit relay-machines">
        <thead>
          <tr>
            <th scope="col">Machine</th>
            <th scope="col">State</th>
            <th scope="col">Accepts</th>
            <th scope="col">
              <span className="relay-sr">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {machines.map((m) => (
            <tr key={m.id}>
              <th scope="row" className="relay-rowhead">
                {m.name}
                {m.self && <span className="relay-tag"> this</span>}
              </th>
              <td>
                {stateText(m, link)}
                {m.blocked ? (
                  <span className="relay-tag relay-tag-warn">
                    blocked by relay admin
                  </span>
                ) : (
                  m.trust !== "verified" && (
                    <span className="relay-tag relay-tag-warn">
                      not verified
                    </span>
                  )
                )}
              </td>
              <td>
                {m.trust === "verified" || m.self
                  ? (ACCEPTS_TEXT[m.accepts] ?? m.accepts)
                  : ""}
              </td>
              <td className="relay-cell-action">
                {!m.self && (
                  <button
                    type="button"
                    className="dialog-button secondary relay-danger"
                    disabled={busy}
                    data-remove={m.name}
                    aria-label={`Remove ${m.name}`}
                    onClick={() => onRemove(m)}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityTable({ rows }: { rows: RelayActivityRow[] }) {
  return (
    <div className="settings-row">
      <span className="settings-label">Activity</span>
      {rows.length === 0 ? (
        <p className="relay-text relay-muted">Nothing yet.</p>
      ) : (
        <div
          className="relay-table-wrap relay-activity"
          role="region"
          aria-label="Relay activity"
          tabIndex={0}
        >
          <table className="relay-table relay-fit relay-activity-table">
            <thead className="relay-sr">
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Machine</th>
                <th scope="col">Tool or event</th>
                <th scope="col">Target</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{stamp(r.at)}</td>
                  <td className="relay-cell-name">{r.machine}</td>
                  {r.event ? (
                    <td colSpan={3}>{r.event}</td>
                  ) : (
                    <>
                      <td>
                        {r.tool}
                        {r.count && r.count > 1 ? ` ×${r.count}` : ""}
                      </td>
                      <td>{r.target}</td>
                      <td>{r.outcome}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// A dialog in the host's own style (the snippets extension's pattern): portaled
// to <body>, focus moves in and stays in, Escape is taken in the capture phase
// so nothing underneath sees it, and focus goes back to the opener. A
// `locked` dialog ignores Escape and a click outside (the invite shown once).
function Modal({
  title,
  onClose,
  locked = false,
  returnFocus,
  children,
}: {
  title: string;
  onClose: () => void;
  locked?: boolean;
  returnFocus: () => HTMLElement | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    const dialog = ref.current;
    (
      dialog?.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog?.querySelector<HTMLElement>("input, select, textarea, button")
    )?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!lockedRef.current) onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      returnFocus()?.focus();
    };
    // Mount-only: the handlers read the latest `locked` through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <div
      className="dialog-overlay"
      onMouseDown={(e) =>
        e.target === e.currentTarget && !lockedRef.current && onClose()
      }
    >
      <div
        className="dialog relay-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
      >
        <div className="dialog-title">{title}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function InviteDialog({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [uses, setUses] = useState(1);
  const [minutes, setMinutes] = useState(1440);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The string replaces the form the focus was in; put focus on it.
  useEffect(() => {
    if (made !== null) {
      const t = textRef.current;
      if (t) {
        // Tall enough for the whole string, so no last line is clipped.
        t.style.height = "auto";
        t.style.height = `${t.scrollHeight + 2}px`;
      }
      t?.focus();
      t?.select();
    }
  }, [made]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await relayApi.createInvite({ uses, expiresMinutes: minutes });
      setMade(r.invite);
      afterAction();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Invite a machine"
      onClose={onClose}
      locked={made !== null}
      returnFocus={returnFocus}
    >
      {made === null ? (
        <>
          <label className="settings-row">
            <span className="settings-label">Uses</span>
            <input
              className="dialog-input settings-number"
              type="number"
              min={1}
              max={20}
              value={uses}
              onChange={(e) =>
                setUses(
                  Math.max(
                    1,
                    Math.min(20, Math.floor(Number(e.target.value)) || 1),
                  ),
                )
              }
            />
          </label>
          <label className="settings-row">
            <span className="settings-label">Expires</span>
            <select
              className="dialog-input settings-select"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
            >
              {EXPIRY_CHOICES.map((c) => (
                <option key={c.minutes} value={c.minutes}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <FormError text={error} />
          <div className="dialog-buttons">
            <button
              type="button"
              className="dialog-button secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dialog-button primary"
              disabled={busy}
              onClick={create}
            >
              Create invite
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="settings-row">
            <label className="settings-label" htmlFor="relay-invite-made">
              Invite
            </label>
            <textarea
              id="relay-invite-made"
              ref={textRef}
              className="dialog-input relay-invite-text"
              readOnly
              rows={3}
              value={made}
              onFocus={(e) => e.currentTarget.select()}
            />
            <p className="settings-hint">This is shown once.</p>
            {copy === "failed" && (
              <p className="settings-hint settings-error">
                Could not copy. Select the text and copy it by hand.
              </p>
            )}
          </div>
          <div className="dialog-buttons">
            <button
              type="button"
              className="dialog-button secondary"
              onClick={() =>
                copyText(made)
                  .then(() => setCopy("copied"))
                  .catch(() => setCopy("failed"))
              }
            >
              {copy === "copied" ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="dialog-button primary"
              onClick={onClose}
            >
              Done
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function InvitesDialog({
  invites,
  onClose,
  returnFocus,
}: {
  invites: RelayInvite[];
  onClose: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // After a revoke: the invite that is gone, and the one whose button should take over.
  const pending = useRef<{ id: string; next: string | null } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (!p || invites.some((i) => i.id === p.id)) return;
    pending.current = null;
    const next = p.next
      ? dialogRef.current?.querySelector<HTMLElement>(
          `[data-revoke="${p.next}"]`,
        )
      : null;
    (
      next ?? dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")
    )?.focus({ preventScroll: true });
  }, [invites]);
  const revoke = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await relayApi.revokeInvite(id);
      const at = invites.findIndex((i) => i.id === id);
      pending.current = {
        id,
        next: (invites[at + 1] ?? invites[at - 1])?.id ?? null,
      };
      afterAction();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId(null);
    }
  };
  return (
    <Modal title="Invites" onClose={onClose} returnFocus={returnFocus}>
      <div ref={dialogRef} className="relay-dialog-body">
        {invites.length === 0 ? (
          <p className="relay-text relay-muted">No invites are waiting.</p>
        ) : (
          <div className="relay-table-wrap">
            <table className="relay-table relay-fit">
              <thead>
                <tr>
                  <th scope="col">Created by</th>
                  <th scope="col" className="relay-hide-narrow">
                    Created
                  </th>
                  <th scope="col">Expires</th>
                  <th scope="col">Uses left</th>
                  <th scope="col">
                    <span className="relay-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.createdBy ?? "unknown"}</td>
                    <td className="relay-hide-narrow">
                      {dateTime(i.createdAt)}
                    </td>
                    <td>{dateTime(i.expiresAt)}</td>
                    <td>{i.usesLeft}</td>
                    <td className="relay-cell-action">
                      <button
                        type="button"
                        className="dialog-button secondary relay-danger"
                        disabled={busyId === i.id}
                        data-revoke={i.id}
                        aria-label={`Revoke the invite created by ${i.createdBy ?? "unknown"} at ${dateTime(i.createdAt)}`}
                        onClick={() => void revoke(i.id)}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <FormError text={error} />
        <div className="dialog-buttons">
          <button
            type="button"
            className="dialog-button primary"
            data-autofocus
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Remove and Leave: the relay's own Modal, so focus stays inside, Escape
// closes it and focus goes back to the button that opened it. Cancel has the
// initial focus, not the destructive button.
function ConfirmDialog({
  text,
  label,
  onCancel,
  onConfirm,
  returnFocus,
}: {
  text: string;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  return (
    <Modal
      title={label === "Leave" ? "Leave the group" : "Remove a machine"}
      onClose={onCancel}
      returnFocus={returnFocus}
    >
      <p className="relay-text relay-confirm-text">{text}</p>
      <div className="dialog-buttons">
        <button
          type="button"
          className="dialog-button secondary"
          data-autofocus
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="dialog-button primary"
          onClick={onConfirm}
        >
          {label}
        </button>
      </div>
    </Modal>
  );
}

function Segmented({
  value,
  disabled,
  limited,
  onChange,
}: {
  value: Inbound | null;
  disabled: boolean;
  // Assistant Read-only holds "Read and send" down to reading: still selected, shown dimmed.
  limited: boolean;
  onChange: (next: Inbound) => void;
}) {
  return (
    <div className="settings-segmented" role="group" aria-label="Others may">
      {INBOUND_CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          className={`settings-segment${value === c.value ? " active" : ""}${value === c.value && c.value === "send" && limited ? " relay-limited" : ""}`}
          aria-pressed={value === c.value}
          disabled={disabled}
          onClick={() => value !== c.value && onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

function Joined({
  state,
  loadError,
}: {
  state: RelayState;
  loadError: string | null;
}) {
  const activity = useRelayActivity();
  const [dialog, setDialog] = useState<"invite" | "invites" | null>(null);
  const [permBusy, setPermBusy] = useState(false);
  const [permError, setPermError] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const removedFocus = useRef<{ id: string; next: string | null } | null>(null);
  const [asking, setAsking] = useState<
    | { kind: "remove"; machine: RelayMachine; opener: HTMLElement | null }
    | { kind: "leave"; opener: HTMLElement | null }
    | null
  >(null);
  const statusRef = useStatusFocus();
  const inviteButton = useRef<HTMLButtonElement>(null);
  const invitesButton = useRef<HTMLButtonElement>(null);
  const machine = state.machine;

  useEffect(() => {
    const p = removedFocus.current;
    if (!p || state.machines.some((x) => x.id === p.id)) return;
    removedFocus.current = null;
    const next = p.next
      ? document.querySelector<HTMLElement>(
          `.relay-machines [data-remove="${CSS.escape(p.next)}"]`,
        )
      : null;
    (next ?? inviteButton.current)?.focus({ preventScroll: true });
  }, [state.machines]);

  const onPermission = async (next: Inbound) => {
    setPermBusy(true);
    setPermError(null);
    try {
      applyState(await relayApi.setPermission(next));
    } catch (err) {
      setPermError(message(err));
    } finally {
      setPermBusy(false);
    }
  };

  const onRemove = async (m: RelayMachine) => {
    setTableError(null);
    setRemoving(true);
    // Focus goes to the next row's Remove (else the one above), else Invite.
    const others = state.machines.filter((x) => !x.self);
    const at = others.findIndex((x) => x.id === m.id);
    removedFocus.current = {
      id: m.id,
      next: (others[at + 1] ?? others[at - 1])?.name ?? null,
    };
    try {
      await relayApi.remove(m.name);
      afterAction();
    } catch (err) {
      removedFocus.current = null;
      setTableError(message(err));
    } finally {
      setRemoving(false);
    }
  };

  const onLeave = async () => {
    setLeaveError(null);
    try {
      const left = (await relayApi.leave()) as {
        relayEntryRemoved?: boolean;
      } | null;
      // Shown in the not-connected view that follows.
      relayEntryRemains = left?.relayEntryRemoved === false;
      focusStatusNext = true;
      requestStateNow();
    } catch (err) {
      setLeaveError(message(err));
    }
  };

  const status = loadError
    ? `could not refresh: ${loadError}`
    : state.connection === "connected"
      ? `connected · ${state.relayHost ?? ""}`
      : state.connection === "refused"
        ? state.reason || "refused"
        : "reconnecting…";
  const linkLabel: LinkLabel =
    !loadError && state.connection === "connected"
      ? "connected"
      : !loadError && state.connection === "refused"
        ? "refused"
        : "reconnecting";
  const bad = !!loadError || state.connection === "refused";

  return (
    <div className="relay-section">
      <div className="settings-row">
        <span className="settings-label">Status</span>
        <p
          className={bad ? "relay-text relay-bad" : "relay-text"}
          role="status"
          tabIndex={-1}
          ref={statusRef}
        >
          <span
            className={`relay-dot ${loadError ? "refused" : (state.connection ?? "")}`}
            aria-hidden="true"
          />{" "}
          {status}
        </p>
      </div>
      {machine && (
        <InlineEdit
          label="This machine"
          value={machine.name}
          empty=""
          action="Rename"
          onSave={async (v) => applyState(await relayApi.rename(v))}
        />
      )}
      {machine && (
        <InlineEdit
          label="Relay label"
          value={machine.label}
          empty="not set"
          action="Set"
          clear
          onSave={async (v) => applyState(await relayApi.setLabel(v))}
        />
      )}
      <div className="settings-row">
        <span className="settings-label">Others may</span>
        <Segmented
          value={state.inbound}
          disabled={permBusy}
          limited={state.readOnlyLimiting}
          onChange={(next) => void onPermission(next)}
        />
        {state.readOnlyLimiting && (
          <p className="settings-hint relay-fg">
            Assistant Read-only is on, so other machines cannot send to agents
            here.
          </p>
        )}
        <FormError text={permError} />
      </div>
      <MachinesTable
        machines={state.machines}
        link={linkLabel}
        onRemove={(m) =>
          setAsking({
            kind: "remove",
            machine: m,
            opener: document.activeElement as HTMLElement | null,
          })
        }
        busy={removing}
      />
      <FormError text={tableError} />
      <div className="relay-buttons">
        <button
          type="button"
          ref={inviteButton}
          className="dialog-button primary"
          onClick={() => setDialog("invite")}
        >
          Invite a machine…
        </button>
        <button
          type="button"
          ref={invitesButton}
          className="dialog-button secondary"
          onClick={() => setDialog("invites")}
        >
          Invites ({state.invites.length})
        </button>
        <button
          type="button"
          className="dialog-button secondary relay-danger"
          onClick={() =>
            setAsking({
              kind: "leave",
              opener: document.activeElement as HTMLElement | null,
            })
          }
        >
          Leave group
        </button>
      </div>
      <FormError text={leaveError} />
      <ActivityTable rows={activity} />
      {asking?.kind === "remove" && (
        <ConfirmDialog
          text={`Remove ${asking.machine.name} from the group? It will be blocked and every outstanding invite will be cancelled.`}
          label="Remove"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const m = asking.machine;
            setAsking(null);
            void onRemove(m);
          }}
          returnFocus={() =>
            asking.opener?.isConnected ? asking.opener : inviteButton.current
          }
        />
      )}
      {asking?.kind === "leave" && (
        <ConfirmDialog
          text="Leave the group? This machine's keys are deleted; you will need a new invite to come back."
          label="Leave"
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            void onLeave();
          }}
          returnFocus={() => asking.opener}
        />
      )}
      {dialog === "invite" && (
        <InviteDialog
          onClose={() => setDialog(null)}
          returnFocus={() => inviteButton.current}
        />
      )}
      {dialog === "invites" && (
        <InvitesDialog
          invites={state.invites}
          onClose={() => setDialog(null)}
          returnFocus={() => invitesButton.current}
        />
      )}
    </div>
  );
}

function RelayBody() {
  const view = useRelayView();
  if (view.kind === "unavailable") {
    return (
      <div className="settings-row">
        <span className="settings-label">Status</span>
        <p className="relay-text relay-muted">{view.reason}</p>
      </div>
    );
  }
  if (view.kind === "loading") {
    return view.error ? (
      <div className="settings-row">
        <span className="settings-label">Status</span>
        <FormError text={view.error} />
      </div>
    ) : null;
  }
  return view.state.joined ? (
    <Joined state={view.state} loadError={view.error} />
  ) : (
    <NotJoined state={view.state} />
  );
}

// The section under its own divider and sub-heading, so it reads apart from
// the MCP setup above it.
export function RelaySection() {
  return (
    <div className="relay-block">
      <h3 className="relay-heading">Relay</h3>
      <RelayBody />
    </div>
  );
}
