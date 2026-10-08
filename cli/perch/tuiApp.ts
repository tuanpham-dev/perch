// `perch tui`'s list: projects and their terminals from one Perch server,
// with the keys to attach, add, rename, kill, open and pin. The whole frame
// is redrawn on every change (it is a few KB at most), line by line from the
// top, so there is no screen state to keep in sync.
import { spawn } from 'node:child_process';
import { runAttach, type AttachEnd } from './tuiAttach.ts';
import { ApiError, tunnelClientId, type DirEntry, type ListeningPort, type PerchClient } from './tuiClient.ts';
import { keyLabel } from './tuiDetach.ts';
import { parseKeys, type Key } from './tuiKeys.ts';
import {
  attachChoice, buildRows, bumpRecent, completePath, completionDir, findRowIndex, fit, openCommand, openMethod, osc52, osc8,
  pickerItems, portUrl, projectName,
  scrollTop, tunnelCommand, wrapWords,
  sessionNameForProject, togglePin, type PickerItem, type Project, type ProjectRow, type Row, type Session,
} from './tuiModel.ts';

const POLL_MS = 2000;
const STATUS_MS = 4000;
const MIN_COLS = 40;
const MIN_ROWS = 10;

const ESC = '\x1b[';
const style = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  inverse: `${ESC}7m`,
  accent: `${ESC}36m`,
};

type Mode =
  | { kind: 'list' }
  | { kind: 'filter' }
  | { kind: 'help' }
  | { kind: 'prompt'; label: string; text: string; submit: (text: string) => Promise<void> }
  | { kind: 'confirm'; question: string; yes: () => Promise<void>; back?: Mode }
  | {
      kind: 'ports';
      /** Sorted by port; undefined until the first answer, null with no Ports extension. */
      ports: ListeningPort[] | null | undefined;
      /** The selected listener's portKey (stable across refreshes), or ''. */
      selected: string;
      top: number;
      reveal: boolean;
      domain: string | null;
      error: string;
      /** Whether this TUI's tunnel (its --client id) is connected, and the ports it has bound. */
      tunnel: boolean;
      forwarded: Set<number>;
    }
  | {
      kind: 'picker';
      text: string;
      recents: Project[];
      /** Index into pickerItems(); -1 is the path field itself. */
      selected: number;
      /** First list row shown, so a long folder list scrolls with the selection. */
      top: number;
      error: string;
      /** The server's listing of the typed path's folder, once it arrives. */
      listing: { dir: string; entries: DirEntry[] } | null;
      /** The folder last asked for, so typing within one folder lists it once. */
      listingFor: string | null;
    };

type Picker = Extract<Mode, { kind: 'picker' }>;
type Ports = Extract<Mode, { kind: 'ports' }>;
// One port can have several listeners (IPv4 and IPv6, say): the selection names one.
const portKey = (p: ListeningPort) => `${p.port} ${p.address}`;

type BoxLine = { text: string; selected?: boolean; dim?: boolean; link?: string };

const HELP_LINES = [
  ['↑ ↓  j k', 'Move'],
  ['← →', 'Collapse / expand a project'],
  ['Enter', 'Attach (starts a pinned project that is not running)'],
  ['n', 'New terminal in the project'],
  ['r', 'Rename the terminal or project session'],
  ['x', 'Kill the terminal or project session'],
  ['o', 'Open a project by path or from recents'],
  ['p', 'Pin / unpin the project'],
  ['t', 'Ports: tunnel command and listening ports'],
  ['/', 'Filter (Esc clears)'],
  ['g G', 'First / last row'],
  ['q  Ctrl-C', 'Quit'],
];

export class TuiApp {
  #client: PerchClient;
  #detachKey: string;
  // The terminal this TUI runs in, when that is a Perch terminal: never
  // attached to (see attachChoice) and labeled in the list.
  #self = process.env.PERCH_WINDOW || undefined;
  #sessions: Session[] = [];
  #projects: Project[] = [];
  #collapsed = new Set<string>();
  #filter = '';
  #rows: Row[] = [];
  #selected = 0;
  #selectedKey: string | undefined;
  #top = 0;
  #mode: Mode = { kind: 'list' };
  #status: { text: string; until: number } | null = null;
  #offline = false;
  #attached = false;
  #refreshing = false;
  #busy = false;
  #poll: NodeJS.Timeout | undefined;
  #statusTimer: NodeJS.Timeout | undefined;
  #portsPoll: NodeJS.Timeout | undefined;
  // This machine's tunnel pairing id, read (or made) on first use of the Ports box.
  #tunnelClient: string | undefined;
  #quit: (() => void) | undefined;

  constructor(client: PerchClient, detachKey: string, initial: { sessions: Session[]; projects: Project[] }) {
    this.#client = client;
    this.#detachKey = detachKey;
    this.#sessions = initial.sessions;
    this.#projects = initial.projects;
    this.#rebuild();
  }

  /** Runs until the user quits. The caller owns raw mode and screen restore. */
  run(): Promise<void> {
    const { stdin, stdout } = process;
    stdout.write(`${ESC}?1049h${ESC}?25l`);
    stdin.on('data', this.#onData);
    stdout.on('resize', this.#onResize);
    this.#poll = setInterval(() => void this.#refresh(), POLL_MS);
    this.#render();
    return new Promise((resolve) => {
      this.#quit = () => {
        clearInterval(this.#poll);
        clearTimeout(this.#statusTimer);
        clearInterval(this.#portsPoll);
        stdin.off('data', this.#onData);
        stdout.off('resize', this.#onResize);
        resolve();
      };
    });
  }

  // ---- data ------------------------------------------------------------------

  #rebuild(): void {
    this.#rows = buildRows(this.#sessions, this.#projects, this.#collapsed, this.#filter);
    this.#selected = findRowIndex(this.#rows, this.#selectedKey, this.#selected);
    this.#selectedKey = this.#rows[this.#selected]?.key;
  }

  async #refresh(): Promise<void> {
    if (this.#attached || this.#refreshing) return;
    this.#refreshing = true;
    try {
      const [sessions, projects] = await Promise.all([this.#client.sessions(), this.#client.projects()]);
      this.#sessions = sessions;
      this.#projects = projects;
      this.#offline = false;
    } catch {
      this.#offline = true;
    } finally {
      this.#refreshing = false;
    }
    if (this.#attached) return;
    this.#rebuild();
    this.#render();
  }

  /** Re-reads projects, applies `change`, and saves just that key. */
  async #updateProjects(change: (p: Project[]) => Project[]): Promise<void> {
    const fresh = await this.#client.projects();
    this.#projects = change(fresh);
    await this.#client.saveProjects(this.#projects);
  }

  #setStatus(text: string): void {
    this.#status = { text, until: Date.now() + STATUS_MS };
    clearTimeout(this.#statusTimer);
    this.#statusTimer = setTimeout(() => this.#render(), STATUS_MS + 50);
  }

  #current(): Row | undefined {
    return this.#rows[this.#selected];
  }

  /** The project a row belongs to: itself, or a terminal's session. */
  #projectOf(row: Row): { name: string; path: string; session?: Session } {
    if (row.kind === 'window') return { name: row.session.name, path: row.session.path, session: row.session };
    return { name: row.name, path: row.path, session: row.session };
  }

  // ---- actions ---------------------------------------------------------------

  /** Runs an action with errors reported in the status line; one at a time. */
  async #act(fn: () => Promise<void>): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await fn();
    } catch (err) {
      this.#setStatus(err instanceof ApiError || err instanceof Error ? err.message : String(err));
    } finally {
      this.#busy = false;
    }
    await this.#refresh();
    this.#render();
  }

  async #attach(target: string, selectKey?: string): Promise<void> {
    if (selectKey) this.#selectedKey = selectKey;
    this.#attached = true;
    process.stdin.off('data', this.#onData);
    let end: AttachEnd;
    try {
      end = await runAttach(this.#client, target, this.#detachKey);
    } finally {
      process.stdout.write(`${ESC}?1049h${ESC}?25l`);
      process.stdin.on('data', this.#onData);
      this.#attached = false;
    }
    if (end === 'closed') this.#setStatus('Terminal closed');
    else if (end === 'lost') this.#setStatus('Connection lost');
    else if (typeof end === 'object') this.#setStatus(`Couldn't attach: ${end.error}`);
    this.#render();
    await this.#refresh();
  }

  /** Starts a session for a project folder, records it as most recent, and returns it. */
  async #startProject(cwd: string): Promise<Session> {
    const name = sessionNameForProject(cwd, this.#sessions.map((s) => s.name));
    const created = await this.#client.createSession(name, cwd);
    await this.#updateProjects((p) => bumpRecent(p, cwd));
    return created;
  }

  #enter(): Promise<void> {
    const row = this.#current();
    if (!row) return Promise.resolve();
    if (row.kind === 'window' || row.session) {
      const choice = attachChoice(row, this.#self);
      if ('refuse' in choice) {
        this.#setStatus(choice.refuse);
        return Promise.resolve();
      }
      return this.#act(() => this.#attach(choice.target));
    }
    // A pinned project that isn't running: start it, then attach.
    return this.#act(async () => {
      const created = await this.#startProject(row.path);
      await this.#attach(created.name, `s:${created.id}`);
    });
  }

  #newTerminal(): Promise<void> {
    const row = this.#current();
    if (!row) return Promise.resolve();
    const project = this.#projectOf(row);
    return this.#act(async () => {
      if (!project.session) {
        const created = await this.#startProject(project.path);
        await this.#attach(created.name, `s:${created.id}`);
        return;
      }
      const index = await this.#client.newWindow(project.session.name, project.path);
      const fresh = (await this.#client.sessions()).find((s) => s.id === project.session!.id);
      const win = fresh?.windows.find((w) => w.index === index);
      if (!win) throw new Error('The new terminal closed before it could be opened');
      await this.#attach(`@${win.id}`, `w:${win.id}`);
    });
  }

  #rename(): void {
    const row = this.#current();
    if (!row) return;
    if (row.kind === 'project' && !row.session) return this.#setStatus(`${row.name} is not running - nothing to rename`);
    const isWin = row.kind === 'window';
    const current = isWin ? row.win.name : row.session!.name;
    this.#mode = {
      kind: 'prompt',
      label: isWin ? `Rename terminal "${current}": ` : `Rename project session "${current}": `,
      text: current,
      submit: async (text) => {
        const name = text.trim();
        if (!name) throw new Error('A name is required');
        if (name === current) return;
        if (isWin) await this.#client.renameWindow(row.session.name, row.win.index, name);
        else await this.#client.renameSession(row.session!.name, name);
        this.#setStatus(`Renamed to ${name}`);
      },
    };
  }

  #kill(): void {
    const row = this.#current();
    if (!row) return;
    if (row.kind === 'project' && !row.session) return this.#setStatus(`${row.name} is not running - nothing to kill`);
    if (row.kind === 'window') {
      const { session, win } = row;
      this.#mode = {
        kind: 'confirm',
        question: `Kill terminal "${win.name}"? [y/N] `,
        yes: async () => {
          await this.#client.killWindow(session.name, win.index);
          this.#setStatus(`Killed ${win.name}`);
        },
      };
      return;
    }
    const session = row.session!;
    const n = session.windows.length;
    this.#mode = {
      kind: 'confirm',
      question: `Kill project session "${session.name}" and its ${n} terminal${n === 1 ? '' : 's'}? [y/N] `,
      yes: async () => {
        await this.#client.killSession(session.name);
        this.#setStatus(`Killed ${session.name}`);
      },
    };
  }

  #pin(): Promise<void> {
    const row = this.#current();
    if (!row) return Promise.resolve();
    const { path } = this.#projectOf(row);
    return this.#act(async () => {
      await this.#updateProjects((p) => togglePin(p, path));
      const pinned = this.#projects.find((p) => p.cwd === path)?.pinned;
      this.#setStatus(`${pinned ? 'Pinned' : 'Unpinned'} ${projectName(path)}`);
    });
  }

  // Opens at once from the projects the last poll brought, so keys typed
  // right after `o` land in the picker; a fresh copy replaces them when it
  // arrives.
  #openPicker(): void {
    const byRecent = (list: Project[]) => [...list].sort((a, b) => b.lastOpened - a.lastOpened);
    const mode: Picker = {
      kind: 'picker', text: '~/', recents: byRecent(this.#projects), selected: -1, top: 0, error: '', listing: null, listingFor: null,
    };
    this.#mode = mode;
    this.#list(mode);
    void this.#client.projects().then(
      (fresh) => {
        mode.recents = byRecent(fresh);
        if (this.#mode === mode) this.#render();
      },
      () => { /* keep the cached list */ },
    );
  }

  /**
   * Lists the folder the typed path points into, once per folder: typing
   * more of a name only narrows what is already listed. A missing folder
   * lists as empty, with the reason shown.
   */
  #list(mode: Picker): void {
    const dir = completionDir(mode.text);
    if (dir === null || dir === mode.listingFor) return;
    mode.listingFor = dir;
    this.#client.listDir(dir).then(
      (listed) => {
        if (mode.listingFor !== dir) return;
        mode.listing = { dir, entries: listed.entries };
        if (this.#mode === mode) this.#render();
      },
      (err: unknown) => {
        if (mode.listingFor !== dir) return;
        mode.listing = { dir, entries: [] };
        mode.error = err instanceof Error ? err.message : String(err);
        if (this.#mode === mode) this.#render();
      },
    );
  }

  /** Sets the path field, resetting the selection and listing its folder. */
  #setPickerText(mode: Picker, text: string): void {
    mode.text = text;
    mode.selected = -1;
    mode.top = 0;
    mode.error = '';
    this.#list(mode);
  }

  #pickerItems(mode: Picker): PickerItem[] {
    return pickerItems(mode.text, mode.recents, mode.listing);
  }

  async #openPath(mode: Picker): Promise<void> {
    const raw = mode.selected >= 0 ? this.#pickerItems(mode)[mode.selected]?.path : mode.text.trim();
    if (!raw) return;
    if (this.#busy) return;
    this.#busy = true;
    try {
      // The server's listing both proves it's a folder and gives back its
      // `~`-shortened form, which is what sessions are matched against.
      const listed = await this.#client.listDir(raw);
      const cwd = listed.path.replace(/(.)\/+$/, '$1');
      this.#mode = { kind: 'list' };
      const live = this.#sessions.find((s) => s.path === cwd);
      if (live) {
        await this.#updateProjects((p) => bumpRecent(p, cwd));
        this.#busy = false;
        await this.#attach(live.name, `s:${live.id}`);
        return;
      }
      const created = await this.#startProject(cwd);
      this.#busy = false;
      await this.#attach(created.name, `s:${created.id}`);
    } catch (err) {
      if (this.#mode.kind === 'picker') this.#mode.error = err instanceof Error ? err.message : String(err);
      else this.#setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      this.#busy = false;
    }
    this.#render();
  }

  /**
   * Tab: into the highlighted folder (or recent project); else into the
   * only folder that matches; else as far as every match agrees.
   */
  #complete(mode: Picker): void {
    if (mode.text === '~') return this.#setPickerText(mode, '~/');
    const items = this.#pickerItems(mode);
    const chosen = items[mode.selected];
    if (chosen) return this.#setPickerText(mode, `${chosen.path}/`);
    const folders = items.filter((i) => i.kind === 'folder');
    if (folders.length === 1) return this.#setPickerText(mode, `${folders[0]!.path}/`);
    if (mode.listing && mode.listing.dir === completionDir(mode.text)) {
      const next = completePath(mode.text, mode.listing.entries);
      if (next !== mode.text) this.#setPickerText(mode, next);
    }
  }

  // ---- the Ports box -------------------------------------------------------

  #openPorts(): void {
    const mode: Ports = {
      kind: 'ports', ports: undefined, selected: '', top: 0, reveal: false, domain: null, error: '', tunnel: false, forwarded: new Set(),
    };
    this.#mode = mode;
    void this.#loadPorts(mode);
    this.#client.proxyDomain().then(
      (domain) => {
        mode.domain = domain;
        if (this.#portsShowing(mode)) this.#render();
      },
      () => { /* the /proxy/ path is the fallback */ },
    );
    clearInterval(this.#portsPoll);
    this.#portsPoll = setInterval(() => {
      if (!this.#portsShowing(mode)) {
        clearInterval(this.#portsPoll);
        return;
      }
      if (!this.#attached) void this.#loadPorts(mode);
    }, POLL_MS);
  }

  /** The box is up: on its own, or behind its kill question. */
  #portsShowing(mode: Ports): boolean {
    const m = this.#mode;
    return m === mode || (m.kind === 'confirm' && m.back === mode);
  }

  async #loadPorts(mode: Ports): Promise<void> {
    // A failed status read means "no tunnel", not an error worth showing.
    const status = this.#client.tunnelStatus(this.#tunnel()).catch(() => ({ connected: false, ports: [] as number[] }));
    try {
      const list = await this.#client.ports();
      const tunnel = await status;
      mode.tunnel = tunnel.connected;
      mode.forwarded = new Set(tunnel.ports);
      mode.ports = list ? [...list].sort((a, b) => a.port - b.port) : null;
      mode.error = '';
      // Stay on the same port; else the first one.
      if (mode.ports && !mode.ports.some((p) => portKey(p) === mode.selected)) mode.selected = mode.ports[0] ? portKey(mode.ports[0]) : '';
    } catch (err) {
      mode.error = err instanceof Error ? err.message : String(err);
    }
    if (this.#portsShowing(mode) && !this.#attached) this.#render();
  }

  #tunnel(): string {
    this.#tunnelClient ??= tunnelClientId();
    return this.#tunnelClient;
  }

  /** The port's link: localhost once this TUI's tunnel has forwarded it, else through Perch. */
  #portLink(mode: Ports, port: number): string {
    return portUrl(port, this.#client.baseUrl, mode.domain, mode.forwarded.has(port));
  }

  #selectedPort(mode: Ports): ListeningPort | undefined {
    return mode.ports?.find((p) => portKey(p) === mode.selected);
  }

  #copy(text: string, what: string): void {
    process.stdout.write(osc52(text));
    this.#setStatus(`${what} sent to clipboard (if your terminal allows it)`);
  }

  #portsKey(mode: Ports, key: Key): void {
    const ch = key.name === 'char' ? key.ch : undefined;
    const list = mode.ports ?? [];
    const at = list.findIndex((p) => portKey(p) === mode.selected);
    const move = (delta: number) => {
      if (list.length === 0) return;
      mode.selected = portKey(list[Math.max(0, Math.min(list.length - 1, (at < 0 ? 0 : at) + delta))]!);
    };
    if (key.name === 'escape' || key.name === 'ctrl-c' || ch === 't') {
      clearInterval(this.#portsPoll);
      this.#mode = { kind: 'list' };
    } else if (key.name === 'up' || ch === 'k') move(-1);
    else if (key.name === 'down' || ch === 'j') move(1);
    else if (key.name === 'pageup') move(-10);
    else if (key.name === 'pagedown') move(10);
    else if (ch === 's' && this.#client.token) mode.reveal = !mode.reveal;
    else if (ch === 'c') this.#copy(tunnelCommand(this.#client.baseUrl, this.#client.token, false, this.#tunnel()), 'Command');
    else if (ch === 'u') {
      const p = this.#selectedPort(mode);
      if (p) this.#copy(this.#portLink(mode, p.port), 'URL');
    } else if (ch === 'o') {
      const p = this.#selectedPort(mode);
      if (p) this.#openInBrowser(mode, this.#portLink(mode, p.port));
    } else if (ch === 'x') this.#killPort(mode);
    else if (key.name === 'enter') this.#goToPort(mode);
  }

  // Opens the URL in a browser you can see: through this TUI's own tunnel
  // when it's connected (the tunnel runs on your machine, so that's your
  // browser, wherever the TUI runs), else this machine's when it has one
  // (see openMethod).
  #openInBrowser(mode: Ports, url: string): void {
    if (mode.tunnel) {
      this.#client.openThroughTunnel(this.#tunnel(), url).then(
        (opened) => {
          if (opened) this.#setStatus('Opened in your browser (through your tunnel)');
          else this.#openHere(url);
          this.#render();
        },
        () => {
          this.#openHere(url);
          this.#render();
        },
      );
      return;
    }
    this.#openHere(url);
  }

  #openHere(url: string): void {
    if (openMethod(process.platform, process.env) === 'none') {
      return this.#setStatus("Can't open a browser from here (no display) - start the tunnel (c) to open links on your machine, or press u");
    }
    const { cmd, args } = openCommand(process.platform, url);
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => {
        this.#setStatus(`Couldn't open a browser (${cmd} not found) - press u to copy the URL`);
        this.#render();
      });
      child.unref();
      this.#setStatus(`Opening ${url}`);
    } catch {
      this.#setStatus(`Couldn't open a browser - press u to copy the URL`);
    }
  }

  #killPort(mode: Ports): void {
    const p = this.#selectedPort(mode);
    if (!p) return;
    if (p.pid === undefined) return this.#setStatus(`Can't kill: no process found for port ${p.port}`);
    this.#mode = {
      kind: 'confirm',
      question: `Kill ${p.process ?? 'the process'} (pid ${p.pid}) on port ${p.port}? [y/N] `,
      back: mode,
      yes: async () => {
        await this.#client.killPort(p.port);
        this.#setStatus(`Stopping ${p.process ?? 'the process'} on port ${p.port}`);
        await this.#loadPorts(mode);
      },
    };
  }

  // Attaches to the terminal running the port's process. The mode stays on
  // this box, so detaching comes back to it.
  #goToPort(mode: Ports): void {
    const p = this.#selectedPort(mode);
    if (!p) return;
    if (p.orphan || !p.session) return this.#setStatus(`Port ${p.port} has no terminal - its process outlived it`);
    if (p.window && p.window === this.#self) {
      return this.#setStatus('That port runs in the terminal perch tui is running in');
    }
    // An older server names only the session: follow its current window.
    const target = p.window ? `@${p.window}` : p.session;
    void this.#act(() => this.#attach(target));
  }

  // ---- input -----------------------------------------------------------------

  #onResize = () => {
    if (!this.#attached) this.#render();
  };

  #onData = (chunk: Buffer) => {
    for (const key of parseKeys(chunk)) {
      if (this.#attached) return;
      this.#handleKey(key);
    }
    if (!this.#attached) this.#render();
  };

  #move(delta: number): void {
    if (this.#rows.length === 0) return;
    this.#selected = Math.max(0, Math.min(this.#rows.length - 1, this.#selected + delta));
    this.#selectedKey = this.#rows[this.#selected]?.key;
  }

  #handleKey(key: Key): void {
    const mode = this.#mode;
    if (key.name === 'ctrl-c' && mode.kind === 'list') return this.#quit?.();
    switch (mode.kind) {
      case 'help':
        this.#mode = { kind: 'list' };
        return;
      case 'filter':
        return this.#filterKey(key);
      case 'prompt':
        return this.#promptKey(mode, key);
      case 'confirm':
        this.#mode = mode.back ?? { kind: 'list' };
        if (key.name === 'char' && key.ch?.toLowerCase() === 'y') void this.#act(mode.yes);
        return;
      case 'ports':
        return this.#portsKey(mode, key);
      case 'picker':
        return this.#pickerKey(mode, key);
      case 'list':
        return this.#listKey(key);
    }
  }

  #listKey(key: Key): void {
    const page = Math.max(1, this.#bodyHeight() - 1);
    const ch = key.name === 'char' ? key.ch : undefined;
    if (key.name === 'up' || ch === 'k') return this.#move(-1);
    if (key.name === 'down' || ch === 'j') return this.#move(1);
    if (key.name === 'pageup') return this.#move(-page);
    if (key.name === 'pagedown') return this.#move(page);
    if (key.name === 'home' || ch === 'g') return this.#move(-this.#rows.length);
    if (key.name === 'end' || ch === 'G') return this.#move(this.#rows.length);
    if (key.name === 'left' || key.name === 'right') return this.#toggleCollapse(key.name === 'left');
    if (key.name === 'enter') return void this.#enter();
    if (key.name === 'escape' && this.#filter) {
      this.#filter = '';
      return this.#rebuild();
    }
    switch (ch) {
      case 'q': return this.#quit?.();
      case '?': this.#mode = { kind: 'help' }; return;
      case '/': this.#mode = { kind: 'filter' }; return;
      case 'n': return void this.#newTerminal();
      case 'r': return this.#rename();
      case 'x': return this.#kill();
      case 'p': return void this.#pin();
      case 'o': return this.#openPicker();
      case 't': return this.#openPorts();
    }
  }

  #toggleCollapse(collapse: boolean): void {
    const row = this.#current();
    if (!row) return;
    if (row.kind === 'window') {
      // Left on a terminal jumps to its project row.
      if (collapse) {
        this.#selectedKey = `s:${row.session.id}`;
        this.#rebuild();
      }
      return;
    }
    if (!row.session) return;
    if (collapse) this.#collapsed.add(row.key);
    else this.#collapsed.delete(row.key);
    this.#rebuild();
  }

  #filterKey(key: Key): void {
    if (key.name === 'escape' || key.name === 'ctrl-c') {
      this.#filter = '';
      this.#mode = { kind: 'list' };
    } else if (key.name === 'enter') {
      this.#mode = { kind: 'list' };
    } else if (key.name === 'backspace') {
      this.#filter = Array.from(this.#filter).slice(0, -1).join('');
    } else if (key.name === 'ctrl-u') {
      this.#filter = '';
    } else if (key.name === 'char') {
      this.#filter += key.ch;
    } else if (key.name === 'up' || key.name === 'down') {
      this.#move(key.name === 'up' ? -1 : 1);
      return;
    }
    this.#rebuild();
  }

  #promptKey(mode: Extract<Mode, { kind: 'prompt' }>, key: Key): void {
    if (key.name === 'escape' || key.name === 'ctrl-c') {
      this.#mode = { kind: 'list' };
    } else if (key.name === 'enter') {
      this.#mode = { kind: 'list' };
      void this.#act(() => mode.submit(mode.text));
    } else if (key.name === 'backspace') {
      mode.text = Array.from(mode.text).slice(0, -1).join('');
    } else if (key.name === 'ctrl-u') {
      mode.text = '';
    } else if (key.name === 'char') {
      mode.text += key.ch;
    }
  }

  #pickerKey(mode: Picker, key: Key): void {
    const items = this.#pickerItems(mode);
    if (key.name === 'escape' || key.name === 'ctrl-c') {
      this.#mode = { kind: 'list' };
    } else if (key.name === 'enter') {
      void this.#openPath(mode);
    } else if (key.name === 'tab' || (key.name === 'right' && items[mode.selected])) {
      this.#complete(mode);
    } else if (key.name === 'left' && mode.text.endsWith('/') && mode.text.length > 1) {
      // Back up to the parent folder ("~/works/app/" -> "~/works/").
      this.#setPickerText(mode, mode.text.replace(/[^/]*\/$/, '') || '/');
    } else if (key.name === 'up') {
      mode.selected = Math.max(-1, mode.selected - 1);
    } else if (key.name === 'down') {
      mode.selected = Math.min(items.length - 1, mode.selected + 1);
    } else if (key.name === 'pageup') {
      mode.selected = Math.max(-1, mode.selected - 10);
    } else if (key.name === 'pagedown') {
      mode.selected = Math.min(items.length - 1, mode.selected + 10);
    } else if (key.name === 'backspace') {
      this.#setPickerText(mode, Array.from(mode.text).slice(0, -1).join(''));
    } else if (key.name === 'ctrl-u') {
      this.#setPickerText(mode, '');
    } else if (key.name === 'ctrl-w') {
      this.#setPickerText(mode, mode.text.replace(/[^/]*\/?$/, ''));
    } else if (key.name === 'char') {
      // An absolute path typed over the untouched "~/" starts from "/".
      this.#setPickerText(mode, mode.text === '~/' && key.ch === '/' ? '/' : mode.text + key.ch);
    }
  }

  // ---- rendering ---------------------------------------------------------------

  #bodyHeight(): number {
    return (process.stdout.rows || 24) - 4;
  }

  #render(): void {
    if (this.#attached) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    let out = `${ESC}?25l${ESC}H`;
    const line = (text: string) => {
      out += `${text}${style.reset}${ESC}K\r\n`;
    };
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      out += `${ESC}2J${ESC}H${fit('Terminal too small', cols)}\r\n${fit(`(needs ${MIN_COLS}x${MIN_ROWS})`, cols)}`;
      process.stdout.write(out);
      return;
    }

    const host = ` Perch · ${this.#client.host}`;
    const help = '? help ';
    line(`${style.bold}${style.accent}${fit(host, cols - help.length)}${style.reset}${style.dim}${help}`);
    line(`${style.dim}${'─'.repeat(cols)}`);

    const height = this.#bodyHeight();
    this.#top = scrollTop(this.#top, this.#selected, height, this.#rows.length);
    const body: string[] = [];
    if (this.#rows.length === 0) {
      body.push(`${style.dim}${fit(this.#filter ? '  No matches.' : '  No projects yet. Press o to open a folder.', cols)}`);
    }
    for (let i = this.#top; i < this.#rows.length && body.length < height; i++) {
      body.push(this.#renderRow(this.#rows[i]!, i === this.#selected, cols));
    }
    while (body.length < height) body.push('');
    for (const b of body) line(b);

    line(`${style.dim}${'─'.repeat(cols)}`);
    out += this.#footer(cols);
    out += `${style.reset}${ESC}K`;
    out += this.#overlay(cols, rows);
    process.stdout.write(out);
  }

  #renderRow(row: Row, selected: boolean, cols: number): string {
    const nameW = Math.min(24, Math.max(12, Math.floor(cols * 0.28)));
    if (row.kind === 'project') return this.#renderProject(row, selected, cols, nameW);
    const { win, session } = row;
    const idx = String(win.index).padStart(2);
    const cmdW = Math.min(14, Math.max(6, Math.floor(cols * 0.15)));
    const left = `  ${idx}  ${fit(win.name, nameW - 4)}  ${fit(win.command, cmdW)}  `;
    const self = win.id === this.#self;
    const mark = win.activity && !self ? ' ●' : '  ';
    const cwd = self ? '(this terminal - perch tui runs here)' : win.cwd !== session.path ? win.cwd : '';
    const mid = fit(cwd, cols - Array.from(left).length - mark.length);
    if (selected) return `${style.inverse}${left}${mid}${mark}`;
    return `${left}${style.dim}${mid}${style.reset}${style.accent}${mark}`;
  }

  #renderProject(row: ProjectRow, selected: boolean, cols: number, nameW: number): string {
    const caret = !row.session ? ' ' : row.collapsed ? '▸' : '▾';
    const tags: string[] = [];
    if (!row.session) tags.push('not running');
    else if (row.collapsed) tags.push(`${row.session.windows.length} terminal${row.session.windows.length === 1 ? '' : 's'}`);
    const right = `${tags.length ? `${tags.join(' ')} ` : ''}${row.pinned ? '★' : ' '} `;
    const left = `${caret} ${fit(row.name, nameW)}  `;
    const mid = fit(row.path, cols - Array.from(left).length - Array.from(right).length);
    if (selected) return `${style.inverse}${style.bold}${left}${mid}${right}`;
    if (!row.session) return `${style.dim}${left}${mid}${right}`;
    return `${style.bold}${left}${style.reset}${style.dim}${mid}${style.reset}${style.accent}${right}`;
  }

  #footer(cols: number): string {
    const mode = this.#mode;
    if (mode.kind === 'filter') return fit(`/${this.#filter}▏`, cols);
    if (mode.kind === 'prompt') return fit(`${mode.label}${mode.text}▏`, cols);
    if (mode.kind === 'confirm') return `${style.bold}${fit(mode.question, cols)}`;
    if (this.#status && this.#status.until > Date.now()) return fit(` ${this.#status.text}`, cols);
    if (this.#offline) return `${style.bold}${fit(" Can't reach the server, retrying...", cols)}`;
    const detach = keyLabel(this.#detachKey);
    const filter = this.#filter ? `filter: ${this.#filter} (Esc clears) · ` : '';
    return `${style.dim}${fit(` ${filter}⏎ attach  n new  r rename  x kill  o open  p pin  t ports  / filter  q quit · detach: ${detach} ×2`, cols)}`;
  }

  /**
   * The picker's lines: the path field, a hint or error, then recent
   * projects and the folders under the typed path, each group under a
   * heading. The list scrolls so the selection stays inside the box.
   */
  #pickerLines(mode: Picker, rows: number): BoxLine[] {
    const lines: BoxLine[] = [
      { text: `Path: ${mode.text}▏`, selected: mode.selected === -1 },
      mode.error
        ? { text: `! ${mode.error}` }
        : { text: 'Type to filter · Tab/→ into folder · ← up · ↑↓ pick · Enter opens', dim: true },
      { text: '' },
    ];
    const items = this.#pickerItems(mode);
    const dir = completionDir(mode.text);
    const body: { text: string; selected?: boolean; dim?: boolean; item?: number }[] = [];
    items.forEach((it, i) => {
      if (i === 0 && it.kind === 'recent') body.push({ text: 'Recent projects', dim: true });
      if (it.kind === 'folder' && (i === 0 || items[i - 1]!.kind === 'recent')) {
        body.push({ text: `Folders in ${dir}`, dim: true });
      }
      const text = it.kind === 'recent' ? `${it.pinned ? '★' : ' '} ${projectName(it.path).padEnd(18)} ${it.label}` : `  ${it.label}`;
      body.push({ text, selected: i === mode.selected, item: i });
    });
    if (dir !== null && !items.some((it) => it.kind === 'folder')) {
      const listed = mode.listing !== null && mode.listing.dir === dir;
      body.push({ text: listed ? `No matching folders in ${dir}` : `Listing ${dir}...`, dim: true });
    }
    // Rows inside the box: the screen less its margin, the borders and the fixed lines.
    const room = Math.max(3, rows - 4 - lines.length);
    if (mode.selected === -1) mode.top = 0;
    const at = body.findIndex((b) => b.item === mode.selected);
    if (at >= 0 && at < mode.top) mode.top = Math.max(0, at - 1);
    if (at >= mode.top + room) mode.top = at - room + 1;
    return [...lines, ...body.slice(mode.top, mode.top + room)];
  }

  /**
   * The Ports box: the tunnel command wrapped to the box, then (with the
   * Ports extension) the listening ports, the selected port's URL as a link,
   * and the per-port keys. The table scrolls to keep the selection visible.
   */
  #portsLines(mode: Ports, inner: number, rows: number): BoxLine[] {
    const token = this.#client.token;
    const command = tunnelCommand(this.#client.baseUrl, token, !mode.reveal, this.#tunnel());
    const extension = mode.ports !== null;
    const commandKeys = ['c copy', token ? (mode.reveal ? 's hide token' : 's show token') : '', extension ? '' : 'Esc close']
      .filter(Boolean).join(' · ');
    const lines: BoxLine[] = [
      { text: 'Forward every port to your machine - run this there:' },
      ...wrapWords(command, inner).map((text) => ({ text })),
      { text: commandKeys, dim: true },
    ];
    if (mode.tunnel) {
      const n = mode.forwarded.size;
      lines.push({ text: `Tunnel connected - ${n} port${n === 1 ? '' : 's'} forwarded to localhost on its machine` });
    }
    if (mode.error) lines.push({ text: `! ${mode.error}` });
    const ports = mode.ports;
    if (ports === null) return lines;

    lines.push({ text: '' }, { text: `${'PORT'.padEnd(6)} ${'PROCESS'.padEnd(12)} ${'PROJECT'.padEnd(16)} ADDRESS`, dim: true });
    const tail: BoxLine[] = [{ text: '' }];
    const selected = this.#selectedPort(mode);
    if (selected) {
      const url = this.#portLink(mode, selected.port);
      tail.push({ text: url, link: url });
    }
    tail.push({ text: '⏎ go to terminal · o open · u copy URL · x kill · Esc close', dim: true });

    const body: BoxLine[] = [];
    if (ports === undefined) body.push({ text: 'Loading ports...', dim: true });
    else if (ports.length === 0) body.push({ text: 'No ports listening', dim: true });
    else {
      for (const p of ports) {
        const where = [mode.forwarded.has(p.port) ? 'forwarded' : '', p.orphan || !p.session ? 'no terminal' : ''].filter(Boolean).join(', ');
        body.push({
          text: `${String(p.port).padEnd(6)} ${fit(p.process ?? '', 12)} ${fit(p.session || '-', 16)} ${fit(p.address, 15)} ${where}`,
          selected: portKey(p) === mode.selected,
        });
      }
    }
    // Rows left inside the box: the screen less its margin, the borders and the other lines.
    const room = Math.max(3, rows - 4 - lines.length - tail.length);
    const at = ports?.findIndex((p) => portKey(p) === mode.selected) ?? -1;
    mode.top = at < 0 ? 0 : scrollTop(mode.top, at, room, body.length);
    return [...lines, ...body.slice(mode.top, mode.top + room), ...tail];
  }

  /** A centered box drawn over the list: help, Open project, Ports. */
  #overlay(cols: number, rows: number): string {
    const mode = this.#mode;
    let title: string;
    let lines: BoxLine[];
    let maxWidth = 72;
    // A kill question keeps the Ports box it came from on screen.
    const shown = mode.kind === 'confirm' && mode.back ? mode.back : mode;
    if (shown.kind === 'ports') {
      title = 'Ports';
      maxWidth = 100;
      lines = this.#portsLines(shown, Math.min(cols - 4, maxWidth) - 4, rows);
    } else if (mode.kind === 'help') {
      title = 'Keys';
      lines = HELP_LINES.map(([k, d]) => ({ text: `${k!.padEnd(11)} ${d}` }));
      lines.push({ text: '' }, { text: `Attached: ${keyLabel(this.#detachKey)} twice returns here`, dim: true });
      lines.push({ text: 'Press any key to close', dim: true });
    } else if (mode.kind === 'picker') {
      title = 'Open project';
      lines = this.#pickerLines(mode, rows);
    } else {
      return '';
    }
    const width = Math.min(cols - 4, maxWidth);
    const inner = width - 4;
    const x = Math.floor((cols - width) / 2) + 1;
    const height = Math.min(lines.length + 2, rows - 2);
    let y = Math.max(1, Math.floor((rows - height) / 2) + 1);
    const at = (row: number) => `${ESC}${row};${x}H`;
    const label = ` ${title} `;
    let out = `${at(y++)}${style.reset}┌─${label}${'─'.repeat(Math.max(0, width - 3 - label.length))}┐`;
    for (const l of lines.slice(0, height - 2)) {
      const text = fit(l.text, inner);
      const styled = l.selected ? `${style.inverse}${text}${style.reset}` : l.dim ? `${style.dim}${text}${style.reset}` : text;
      const body = l.link ? osc8(l.link, styled) : styled;
      out += `${at(y++)}│ ${body} │`;
    }
    out += `${at(y)}└${'─'.repeat(width - 2)}┘`;
    return out;
  }
}
