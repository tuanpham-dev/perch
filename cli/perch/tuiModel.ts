// The pure half of `perch tui`: what the server's sessions and the stored
// projects look like as list rows, how the selection survives a refresh, and
// the small string jobs the screen needs. Nothing here touches the terminal
// or the network, so it is tested on its own (tuiModel.test.ts).

/** One terminal, as GET /api/sessions returns it. */
export interface Win {
  id: string;
  index: number;
  name: string;
  active: boolean;
  cwd: string;
  activity: boolean;
  command: string;
}

/** One session, as GET /api/sessions returns it. Paths are `~`-shortened. */
export interface Session {
  id: string;
  name: string;
  path: string;
  windows: Win[];
}

/** A registered folder, as stored under `projects` in the settings doc. */
export interface Project {
  cwd: string;
  pinned: boolean;
  lastOpened: number;
}

export type ProjectRow = {
  kind: 'project';
  key: string;
  name: string;
  path: string;
  pinned: boolean;
  /** The live session, or undefined for a pinned project that isn't running. */
  session?: Session;
  collapsed: boolean;
};

export type WindowRow = {
  kind: 'window';
  key: string;
  session: Session;
  win: Win;
};

export type Row = ProjectRow | WindowRow;

// A project's display name is its folder's basename, never stored - the same
// rule as the web client's lib/projects.ts ("~/works/app" -> "app"; "~" -> "~").
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return base || trimmed || '/';
}

// Session names may not contain "." or ":"; otherwise the basename, suffixed
// -2, -3... when a live session already holds it. Kept identical to the web
// client so a project opened from either place gets the same name.
export function sessionNameForProject(cwd: string, existingSessionNames: Iterable<string>): string {
  const base = projectName(cwd).replace(/[.:]/g, '-');
  const taken = new Set(existingSessionNames);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const RECENTS_CAP = 15;

// Records a project open the way the web client does: upsert keeping the pin,
// stamp lastOpened, and keep at most RECENTS_CAP unpinned entries.
export function bumpRecent(projects: Project[], cwd: string, now = Date.now()): Project[] {
  const existing = projects.find((p) => p.cwd === cwd);
  const next: Project[] = [
    { cwd, pinned: existing?.pinned ?? false, lastOpened: now },
    ...projects.filter((p) => p.cwd !== cwd),
  ];
  let unpinned = 0;
  return next
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .filter((p) => p.pinned || ++unpinned <= RECENTS_CAP);
}

/** Pins or unpins a folder; unpinning keeps it in recents. */
export function togglePin(projects: Project[], cwd: string, now = Date.now()): Project[] {
  const existing = projects.find((p) => p.cwd === cwd);
  if (!existing) return [{ cwd, pinned: true, lastOpened: now }, ...projects];
  return projects.map((p) => (p.cwd === cwd ? { ...p, pinned: !p.pinned } : p));
}

/** Keeps only well-formed entries from whatever the settings doc holds. */
export function sanitizeProjects(raw: unknown): Project[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) =>
    p && typeof p === 'object' && typeof (p as Project).cwd === 'string'
      ? [{ cwd: (p as Project).cwd, pinned: (p as Project).pinned === true, lastOpened: Number((p as Project).lastOpened) || 0 }]
      : [],
  );
}

const matches = (needle: string, ...hay: string[]) => hay.some((h) => h.toLowerCase().includes(needle));

/**
 * The list, top to bottom: every live session in server order with its
 * terminals beneath (unless collapsed), then each pinned project with no live
 * session, by name. A filter keeps a project when it or any of its terminals
 * matches, and shows only the matching terminals unless the project itself
 * matched.
 */
export function buildRows(sessions: Session[], projects: Project[], collapsed: ReadonlySet<string>, filter = ''): Row[] {
  const needle = filter.trim().toLowerCase();
  const pinned = new Set(projects.filter((p) => p.pinned).map((p) => p.cwd));
  const rows: Row[] = [];
  for (const session of sessions) {
    const key = `s:${session.id}`;
    const name = session.name;
    const selfMatch = !needle || matches(needle, name, projectName(session.path), session.path);
    const wins = selfMatch ? session.windows : session.windows.filter((w) => matches(needle, w.name, w.command, w.cwd));
    if (!selfMatch && wins.length === 0) continue;
    // A filter always shows what matched, even inside a collapsed project.
    const isCollapsed = collapsed.has(key) && !needle;
    rows.push({ kind: 'project', key, name, path: session.path, pinned: pinned.has(session.path), session, collapsed: isCollapsed });
    if (!isCollapsed) for (const win of wins) rows.push({ kind: 'window', key: `w:${win.id}`, session, win });
  }
  const live = new Set(sessions.map((s) => s.path));
  const dead = projects
    .filter((p) => p.pinned && !live.has(p.cwd))
    .map((p) => ({ p, name: projectName(p.cwd) }))
    .filter(({ p, name }) => !needle || matches(needle, name, p.cwd))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const { p, name } of dead) {
    rows.push({ kind: 'project', key: `p:${p.cwd}`, name, path: p.cwd, pinned: true, collapsed: false });
  }
  return rows;
}

/** Where the selection lands after a rebuild: the same row, else the nearest. */
export function findRowIndex(rows: Row[], key: string | undefined, fallbackIndex: number): number {
  if (rows.length === 0) return 0;
  if (key !== undefined) {
    const i = rows.findIndex((r) => r.key === key);
    if (i >= 0) return i;
  }
  return Math.max(0, Math.min(fallbackIndex, rows.length - 1));
}

/** First visible row so the selection stays on screen with `height` rows. */
export function scrollTop(current: number, selected: number, height: number, total: number): number {
  if (height <= 0) return 0;
  let top = current;
  if (selected < top) top = selected;
  if (selected >= top + height) top = selected - height + 1;
  return Math.max(0, Math.min(top, Math.max(0, total - height)));
}

/** Exactly `width` columns: truncated with an ellipsis, or padded. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = Array.from(text);
  if (chars.length > width) return chars.slice(0, width - 1).join('') + '…';
  return text + ' '.repeat(width - chars.length);
}

/**
 * Tab completion for a path input: the input with its last segment extended
 * to the longest prefix every matching folder shares, and a trailing "/" when
 * exactly one folder matched. Unchanged input when nothing matches.
 */
export function completePath(input: string, entries: { name: string; dir: boolean }[]): string {
  const slash = input.lastIndexOf('/');
  const head = input.slice(0, slash + 1);
  const partial = input.slice(slash + 1);
  const hits = entries.filter((e) => e.dir && e.name.startsWith(partial)).map((e) => e.name);
  if (hits.length === 0) return input;
  if (hits.length === 1) return `${head}${hits[0]}/`;
  let prefix = hits[0]!;
  for (const h of hits) while (!h.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return head + prefix;
}

/**
 * The folder whose listing completes `input` ("~/wo" -> "~/", "/" -> "/"), or
 * null for input with no folder part yet: a relative path would resolve
 * against the server's own working directory, which means nothing here.
 */
export function completionDir(input: string): string | null {
  const slash = input.lastIndexOf('/');
  if (slash < 0) return null;
  return input.slice(0, slash + 1);
}

export type AttachChoice = { target: string } | { refuse: string };

/**
 * What Enter on a live row attaches to. Never the terminal this TUI runs in
 * (`selfWindowId`, from $PERCH_WINDOW): attached to itself, every frame it
 * draws would come straight back as output and redraw again, forever. A
 * project row normally follows its session's current window; when the TUI's
 * own terminal is in that session, it pins to the current window instead, so
 * a later switch can't carry it into itself.
 */
export function attachChoice(row: Row, selfWindowId: string | undefined): AttachChoice {
  if (row.kind === 'window') {
    if (row.win.id === selfWindowId) return { refuse: 'That is the terminal perch tui is running in - pick another one' };
    return { target: `@${row.win.id}` };
  }
  const session = row.session;
  if (!session) return { refuse: `${row.name} is not running` };
  if (!selfWindowId || !session.windows.some((w) => w.id === selfWindowId)) {
    return { target: session.name };
  }
  const current = session.windows.find((w) => w.active);
  if (!current || current.id === selfWindowId) {
    return { refuse: `${session.name}'s current terminal is the one perch tui is running in - pick another of its terminals` };
  }
  return { target: `@${current.id}` };
}

export interface PickerItem {
  kind: 'recent' | 'folder';
  /** The path to open, as typed into the path field (`~` kept). */
  path: string;
  label: string;
  pinned: boolean;
}

/**
 * The open-project picker's list for what is typed so far: matching recent
 * projects first, then the folders inside the typed path whose names start
 * with its last segment, so you can browse down to a project. Hidden folders
 * show only once the segment starts with a dot. `listing` is the server's
 * listing of the typed path's folder part, or null before it has arrived.
 */
export function pickerItems(
  text: string,
  recents: Project[],
  listing: { dir: string; entries: { name: string; dir: boolean }[] } | null,
  maxRecents = 5,
): PickerItem[] {
  const needle = text.trim().toLowerCase();
  const untouched = needle === '' || needle === '~/';
  const items: PickerItem[] = recents
    .filter((p) => untouched || p.cwd.toLowerCase().includes(needle))
    .slice(0, maxRecents)
    .map((p) => ({ kind: 'recent', path: p.cwd, label: p.cwd, pinned: p.pinned }));
  const dir = completionDir(text);
  if (listing && dir !== null && listing.dir === dir) {
    const partial = text.slice(dir.length).toLowerCase();
    for (const e of listing.entries) {
      if (!e.dir) continue;
      if (e.name.startsWith('.') && !partial.startsWith('.')) continue;
      if (!e.name.toLowerCase().startsWith(partial)) continue;
      items.push({ kind: 'folder', path: `${dir}${e.name}`, label: `${e.name}/`, pinned: false });
    }
  }
  return items;
}

// ---- the Ports box ----------------------------------------------------------

/** Single-quoted for a POSIX shell, inner quotes escaped. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const MASK = '••••';

/**
 * The command that forwards every port listening on the server to the
 * machine it runs on: the tunnel script streamed from the server into node,
 * with the token as a header when the server has one. `mask` hides the
 * token for display; a copy always gets the real one.
 */
export function tunnelCommand(baseUrl: string, token: string, mask: boolean, client = ''): string {
  const url = baseUrl.replace(/\/+$/, '');
  const header = token ? shellQuote(`x-auth-token: ${mask ? MASK : token}`) : '';
  const curl = `curl -s ${header ? `-H ${header} ` : ''}${url}/tunnel.mjs`;
  // --client pairs the tunnel with this TUI, so the server can say which
  // ports it has forwarded (and only to this TUI, like the web panel).
  const node = `node --input-type=module - --url ${url} ${header ? `--header ${header} ` : ''}${client ? `--client ${client} ` : ''}--all`;
  return `${curl} | ${node}`;
}

/**
 * Where a port's app is reachable through the server: its own subdomain when
 * a proxy domain is configured, else the server's /proxy/<port>/ path. The
 * same rule as the web PORTS panel.
 */
export function portUrl(port: number, baseUrl: string, proxyDomain: string | null, forwarded = false): string {
  // Forwarded to this machine by a tunnel: reachable directly, which beats the proxy.
  if (forwarded) return `http://localhost:${port}/`;
  const url = new URL(baseUrl);
  if (proxyDomain) return `${url.protocol}//${port}.${proxyDomain}/`;
  return `${url.origin}/proxy/${port}/`;
}

/** Asks the terminal to put `text` on the clipboard (OSC 52). */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/** `text` as a hyperlink to `url` in terminals that support OSC 8. */
export function osc8(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Wraps at spaces to `width` columns; a word longer than that is split. */
export function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let w = word;
    const candidate = line ? `${line} ${w}` : w;
    if (Array.from(candidate).length <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    while (Array.from(w).length > width) {
      lines.push(Array.from(w).slice(0, width).join(''));
      w = Array.from(w).slice(width).join('');
    }
    line = w;
  }
  if (line) lines.push(line);
  return lines;
}

/** The system command that opens `url` in the default browser. */
export function openCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  // Not `cmd /c start`: cmd would split the URL at every "&".
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { cmd: 'xdg-open', args: [url] };
}

export type OpenMethod = 'system' | 'none';

/**
 * Whether the TUI can show a URL in a browser the person is looking at.
 * - Inside a Perch terminal: yes, through the system opener, whose xdg-open
 *   there is Perch's stand-in that hands the URL to the Perch browser tab
 *   being typed into.
 * - On a desktop (macOS, Windows, a Linux display) and not over SSH: yes.
 * - Otherwise (over SSH, in code-server's terminal) no browser on this
 *   machine is the one in front of you. Perch's bridge to its browser tabs
 *   doesn't help either: a tab acts only while focused, and it isn't while
 *   you type here.
 */
export function openMethod(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): OpenMethod {
  if (env.PERCH_WINDOW) return 'system';
  const overSsh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  const display = platform === 'darwin' || platform === 'win32' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  return display && !overSsh ? 'system' : 'none';
}

