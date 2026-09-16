// snippets: the SNIPPETS accordion section of the Run tab — saved,
// parameterized commands typed into the active session's pane (via this
// extension's own /type server route, same posture as command-history).
// `{param}` placeholders prompt for values on run; `{{` escapes a literal
// brace. Snippets persist as a JSON-string configuration property
// (snippets.items), so they sync across devices like any other setting —
// the touch-keys layout pattern. Palette/switcher entry points: one static
// "Snippets: Run Snippet…" picker command, a per-snippet palette command for
// every snippet present at activation (registerCommand has no per-command
// disposal, so snippets added this session join the palette after reload),
// and a quick-switcher provider that matches snippet names live.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import "./style.css";
import { copyText } from "../../_shared/clipboard";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { useLongPressMenu } from "../../_shared/useLongPressMenu";

interface Snippet {
  id: string;
  name: string;
  command: string;
  // Type the command at the prompt without pressing Enter — for commands the
  // user wants to review or complete by hand.
  insertOnly?: boolean;
}

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

// ---- Module-level host bridge ----

interface ExtSettings {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  onDidChange(cb: () => void): () => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let extSettings: ExtSettings | null = null;
let refreshSwitcher: (() => void) | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;
let removeRunListener: (() => void) | null = null;

const NO_CONTEXT: ActiveContext = { sessionName: null, windowIndex: null, cwd: null };
let activeContext: ActiveContext = NO_CONTEXT;

const changeListeners = new Set<() => void>();

function notifyChanged(): void {
  for (const listener of changeListeners) listener();
  refreshSwitcher?.();
}

// ---- Storage ----

function readSnippets(): Snippet[] {
  const raw = extSettings?.get("snippets.items");
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (s) =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as Snippet).id === "string" &&
          typeof (s as Snippet).name === "string" &&
          typeof (s as Snippet).command === "string",
      )
    ) {
      return parsed as Snippet[];
    }
  } catch {
    // Malformed stored value — treat as empty rather than breaking the panel.
  }
  return [];
}

function writeSnippets(snippets: Snippet[]): void {
  extSettings?.set("snippets.items", JSON.stringify(snippets));
  notifyChanged();
}

// ---- Placeholders ----

// `{param}` tokens prompt on run; `{{` and `}}` escape literal braces.
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_-]+)\}/g;

function placeholdersOf(command: string): string[] {
  const seen = new Set<string>();
  for (const match of command.replace(/\{\{|\}\}/g, "").matchAll(PLACEHOLDER_RE)) {
    seen.add(match[1]);
  }
  return [...seen];
}

function substitute(command: string, values: Record<string, string>): string {
  // Escapes first (so "{{literal}}" never matches a param), then params.
  return command
    .split("{{")
    .map((part) =>
      part
        .split("}}")
        .map((inner) => inner.replace(PLACEHOLDER_RE, (_, name: string) => values[name] ?? ""))
        .join("}"),
    )
    .join("{");
}

// ---- Dialogs ----
// Rendered into a root this extension owns (host's react-dom/client via the
// build shim — see client/src/main.tsx) so palette/switcher runs work with
// no panel mounted.

function mountDialog<T>(render: (resolve: (value: T | null) => void) => JSX.Element): Promise<T | null> {
  return new Promise((resolvePromise) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (value: T | null) => {
      root.unmount();
      host.remove();
      resolvePromise(value);
    };
    root.render(render(done));
  });
}

function DialogShell({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="snippets-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="snippets-dialog" role="dialog" aria-label={title}>
        <div className="snippets-dialog-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function ParamForm({
  snippet,
  params,
  resolve,
}: {
  snippet: Snippet;
  params: string[];
  resolve: (values: Record<string, string> | null) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <DialogShell title={snippet.name} onCancel={() => resolve(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          resolve(values);
        }}
      >
        {params.map((name, i) => (
          <label key={name} className="snippets-field">
            <span>{name}</span>
            <input
              className="snippets-input"
              autoFocus={i === 0}
              value={values[name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
            />
          </label>
        ))}
        <div className="snippets-dialog-buttons">
          <button type="button" className="snippets-button" onClick={() => resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="snippets-button primary">
            {snippet.insertOnly ? "Insert" : "Run"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function EditForm({
  snippet,
  resolve,
}: {
  snippet: Snippet | null;
  resolve: (value: Omit<Snippet, "id"> | null) => void;
}) {
  const [name, setName] = useState(snippet?.name ?? "");
  const [command, setCommand] = useState(snippet?.command ?? "");
  const [insertOnly, setInsertOnly] = useState(snippet?.insertOnly ?? false);
  return (
    <DialogShell title={snippet ? "Edit Snippet" : "New Snippet"} onCancel={() => resolve(null)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !command.trim()) return;
          resolve({ name: name.trim(), command, insertOnly: insertOnly || undefined });
        }}
      >
        <label className="snippets-field">
          <span>Name</span>
          <input className="snippets-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="snippets-field">
          <span>Command</span>
          <textarea
            className="snippets-input"
            rows={3}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="deploy {env}"
          />
        </label>
        <div className="snippets-hint">{"{param} prompts on run; {{ and }} for literal braces"}</div>
        <label className="snippets-check">
          <input type="checkbox" checked={insertOnly} onChange={(e) => setInsertOnly(e.target.checked)} />
          <span>Insert at prompt without running</span>
        </label>
        <div className="snippets-dialog-buttons">
          <button type="button" className="snippets-button" onClick={() => resolve(null)}>
            Cancel
          </button>
          <button type="submit" className="snippets-button primary">
            Save
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function PickerForm({
  snippets,
  resolve,
}: {
  snippets: Snippet[];
  resolve: (value: Snippet | null) => void;
}) {
  return (
    <DialogShell title="Run Snippet" onCancel={() => resolve(null)}>
      <ul className="snippets-picker">
        {snippets.map((s) => (
          <li key={s.id}>
            <button type="button" className="snippets-picker-row" onClick={() => resolve(s)}>
              <span className="snippets-name">{s.name}</span>
              <span className="snippets-preview">{s.command}</span>
            </button>
          </li>
        ))}
        {snippets.length === 0 && <li className="snippets-empty">No snippets yet - add one in the Commands sidebar tab.</li>}
      </ul>
    </DialogShell>
  );
}

// ---- Actions ----

function typeIntoActivePane(text: string, submit: boolean): void {
  const session = activeContext.sessionName;
  if (!session || !serverFetch) return;
  void serverFetch("/type", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session, text, submit }),
  }).catch(() => {});
}

// The full run flow: prompt for params if any, substitute, type. forceInsert
// (the switcher's Shift+Enter) downgrades a run-snippet to insert-only.
// sendOverride (a touch key's tap, see the run-snippet listener in
// activate()) replaces the type-into-active-pane default so the text lands
// in the terminal the gesture came from.
async function runSnippet(
  snippet: Snippet,
  forceInsert = false,
  sendOverride?: (text: string, submit: boolean) => void,
): Promise<void> {
  const params = placeholdersOf(snippet.command);
  let values: Record<string, string> = {};
  if (params.length > 0) {
    const answered = await mountDialog<Record<string, string>>((resolve) => (
      <ParamForm snippet={snippet} params={params} resolve={resolve} />
    ));
    if (!answered) return;
    values = answered;
  }
  const text = substitute(snippet.command, values);
  const submit = !(snippet.insertOnly || forceInsert);
  if (sendOverride) sendOverride(text, submit);
  else typeIntoActivePane(text, submit);
}

// A touch key referencing a deleted snippet: explain instead of a dead tap
// (the key deliberately keeps rendering — see touch-keys' visibleKeys).
function showMissingSnippet(): void {
  void mountDialog<null>((resolve) => (
    <DialogShell title="Snippet not found" onCancel={() => resolve(null)}>
      <div className="snippets-hint">
        This touch key references a snippet that no longer exists - it may have been deleted.
        Edit the key in Settings → Touch Keys, or re-create the snippet.
      </div>
      <div className="snippets-dialog-buttons">
        <button type="button" className="snippets-button primary" onClick={() => resolve(null)}>
          OK
        </button>
      </div>
    </DialogShell>
  ));
}

async function pickAndRun(): Promise<void> {
  const chosen = await mountDialog<Snippet>((resolve) => (
    <PickerForm snippets={readSnippets()} resolve={resolve} />
  ));
  if (chosen) await runSnippet(chosen);
}

async function addOrEdit(existing: Snippet | null): Promise<void> {
  const result = await mountDialog<Omit<Snippet, "id">>((resolve) => (
    <EditForm snippet={existing} resolve={resolve} />
  ));
  if (!result) return;
  const snippets = readSnippets();
  if (existing) {
    writeSnippets(snippets.map((s) => (s.id === existing.id ? { ...s, ...result } : s)));
  } else {
    writeSnippets([...snippets, { id: `s${Date.now().toString(36)}`, ...result }]);
  }
}

// ---- Panel ----

interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
  confirmDialog?: (message: string, confirmLabel?: string) => Promise<boolean>;
}

function SnippetsPanel({ actionsTarget, showMenu, confirmDialog }: PanelProps) {
  const bindMenu = useLongPressMenu();
  const [, forceRender] = useState(0);

  useEffect(() => {
    const listener = () => forceRender((v) => v + 1);
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }, []);

  const snippets = readSnippets();

  const remove = async (snippet: Snippet) => {
    const ok = (await confirmDialog?.(`Delete snippet "${snippet.name}"?`, "Delete")) ?? true;
    if (ok) writeSnippets(readSnippets().filter((s) => s.id !== snippet.id));
  };

  const menuFor = (s: Snippet): MenuItem[] => [
    { label: s.insertOnly ? "Insert" : "Run", onClick: () => void runSnippet(s) },
    { label: "Insert without running", onClick: () => void runSnippet(s, true) },
    { label: "Copy command", onClick: () => void copyText(s.command).catch(() => {}) },
    { label: "Edit…", onClick: () => void addOrEdit(s) },
    { label: "Delete", danger: true, onClick: () => void remove(s) },
  ];

  return (
    <div className="snippets-panel">
      {actionsTarget &&
        createPortal(
          <button
            type="button"
            className="snippets-header-action"
            title="New snippet"
            onClick={() => void addOrEdit(null)}
          >
            <Icon name="add" />
          </button>,
          actionsTarget,
        )}
      <ul className="snippets-list">
        {snippets.map((s) => (
          <li
            key={s.id}
            className="snippets-row"
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu?.(e.clientX, e.clientY, menuFor(s));
            }}
            {...bindMenu((x, y) => showMenu?.(x, y, menuFor(s)))}
          >
            <button
              type="button"
              className="snippets-row-main"
              title={s.command}
              onClick={() => void runSnippet(s)}
            >
              <span className="snippets-name">{s.name}</span>
              <span className="snippets-preview">{s.command}</span>
            </button>
            <span className="snippets-actions">
              <button
                type="button"
                className="snippets-action"
                title={s.insertOnly ? "Insert at prompt" : "Run in active pane"}
                onClick={() => void runSnippet(s)}
              >
                <Icon name={s.insertOnly ? "insert" : "play"} />
              </button>
              <button
                type="button"
                className="snippets-action"
                title="Edit"
                onClick={() => void addOrEdit(s)}
              >
                <Icon name="edit" />
              </button>
            </span>
          </li>
        ))}
        {snippets.length === 0 && (
          <li className="snippets-empty">No snippets yet - click + to add one.</li>
        )}
      </ul>
    </div>
  );
}

// ---- Activation ----

interface QuickSwitcherItem {
  label: string;
  tag?: string;
  run: (secondary: boolean) => void;
}

interface ExtensionContext {
  registerSidebarPanel(panel: {
    id: string;
    title: string;
    icon?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    defaultCollapsed?: boolean;
    order?: number;
    component: (props: PanelProps) => ReturnType<typeof SnippetsPanel>;
  }): void;
  registerCommand(command: { id: string; label: string; defaultBinding?: string; run: () => void }): void;
  registerQuickSwitcherProvider(provider: {
    id: string;
    provideResults: (query: string) => QuickSwitcherItem[];
  }): { refresh(): void };
  app: {
    getActiveContext(): ActiveContext;
    onDidChangeContext(cb: (ctx: ActiveContext) => void): () => void;
  };
  serverFetch(path: string, init?: RequestInit): Promise<Response>;
  assetUrl(relPath: string): string;
  settings: ExtSettings;
}

const SWITCHER_LIMIT = 10;

export function activate(ctx: ExtensionContext): void {
  serverFetch = ctx.serverFetch;
  extSettings = ctx.settings;
  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");

  ctx.registerSidebarPanel({
    id: "snippets",
    title: "Snippets",
    icon: "bookmark",
    location: "commands",
    order: 20,
    defaultCollapsed: false,
    component: SnippetsPanel,
  });

  ctx.registerCommand({
    id: "run",
    label: "Snippets: Run Snippet…",
    run: () => void pickAndRun(),
  });
  ctx.registerCommand({
    id: "add",
    label: "Snippets: Add Snippet…",
    run: () => void addOrEdit(null),
  });
  // Per-snippet palette entries for whatever exists now; run() re-reads by
  // id so edits apply live. registerCommand has no disposal, so snippets
  // added this session appear in the palette after the next reload (the
  // switcher provider below has no such lag).
  for (const snippet of readSnippets()) {
    ctx.registerCommand({
      id: `run.${snippet.id}`,
      label: `Snippet: ${snippet.name}`,
      run: () => {
        const current = readSnippets().find((s) => s.id === snippet.id);
        if (current) void runSnippet(current);
      },
    });
  }

  const handle = ctx.registerQuickSwitcherProvider({
    id: "snippets",
    provideResults: (query: string) => {
      const term = query.trim().toLowerCase();
      if (!term || term.startsWith(">") || term.startsWith("!")) return [];
      return readSnippets()
        .filter((s) => s.name.toLowerCase().includes(term))
        .slice(0, SWITCHER_LIMIT)
        .map((s) => ({
          label: s.name,
          tag: "snippet",
          run: (secondary: boolean) => void runSnippet(s, secondary),
        }));
    },
  });
  refreshSwitcher = handle.refresh;

  activeContext = ctx.app.getActiveContext();
  removeContextListener = ctx.app.onDidChangeContext((next) => {
    activeContext = next;
  });
  // Settings can change from another device or the Settings UI — keep the
  // panel and switcher current.
  removeSettingsListener = ctx.settings.onDidChange(notifyChanged);

  // Touch-key bridge: a "{snippet:<id>}" key tap (touch-keys extension)
  // dispatches this event; the full run flow — {param} dialogs, insert-only
  // — answers through detail.send so the text lands in the tapped terminal.
  const onRunSnippet = (e: Event) => {
    const detail = (e as CustomEvent<{ id?: string; send?: (text: string, submit: boolean) => void }>).detail;
    if (!detail?.id) return;
    const snippet = readSnippets().find((s) => s.id === detail.id);
    if (!snippet) {
      showMissingSnippet();
      return;
    }
    void runSnippet(snippet, false, detail.send);
  };
  window.addEventListener("perch:run-snippet", onRunSnippet);
  removeRunListener = () => window.removeEventListener("perch:run-snippet", onRunSnippet);
}

export function deactivate(): void {
  removeStylesheet?.();
  removeStylesheet = null;
  removeContextListener?.();
  removeContextListener = null;
  removeSettingsListener?.();
  removeSettingsListener = null;
  removeRunListener?.();
  removeRunListener = null;
  serverFetch = null;
  extSettings = null;
  refreshSwitcher = null;
  activeContext = NO_CONTEXT;
}
