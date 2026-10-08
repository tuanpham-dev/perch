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

interface ServerVersion {
  id: string;
  version: string | null;
  compatNote: string | null;
}

// The app's own update (src-tauri/src/updater.rs).
interface UpdateView {
  appVersion: string;
  autoCheck: boolean;
  channel: "stable" | "beta";
  phase: "idle" | "checking" | "upToDate" | "downloading" | "ready" | "available" | "error";
  version: string | null;
  error: string | null;
  checkedAt: number | null;
  noticeOnly: boolean;
  releaseUrl: string | null;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>("servers");
const footer = $<HTMLElement>("local");
const updateBar = $<HTMLElement>("update");
const updatesPanel = $<HTMLElement>("updates-panel");

// What each server said its version is, and whether it fits this app.
const versions = new Map<string, ServerVersion>();
let update: UpdateView | null = null;
let updatesOpen = false;

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
  void checkVersions();
}

let askingVersions = false;
async function checkVersions() {
  if (askingVersions) return;
  askingVersions = true;
  try {
    const answers = await invoke<ServerVersion[]>("server_versions");
    versions.clear();
    for (const v of answers) versions.set(v.id, v);
    render();
  } catch {
    // Versions are extra; the list works without them.
  } finally {
    askingVersions = false;
  }
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
  renderUpdate();
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
  const v = versions.get(s.id);
  // Only while it answers: a version from an earlier check could be stale.
  const version = v?.version && (s.kind !== "remote" || reachable.get(s.id) !== false) ? ` · v${v.version}` : "";
  loc.textContent = where(s) + version;
  loc.title = loc.textContent;
  if (v?.compatNote) loc.append(" ⚠");
  who.append(name, loc);
  if (status.note) {
    const note = document.createElement("div");
    note.className = `note${status.warn ? " warn" : ""}`;
    note.textContent = status.note;
    who.append(note);
  }
  if (v?.compatNote) {
    const note = document.createElement("div");
    note.className = "note warn";
    note.textContent = v.compatNote;
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
  const app = document.createElement("span");
  app.className = "app-version";
  app.textContent = update ? `App v${update.appVersion}` : "";
  const updates = button("Updates", () => {
    updatesOpen = !updatesOpen;
    renderUpdate();
  });
  updates.setAttribute("aria-haspopup", "dialog");
  updates.setAttribute("aria-expanded", String(updatesOpen));
  footer.replaceChildren(text, app, ...actions, updates);
}

// ---- The app's own update -------------------------------------------------

function renderUpdate() {
  const u = update;
  // The bar: something to act on.
  if (u && u.phase === "ready" && u.version) {
    const text = document.createElement("span");
    text.className = "grow";
    text.textContent = `Perch ${u.version} is ready - Restart to update`;
    updateBar.replaceChildren(text, button("Restart", () => void run("restart_to_update"), ""));
    updateBar.hidden = false;
  } else if (u && u.phase === "available" && u.version) {
    const text = document.createElement("span");
    text.className = "grow";
    text.textContent = `Perch ${u.version} is available`;
    updateBar.replaceChildren(text, button("Download", () => void run("open_release_page"), ""));
    updateBar.hidden = false;
  } else if (u && u.phase === "error" && u.error) {
    const text = document.createElement("span");
    text.className = "grow warn";
    text.textContent = `Couldn't update the app: ${u.error}`;
    updateBar.replaceChildren(text, button("Try again", () => void run("check_updates")));
    updateBar.hidden = false;
  } else {
    updateBar.hidden = true;
  }

  updatesPanel.hidden = !updatesOpen || !u;
  if (!updatesOpen || !u) return;
  const title = document.createElement("div");
  title.className = "panel-title";
  title.textContent = `Perch app ${u.appVersion}`;
  const status = document.createElement("div");
  status.className = "panel-status";
  status.textContent = updateStatusText(u);
  const busy = u.phase === "checking" || u.phase === "downloading";
  const check = button(busy ? "Checking..." : "Check for updates now", () => void run("check_updates"));
  check.disabled = busy || u.phase === "ready";

  const auto = document.createElement("label");
  auto.className = "check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = u.autoCheck;
  box.addEventListener("change", () => void run("set_update_settings", { autoCheck: box.checked }));
  auto.append(box, " Automatically check for updates");

  const channel = document.createElement("label");
  channel.className = "channel";
  const select = document.createElement("select");
  for (const [value, label] of [
    ["stable", "Stable"],
    ["beta", "Beta (includes pre-releases)"],
  ]) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    o.selected = u.channel === value;
    select.append(o);
  }
  select.addEventListener("change", () => void run("set_update_settings", { channel: select.value }));
  channel.append("Channel ", select);

  updatesPanel.replaceChildren(title, status, check, auto, channel);
}

function updateStatusText(u: UpdateView): string {
  switch (u.phase) {
    case "checking":
      return "Checking for updates...";
    case "downloading":
      return `Downloading Perch ${u.version ?? ""}...`;
    case "ready":
      return `Perch ${u.version} is ready - Restart to update.`;
    case "available":
      return `Perch ${u.version} is available.${u.noticeOnly ? " Installed from a package: download it from the release page." : ""}`;
    case "error":
      return `Couldn't check for updates: ${u.error ?? "unknown error"}`;
    case "upToDate":
      return `Up to date. Checked ${u.checkedAt ? ago(u.checkedAt) : "just now"}.`;
    default:
      return u.autoCheck ? "Not checked yet." : "Automatic checks are off.";
  }
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
document.addEventListener("click", (e) => {
  if (openMenu) {
    openMenu = null;
    render();
  }
  // A click outside the Updates panel (and its button) closes it.
  if (updatesOpen && !updatesPanel.contains(e.target as Node) && !footer.contains(e.target as Node)) {
    updatesOpen = false;
    renderUpdate();
    renderFooter();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenu) {
    openMenu = null;
    render();
  } else if (e.key === "Escape" && updatesOpen) {
    updatesOpen = false;
    render();
  }
});

void listen<string>("launcher-error", (e) => {
  busy = false;
  showError(e.payload);
  void refresh();
});
void listen<UpdateView>("updates-changed", (e) => {
  update = e.payload;
  render();
});
void invoke<UpdateView>("get_update_state").then((u) => {
  update = u;
  render();
});
void listen("servers-changed", () => {
  busy = false;
  void refresh();
});

// The timer below skips a hidden launcher (WebKit also counts one covered
// by other windows as hidden), so it would come back showing what was true
// when it was last seen - Local "Stopped", a window that has since opened
// still offered as "Open". It catches up as soon as it's shown.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
window.addEventListener("focus", () => void refresh());

// While the launcher is visible, look for an installed Perch and recheck
// the remotes now and then.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  void invoke("detect_installed");
  void refresh();
}, 5000);

void refresh();
