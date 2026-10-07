// The launcher (plans/desktop-app.md T10): every server the app knows, with
// whether it answers, a way to open each, and the bundled local server's
// state. The list itself lives in the app (src-tauri/src/servers.rs).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Kind = "local" | "installed" | "remote";
type LocalStatus =
  | { state: "running"; port: number }
  | { state: "stopped" }
  | { state: "missing" }
  | { state: "failed"; message: string; logTail: string };

interface Server {
  id: string;
  name: string;
  url: string;
  kind: Kind;
  notify: boolean;
  needsSignIn: boolean;
  open: boolean;
}

interface LauncherState {
  servers: Server[];
  local: LocalStatus;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>("servers");
const footer = $<HTMLElement>("local");

// Whether each remote answered at the last check, and when it last did.
const reachable = new Map<string, boolean>();
const LAST_SEEN_KEY = "perch.lastSeen";
function lastSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(LAST_SEEN_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function markSeen(id: string) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, JSON.stringify({ ...lastSeen(), [id]: Date.now() }));
  } catch {
    // Only a convenience.
  }
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

let state: LauncherState = { servers: [], local: { state: "stopped" } };
let openMenu: string | null = null;
// What's typed so far and where the caret is live here, not just in the
// input: the list is rebuilt every few seconds (the timer at the bottom).
let editing: { id: string; field: "name" | "url"; draft?: string; caret?: [number, number] } | null = null;
// The server whose Remove was clicked once: the second click removes it.
let confirmingRemove: string | null = null;
let busy = false;

function showError(message: string) {
  // A failed local start appends the server's log after a blank line
  // (windows.rs describe_local_failure): the message reads as prose, the
  // log as the log it is.
  const [text, ...rest] = message.split("\n\n");
  const p = document.createElement("p");
  p.textContent = text;
  const parts: HTMLElement[] = [p];
  if (rest.length > 0) {
    const log = document.createElement("pre");
    log.textContent = rest.join("\n\n");
    parts.push(log);
  }
  $("error-text").replaceChildren(...parts);
  $("error").hidden = false;
}

// A form that went through: whatever it complained about before is moot.
function clearError() {
  $("error").hidden = true;
}

async function run<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    showError(String(e));
    return undefined;
  }
}

async function refresh() {
  state = await invoke<LauncherState>("list_servers");
  render();
  void checkReachable();
}

// A remote answers if anything comes back for its public /tunnel.mjs; an
// opaque no-cors reply is enough to know that.
async function checkReachable() {
  await Promise.all(
    state.servers
      .filter((s) => s.kind === "remote")
      .map(async (s) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
          await fetch(new URL("tunnel.mjs", s.url), { mode: "no-cors", signal: ctrl.signal, cache: "no-store" });
          reachable.set(s.id, true);
          markSeen(s.id);
        } catch {
          reachable.set(s.id, false);
        } finally {
          clearTimeout(timer);
        }
      }),
  );
  render();
}

function where(s: Server): string {
  if (s.kind === "local") {
    return state.local.state === "running" ? `this computer - :${state.local.port}` : "this computer";
  }
  return s.url.replace(/\/$/, "");
}

function statusOf(s: Server): { dot: "" | "up" | "down"; note: string; warn: boolean } {
  if (s.kind === "local") {
    switch (state.local.state) {
      case "running":
        return { dot: "up", note: "", warn: false };
      case "missing":
        return { dot: "down", note: "Not included in this build", warn: true };
      case "failed":
        return { dot: "down", note: "Couldn't start - see the message above", warn: true };
      default:
        return { dot: "", note: "Stopped - Open starts it", warn: false };
    }
  }
  if (s.kind === "installed") return { dot: "up", note: "", warn: false };
  const up = reachable.get(s.id);
  if (up === false) {
    const seen = lastSeen()[s.id];
    return { dot: "down", note: seen ? `Unreachable - last seen ${ago(seen)}` : "Unreachable", warn: true };
  }
  if (s.needsSignIn) return { dot: up ? "up" : "", note: "Sign in to get alerts", warn: true };
  return { dot: up ? "up" : "", note: "", warn: false };
}

function button(label: string, onClick: () => void, cls = "ghost"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.className = cls;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function render() {
  // A confirmation lasts only while its menu stays open.
  if (confirmingRemove !== openMenu) confirmingRemove = null;
  list.replaceChildren(...state.servers.map(row));
  renderFooter();
}

function row(s: Server): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "server";
  const status = statusOf(s);
  const dot = document.createElement("span");
  dot.className = `dot ${status.dot}`;
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = s.name;
  const loc = document.createElement("div");
  loc.className = "where";
  loc.textContent = where(s);
  loc.title = where(s);
  who.append(name, loc);
  if (status.note) {
    const note = document.createElement("div");
    note.className = `note${status.warn ? " warn" : ""}`;
    note.textContent = status.note;
    who.append(note);
  }
  const open = button(
    s.open ? "Show" : "Open",
    () => {
      // Opening Local may start its server first (a while, the first time).
      if (s.kind === "local" && state.local.state !== "running") {
        busy = true;
        renderFooter();
      }
      void run("open_server", { id: s.id });
    },
    "",
  );
  open.disabled = s.kind === "local" && state.local.state === "missing";
  const more = button("...", () => {
    openMenu = openMenu === s.id ? null : s.id;
    render();
  });
  more.setAttribute("aria-label", `More for ${s.name}`);
  more.setAttribute("aria-haspopup", "menu");
  li.append(dot, who, open, more);
  if (openMenu === s.id) li.append(menu(s));
  if (editing?.id === s.id) li.append(editor(s, editing.field));
  return li;
}

function menu(s: Server): HTMLElement {
  const m = document.createElement("div");
  m.className = "menu";
  m.setAttribute("role", "menu");
  const close = () => {
    openMenu = null;
  };
  if (s.kind === "remote") {
    m.append(
      button("Rename", () => {
        close();
        editing = { id: s.id, field: "name" };
        render();
      }),
      button("Edit address", () => {
        close();
        editing = { id: s.id, field: "url" };
        render();
      }),
    );
  }
  m.append(
    button(s.notify ? "Notify: on" : "Notify: off", async () => {
      close();
      await run("update_server", { id: s.id, notify: !s.notify });
      await refresh();
    }),
  );
  if (s.kind === "remote") {
    const confirming = confirmingRemove === s.id;
    // Removing also signs the app out of the server: ask once more.
    const remove = button(confirming ? `Remove "${s.name}"` : "Remove...", async () => {
      if (!confirming) {
        confirmingRemove = s.id;
        render();
        return;
      }
      close();
      confirmingRemove = null;
      await run("remove_server", { id: s.id });
      await refresh();
    });
    remove.classList.add("danger");
    if (confirming) {
      remove.classList.add("confirm");
      queueMicrotask(() => remove.focus());
    }
    m.append(remove);
  }
  for (const b of m.querySelectorAll("button")) b.setAttribute("role", "menuitem");
  return m;
}

function editor(s: Server, field: "name" | "url"): HTMLElement {
  const form = document.createElement("form");
  form.className = "edit";
  const input = document.createElement("input");
  const edit = editing;
  input.value = edit?.draft ?? (field === "name" ? s.name : s.url);
  const keep = () => {
    if (editing !== edit || !edit) return;
    edit.draft = input.value;
    edit.caret = [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length];
  };
  for (const type of ["input", "keyup", "mouseup", "select"]) input.addEventListener(type, keep);
  input.setAttribute("aria-label", field === "name" ? "Server name" : "Server address");
  const done = () => {
    editing = null;
    render();
  };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    // A unit command resolves to null; `run` gives undefined on an error,
    // which leaves the form open with the message above it.
    if ((await run("update_server", { id: s.id, [field]: input.value })) !== undefined) {
      clearError();
      editing = null;
      await refresh();
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done();
  });
  form.append(input, button("Save", () => form.requestSubmit(), ""), button("Cancel", done));
  queueMicrotask(() => {
    input.focus();
    if (edit?.caret) input.setSelectionRange(...edit.caret);
  });
  return form;
}

function renderFooter() {
  const text = document.createElement("span");
  text.className = "grow";
  const local = state.local;
  const actions: HTMLButtonElement[] = [];
  if (local.state === "running") {
    text.textContent = `Local server: running on :${local.port}`;
    const stop = button("Stop", async () => {
      busy = true;
      renderFooter();
      await run("stop_local");
      busy = false;
      await refresh();
    });
    stop.disabled = busy;
    actions.push(stop);
  } else if (local.state === "missing") {
    text.textContent = "Local server: not included in this build";
  } else {
    text.textContent = busy ? "Local server: starting..." : "Local server: stopped";
    const start = button("Start", async () => {
      busy = true;
      renderFooter();
      await run("start_local");
    });
    start.disabled = busy;
    actions.push(start);
  }
  footer.replaceChildren(text, ...actions);
}

// ---- Wiring --------------------------------------------------------------

const addForm = $<HTMLFormElement>("add-form");
$("add-toggle").addEventListener("click", () => {
  addForm.hidden = !addForm.hidden;
  if (!addForm.hidden) $<HTMLInputElement>("add-name").focus();
});
$("add-cancel").addEventListener("click", () => {
  addForm.hidden = true;
  addForm.reset();
});
addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const added = await run("add_server", {
    name: $<HTMLInputElement>("add-name").value,
    url: $<HTMLInputElement>("add-url").value,
  });
  if (added) {
    clearError();
    addForm.reset();
    addForm.hidden = true;
    await refresh();
  }
});
$("error-close").addEventListener("click", () => {
  $("error").hidden = true;
});
document.addEventListener("click", () => {
  if (openMenu) {
    openMenu = null;
    render();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu) {
    openMenu = null;
    render();
  }
});

void listen<string>("launcher-error", (e) => {
  busy = false;
  showError(e.payload);
  void refresh();
});
void listen("servers-changed", () => {
  busy = false;
  void refresh();
});

// While the launcher is visible, look for an installed Perch and recheck
// the remotes now and then.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  void invoke("detect_installed");
  void refresh();
}, 5000);

void refresh();
