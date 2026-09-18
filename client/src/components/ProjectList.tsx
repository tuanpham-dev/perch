import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getContextGetter } from "../contextKeys";
import { getWindowDecorations, resolveWindowActionIcon, useExtensionRegistryVersion } from "../extensions";
import type { RegisteredWindowAction } from "../extensions";
import { useDismissOnOutsidePress } from "../hooks/useDismissOnOutsidePress";
import { useGitRootDirs } from "../hooks/useGitRootDir";
import { useListNavigation } from "../hooks/useListNavigation";
import { useLongPressMenu } from "../hooks/useLongPressMenu";
import { bindingMatches, recorderState, serializeEvent, type Keybinding } from "../keybindings";
import { projectTree, sessionNameForBranch, type ProjectNode, type WorktreeNode } from "../lib/projects";
import type { MenuItem, Project, RepoInfo, TerminalSession, TerminalWindow, WorktreeBranch } from "../types";
import Icon from "./Icon";

export interface ProjectListHandle {
  // Moves keyboard focus onto the focused-or-first row — called by
  // projects.focus (see extensions.ts's projectsFocusBridge) after the
  // caller has ensured the sidebar is visible, the Explorer tab is active,
  // and the PROJECTS panel isn't collapsed.
  focusList: () => void;
}

export interface ProjectListProps {
  sessions: TerminalSession[];
  activeSessionName: string | null;
  activeWindow: { sessionName: string; index: number } | null;
  projects: Project[];
  // Which repository each session folder belongs to, and that repository's
  // worktrees — the tree's middle level. An empty map renders the flat
  // two-level tree, which is also what a folder outside any repository gets.
  repoIndex: Map<string, RepoInfo>;
  onOpenAllWindows: (session: string) => void;
  onOpenWindow: (session: string, index: number) => void;
  onKillWindow: (session: string, index: number) => void;
  onKillSession: (name: string) => void;
  onRenameWindow: (session: string, win: TerminalWindow) => void;
  onTogglePinSession: (name: string) => void;
  onNewWindowInSession: (session: string) => void;
  // Opens the session rooted in this folder — see useSessionActions'
  // openProject. It focuses the project's most-recent terminal.
  onOpenProject: (cwd: string) => void;
  // A worktree row's click: focus its most-recent terminal, or start a
  // session in it named after its branch when it has none.
  onOpenWorktree: (node: WorktreeNode) => void;
  onNewTerminalInProject: (node: ProjectNode) => void;
  onNewTerminalInWorktree: (node: WorktreeNode) => void;
  // Creates a worktree in this project's repository and opens a session in
  // it. Resolves when the checkout exists; the row appears on the tree's
  // next poll.
  onCreateWorktree: (opts: {
    cwd: string;
    branch: string;
    base?: string;
    mode: "new" | "existing";
    sessionName?: string;
    runCommand?: string;
  }) => Promise<void>;
  // Clean Up Worktrees for a repository project: removes its worktrees that
  // are safe to lose, after a confirmation (useSessionActions').
  onCleanUpWorktrees: (node: ProjectNode) => Promise<void>;
  // The repository's local branches, fetched when the create form opens —
  // they aren't part of the tree's poll.
  loadBranches: (cwd: string) => Promise<WorktreeBranch[]>;
  // Commands the create form offers to run in the new session (the
  // The agents offered by the New Worktree form's picker, from the one
  // registry (see App.tsx). Each `command` already carries the app's
  // Yolo/Manual choice, so the form launches it as given and asks nothing.
  worktreeAgents: { name: string; command: string }[];
  // Settings → AI Providers' Yolo/Manual choice, as the checkbox's starting
  // position. The form can override it for one launch.
  onShowMenu: (x: number, y: number, items: MenuItem[]) => void;
  projectMenuItems: (node: ProjectNode) => MenuItem[];
  worktreeMenuItems: (node: WorktreeNode) => MenuItem[];
  windowMenuItems: (session: string, win: TerminalWindow) => MenuItem[];
  extensionWindowActions: RegisteredWindowAction[];
  resolvedBindings: Record<string, Keybinding[]>;
  // Lets the host drive this tree's worktree actions from outside (the
  // worktrees extension's palette commands): open the create form, or clean
  // up a repository's worktrees. Only the sidebar's instance registers one —
  // the status bar's popover copy stays a viewer.
  registerWorktreeBridge?: (bridge: WorktreeBridgeHandlers | null) => void;
}

export interface WorktreeBridgeHandlers {
  open: (runCommandIndex?: number) => void;
  cleanUp: () => void;
}

// A single flattened, keyboard-navigable row. Project rows hold either their
// own terminals (a plain folder, or a repository with one worktree) or a
// worktree level; worktree rows hold terminals. `parentId` backs ArrowLeft
// (jump to the row above in the tree), which useListNavigation's generic
// onCollapse can't derive on its own since it has no notion of depth —
// which is also why every non-root row carries one.
type Row =
  | { kind: "project"; id: string; node: ProjectNode; parentId: null; depth: 0 }
  | { kind: "worktree"; id: string; node: WorktreeNode; parentId: string; depth: 1 }
  | {
      kind: "window";
      id: string;
      session: TerminalSession;
      window: TerminalWindow;
      parentId: string;
      // 0 directly under a project (today's position), 1 under a worktree.
      depth: 0 | 1;
    };

// The create-worktree popover's offset from its anchor, and the margin it
// keeps from the viewport edge — the same two numbers ContextMenu uses.
const POPOVER_GAP = 4;
const POPOVER_EDGE = 4;

const windowRowId = (sessionName: string, index: number) => `window:${sessionName}:${index}`;
// Keyed by repo root for repository projects and by folder for plain ones
// (both stable across session renames), by session name for pathless
// sessions — a path always starts with "/" or "~", so the two namespaces
// can't collide.
const projectRowId = (node: ProjectNode) => `project:${node.key}`;
const worktreeRowId = (node: WorktreeNode) => `worktree:${node.key}`;


const ProjectList = forwardRef<ProjectListHandle, ProjectListProps>(function ProjectList(
  {
    sessions,
    activeSessionName,
    activeWindow,
    projects,
    repoIndex,
    onOpenAllWindows,
    onOpenWindow,
    onKillWindow,
    onKillSession,
    onRenameWindow,
    onTogglePinSession,
    onNewWindowInSession,
    onOpenProject,
    onOpenWorktree,
    onNewTerminalInProject,
    onNewTerminalInWorktree,
    onCreateWorktree,
    onCleanUpWorktrees,
    loadBranches,
    worktreeAgents,
    onShowMenu,
    projectMenuItems,
    worktreeMenuItems,
    windowMenuItems,
    extensionWindowActions,
    resolvedBindings,
    registerWorktreeBridge,
  },
  ref,
) {
  // Ephemeral, and shared by both collapsible kinds — project rows and
  // worktree rows are both just ids in here.
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set());
  // The open create-worktree popover: which project it is for, and the
  // viewport rect of the control it was opened from, which it anchors to.
  // One at a time — opening another closes the first.
  const [formFor, setFormFor] = useState<{ key: string; anchor: DOMRect } | null>(null);
  const [form, setForm] = useState({
    mode: "new" as "new" | "existing",
    branch: "",
    base: "",
    sessionName: "",
    run: "",
  });
  const [formBranches, setFormBranches] = useState<WorktreeBranch[]>([]);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // Until the user edits the session name it tracks the branch, so the
  // common case needs no second edit.
  const sessionEditedRef = useRef(false);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Touch/pen long-press → the same context menu right-click opens.
  const bindMenu = useLongPressMenu();
  // Re-render when a session-decoration provider registers or refresh()es —
  // getWindowDecorations below reads the registry imperatively per row.
  useExtensionRegistryVersion();

  const toggleCollapsed = (key: string) => {
    setCollapsedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const nodes = useMemo(
    () => projectTree(sessions, projects, repoIndex),
    [sessions, projects, repoIndex],
  );

  // `anchor` is the viewport rect the popover hangs off — the row's own "+"
  // button for a menu pick. The palette command has no pointer to anchor to,
  // so it passes none and falls back to the project row itself.
  const openCreateForm = useCallback(
    (node: ProjectNode, anchor?: DOMRect) => {
      if (!node.cwd) return;
      const fallback = () =>
        containerRef.current
          ?.querySelector(`[data-row-id="${CSS.escape(projectRowId(node))}"]`)
          ?.getBoundingClientRect();
      const rect = anchor ?? fallback();
      if (!rect) return;
      setFormFor({ key: node.key, anchor: rect });
      setForm({
        mode: "new",
        branch: "",
        base: "",
        sessionName: "",
        run: "",
          });
      sessionEditedRef.current = false;
      setFormError(null);
      setFormBranches([]);
      void loadBranches(node.cwd).then(setFormBranches);
      // The input mounts with the form; focus after paint.
      window.setTimeout(() => branchInputRef.current?.focus(), 0);
    },
    [loadBranches],
  );

  const closeCreateForm = useCallback(() => {
    setFormFor(null);
    setFormError(null);
  }, []);

  // A project that stops being a repository (its last worktree removed, or
  // its sessions gone) takes its form with it.
  useEffect(() => {
    if (formFor !== null && !nodes.some((n) => n.key === formFor.key)) setFormFor(null);
  }, [nodes, formFor]);

  // Where the popover actually lands: below its anchor, clamped into the
  // viewport. Measured after layout because the height depends on which
  // fields are showing (the base input only exists in "new branch" mode).
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!formFor || !el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    const anchor = formFor.anchor;
    // Flips above the anchor when there is no room below — the tree's lower
    // rows are exactly where a repo with many terminals puts its "+".
    const below = anchor.bottom + POPOVER_GAP;
    const y =
      below + rect.height > innerHeight - POPOVER_EDGE
        ? Math.max(POPOVER_EDGE, anchor.top - rect.height - POPOVER_GAP)
        : below;
    setPopoverPos({
      x: Math.max(POPOVER_EDGE, Math.min(anchor.left, innerWidth - rect.width - POPOVER_EDGE)),
      y,
    });
  }, [formFor, form.mode, formError, worktreeAgents.length]);

  // Click-outside and Escape close it, the same way every other overlay in
  // the app does — the dismissing press is swallowed rather than passed on
  // to whatever it landed on (see useDismissOnOutsidePress).
  useDismissOnOutsidePress({ ref: popoverRef, onDismiss: closeCreateForm, enabled: !!formFor });

  useEffect(() => {
    if (!formFor) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCreateForm();
    };
    window.addEventListener("keydown", onKeyDown);
    // A scroll or resize moves the anchor out from under it; re-anchoring a
    // form mid-typing would be worse than dismissing, and matches the menu.
    const onReflow = () => closeCreateForm();
    window.addEventListener("resize", onReflow);
    containerRef.current?.addEventListener("scroll", onReflow);
    const list = containerRef.current;
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReflow);
      list?.removeEventListener("scroll", onReflow);
    };
  }, [formFor, closeCreateForm]);

  const submitCreateForm = useCallback(
    async (node: ProjectNode) => {
      const branch = form.branch.trim();
      if (!node.cwd || !branch || formBusy) return;
      setFormBusy(true);
      setFormError(null);
      try {
        await onCreateWorktree({
          cwd: node.cwd,
          branch,
          base: form.mode === "new" ? form.base.trim() || undefined : undefined,
          mode: form.mode,
          sessionName: form.sessionName.trim() || undefined,
          runCommand: form.run
            ? worktreeAgents[Number(form.run)]?.command
            : undefined,
        });
        closeCreateForm();
      } catch (err) {
        setFormError(err instanceof Error ? err.message : String(err));
      } finally {
        setFormBusy(false);
      }
    },
    [form, formBusy, onCreateWorktree, worktreeAgents, closeCreateForm],
  );

  // Terminal rows show each window's cwd collapsed to its git repo root
  // (matching the FILES panel), falling back to the live cwd for windows not
  // inside a repo. rootOf resolves via a shared cache; the actual w.cwd is
  // still what's passed to extension decoration/action contexts below, which
  // must decorate the real path, not the project root.
  const allCwds = useMemo(() => sessions.flatMap((s) => s.windows.map((w) => w.cwd)), [sessions]);
  const { rootOf } = useGitRootDirs(allCwds);

  // The project the active terminal lives in. Its whole block — the project
  // row, its worktrees and every terminal under them — sits on a raised
  // surface, so "where am I" reads as one shape rather than one highlighted
  // row buried among its own children.
  const activeProjectKey = useMemo(() => {
    if (!activeSessionName) return null;
    const owner = nodes.find((n) =>
      [...n.sessions, ...n.worktrees.flatMap((w) => w.sessions)].some((s) => s.name === activeSessionName),
    );
    return owner?.key ?? null;
  }, [nodes, activeSessionName]);

  // Flattened in the exact visual order the tree renders — and the *only*
  // walk: the JSX below maps this array rather than re-deriving the same
  // structure a second time, so the two can't drift out of sync.
  // `blockPos` rides alongside it, marking where each row of the active
  // project's block sits so the surface can round its own ends.
  const { rows, blockPos } = useMemo<{ rows: Row[]; blockPos: Map<string, string> }>(() => {
    const out: Row[] = [];
    const pos = new Map<string, string>();
    const pushWindows = (list: TerminalSession[], parentId: string, depth: 0 | 1) => {
      for (const s of list) {
        for (const w of s.windows) {
          out.push({ kind: "window", id: windowRowId(s.name, w.index), session: s, window: w, parentId, depth });
        }
      }
    };
    for (const node of nodes) {
      const id = projectRowId(node);
      const blockStart = out.length;
      out.push({ kind: "project", id, node, parentId: null, depth: 0 });
      if (collapsedRows.has(id)) {
        if (node.key === activeProjectKey) pos.set(id, "solo");
        continue;
      }
      pushWindows(node.sessions, id, 0);
      for (const wt of node.worktrees) {
        const wtId = worktreeRowId(wt);
        out.push({ kind: "worktree", id: wtId, node: wt, parentId: id, depth: 1 });
        if (collapsedRows.has(wtId)) continue;
        pushWindows(wt.sessions, wtId, 1);
      }
      if (node.key !== activeProjectKey) continue;
      const last = out.length - 1;
      for (let i = blockStart; i <= last; i++) pos.set(out[i].id, "mid");
      pos.set(out[blockStart].id, blockStart === last ? "solo" : "start");
      if (last !== blockStart) pos.set(out[last].id, "end");
    }
    return { rows: out, blockPos: pos };
  }, [nodes, collapsedRows, activeProjectKey]);

  // The bridge below runs outside React's data flow, so it reads the live
  // tree through a ref rather than closing over a render's copy.
  const treeRef = useRef({ nodes, activeSessionName, repoIndex });
  treeRef.current = { nodes, activeSessionName, repoIndex };

  // Stable across renders so the effect below registers once; it reads the
  // latest handler through this ref.
  const cleanUpRef = useRef(onCleanUpWorktrees);
  cleanUpRef.current = onCleanUpWorktrees;

  useEffect(() => {
    if (!registerWorktreeBridge) return;
    // The project you're working in, else the first one that passes.
    const pickTarget = (passes: (n: ProjectNode) => boolean): ProjectNode | undefined => {
      const { nodes: live, activeSessionName: active } = treeRef.current;
      const owns = (n: ProjectNode) =>
        [...n.sessions, ...n.worktrees.flatMap((w) => w.sessions)].some((s) => s.name === active);
      return live.find((n) => passes(n) && owns(n)) ?? live.find((n) => passes(n));
    };
    registerWorktreeBridge({
      open: (runCommandIndex?: number) => {
        const { repoIndex: repos } = treeRef.current;
        // Same test as canCreateWorktree, off the ref: this callback is
        // registered once and would otherwise pin the first render's repoIndex.
        const target = pickTarget((n) => !!n.cwd && (n.worktrees.length > 0 || repos.has(n.cwd)));
        if (!target) return;
        openCreateForm(target);
        if (runCommandIndex !== undefined) {
          setForm((f) => ({ ...f, run: String(runCommandIndex) }));
        }
      },
      cleanUp: () => {
        // Same gate as the row's menu item: a repository with linked worktrees.
        const target = pickTarget((n) => !!n.cwd && n.worktrees.length > 1);
        if (target) void cleanUpRef.current(target);
      },
    });
    return () => registerWorktreeBridge(null);
  }, [registerWorktreeBridge, openCreateForm]);

  const rowsById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  // The project the open popover belongs to. Null once that project is gone,
  // which the effect above turns into a close on the same render.
  const formNode = useMemo(
    () => (formFor ? (nodes.find((n) => n.key === formFor.key) ?? null) : null),
    [nodes, formFor],
  );
  // Which rows have something to collapse — project rows with children, and
  // worktree rows with terminals.
  const isCollapsible = (row: Row): boolean =>
    (row.kind === "project" && (row.node.sessions.length > 0 || row.node.worktrees.length > 0)) ||
    (row.kind === "worktree" && row.node.sessions.length > 0);

  // A project row offers the create form only when it actually has a
  // repository to create in — a plain folder has no worktrees to add to.
  //
  // `node.worktrees` can't answer that on its own: it is only populated once
  // the repository has more than one worktree (see hasWorktreeLevel in
  // lib/projects.ts), so gating on it alone means the very first worktree of
  // a repository can never be created from here. repoIndex is the real
  // answer — it holds every session folder that resolved to a repository —
  // and a single-worktree project's cwd IS its session path, the key it is
  // stored under.
  const canCreateWorktree = (node: ProjectNode) =>
    !!node.cwd && (node.worktrees.length > 0 || repoIndex.has(node.cwd));

  // Set right after useListNavigation below (same render) — lets onCollapse
  // move focus to a row's parent without a circular reference to the hook
  // it's passed into, same ref-indirection useGlobalKeybindings uses for
  // globalCommandsRef.
  const focusRowRef = useRef<(id: string) => void>(() => {});

  const onActivate = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (row.kind === "window") {
        onOpenWindow(row.session.name, row.window.index);
        return;
      }
      if (row.kind === "worktree") {
        onOpenWorktree(row.node);
        return;
      }
      const node = row.node;
      if (node.sessions.length > 0) {
        // Focus the project's most-recent terminal (openProject's live
        // branch) rather than the session's open-every-window; Open All Terminals
        // stays in the context menu.
        if (node.cwd) onOpenProject(node.cwd);
        else onOpenAllWindows(node.sessions[0].name);
        return;
      }
      // A repository row whose terminals all live on worktrees has no
      // terminal of its own, but it is still the project you are asking to
      // switch to: hand off to the checkout that represents it — its main
      // one, or the first worktree that actually has a terminal. Folding is
      // the chevron's job (and ArrowLeft's), never the row's, so a click
      // here always lands on a project.
      const worktree =
        node.worktrees.find((w) => w.worktree.main && w.sessions.length > 0) ??
        node.worktrees.find((w) => w.sessions.length > 0);
      if (worktree) {
        onOpenWorktree(worktree);
        return;
      }
      // Nothing live anywhere under it — a pinned project outliving its
      // sessions. Opening its folder is what "switch to this project" can
      // still mean, and matches the row's own New Terminal fallback.
      if (node.cwd) onOpenProject(node.cwd);
    },
    [rowsById, onOpenProject, onOpenAllWindows, onOpenWindow, onOpenWorktree],
  );

  const onExpand = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (row && isCollapsible(row) && collapsedRows.has(row.id)) toggleCollapsed(row.id);
    },
    [rowsById, collapsedRows],
  );

  const onCollapse = useCallback(
    (id: string) => {
      const row = rowsById.get(id);
      if (!row) return;
      if (isCollapsible(row) && !collapsedRows.has(row.id)) {
        toggleCollapsed(row.id);
      } else if (row.parentId) {
        focusRowRef.current(row.parentId);
      }
    },
    [rowsById, collapsedRows],
  );

  const menuItemsFor = useCallback(
    (row: Row): MenuItem[] =>
      row.kind === "window"
        ? windowMenuItems(row.session.name, row.window)
        : row.kind === "worktree"
          ? worktreeMenuItems(row.node)
          : row.kind === "project"
            ? projectMenuItems(row.node)
            : [],
    [projectMenuItems, worktreeMenuItems, windowMenuItems],
  );

  const onContextMenuKey = useCallback(
    (id: string, rect: DOMRect) => {
      const row = rowsById.get(id);
      if (!row) return;
      onShowMenu(rect.left + 8, rect.bottom, menuItemsFor(row));
    },
    [rowsById, menuItemsFor, onShowMenu],
  );

  const nav = useListNavigation({
    rowIds,
    onActivate,
    onExpand,
    onCollapse,
    onContextMenuKey,
  });
  focusRowRef.current = nav.focusRow;

  useImperativeHandle(
    ref,
    () => ({
      focusList: () => {
        const target = nav.focusedId ?? rowIds[0];
        if (target) nav.focusRow(target);
      },
    }),
    [nav, rowIds],
  );

  // The sessions a row's operation shortcuts act on: its own for a terminal,
  // the node's for a project or worktree row.
  const sessionsOfRow = (row: Row): TerminalSession[] =>
    row.kind === "window" ? [row.session] : row.node.sessions;

  // projects.* operation commands (rebindable) — dispatched here, ahead of
  // the hook's own onKeyDown, exactly the split FileTree.tsx uses for
  // files.*: list-widget keys (arrows/Enter/Space, handled by
  // useListNavigation below) stay hardcoded, operations go through the live
  // resolvedBindings map so a Settings rebind takes effect without a
  // remount.
  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (!recorderState.recording) {
      const combo = serializeEvent(e.nativeEvent);
      if (combo) {
        const get = getContextGetter(e.nativeEvent);
        const matches = (id: string) => bindingMatches(resolvedBindings[id], combo, get);
        const row = nav.focusedId ? rowsById.get(nav.focusedId) : undefined;
        const rowSessions = row ? sessionsOfRow(row) : [];

        if (row && matches("projects.kill")) {
          e.preventDefault();
          if (row.kind === "window") onKillWindow(row.session.name, row.window.index);
          else if (rowSessions[0]) onKillSession(rowSessions[0].name);
          return;
        }
        // Rename applies to terminal rows only — projects and worktrees have
        // no rename (a project's name is its folder's, a worktree's is its
        // branch's; session names are cosmetic).
        if (row && matches("projects.rename")) {
          if (row.kind === "window") {
            e.preventDefault();
            onRenameWindow(row.session.name, row.window);
            return;
          }
        }
        if (row && matches("projects.newWindow")) {
          e.preventDefault();
          if (row.kind === "worktree") onNewTerminalInWorktree(row.node);
          else if (row.kind === "project") onNewTerminalInProject(row.node);
          else if (row.kind === "window") onNewWindowInSession(row.session.name);
          return;
        }
        if (row && matches("projects.togglePin")) {
          if (rowSessions[0]) {
            e.preventDefault();
            onTogglePinSession(rowSessions[0].name);
            return;
          }
        }
      }
    }
    nav.onKeyDown(e);
  };

  const chevron = (key: string) => (
    <span
      className="chevron"
      onClick={(e) => {
        e.stopPropagation();
        toggleCollapsed(key);
      }}
    >
      <Icon name={collapsedRows.has(key) ? "chevron-right" : "chevron-down"} />
    </span>
  );

  // Every row shares this: right-click and long-press open the same menu, and
  // both move the roving focus onto the row first so the keyboard and the
  // pointer agree on what's selected.
  const menuBindings = (row: Row) => ({
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      nav.focusRow(row.id);
      onShowMenu(e.clientX, e.clientY, menuItemsFor(row));
    },
    ...bindMenu((x: number, y: number) => {
      nav.focusRow(row.id);
      onShowMenu(x, y, menuItemsFor(row));
    }),
  });

  const renderProjectRow = (row: Extract<Row, { kind: "project" }>) => {
    const node = row.node;
    const rowProps = nav.getRowProps(row.id);
    const members = [...node.sessions, ...node.worktrees.flatMap((w) => w.sessions)];
    const isActive = activeSessionName !== null && members.some((m) => m.name === activeSessionName);
    const anyAttached = members.some((m) => m.attached > 0);
    const sessionNames = members.map((m) => m.name).join(", ");
    const tooltip = `${node.cwd ?? node.label}${sessionNames ? ` (session: ${sessionNames})` : ""}`;
    return (
      <div className={`session-row${isActive ? " active" : ""}`}>
        <button
          className={`session-item project-item${isActive ? " active" : ""}`}
          title={tooltip}
          onClick={() => onActivate(row.id)}
          {...menuBindings(row)}
          tabIndex={rowProps.tabIndex}
          ref={rowProps.ref}
          onFocus={rowProps.onFocus}
        >
          {chevron(row.id)}
          <span className={`session-dot${anyAttached ? " attached" : ""}`} />
          {node.pinned && <Icon name="pinned" className="pin-indicator" />}
          <span className="session-name">{node.label}</span>
          {node.cwd && <span className="item-cwd">{node.cwd}</span>}
        </button>
        <button
          className="row-add-button"
          title={canCreateWorktree(node) ? "New…" : "New Terminal"}
          tabIndex={-1}
          onClick={(e) => {
            if (!canCreateWorktree(node)) {
              onNewTerminalInProject(node);
              return;
            }
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onShowMenu(rect.left, rect.bottom + 4, [
              { label: "New Terminal", onClick: () => onNewTerminalInProject(node) },
              { label: "New Worktree…", onClick: () => openCreateForm(node, rect) },
            ]);
          }}
        >
          <Icon name="add" />
        </button>
      </div>
    );
  };

  // The create-worktree popover, anchored to whatever opened it. A popover
  // rather than a modal so the tree it is about stays visible while you fill
  // it in, and rather than an inline row so it never pushes the tree around
  // under the pointer.
  const renderCreateForm = (node: ProjectNode) => {
    const attached = new Set(
      formBranches.filter((b) => b.checkedOutAt).map((b) => b.name),
    );
    // git refuses to check one branch out in two worktrees, so existing-branch
    // mode offers only the unattached ones.
    const options = form.mode === "existing" ? formBranches.filter((b) => !attached.has(b.name)) : formBranches;
    return (
      <div
        ref={popoverRef}
        className="worktree-popover"
        role="dialog"
        aria-label="New worktree"
        style={{ left: popoverPos.x, top: popoverPos.y }}
      >
      <form
        className="worktree-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submitCreateForm(node);
        }}
        onKeyDown={(e) => {
          // The tree's own key handling would otherwise steal typing.
          e.stopPropagation();
          if (e.key === "Escape") closeCreateForm();
        }}
      >
        {formError && <div className="worktree-form-error">{formError}</div>}
        <div className="worktree-form-modes">
          <label>
            <input
              type="radio"
              name={`worktree-mode-${node.key}`}
              checked={form.mode === "new"}
              onChange={() => setForm((f) => ({ ...f, mode: "new" }))}
            />
            New branch
          </label>
          <label>
            <input
              type="radio"
              name={`worktree-mode-${node.key}`}
              checked={form.mode === "existing"}
              onChange={() => setForm((f) => ({ ...f, mode: "existing" }))}
            />
            Existing
          </label>
        </div>
        <input
          ref={branchInputRef}
          className="worktree-form-input"
          list={`worktree-branches-${node.key}`}
          placeholder={form.mode === "new" ? "New branch name" : "Branch to check out"}
          value={form.branch}
          onChange={(e) => {
            const branch = e.target.value;
            setForm((f) => ({
              ...f,
              branch,
              sessionName: sessionEditedRef.current ? f.sessionName : sessionNameForBranch(branch),
            }));
          }}
        />
        <datalist id={`worktree-branches-${node.key}`}>
          {options.map((b) => (
            <option key={b.name} value={b.name} />
          ))}
        </datalist>
        {form.mode === "new" && (
          <input
            className="worktree-form-input"
            list={`worktree-bases-${node.key}`}
            placeholder="Base (defaults to current branch)"
            value={form.base}
            onChange={(e) => setForm((f) => ({ ...f, base: e.target.value }))}
          />
        )}
        <datalist id={`worktree-bases-${node.key}`}>
          {formBranches.map((b) => (
            <option key={b.name} value={b.name} />
          ))}
        </datalist>
        <input
          className="worktree-form-input"
          placeholder="Session name"
          value={form.sessionName}
          onChange={(e) => {
            sessionEditedRef.current = true;
            setForm((f) => ({ ...f, sessionName: e.target.value }));
          }}
        />
        {worktreeAgents.length > 0 && (
          <select
            className="worktree-form-input"
            aria-label="Run command"
            value={form.run}
            onChange={(e) => setForm((f) => ({ ...f, run: e.target.value }))}
          >
            <option value="">Run: nothing</option>
            {worktreeAgents.map((preset, i) => (
              <option key={preset.name + i} value={i}>
                Run: {preset.name}
              </option>
            ))}
          </select>
        )}
        <div className="worktree-form-buttons">
          <button type="submit" disabled={!form.branch.trim() || formBusy}>
            Create
          </button>
          <button type="button" onClick={closeCreateForm}>
            Cancel
          </button>
        </div>
      </form>
      </div>
    );
  };

  const renderWorktreeRow = (row: Extract<Row, { kind: "worktree" }>) => {
    const node = row.node;
    const wt = node.worktree;
    const rowProps = nav.getRowProps(row.id);
    const isActive = activeSessionName !== null && node.sessions.some((s) => s.name === activeSessionName);
    const anyAttached = node.sessions.some((s) => s.attached > 0);
    const sessionNames = node.sessions.map((s) => s.name).join(", ");
    return (
      <div className={`session-row${isActive ? " active" : ""}`}>
        <button
          className={`session-item worktree-item${isActive ? " active" : ""}`}
          title={`${wt.path}${sessionNames ? ` (session: ${sessionNames})` : " (no session)"}`}
          onClick={() => onOpenWorktree(node)}
          {...menuBindings(row)}
          tabIndex={rowProps.tabIndex}
          ref={rowProps.ref}
          onFocus={rowProps.onFocus}
        >
          {node.sessions.length > 0 ? chevron(row.id) : <span className="chevron chevron-empty" />}
          <Icon name={wt.main ? "repo" : "git-branch"} className="worktree-icon" />
          {node.pinned && <Icon name="pinned" className="pin-indicator" />}
          <span className={`session-dot${anyAttached ? " attached" : ""}`} />
          <span className="session-name">{node.label}</span>
          {wt.dirty && <span className="worktree-dirty" title="Uncommitted changes" />}
          {wt.prunable && <span className="worktree-tag worktree-tag-warn">missing</span>}
        </button>
        <button
          className="row-add-button"
          title="New Terminal"
          tabIndex={-1}
          onClick={() => onNewTerminalInWorktree(node)}
        >
          <Icon name="add" />
        </button>
      </div>
    );
  };

  const renderWindowRow = (row: Extract<Row, { kind: "window" }>) => {
    const { session: s, window: w } = row;
    const isActive =
      activeWindow !== null
        ? activeWindow.sessionName === s.name && activeWindow.index === w.index
        : w.active;
    const rowProps = nav.getRowProps(row.id);
    const ctx = { sessionName: s.name, windowIndex: w.index, cwd: w.cwd, command: w.command };
    return (
      <div
        role="button"
        className={`window-item${isActive ? " active-window" : ""}`}
        title={`${s.name} · ${w.name} - ${w.cwd}${w.activity ? " (new output)" : ""} (${s.name}:${w.index})`}
        onClick={() => onOpenWindow(s.name, w.index)}
        {...menuBindings(row)}
        tabIndex={rowProps.tabIndex}
        ref={rowProps.ref}
        onFocus={rowProps.onFocus}
      >
        {w.activity && <span className="activity-dot" />}
        <span className="window-label">{w.name}</span>
        <span className="item-cwd">{rootOf(w.cwd)}</span>
        {getWindowDecorations(ctx).map(({ provider, decoration }) => (
          <button
            key={provider.id}
            className={`window-decoration-badge${decoration.className ? ` ${decoration.className}` : ""}`}
            title={decoration.tooltip ?? decoration.badge}
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              provider.onClick?.((e.currentTarget as HTMLElement).getBoundingClientRect(), ctx);
            }}
          >
            {decoration.badge}
          </button>
        ))}
        {extensionWindowActions
          .filter((action) => action.isVisible(ctx))
          .map((action) => (
            <button
              key={action.id}
              className="window-action-button"
              title={action.title}
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                action.onClick(ctx);
              }}
            >
              <Icon name={resolveWindowActionIcon(action, ctx)} />
            </button>
          ))}
        <button
          className="window-kill-button"
          title="Close Terminal"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            onKillWindow(s.name, w.index);
          }}
        >
          <Icon name="trash" />
        </button>
      </div>
    );
  };

  return (
    <div className="session-list" ref={containerRef} onKeyDown={handleKeyDown}>
      <ul className="session-list-ul">
        {rows.map((row) => (
          <li
            key={row.id}
            data-row-id={row.id}
            data-kind={row.kind}
            data-block={blockPos.get(row.id)}
            style={{ "--row-depth": row.depth } as React.CSSProperties}
          >
            {row.kind === "project"
              ? renderProjectRow(row)
              : row.kind === "worktree"
                ? renderWorktreeRow(row)
                : renderWindowRow(row)}
          </li>
        ))}
        {rows.length === 0 && <li className="session-empty">No projects open</li>}
      </ul>
      {formFor && formNode && renderCreateForm(formNode)}
    </div>
  );
});

export default ProjectList;
