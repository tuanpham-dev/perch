// git-scm: a VS Code-style SOURCE CONTROL sidebar panel (stage/unstage/
// discard/commit/push/pull/sync) plus a diff viewer tab. GitPanel takes no
// props (registerSidebarPanel's component signature) and DiffView is reached
// only via ctx.app.openViewerTab (registered with extensions: [] so it's
// never auto-matched to a file) — both read the small set of host hooks
// (serverFetch, active context, settings, openViewerTab/openFileTab/
// refreshFiles) from module-level bridge variables set once in activate(),
// the same pattern live-preview's client.tsx uses for ctx.settings.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import "./style.css";
import { injectStylesheet } from "../../_shared/injectStylesheet";
import Icon from "../../_shared/Icon";
import FileIcon from "../../_shared/FileIcon";
import type { IconResult } from "../../_shared/FileIcon";
import type { MenuItem } from "../../_shared/types";
import { useListNavigation } from "../../_shared/useListNavigation";
import { useLongPressMenu } from "../../_shared/useLongPressMenu";
import { useMarqueeSelection } from "../../_shared/useMarqueeSelection";
import DiffView from "./DiffView";
import { statusForEntry, type GitFileStatus } from "../statusModel.mjs";
import {
  parseConflictSegments,
  buildResolvedContent,
  type ConflictBlock,
  type ResolutionChoice,
  type ResolutionMap,
} from "../conflictModel.mjs";

// ---- Module-level host bridge ----

interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}
export interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
let getActiveContext: (() => ActiveContext) | null = null;
let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
let openDiffInEditor:
  | ((req: {
      title: string;
      original: { content: string; label: string };
      modified: { content: string; label: string; path?: string; readOnlyReason?: string };
    }) => Promise<boolean>)
  | null = null;
let openMergeInEditor:
  | ((req: {
      title: string;
      path: string;
      ours: { content: string; label: string };
      theirs: { content: string; label: string };
      base?: { content: string; label: string } | null;
      markResolved: () => Promise<void>;
    }) => Promise<boolean>)
  | null = null;
let openFileTab: ((path: string) => void) | null = null;
let refreshFiles: (() => void) | null = null;
let setSidebarBadge: ((panelId: string, badge: number | null) => void) | null = null;
let revealSidebarPanel: ((panelId: string) => void) | null = null;
export let extSettings: SettingsApi | null = null;
let getFileIcon: ((fileName: string) => IconResult) | null = null;
let getFolderIcon: ((folderName: string, expanded: boolean) => IconResult) | null = null;
let onDidChangeIconTheme: ((cb: () => void) => () => void) | null = null;
let removeStylesheet: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;
let removeSettingsListener: (() => void) | null = null;

function readPollInterval(): number {
  const raw = Number(extSettings?.get("gitScm.pollInterval"));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(1000, raw);
}

// 0 (the default) disables background fetch entirely — same "0 disables"
// convention as gitScm.pollInterval, but off by default since a network
// call to a remote is a heavier and more surprising default than a local
// status poll.
function readFetchInterval(): number {
  const raw = Number(extSettings?.get("gitScm.fetchInterval"));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(60000, raw);
}

type ClickAction = "diff" | "edit";

function readClickAction(): ClickAction {
  return extSettings?.get("gitScm.clickAction") === "edit" ? "edit" : "diff";
}

// ---- View mode (list vs. tree) ----
// Panel-side toggle, not an extension setting — SettingsApi is read-only
// (get/onDidChange), so this can't be written through ctx.settings. Mirrors
// the host's own Sidebar.tsx sidebarMode localStorage key.
type ViewMode = "list" | "tree";
const VIEW_MODE_KEY = "gitScm.viewMode";

function readViewMode(): ViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === "tree" ? "tree" : "list";
}

function writeViewMode(mode: ViewMode) {
  localStorage.setItem(VIEW_MODE_KEY, mode);
}

// ---- COMMITS ----
// No collapse state here, unlike viewMode above: COMMITS is its own sidebar
// pane now (see activate's second registerSidebarPanel), so the host's
// accordion owns collapsing it, remembers that per user, and lets it be
// dragged out of the Source Control tab entirely.
interface CommitEntry {
  hash: string;
  author: string;
  timestamp: number;
  subject: string;
}

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatRelativeTime(unixSeconds: number): string {
  const diffSeconds = unixSeconds - Math.floor(Date.now() / 1000);
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return relativeTimeFormatter.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return relativeTimeFormatter.format(Math.round(diffSeconds / 60), "minute");
}

// ---- Collapsed directory state (tree mode) ----
// Persisted per repo root + group + dir path so collapse state survives a
// reload without leaking between repos or groups. Pruned lazily on write —
// only keys for the *current* repo root are checked against live dir nodes;
// keys for other repos can't be validated here and are left untouched.
const COLLAPSED_DIRS_KEY = "gitScm.collapsedDirs";

function readCollapsedDirs(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_DIRS_KEY) ?? "[]");
    return Array.isArray(raw) ? new Set(raw.filter((x) => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedDirs(keys: Set<string>) {
  localStorage.setItem(COLLAPSED_DIRS_KEY, JSON.stringify([...keys]));
}

// ---- Status types (mirrors server.js's parseStatus output) ----

type FileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

interface FileEntry {
  path: string;
  origPath?: string;
  status: FileStatus;
}

type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert";

const OPERATION_LABEL: Record<OperationKind, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

interface StatusResponse {
  root: string | null;
  branch?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: FileEntry[];
  unstaged?: FileEntry[];
  conflicted?: FileEntry[];
  operation?: OperationKind | null;
  // .git/MERGE_MSG content while operation is truthy — also written for a
  // conflicted cherry-pick/revert, not just a merge. Used to prefill the
  // commit box once per operation (see GitPanel's prefill effect).
  mergeMsg?: string | null;
  // HEAD's raw commit message (git log -1 --format=%B), null on an unborn
  // branch — prefills the commit box when Amend is toggled on. See the
  // amend-prefill effect below.
  lastCommitMessage?: string | null;
  // Drives the More Actions menu's "Pop Latest Stash" enabled state.
  stashCount?: number;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
};

function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
// Immediate parent directory name only (e.g. "components" for
// "client/src/components/Foo.tsx"), not the full relative path.
function dirOf(p: string): string {
  const slash = p.lastIndexOf("/");
  if (slash === -1) return "";
  const dir = p.slice(0, slash);
  const parentSlash = dir.lastIndexOf("/");
  return parentSlash === -1 ? dir : dir.slice(parentSlash + 1);
}

// ---- Tree view ----

interface TreeDirNode {
  kind: "dir";
  // Full path from the repo root, e.g. "client/src/components" — a single
  // node here can represent several collapsed directory levels (see
  // buildTree's chain compression), so this is NOT always one path segment.
  path: string;
  name: string;
  children: TreeNode[];
}
interface TreeFileNode {
  kind: "file";
  entry: FileEntry;
}
type TreeNode = TreeDirNode | TreeFileNode;

// The three status groups a file row can belong to — shared by the tree
// builder, the selection state (confined to one group at a time, see
// GitPanel), and the context-menu builders.
type GroupKey = "conflicted" | "staged" | "unstaged";

// Converts a group's flat file list into a nested directory tree, matching
// VS Code's SCM tree: directories sort before files, both alphabetically;
// files keep the order the server returned them in (server already applies
// its own porcelain ordering, not re-sorted here). A directory chain with
// only one child at every level (e.g. "client" -> "src" -> "components", each
// having exactly one entry) collapses into a single row labeled
// "client/src/components" rather than three nested rows.
function buildTree(entries: FileEntry[]): TreeNode[] {
  interface MutableDir {
    path: string;
    name: string;
    dirs: Map<string, MutableDir>;
    files: FileEntry[];
  }
  const root: MutableDir = { path: "", name: "", dirs: new Map(), files: [] };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    const fileName = segments.pop()!;
    let cur = root;
    let curPath = "";
    for (const seg of segments) {
      curPath = curPath ? `${curPath}/${seg}` : seg;
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { path: curPath, name: seg, dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(entry);
  }

  function toNodes(dir: MutableDir): TreeNode[] {
    const dirNodes = [...dir.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d): TreeDirNode => {
        // Compress a single-child chain (one subdir, no files) into this
        // node's own label, e.g. "src" swallowing "components" -> "src/components".
        let chain = d;
        let label = d.name;
        while (chain.files.length === 0 && chain.dirs.size === 1) {
          const [only] = chain.dirs.values();
          label = `${label}/${only.name}`;
          chain = only;
        }
        return { kind: "dir", path: chain.path, name: label, children: toNodes(chain) };
      });
    const fileNodes: TreeFileNode[] = dir.files.map((entry) => ({ kind: "file", entry }));
    return [...dirNodes, ...fileNodes];
  }

  return toNodes(root);
}

// Every collapsed-dir key ("${keyPrefix}:${dirPath}") derivable from a
// group's current tree — used both to render DirRow's collapse key and to
// prune stale keys for dirs that no longer exist (see toggleDir).
function collectDirKeys(keyPrefix: string, nodes: TreeNode[], out: Set<string>) {
  for (const node of nodes) {
    if (node.kind === "dir") {
      out.add(`${keyPrefix}:${node.path}`);
      collectDirKeys(keyPrefix, node.children, out);
    }
  }
}

// All FileEntry values under a tree node (recursively) — used to build the
// path arrays for a directory row's aggregate stage/unstage/discard actions.
function collectEntries(nodes: TreeNode[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const node of nodes) {
    if (node.kind === "file") out.push(node.entry);
    else out.push(...collectEntries(node.children));
  }
  return out;
}

// ---- Diff tab composite key ----
// A diff tab's `filePath` (what persists as Tab.extViewerPath) has to carry
// everything DiffView needs to refetch after a reload — cwd, the repo-
// relative path, which side (staged/working), whether it's untracked, and
// a rename's orig path — since a transient in-memory map would be empty
// after a fresh page load. NUL can't appear in any of these fields, so it's
// a safe join separator. This composite string is never shown to the user;
// the tab's visible title is set separately via openViewerTab's `title`.
const KEY_SEP = "\u0000";

// commitHash is a 6th, optional field appended after origPath — set only
// for a COMMITS-row diff (see GitPanel's openCommitDiff), empty/absent for
// every existing staged/working-tree/untracked diff. A key persisted before
// this field existed simply decodes with commitHash undefined (split()
// yields one fewer element than the destructure has names), so old tabs
// restore unchanged.
function encodeDiffKey(
  cwd: string,
  path: string,
  staged: boolean,
  untracked: boolean,
  origPath?: string,
  commitHash?: string,
  // Show the commit against its FIRST parent rather than as a combined
  // diff. Only stash entries ask for this: a stash is a merge commit (work
  // tree + index, sometimes + untracked), and `git show` renders a merge as
  // a "diff --cc" combined diff, which is not what anyone means by "what's
  // in this stash".
  firstParent?: boolean,
): string {
  return [
    cwd,
    path,
    staged ? "1" : "0",
    untracked ? "1" : "0",
    origPath ?? "",
    commitHash ?? "",
    firstParent ? "1" : "",
  ].join(KEY_SEP);
}

export function decodeDiffKey(key: string): {
  cwd: string;
  path: string;
  staged: boolean;
  untracked: boolean;
  origPath?: string;
  commitHash?: string;
  firstParent: boolean;
} {
  const [cwd, path, stagedFlag, untrackedFlag, origPath, commitHash, firstParent] = key.split(KEY_SEP);
  return {
    cwd,
    path,
    staged: stagedFlag === "1",
    untracked: untrackedFlag === "1",
    origPath: origPath || undefined,
    commitHash: commitHash || undefined,
    firstParent: firstParent === "1",
  };
}

// A conflict tab's key only ever needs cwd + path (there's no staged/
// working-tree distinction for an unmerged path — see openEntry) — reusing
// KEY_SEP keeps decode symmetric with encodeDiffKey even though there's
// nothing else to encode.
function encodeConflictKey(cwd: string, path: string): string {
  return [cwd, path].join(KEY_SEP);
}

function decodeConflictKey(key: string): { cwd: string; path: string } {
  const [cwd, path] = key.split(KEY_SEP);
  return { cwd, path };
}

// ---- Shared fetch helpers ----

class ApiError extends Error {
  cancelled?: boolean;
  constructor(message: string, cancelled?: boolean) {
    super(message);
    this.cancelled = cancelled;
  }
}

async function apiPost(path: string, body: unknown): Promise<void> {
  const res = await serverFetch!(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as { error?: string; cancelled?: boolean });
    throw new ApiError(data.error || `${res.status} ${res.statusText}`, data.cancelled);
  }
}

// apiPost for the one route whose reply is the point (/generate-message),
// rather than a bare acknowledgement.
async function apiPostJson<T>(path: string, body: unknown): Promise<T> {
  const res = await serverFetch!(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

export async function apiGetJson<T>(path: string): Promise<T> {
  const res = await serverFetch!(path);
  const data = await res.json().catch(() => ({}) as Record<string, never>);
  if (!res.ok) throw new ApiError((data as { error?: string }).error || `${res.status} ${res.statusText}`);
  return data as T;
}

// ---- Small presentational pieces ----

interface RowAction {
  icon: string;
  title: string;
  onClick: () => void;
}

function FileRow({
  entry,
  group,
  selected,
  onRowClick,
  onRowContextMenu,
  longPress,
  actions,
  clickHint,
  depth,
  hideDir,
  tabIndex,
  rowRef,
  onRowFocus,
}: {
  entry: FileEntry;
  // Which status group this row belongs to — rendered as a data attribute
  // so the marquee-selection hit-test (GitPanel's getRows) can enumerate
  // rows by querying the DOM rather than needing its own row registry (the
  // FILES tree already has one — rowRefs — git-scm doesn't).
  group: GroupKey;
  // Whether this row is part of the panel's active multi-selection — drives
  // the .selected highlight, same convention as FileTree.tsx's file rows.
  selected: boolean;
  // Raw event pass-through — GitPanel's handleRowClick owns the full click
  // precedence (secondary-open, toggle-select, range-select, plain select),
  // same split as FileTree.tsx's handleRowClick.
  onRowClick: (e: ReactMouseEvent) => void;
  onRowContextMenu: (e: ReactMouseEvent) => void;
  // Touch/pen long-press → the same context menu onRowContextMenu opens
  // (useLongPressMenu handlers, spread onto the row div). Optional so a caller
  // that doesn't wire it just gets no long-press.
  longPress?: ReturnType<ReturnType<typeof useLongPressMenu>>;
  actions: RowAction[];
  // Discoverability for the Shift-click escape hatch — there's no visual
  // affordance for it otherwise, so it rides along in the row's own native
  // tooltip. Omitted for conflicted entries, which ignore the click setting.
  clickHint?: string;
  // Tree mode: indent level (each level = one row's worth of chevron+gap)
  // and suppress the parent-dir hint, since the tree's own DirRow ancestry
  // already shows that information.
  depth?: number;
  hideDir?: boolean;
  // Roving-tabindex keyboard nav (GitPanel's resultNav — see
  // useListNavigation) — a plain prop rather than a forwarded React ref
  // since rowRef is a callback consumed directly as this root div's own
  // `ref`, not passed further up.
  tabIndex?: number;
  rowRef?: (el: HTMLElement | null) => void;
  onRowFocus?: () => void;
}) {
  const dir = !hideDir ? dirOf(entry.path) : "";
  const label = entry.origPath ? `${basenameOf(entry.origPath)} → ${basenameOf(entry.path)}` : basenameOf(entry.path);
  const title = clickHint ? `${entry.path}\n${clickHint}` : entry.path;
  // Icon always resolves from the *new* path's basename — same side the
  // rename label's arrow points to.
  const icon = getFileIcon?.(basenameOf(entry.path)) ?? { kind: "none" as const };
  return (
    <div
      className={`git-row${selected ? " selected" : ""}`}
      title={title}
      data-group={group}
      data-path={entry.path}
      onClick={onRowClick}
      onContextMenu={onRowContextMenu}
      {...longPress}
      style={depth ? { paddingLeft: 6 + depth * 14 } : undefined}
      tabIndex={tabIndex}
      ref={rowRef}
      onFocus={onRowFocus}
    >
      {/* Tree mode only (depth is set) — reserves the same width DirRow's
          chevron occupies so file icons line up with folder icons at the
          same depth, matching client/src's .chevron-spacer. */}
      {depth !== undefined && <span className="git-row-chevron-spacer" />}
      <FileIcon className="git-row-icon" result={icon} />
      <span className="git-row-name">{label}</span>
      {dir && <span className="git-row-dir">{dir}</span>}
      <span className="git-row-trailer">
        <span className="git-row-actions" onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <button key={a.title} className="icon-button" title={a.title} tabIndex={-1} onClick={a.onClick}>
              <Icon name={a.icon} />
            </button>
          ))}
        </span>
        <span className={`git-row-status git-status-${entry.status}`}>{STATUS_LABEL[entry.status]}</span>
      </span>
    </div>
  );
}

function DirRow({
  node,
  depth,
  collapsed,
  onToggle,
  actions,
  tabIndex,
  rowRef,
  onRowFocus,
}: {
  node: TreeDirNode;
  depth: number;
  collapsed: boolean;
  onToggle: () => void;
  actions: RowAction[];
  tabIndex?: number;
  rowRef?: (el: HTMLElement | null) => void;
  onRowFocus?: () => void;
}) {
  // A compressed chain's name ("client/src/components") resolves its folder
  // icon from the last segment — icon themes key folderNames on a single
  // directory name, and (matching VS Code) a compressed node's underlying
  // resource is that leaf directory; the joined label is display-only.
  const lastSegment = node.name.slice(node.name.lastIndexOf("/") + 1);
  const icon = getFolderIcon?.(lastSegment, !collapsed) ?? { kind: "none" as const };
  return (
    <div
      className="git-row git-dir-row"
      title={node.path}
      onClick={onToggle}
      style={{ paddingLeft: 6 + depth * 14 }}
      tabIndex={tabIndex}
      ref={rowRef}
      onFocus={onRowFocus}
    >
      <span className="git-row-chevron">
        <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
      </span>
      <FileIcon className="git-row-icon" result={icon} />
      <span className="git-row-name">{node.name}</span>
      <span className="git-row-trailer">
        <span className="git-row-actions" onClick={(e) => e.stopPropagation()}>
          {actions.map((a) => (
            <button key={a.title} className="icon-button" title={a.title} tabIndex={-1} onClick={a.onClick}>
              <Icon name={a.icon} />
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}

function GroupHeader({
  title,
  count,
  actions,
  tabIndex,
  rowRef,
  onRowFocus,
}: {
  title: string;
  count: number;
  actions?: RowAction[];
  // Group headers are keyboard focus stops (unlike a plain list-widget
  // header would default to) — see plans/keyboard-nav-context-menus-
  // sessions-search-git.md's T10 note: this keeps the header's Stage All /
  // Unstage All / Discard All actions Tab-reachable from a focused header.
  tabIndex?: number;
  rowRef?: (el: HTMLElement | null) => void;
  onRowFocus?: () => void;
}) {
  return (
    <div className="git-group-header" tabIndex={tabIndex} ref={rowRef} onFocus={onRowFocus}>
      <span className="git-group-title">{title}</span>
      <span className="git-group-count">{count}</span>
      <span className="git-group-actions">
        {actions?.map((a) => (
          <button key={a.title} className="icon-button" title={a.title} onClick={a.onClick}>
            <Icon name={a.icon} />
          </button>
        ))}
      </span>
    </div>
  );
}

// A COMMITS-section row — deliberately not a FileRow: no data-path (so the
// panel's marquee-selection hit-test, which queries `[data-path]` inside
// `.git-groups`, never picks these up), no group/selection wiring, single
// click only, matching the plan's "keep it out of the marquee/multi-select
// machinery" call.
function CommitRow({ commit, unpushed, onClick }: { commit: CommitEntry; unpushed: boolean; onClick: () => void }) {
  return (
    <div
      className="git-commit-row"
      title={`${commit.author}\n${commit.hash}`}
      onClick={onClick}
    >
      <span className={`git-commit-unpushed-dot${unpushed ? " visible" : ""}`} title="Not pushed yet" />
      <span className="git-commit-subject">{commit.subject}</span>
      <span className="git-commit-time">{formatRelativeTime(commit.timestamp)}</span>
    </div>
  );
}

// ---- Background status polling ----
// Drives the Source Control sidebar badge independent of GitPanel's mount
// state. Sidebar.tsx only mounts GitPanel once the git tab is selected, so
// without this the badge stayed empty until the user opened the tab at
// least once. Started/stopped from activate()/deactivate(); GitPanel
// subscribes to the same status stream instead of fetching its own copy.
let currentStatus: StatusResponse | null = null;
export const statusListeners = new Set<(status: StatusResponse | null) => void>();
const fetchErrorListeners = new Set<(message: string) => void>();
let pollCwd: string | null = null;
let pollTimer: number | null = null;
let lastPollMs = 0;

// How many files a status describes as changed. Distinct paths: a file
// that is both staged and modified again appears in two of the lists and
// is still one change. Behind the sidebar badge and the status-bar item's
// dirty marker, which must never disagree about it.
function changeCount(status: StatusResponse | null): number {
  if (!status?.root) return 0;
  return new Set(
    [...(status.staged ?? []), ...(status.unstaged ?? []), ...(status.conflicted ?? [])].map((e) => e.path),
  ).size;
}

function updateBadge(status: StatusResponse | null) {
  const count = changeCount(status);
  setSidebarBadge?.("git", count > 0 ? count : null);
}

function setSharedStatus(next: StatusResponse | null) {
  currentStatus = next;
  updateBadge(next);
  statusListeners.forEach((cb) => cb(next));
}

async function fetchStatus(cwd: string) {
  try {
    const data = await apiGetJson<StatusResponse>(`/status?cwd=${encodeURIComponent(cwd)}`);
    setSharedStatus(data);
  } catch (err) {
    setSharedStatus(null);
    const message = err instanceof Error ? err.message : String(err);
    fetchErrorListeners.forEach((cb) => cb(message));
  }
}

function refreshStatus() {
  if (pollCwd) fetchStatus(pollCwd);
  // Manual refreshes are exactly the moments (post-op, refresh button)
  // where tree badges must not lag a poll tick behind the panel.
  refreshDecorationsNow();
}

function restartPolling() {
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  lastPollMs = readPollInterval();
  if (!pollCwd) {
    setSharedStatus(null);
    return;
  }
  fetchStatus(pollCwd);
  if (lastPollMs > 0) {
    pollTimer = window.setInterval(() => fetchStatus(pollCwd!), lastPollMs);
  }
}

function setPollCwd(cwd: string | null) {
  if (cwd === pollCwd) return;
  pollCwd = cwd;
  restartPolling();
  restartFetchTimer();
}

// Read the stream above from a component. Three things render off it — the
// panel, the COMMITS pane and the status-bar item — and none of them owns a
// fetch: whichever happen to be mounted all see the one poll started in
// activate(). The mount-time re-read covers the gap between the initial
// state and the subscription.
function useSharedStatus(): StatusResponse | null {
  const [status, setStatus] = useState<StatusResponse | null>(() => currentStatus);
  useEffect(() => {
    setStatus(currentStatus);
    statusListeners.add(setStatus);
    return () => {
      statusListeners.delete(setStatus);
    };
  }, []);
  return status;
}

// ---- COMMITS store ----
// Module-level for the same reason the status poller above is, plus one
// more: COMMITS is now its own sidebar pane, and the host UNMOUNTS a
// collapsed pane outright. Holding the list, the paging limit and the
// in-flight flag out here means collapsing the pane (or switching tabs, or
// dragging it to the other sidebar) doesn't throw away Load More pages the
// user already waited for — and it gives GitPanel's post-mutation refresh a
// way to reach the pane, now that no prop runs between them.
const COMMITS_PAGE = 20;

interface CommitsState {
  commits: CommitEntry[];
  limit: number;
  loading: boolean;
  // The repo the list describes. Switching repos resets the paging limit
  // rather than paging into a fresh history at someone else's offset.
  root: string | null;
}

let commitsState: CommitsState = { commits: [], limit: COMMITS_PAGE, loading: false, root: null };
const commitsListeners = new Set<(state: CommitsState) => void>();

function setCommitsState(next: CommitsState) {
  commitsState = next;
  commitsListeners.forEach((cb) => cb(next));
}

async function fetchCommits(root: string, limit: number) {
  const cwd = pollCwd;
  if (!cwd) return;
  setCommitsState({ ...commitsState, root, limit, loading: true });
  try {
    const data = await apiGetJson<{ commits: CommitEntry[] }>(
      `/log?cwd=${encodeURIComponent(cwd)}&limit=${limit}`,
    );
    // A repo switch mid-flight makes this response the wrong history —
    // drop it and let the switch's own fetch win.
    if (commitsState.root !== root) return;
    setCommitsState({ commits: data.commits, limit, loading: false, root });
  } catch {
    // Best-effort — keep the last-good list; the panel's error banner is
    // reserved for the change-list status fetch.
    if (commitsState.root === root) setCommitsState({ ...commitsState, loading: false });
  }
}

// Called after any mutating operation (commit, pull, discard…). A no-op
// until the pane has fetched once, so a user who never opens COMMITS never
// pays for a `git log` on every stage.
function refreshCommits() {
  if (commitsState.root) fetchCommits(commitsState.root, commitsState.limit);
}

// ---- STASH store ----
// Module-level for the same reason the COMMITS store above is: the host
// unmounts a collapsed pane outright, and the panel's own Stash/Pop actions
// have to reach the list whether or not that pane is expanded.

interface StashEntry {
  // The commit the entry IS — what a row opens as an ordinary diff.
  hash: string;
  // "stash@{0}". Positional: every drop/pop renumbers the entries below it,
  // which is why every mutation here refetches rather than splicing.
  ref: string;
  timestamp: number;
  subject: string;
}

interface StashesState {
  stashes: StashEntry[];
  loading: boolean;
  root: string | null;
}

let stashesState: StashesState = { stashes: [], loading: false, root: null };
const stashesListeners = new Set<(state: StashesState) => void>();

function setStashesState(next: StashesState) {
  stashesState = next;
  stashesListeners.forEach((cb) => cb(next));
}

async function fetchStashes(root: string) {
  setStashesState({ ...stashesState, root, loading: true });
  try {
    const data = await apiGetJson<{ stashes: StashEntry[] }>(
      `/stashes?cwd=${encodeURIComponent(root)}`,
    );
    // A repo switch mid-flight makes this the wrong list — let the switch's
    // own fetch win, exactly as fetchCommits does.
    if (stashesState.root !== root) return;
    setStashesState({ stashes: data.stashes, loading: false, root });
  } catch {
    // Best-effort: keep the last-good list. A failing ACTION reports through
    // the pane's own error banner; a failing refresh is not worth a banner.
    if (stashesState.root === root) setStashesState({ ...stashesState, loading: false });
  }
}

// Called after any mutating operation, like refreshCommits — a stash push
// or pop from the panel's More Actions menu changes this list too. A no-op
// until the pane has fetched once, so a user who never opens STASH never
// pays for a `git stash list`.
function refreshStashes() {
  if (stashesState.root) fetchStashes(stashesState.root);
}

// ---- Background fetch ----
// Off by default (gitScm.fetchInterval: 0 — see readFetchInterval). When
// enabled, silently POSTs /fetch on an interval so ahead/behind counts stay
// live without the user running Pull. Failures are swallowed here — an
// unattended timer must never surface an error or credential prompt for a
// repo whose remote needs auth (the server route itself is already
// non-interactive; see server.js's /fetch comment).
let fetchTimer: number | null = null;
let lastFetchMs = 0;

async function backgroundFetch() {
  if (!pollCwd) return;
  try {
    await apiPost("/fetch", { cwd: pollCwd });
    refreshStatus();
  } catch {
    // Best-effort — see the section comment above.
  }
}

function restartFetchTimer() {
  if (fetchTimer != null) {
    window.clearInterval(fetchTimer);
    fetchTimer = null;
  }
  lastFetchMs = readFetchInterval();
  if (lastFetchMs > 0 && pollCwd) {
    fetchTimer = window.setInterval(backgroundFetch, lastFetchMs);
  }
}

function onSettingsChanged() {
  if (readPollInterval() !== lastPollMs) restartPolling();
  if (readFetchInterval() !== lastFetchMs) restartFetchTimer();
  // The gitScm.fileTreeDecorations toggle applies live: the provider reads
  // it on every provide call, so a bare re-render nudge is enough.
  decorHandle?.refresh();
}

// ---- FILES tree decorations (provider for core's file-decoration point) ----
//
// Ported from core's inline /api/fs enrichment: the server hook's
// /decorations route returns the repo scan for a tree root; each visible
// row resolves against it with statusModel's statusForEntry, exactly the
// logic core api.ts ran per entry. Data is cached per FILES-tree root
// (learned from provideRootDecoration, which the sidebar calls with its
// current root every render) and refreshed on a 3s poll — the same beat
// the tree's own listing poll runs on — plus immediately after this
// panel's own mutating operations (see refreshStatus).

interface DecorRepo {
  root: string;
  branch: string | null;
  statuses: Map<string, GitFileStatus>;
  dirStatuses: Map<string, GitFileStatus>;
  trackedDirs: Set<string>;
}

interface DecorationsResponse {
  root: string | null;
  branch?: string | null;
  statuses?: Record<string, GitFileStatus>;
  dirStatuses?: Record<string, GitFileStatus>;
  trackedDirs?: string[];
}

const DECOR_POLL_MS = 3000;
// A tree root not rendered for this long (tab switched away, session
// closed) drops out of the poll set and cache.
const DECOR_SEEN_TTL_MS = 15_000;

const decorCache = new Map<string, { repo: DecorRepo | null }>();
const decorSeen = new Map<string, number>();
const decorInFlight = new Set<string>();
let decorHandle: { refresh(): void } | null = null;
let decorTimer: number | null = null;

const GIT_BADGE: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
  conflicted: "!",
  ignored: "",
};

function decorationsEnabled(): boolean {
  return extSettings?.get("gitScm.fileTreeDecorations") !== false;
}

async function fetchDecorations(treeRoot: string): Promise<void> {
  if (decorInFlight.has(treeRoot)) return;
  decorInFlight.add(treeRoot);
  try {
    const data = await apiGetJson<DecorationsResponse>(
      `/decorations?cwd=${encodeURIComponent(treeRoot)}`,
    );
    const repo: DecorRepo | null = data.root
      ? {
          root: data.root,
          branch: data.branch ?? null,
          statuses: new Map(Object.entries(data.statuses ?? {})),
          dirStatuses: new Map(Object.entries(data.dirStatuses ?? {})),
          trackedDirs: new Set(data.trackedDirs ?? []),
        }
      : null;
    decorCache.set(treeRoot, { repo });
    decorHandle?.refresh();
  } catch {
    // Best-effort — keep the last answer; the next poll retries.
  } finally {
    decorInFlight.delete(treeRoot);
  }
}

function noteTreeRoot(treeRoot: string): void {
  decorSeen.set(treeRoot, Date.now());
  if (!decorCache.has(treeRoot)) void fetchDecorations(treeRoot);
}

// Immediate refetch of every live root — called after this extension's own
// mutating operations (stage/commit/discard/pull) so tree badges update on
// the next render rather than the next poll tick.
function refreshDecorationsNow(): void {
  for (const root of decorSeen.keys()) void fetchDecorations(root);
}

function decorPollTick(): void {
  const now = Date.now();
  for (const [root, at] of decorSeen) {
    if (now - at > DECOR_SEEN_TTL_MS) {
      decorSeen.delete(root);
      decorCache.delete(root);
    }
  }
  for (const root of decorSeen.keys()) void fetchDecorations(root);
}

function provideDecoration(
  path: string,
  isDir: boolean,
): { badge?: string; tooltip?: string; className?: string } | undefined {
  if (!decorationsEnabled()) return undefined;
  for (const { repo } of decorCache.values()) {
    if (!repo || !(path === repo.root || path.startsWith(`${repo.root}/`))) continue;
    if (path === repo.root) return undefined;
    const rel = path.slice(repo.root.length + 1);
    const status = statusForEntry(repo.statuses, repo.dirStatuses, repo.trackedDirs, rel, isDir);
    if (!status) return undefined;
    return {
      // "ignored" is conveyed by the row-dimming class alone; a badge
      // letter would be noise for something that's neither a change nor
      // actionable.
      badge: GIT_BADGE[status] || undefined,
      tooltip: status,
      className: `git-status-${status}`,
    };
  }
  return undefined;
}

function provideRootDecoration(rootPath: string): { label: string; tooltip?: string } | undefined {
  noteTreeRoot(rootPath);
  const repo = decorCache.get(rootPath)?.repo;
  if (!repo?.branch) return undefined;
  return { label: repo.branch, tooltip: `Branch: ${repo.branch}` };
}

// ---- GitPanel (registerSidebarPanel component — no props) ----

type NetworkKind = "push" | "pull" | "sync";

// Mirrors server.js's pending-prompt shape: kind drives which form variant
// renders, prompt is git/ssh's own text shown verbatim (for hostkey it
// carries the fingerprint the user is confirming).
interface AuthPrompt {
  id: string;
  kind: "username" | "password" | "passphrase" | "hostkey" | "generic";
  prompt: string;
}

// Structurally matches the host's SidebarPanelHostProps (client/src/
// extensions.ts) — a local copy, not an import, per extensions/_shared's
// module comment on why extension code never imports client/src internals.
interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

function GitPanel({ actionsTarget, showMenu }: PanelProps) {
  const [activeCwd, setActiveCwd] = useState<string | null>(() => getActiveContext?.().cwd ?? null);
  // From the module-level poller (started in activate(), kept alive
  // regardless of whether this panel is mounted) rather than a fetch owned
  // by this component — see the "Background status polling" section.
  const status = useSharedStatus();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  // Interactive auth prompt relayed from the server while a network op is
  // in flight (see server.js's askpass relay) — polled below in runNetwork.
  // authSecret doubles as password/passphrase/generic-answer depending on
  // the prompt kind; the id-compare in the poll keeps a rerender from
  // clobbering in-progress typing.
  const [authPrompt, setAuthPrompt] = useState<AuthPrompt | null>(null);
  const [authUsername, setAuthUsername] = useState("");
  const [authSecret, setAuthSecret] = useState("");
  const [authRemember, setAuthRemember] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<{ paths: string[]; untracked: string[] } | null>(null);
  const commitMessageRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grows the commit box with its content up to 300px (VS Code's own
  // commit box behavior) — same measure/clamp-to-scrollHeight approach as
  // csv-preview's formula bar. Runs on every keystroke since a plain CSS
  // height can't track content; resize is disabled below so the two don't
  // fight each other.
  useLayoutEffect(() => {
    const el = commitMessageRef.current;
    if (!el) return;
    el.style.height = "auto";
    const h = Math.min(el.scrollHeight, 300);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight > 300 ? "auto" : "hidden";
  }, [message]);
  const [confirmAbort, setConfirmAbort] = useState(false);
  // AI commit-message generation — its own flag rather than `busy`, which
  // gates the git operations: generating only reads the staged diff, so it
  // must not disable the panel, and the user can keep editing the message or
  // change their mind while it runs.
  const [generating, setGenerating] = useState(false);
  const [clickAction, setClickAction] = useState(readClickAction);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(readCollapsedDirs);
  // Create New Branch… inline form (same "buffer in local state, submit or
  // Escape" convention as the credential form below).
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  // Bumped by onDidChangeIconTheme so FileRow/DirRow re-resolve icons after
  // the active icon theme finishes loading or changes in Settings — the
  // resolved IconResult itself isn't kept in state (getFileIcon/getFolderIcon
  // are called fresh on every render), this just forces that re-render.
  const [, setIconVersion] = useState(0);
  // Multi-selection is confined to one status group at a time (Merge
  // Changes / Staged Changes / Changes) — every bulk action is group-
  // specific, so a cross-group selection has no coherent action. A
  // selection gesture in a different group clears and restarts there (see
  // handleRowClick, below). anchorPath is the Shift+click range pivot,
  // reset whenever the selection changes group or is cleared.
  const [selectedGroup, setSelectedGroup] = useState<GroupKey | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedGroup(null);
    setSelectedPaths(new Set());
    setAnchorPath(null);
  }, []);

  // Rubber-band drag-to-select over ".git-groups" — same gesture as
  // FileTree.tsx, via the shared _shared/useMarqueeSelection copy. Row ids
  // are "<group><KEY_SEP><path>" (decoded below) since selection here is
  // per-group; the marquee constrains to whichever group the *topmost*
  // intersected row belongs to (rows come back from getRows() in DOM
  // order, so decoded[0] is topmost) — an additive (Ctrl/Cmd-held) drag
  // only unions with the pre-drag selection when that selection was
  // already in the same group, otherwise it replaces, consistent with
  // handleRowClick's own single-group rule below.
  const gitGroupsRef = useRef<HTMLDivElement>(null);
  const marqueeSnapshotRef = useRef<{ group: GroupKey | null; paths: Set<string> }>({
    group: null,
    paths: new Set(),
  });
  const { marqueeRect, onMarqueeMouseDown } = useMarqueeSelection({
    containerRef: gitGroupsRef,
    getRows: () => {
      const container = gitGroupsRef.current;
      if (!container) return [];
      return Array.from(container.querySelectorAll<HTMLElement>("[data-path]")).map((el) => ({
        id: `${el.dataset.group}${KEY_SEP}${el.dataset.path}`,
        el,
      }));
    },
    onStart: () => {
      marqueeSnapshotRef.current = { group: selectedGroup, paths: selectedPaths };
    },
    onMarquee: (ids, additive) => {
      const decoded = ids.map((id) => {
        const [group, path] = id.split(KEY_SEP) as [GroupKey, string];
        return { group, path };
      });
      if (decoded.length === 0) {
        if (additive) {
          setSelectedGroup(marqueeSnapshotRef.current.group);
          setSelectedPaths(new Set(marqueeSnapshotRef.current.paths));
        } else {
          setSelectedGroup(null);
          setSelectedPaths(new Set());
        }
        return;
      }
      const topGroup = decoded[0].group;
      const paths = decoded.filter((d) => d.group === topGroup).map((d) => d.path);
      const unionWithSnapshot = additive && marqueeSnapshotRef.current.group === topGroup;
      setSelectedGroup(topGroup);
      setSelectedPaths(unionWithSnapshot ? new Set([...marqueeSnapshotRef.current.paths, ...paths]) : new Set(paths));
    },
    onEnd: (canceled, nearestId) => {
      if (canceled) {
        setSelectedGroup(marqueeSnapshotRef.current.group);
        setSelectedPaths(new Set(marqueeSnapshotRef.current.paths));
        return;
      }
      if (nearestId) {
        const [, path] = nearestId.split(KEY_SEP);
        setAnchorPath(path);
      }
    },
  });

  // onDidChangeContext fires on every sessions poll tick, not just on an
  // actual cwd change — the host derives ActiveContext.windowIndex from a
  // freshly-rebuilt session list each poll, so the callback re-fires with a
  // referentially-new (but value-identical) ctx object even when nothing
  // moved. Tracking the last-seen cwd in a ref (rather than comparing
  // against the `activeCwd` state, which wouldn't yet reflect this same
  // callback's own setActiveCwd call) keeps clearSelection scoped to real
  // directory changes instead of wiping an in-progress selection every ~3s.
  const lastCwdRef = useRef(activeCwd);
  useEffect(() => {
    return onDidChangeContext?.((ctx) => {
      setActiveCwd(ctx.cwd);
      if (ctx.cwd !== lastCwdRef.current) {
        lastCwdRef.current = ctx.cwd;
        clearSelection();
      }
    });
  }, [clearSelection]);
  useEffect(() => extSettings?.onDidChange(() => setClickAction(readClickAction())), []);
  useEffect(() => onDidChangeIconTheme?.(() => setIconVersion((v) => v + 1)), []);
  // Prunes selection entries that no longer exist in their group after a
  // status refresh (staged/committed/discarded out from under the
  // selection elsewhere — another tab, the CLI, a background pull).
  useEffect(() => {
    if (!selectedGroup) return;
    const entries =
      selectedGroup === "conflicted" ? status?.conflicted : selectedGroup === "staged" ? status?.staged : status?.unstaged;
    const validPaths = new Set((entries ?? []).map((e) => e.path));
    setSelectedPaths((prev) => {
      const pruned = new Set([...prev].filter((p) => validPaths.has(p)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [status, selectedGroup]);
  // Escape clears the selection. A window-level listener rather than a
  // focus-dependent one on the row/group elements — file rows aren't
  // otherwise part of a keyboard-navigable tree here (unlike FileTree.tsx),
  // so there's no reliable focus target to hang onKeyDown off of. Scoped to
  // only attach while a selection exists, and doesn't preventDefault/
  // stopPropagation, so it can't interfere with Escape handlers elsewhere
  // (e.g. the credential-prompt form's own Escape-to-cancel).
  useEffect(() => {
    if (selectedPaths.size === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedPaths.size, clearSelection]);

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    writeViewMode(mode);
  };

  // Toggles one dir's collapsed state and persists it, pruning any keys
  // under the current repo root that no longer correspond to a currently
  // rendered dir node (files got staged/unstaged/discarded out from under
  // them) — `validKeysForRepo` is every "${repoRoot}:${group}:${dirPath}"
  // key derivable from the three groups' trees as rendered right now. Keys
  // for other repo roots are left untouched — this repo's tree can't
  // validate them.
  const toggleDir = (key: string, validKeysForRepo: Set<string>, repoRoot: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      const pruned = new Set(
        [...next].filter((k) => !k.startsWith(`${repoRoot}:`) || validKeysForRepo.has(k)),
      );
      writeCollapsedDirs(pruned);
      return pruned;
    });
  };

  // Prefills the commit box from .git/MERGE_MSG once per operation "start"
  // (tracked via the ref, which resets when the operation clears) rather
  // than on every status poll — otherwise it would stomp on whatever the
  // user is typing every few seconds. Only fires into an empty box, so a
  // message the user already started stays untouched. `message` is
  // deliberately left out of the dependency array: this effect should react
  // to the operation changing, not to the user's own typing.
  const prefilledOpRef = useRef<OperationKind | null>(null);
  useEffect(() => {
    const op = status?.operation ?? null;
    if (!op) {
      prefilledOpRef.current = null;
      return;
    }
    if (prefilledOpRef.current === op) return;
    prefilledOpRef.current = op;
    if (!message.trim() && status?.mergeMsg) {
      setMessage(status.mergeMsg.replace(/\n+$/, ""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.operation, status?.mergeMsg]);

  useEffect(() => {
    fetchErrorListeners.add(setError);
    return () => {
      fetchErrorListeners.delete(setError);
    };
  }, []);

  const refresh = useCallback(() => {
    refreshStatus();
  }, []);

  const afterMutate = useCallback(async () => {
    refreshStatus();
    refreshFiles?.();
    // COMMITS lives in its own pane now — this reaches it through the
    // shared store rather than a local fetch, so history stays current
    // whether or not that pane is expanded, or even on this side.
    refreshCommits();
    // Same for STASH: More Actions' Stash/Pop entries change that list.
    refreshStashes();
  }, []);

  const runOp = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await afterMutate();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [afterMutate],
  );

  const stage = (paths: string[]) => runOp(() => apiPost("/stage", { cwd: activeCwd, paths }));
  const unstage = (paths: string[]) => runOp(() => apiPost("/unstage", { cwd: activeCwd, paths }));
  const discard = (paths: string[], untracked: string[]) =>
    runOp(() => apiPost("/discard", { cwd: activeCwd, paths, untracked }));
  const commit = () =>
    runOp(async () => {
      await apiPost("/commit", { cwd: activeCwd, message, amend });
      setMessage("");
      setAmend(false);
    });
  // Fills the commit box from the staged diff using whatever AI is configured
  // in Settings → AI Providers. Deliberately overwrites the box rather than appending —
  // the button is disabled once there's a message, so there is never any
  // typing of the user's to lose.
  const generateMessage = async () => {
    if (!activeCwd || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const data = await apiPostJson<{ message: string }>("/generate-message", { cwd: activeCwd, amend });
      setMessage(data.message);
      commitMessageRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const abortOperation = () => runOp(() => apiPost("/abort", { cwd: activeCwd }));

  // User-initiated fetch (More Actions menu) — same non-interactive /fetch
  // route the background timer uses, but routed through runOp so a failure
  // (e.g. an auth-requiring remote) surfaces in the panel's error banner
  // instead of being swallowed the way the unattended timer's is.
  const manualFetch = () => runOp(() => apiPost("/fetch", { cwd: activeCwd }));

  const checkout = (branch: string, create?: boolean) =>
    runOp(() => apiPost("/checkout", { cwd: activeCwd, branch, create }));

  const submitCreateBranch = () => {
    const name = newBranchName.trim();
    if (!name) return;
    setCreatingBranch(false);
    setNewBranchName("");
    checkout(name, true);
  };
  const cancelCreateBranch = () => {
    setCreatingBranch(false);
    setNewBranchName("");
  };

  // Fetches the branch list fresh on every open (short-lived data, no
  // benefit to caching) and renders it via the host's shared context menu —
  // same popup mechanism the row-level menus use, just anchored to the
  // header button's own rect instead of a click point.
  const openBranchMenu = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (!activeCwd) return;
    const rect = e.currentTarget.getBoundingClientRect();
    try {
      const data = await apiGetJson<{ branches: string[]; current: string | null }>(
        `/branches?cwd=${encodeURIComponent(activeCwd)}`,
      );
      const items: MenuItem[] = data.branches.map((b) => ({
        label: b === data.current ? `✓ ${b}` : b,
        onClick: () => {
          if (b !== data.current) checkout(b);
        },
      }));
      items.push({ label: "Create New Branch…", onClick: () => setCreatingBranch(true) });
      showMenu?.(rect.left, rect.bottom, items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stash = (includeUntracked: boolean) =>
    runOp(() => apiPost("/stash", { cwd: activeCwd, includeUntracked }));
  const stashPop = () => runOp(() => apiPost("/stash-pop", { cwd: activeCwd }));

  // Toggling amend on prefills HEAD's message, but only into an empty box —
  // a draft the user already started is never overwritten. Toggling off
  // leaves whatever text is there untouched (it may still be wanted for an
  // ordinary commit).
  const toggleAmend = () => {
    setAmend((prev) => {
      const next = !prev;
      if (next && !message.trim() && status?.lastCommitMessage) {
        setMessage(status.lastCommitMessage);
      }
      return next;
    });
  };

  const clearAuthForm = useCallback(() => {
    setAuthPrompt(null);
    setAuthUsername("");
    setAuthSecret("");
    setAuthRemember(false);
  }, []);

  const runNetwork = useCallback(
    (kind: NetworkKind) => {
      const opId = crypto.randomUUID();
      opIdRef.current = opId;
      // 300ms keeps a relayed prompt visible ≤ ~350ms after git asks (the
      // plan's stated latency budget); polling only runs while this op's
      // request is in flight.
      const pollTimer = window.setInterval(async () => {
        if (opIdRef.current !== opId) return;
        try {
          const data = await apiGetJson<{ prompt: AuthPrompt | null }>(`/prompt?op=${opId}`);
          if (opIdRef.current !== opId) return;
          setAuthPrompt((cur) => (cur?.id === data.prompt?.id ? cur : data.prompt));
        } catch {
          // Transient poll failure — the op request itself surfaces errors.
        }
      }, 300);
      return runOp(async () => {
        try {
          await apiPost(`/${kind}`, { cwd: activeCwd, opId });
        } catch (err) {
          // The user declining a prompt isn't an error worth displaying.
          if (err instanceof ApiError && err.cancelled) return;
          throw err;
        } finally {
          window.clearInterval(pollTimer);
          if (opIdRef.current === opId) opIdRef.current = null;
          clearAuthForm();
        }
      });
    },
    [activeCwd, runOp, clearAuthForm],
  );

  // Fire-and-forget: the reply's outcome surfaces through the still-open
  // network-op request, not this call.
  const replyPrompt = (body: Record<string, unknown>) => {
    if (!authPrompt || !opIdRef.current) return;
    const payload = { op: opIdRef.current, id: authPrompt.id, ...body };
    clearAuthForm();
    apiPost("/prompt-reply", payload).catch(() => {});
  };

  const submitPrompt = () => {
    if (!authPrompt) return;
    if (authPrompt.kind === "username") {
      replyPrompt({ username: authUsername, password: authSecret, remember: authRemember });
    } else {
      replyPrompt({ answer: authSecret });
    }
  };

  const cancelPrompt = () => replyPrompt({ cancel: true });

  // Explicit, clickAction-independent opens — used directly by the context
  // menu (whose items name the action outright) and composed by openEntry
  // below (whose click-driven default/secondary pair is clickAction-
  // relative). All three no-op without an active directory.
  // Keys and editor opens are joined against status.root (the repo root),
  // not activeCwd (the pane's cwd) — entry.path is always root-relative
  // (server /status resolves it that way), so joining against a pane cwd
  // that's a subdirectory of the repo would double that prefix and 404.
  // This panel's own unified patch view — the fallback when no editor claims
  // the diff capability, and the "Open in Git Diff View" secondary action.
  const openGitDiffView = (entry: FileEntry, staged: boolean) => {
    if (!status?.root) return;
    const untracked = entry.status === "untracked";
    const key = encodeDiffKey(status.root, entry.path, staged, untracked, entry.origPath);
    const title = `${basenameOf(entry.path)} (${staged ? "Staged" : "Working Tree"})`;
    openViewerTab?.("diff", key, { title });
  };

  // The primary action: hand both sides to whichever editor the app's `editor`
  // setting selects (nvim opens `nvim -d`, Monaco a diff editor). Falls back to
  // the view above whenever that can't happen — an older host, no editor with
  // the capability, or a side this route refuses (binary, too large).
  const openDiff = (entry: FileEntry, staged: boolean) => {
    if (!status?.root) return;
    const root = status.root;
    if (!openDiffInEditor) {
      openGitDiffView(entry, staged);
      return;
    }
    const untracked = entry.status === "untracked";
    const title = `${basenameOf(entry.path)} (${staged ? "Staged" : "Working Tree"})`;
    const params = new URLSearchParams({
      cwd: root,
      path: entry.path,
      staged: staged ? "1" : "0",
      untracked: untracked ? "1" : "0",
    });
    if (entry.origPath) params.set("origPath", entry.origPath);
    void apiGetJson<{
      original: { content: string; label: string };
      modified: { content: string; label: string; path?: string; readOnlyReason?: string };
    }>(`/diff-sides?${params}`)
      .then(async (sides) => {
        const handled = await openDiffInEditor!({ title, original: sides.original, modified: sides.modified });
        if (!handled) openGitDiffView(entry, staged);
      })
      .catch(() => openGitDiffView(entry, staged));
  };
  const openInEditor = (entry: FileEntry) => {
    if (!status?.root) return;
    openFileTab?.(`${status.root}/${entry.path}`);
  };
  // This panel's own block-list resolver — the fallback when no editor claims
  // the merge capability, and the "Resolve in Git Merge View" secondary action.
  const openGitMergeView = (entry: FileEntry) => {
    if (!status?.root) return;
    const key = encodeConflictKey(status.root, entry.path);
    openViewerTab?.("conflict", key, { title: `${basenameOf(entry.path)} (Merge)` });
  };

  // The primary action: hand the conflicted file to whichever editor the app's
  // `editor` setting selects. Monaco opens it with inline blocks and per-block
  // accept actions; nvim opens git mergetool's three-window layout. Falls back
  // to the view above on an older host, a refused file (binary, too large), or
  // no editor with the capability.
  const openConflictResolver = (entry: FileEntry) => {
    if (!status?.root) return;
    const root = status.root;
    if (!openMergeInEditor) {
      openGitMergeView(entry);
      return;
    }
    const params = new URLSearchParams({ cwd: root, path: entry.path });
    void apiGetJson<{
      base: { content: string; label: string } | null;
      ours: { content: string; label: string };
      theirs: { content: string; label: string };
    }>(`/conflict-stages?${params}`)
      .then(async (stages) => {
        const handled = await openMergeInEditor!({
          title: `${basenameOf(entry.path)} (Merge)`,
          path: `${root}/${entry.path}`,
          ours: stages.ours,
          theirs: stages.theirs,
          base: stages.base,
          // What "Mark as Resolved" does — the same staging the panel's own
          // resolver performs when its file is fully decided.
          markResolved: async () => {
            await stage([entry.path]);
          },
        });
        if (!handled) openGitMergeView(entry);
      })
      .catch(() => openGitMergeView(entry));
  };

  // Shift+click always opens the OTHER action from gitScm.clickAction's
  // configured default — same escape-hatch convention the host uses for
  // preview vs. edit (QuickSwitcher's Shift+Enter/Shift+click, FileTree's
  // hover icon). Conflicted entries are the one exception: there's no diff
  // to show (both sides are live conflict markers in the working tree, not
  // two commits to compare), so a click opens the ConflictView resolver
  // instead, ignoring gitScm.clickAction — Shift+click is still the escape
  // hatch straight to nvim, same as every other row.
  const openEntry = (entry: FileEntry, staged: boolean, secondary: boolean) => {
    if (entry.status === "conflicted") {
      if (secondary) openInEditor(entry);
      else openConflictResolver(entry);
      return;
    }
    const wantsEdit = secondary ? clickAction !== "edit" : clickAction === "edit";
    if (wantsEdit) openInEditor(entry);
    else openDiff(entry, staged);
  };

  // ---- Multi-selection (Ctrl/Cmd+click toggle, Shift+click range/quick-
  // action, Ctrl+Shift+click secondary escape hatch — same precedence as
  // FileTree.tsx's handleRowClick) ----

  // Every file entry in a group, in the order it's actually rendered right
  // now — list mode is just that group's flat array; tree mode walks the
  // tree depth-first, skipping collapsed dirs, since a row hidden by
  // collapse isn't a valid range-select endpoint. Used both for Shift+click
  // range math and for resolving a bulk selection's entries.
  const visibleFileEntries = (groupKey: GroupKey): FileEntry[] => {
    if (viewMode === "list") {
      return groupKey === "conflicted" ? conflicted : groupKey === "staged" ? staged : unstaged;
    }
    const tree = groupKey === "conflicted" ? conflictedTree : groupKey === "staged" ? stagedTree : unstagedTree;
    const keyPrefix = `${repoRoot}:${groupKey}`;
    const out: FileEntry[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "dir") {
          if (!collapsedDirs.has(`${keyPrefix}:${node.path}`)) walk(node.children);
        } else {
          out.push(node.entry);
        }
      }
    };
    walk(tree);
    return out;
  };

  const selectRange = (groupKey: GroupKey, fromPath: string, toPath: string) => {
    const entries = visibleFileEntries(groupKey);
    const lo = entries.findIndex((e) => e.path === fromPath);
    const hi = entries.findIndex((e) => e.path === toPath);
    setSelectedGroup(groupKey);
    if (lo === -1 || hi === -1) {
      // Anchor fell out of the visible set (pruned by a status change, or
      // collapsed behind a dir) — fall back to selecting just the clicked row.
      setSelectedPaths(new Set([toPath]));
      return;
    }
    const [start, end] = lo <= hi ? [lo, hi] : [hi, lo];
    setSelectedPaths(new Set(entries.slice(start, end + 1).map((e) => e.path)));
  };

  // What a row's hover action (Stage/Unstage/Discard) should apply to: the
  // whole selection when this row is part of one (2+), otherwise just
  // itself — VS Code SCM's "act on the row you clicked, or the selection if
  // it's in one" convention.
  const groupSelectedEntries = (groupKey: GroupKey, entry: FileEntry): FileEntry[] => {
    if (selectedGroup === groupKey && selectedPaths.has(entry.path) && selectedPaths.size > 1) {
      return visibleFileEntries(groupKey).filter((e) => selectedPaths.has(e.path));
    }
    return [entry];
  };

  // What a group header's "All" actions (Stage All / Unstage All / Discard
  // All) apply to: the group's active selection if it has one (any size —
  // even a single selected file scopes the header buttons to just that
  // file), otherwise every entry in the group, unchanged from before multi-
  // select existed.
  const groupTargetEntries = (groupKey: GroupKey, allEntries: FileEntry[]): FileEntry[] =>
    selectedGroup === groupKey && selectedPaths.size > 0
      ? allEntries.filter((e) => selectedPaths.has(e.path))
      : allEntries;

  // Checked in this order: Ctrl/Cmd+Shift+click is the secondary-open
  // escape hatch, collapsing selection to this row first — mirrors
  // FileTree.tsx's handling of the same combo. Then Ctrl/Cmd+click alone
  // toggles the row into the selection (starting fresh if the current
  // selection lives in a different group — selection never spans groups,
  // since every bulk action is group-specific). Then Shift+click: with no
  // selection active in this group it's the ordinary secondary-action click
  // (unchanged from before multi-select existed); with one active it range-
  // selects from the anchor. Otherwise a plain click selects just this row
  // and opens it, same as FileTree.
  const handleRowClick = (groupKey: GroupKey, entry: FileEntry, staged: boolean, e: ReactMouseEvent) => {
    const ctrlOrCmd = e.ctrlKey || e.metaKey;
    const inGroup = selectedGroup === groupKey;
    if (ctrlOrCmd && e.shiftKey) {
      setSelectedGroup(groupKey);
      setSelectedPaths(new Set([entry.path]));
      setAnchorPath(entry.path);
      openEntry(entry, staged, true);
      return;
    }
    if (ctrlOrCmd) {
      if (inGroup) {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
      } else {
        setSelectedGroup(groupKey);
        setSelectedPaths(new Set([entry.path]));
      }
      setAnchorPath(entry.path);
      return;
    }
    if (e.shiftKey) {
      if (!inGroup || selectedPaths.size === 0) {
        openEntry(entry, staged, true);
        return;
      }
      selectRange(groupKey, anchorPath ?? entry.path, entry.path);
      return;
    }
    setSelectedGroup(groupKey);
    setSelectedPaths(new Set([entry.path]));
    setAnchorPath(entry.path);
    openEntry(entry, staged, false);
  };

  const buildFileMenuItems = (groupKey: GroupKey, entry: FileEntry, staged: boolean): MenuItem[] => {
    if (entry.status === "conflicted") {
      return [
        { label: "Resolve in Merge Editor", onClick: () => openConflictResolver(entry) },
        { label: "Resolve in Git Merge View", onClick: () => openGitMergeView(entry) },
        { label: "Open in Editor", onClick: () => openInEditor(entry) },
        { label: "Stage Changes", onClick: () => stage([entry.path]) },
      ];
    }
    const items: MenuItem[] = [
      { label: "Open Diff", onClick: () => openDiff(entry, staged) },
      { label: "Open in Git Diff View", onClick: () => openGitDiffView(entry, staged) },
      { label: "Open in Editor", onClick: () => openInEditor(entry) },
    ];
    if (groupKey === "staged") {
      items.push({ label: "Unstage Changes", onClick: () => unstage([entry.path]) });
    } else {
      items.push({ label: "Stage Changes", onClick: () => stage([entry.path]) });
      items.push({
        label: "Discard Changes",
        danger: true,
        onClick: () =>
          setConfirmDiscard({ paths: [entry.path], untracked: entry.status === "untracked" ? [entry.path] : [] }),
      });
    }
    return items;
  };

  const buildBulkMenuItems = (groupKey: GroupKey, entries: FileEntry[]): MenuItem[] => {
    const n = entries.length;
    const paths = entries.map((e) => e.path);
    if (groupKey === "conflicted") {
      return [{ label: `Stage ${n} Changes`, onClick: () => stage(paths) }];
    }
    if (groupKey === "staged") {
      return [{ label: `Unstage ${n} Changes`, onClick: () => unstage(paths) }];
    }
    const untracked = entries.filter((e) => e.status === "untracked").map((e) => e.path);
    return [
      { label: `Stage ${n} Changes`, onClick: () => stage(paths) },
      { label: `Discard ${n} Changes`, danger: true, onClick: () => setConfirmDiscard({ paths, untracked }) },
    ];
  };

  // Right-clicking a row that's part of a live multi-selection (2+) shows
  // the bulk menu for the whole selection; right-clicking anything else
  // (an unselected row, or a lone selected row) collapses selection to just
  // that row first, matching FileTree.tsx's handleRowContextMenu.
  const openRowMenu = (groupKey: GroupKey, entry: FileEntry, staged: boolean, x: number, y: number) => {
    const inGroup = selectedGroup === groupKey;
    if (inGroup && selectedPaths.has(entry.path) && selectedPaths.size > 1) {
      const entries = visibleFileEntries(groupKey).filter((en) => selectedPaths.has(en.path));
      showMenu?.(x, y, buildBulkMenuItems(groupKey, entries));
      return;
    }
    setSelectedGroup(groupKey);
    setSelectedPaths(new Set([entry.path]));
    setAnchorPath(entry.path);
    showMenu?.(x, y, buildFileMenuItems(groupKey, entry, staged));
  };
  const handleRowContextMenu = (groupKey: GroupKey, entry: FileEntry, staged: boolean, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openRowMenu(groupKey, entry, staged, e.clientX, e.clientY);
  };
  // Touch/pen long-press → the same menu right-click opens.
  const bindMenu = useLongPressMenu();

  // ---- Tree mode (hoisted above the early returns below — useListNavigation
  // needs these, and hooks can't follow a conditional return) ----
  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const conflicted = status?.conflicted ?? [];
  const repoRoot = status?.root ?? "";
  const conflictedTree = viewMode === "tree" ? buildTree(conflicted) : [];
  const stagedTree = viewMode === "tree" ? buildTree(staged) : [];
  const unstagedTree = viewMode === "tree" ? buildTree(unstaged) : [];

  // Every collapse key any of the three trees could currently produce —
  // used to prune stale keys for this repo root when any dir is toggled
  // (see toggleDir).
  const validKeysForRepo = new Set<string>();
  if (viewMode === "tree") {
    collectDirKeys(`${repoRoot}:conflicted`, conflictedTree, validKeysForRepo);
    collectDirKeys(`${repoRoot}:staged`, stagedTree, validKeysForRepo);
    collectDirKeys(`${repoRoot}:unstaged`, unstagedTree, validKeysForRepo);
  }

  // ---- Keyboard navigation (roving tabindex across all three groups) ----
  // One flattened row list per group — header, then its dir/file rows in
  // exactly the order renderTreeGroup (tree mode) or the plain .map (list
  // mode) below renders them, so ids assigned here line up with the
  // getRowProps() calls threaded into the JSX further down. Group headers
  // ARE focus stops (unlike file/dir rows' plain click, Enter/Space on a
  // header is a no-op — see navOnActivate); dir rows aren't part of file
  // selection (matching DirRow's mouse onClick, which only toggles).
  type NavRow =
    | { kind: "header"; id: string; groupKey: GroupKey }
    | { kind: "dir"; id: string; groupKey: GroupKey; node: TreeDirNode }
    | { kind: "file"; id: string; groupKey: GroupKey; entry: FileEntry };

  const buildGroupNavRows = (groupKey: GroupKey, flatEntries: FileEntry[], tree: TreeNode[]): NavRow[] => {
    if (flatEntries.length === 0) return [];
    const out: NavRow[] = [{ kind: "header", id: `header:${groupKey}`, groupKey }];
    if (viewMode === "list") {
      for (const entry of flatEntries) out.push({ kind: "file", id: `file:${groupKey}:${entry.path}`, groupKey, entry });
      return out;
    }
    const keyPrefix = `${repoRoot}:${groupKey}`;
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.kind === "dir") {
          out.push({ kind: "dir", id: `dir:${groupKey}:${node.path}`, groupKey, node });
          if (!collapsedDirs.has(`${keyPrefix}:${node.path}`)) walk(node.children);
        } else {
          out.push({ kind: "file", id: `file:${groupKey}:${node.entry.path}`, groupKey, entry: node.entry });
        }
      }
    };
    walk(tree);
    return out;
  };

  const navRows = [
    ...buildGroupNavRows("conflicted", conflicted, conflictedTree),
    ...buildGroupNavRows("staged", staged, stagedTree),
    ...buildGroupNavRows("unstaged", unstaged, unstagedTree),
  ];
  const navRowsById = new Map(navRows.map((r) => [r.id, r]));
  const navRowIds = navRows.map((r) => r.id);

  const resultNav = useListNavigation({
    rowIds: navRowIds,
    onActivate: (id) => {
      const row = navRowsById.get(id);
      if (!row || row.kind === "header") return;
      if (row.kind === "dir") {
        toggleDir(`${repoRoot}:${row.groupKey}:${row.node.path}`, validKeysForRepo, repoRoot);
        return;
      }
      setSelectedGroup(row.groupKey);
      setSelectedPaths(new Set([row.entry.path]));
      setAnchorPath(row.entry.path);
      openEntry(row.entry, row.groupKey === "staged", false);
    },
    onExpand: (id) => {
      const row = navRowsById.get(id);
      if (row?.kind !== "dir") return;
      const key = `${repoRoot}:${row.groupKey}:${row.node.path}`;
      if (collapsedDirs.has(key)) toggleDir(key, validKeysForRepo, repoRoot);
    },
    onCollapse: (id) => {
      const row = navRowsById.get(id);
      if (row?.kind !== "dir") return;
      const key = `${repoRoot}:${row.groupKey}:${row.node.path}`;
      if (!collapsedDirs.has(key)) toggleDir(key, validKeysForRepo, repoRoot);
    },
    onFocusChange: (id, { shiftKey }) => {
      const row = navRowsById.get(id);
      if (!row || row.kind !== "file") return;
      if (shiftKey && selectedGroup === row.groupKey && anchorPath) {
        selectRange(row.groupKey, anchorPath, row.entry.path);
        return;
      }
      setSelectedGroup(row.groupKey);
      setSelectedPaths(new Set([row.entry.path]));
      setAnchorPath(row.entry.path);
    },
    onContextMenuKey: (id, rect) => {
      const row = navRowsById.get(id);
      if (!row || row.kind !== "file") return;
      if (selectedGroup === row.groupKey && selectedPaths.has(row.entry.path) && selectedPaths.size > 1) {
        const entries = visibleFileEntries(row.groupKey).filter((en) => selectedPaths.has(en.path));
        showMenu?.(rect.left + 8, rect.bottom, buildBulkMenuItems(row.groupKey, entries));
        return;
      }
      setSelectedGroup(row.groupKey);
      setSelectedPaths(new Set([row.entry.path]));
      setAnchorPath(row.entry.path);
      showMenu?.(rect.left + 8, rect.bottom, buildFileMenuItems(row.groupKey, row.entry, row.groupKey === "staged"));
    },
  });

  if (!activeCwd) {
    return <div className="git-empty">No active directory.</div>;
  }
  if (!status) {
    return <div className="git-empty">Loading…</div>;
  }
  if (!status.root) {
    return <div className="git-empty">Not a git repository.</div>;
  }

  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const clickHint = `Shift+Click: ${clickAction === "edit" ? "Open Diff" : "Open in Editor"} · Ctrl+Click: Select`;
  const conflictClickHint = "Shift+Click: Open in Editor · Ctrl+Click: Select";
  const operation = status.operation ?? null;
  // Amend needs no staged changes (it's rewriting HEAD, not composing a new
  // commit from the index) — an ordinary commit still requires at least one.
  const canCommit = !busy && message.trim().length > 0 && (amend || staged.length > 0);
  // Renders one group's tree recursively. `makeFileProps` and `makeDirActions`
  // capture whatever differs per group (openEntry's staged flag, which
  // actions a row/dir gets) — everything else (indentation, collapse
  // toggling, key derivation) is shared.
  function renderTreeGroup(
    groupKey: GroupKey,
    nodes: TreeNode[],
    makeFileProps: (entry: FileEntry) => { staged: boolean; actions: RowAction[]; clickHint?: string },
    makeDirActions: (entries: FileEntry[]) => RowAction[],
    depth = 0,
  ): ReactNode[] {
    const keyPrefix = `${repoRoot}:${groupKey}`;
    const out: ReactNode[] = [];
    for (const node of nodes) {
      if (node.kind === "dir") {
        const key = `${keyPrefix}:${node.path}`;
        const collapsed = collapsedDirs.has(key);
        const dirEntries = collectEntries(node.children);
        const dirRowProps = resultNav.getRowProps(`dir:${groupKey}:${node.path}`);
        out.push(
          <DirRow
            key={key}
            node={node}
            depth={depth}
            collapsed={collapsed}
            onToggle={() => toggleDir(key, validKeysForRepo, repoRoot)}
            actions={makeDirActions(dirEntries)}
            tabIndex={dirRowProps.tabIndex}
            rowRef={dirRowProps.ref}
            onRowFocus={dirRowProps.onFocus}
          />,
        );
        if (!collapsed) {
          out.push(...renderTreeGroup(groupKey, node.children, makeFileProps, makeDirActions, depth + 1));
        }
      } else {
        const { staged, actions, clickHint: rowHint } = makeFileProps(node.entry);
        const fileRowProps = resultNav.getRowProps(`file:${groupKey}:${node.entry.path}`);
        out.push(
          <FileRow
            key={node.entry.path}
            entry={node.entry}
            group={groupKey}
            selected={selectedGroup === groupKey && selectedPaths.has(node.entry.path)}
            onRowClick={(e) => handleRowClick(groupKey, node.entry, staged, e)}
            onRowContextMenu={(e) => handleRowContextMenu(groupKey, node.entry, staged, e)}
            longPress={bindMenu((x, y) => openRowMenu(groupKey, node.entry, staged, x, y))}
            actions={actions}
            clickHint={rowHint}
            depth={depth}
            hideDir
            tabIndex={fileRowProps.tabIndex}
            rowRef={fileRowProps.ref}
            onRowFocus={fileRowProps.onFocus}
          />,
        );
      }
    }
    return out;
  }

  const conflictedHeaderRowProps = resultNav.getRowProps("header:conflicted");
  const stagedHeaderRowProps = resultNav.getRowProps("header:staged");
  const unstagedHeaderRowProps = resultNav.getRowProps("header:unstaged");

  const headerActions = (
    <>
      <button className="git-branch-button" disabled={busy} title="Switch Branch" onClick={openBranchMenu}>
        <Icon name="git-branch" />
        <span className="git-branch-button-name">{status.branch ?? "detached HEAD"}</span>
      </button>
      <button
        className={`icon-button mode-button${viewMode === "list" ? " active" : ""}`}
        title="View as List"
        onClick={() => changeViewMode("list")}
      >
        <Icon name="list-flat" />
      </button>
      <button
        className={`icon-button mode-button${viewMode === "tree" ? " active" : ""}`}
        title="View as Tree"
        onClick={() => changeViewMode("tree")}
      >
        <Icon name="list-tree" />
      </button>
      <button
        className="git-sync-button"
        disabled={busy}
        title={status.upstream ? `Sync with ${status.upstream}` : "Publish branch"}
        onClick={() => runNetwork("sync")}
      >
        <Icon name="sync" />
        {status.upstream && (
          <span className="git-sync-counts">
            {behind > 0 && (
              <>
                <Icon name="arrow-down" />
                {behind}
              </>
            )}
            {ahead > 0 && (
              <>
                <Icon name="arrow-up" />
                {ahead}
              </>
            )}
          </span>
        )}
      </button>
      <button className="icon-button" title="Refresh" disabled={busy} onClick={refresh}>
        <Icon name="refresh" />
      </button>
      <button
        className="icon-button"
        title="More Actions…"
        disabled={busy}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          // MenuItem (extensions/_shared/types.ts) has no disabled state —
          // same gap the Amend checkmark above works around with a label
          // prefix. A greyed-out-but-clickable Stash/Pop entry isn't
          // representable, so the entries are omitted outright when they
          // wouldn't apply, rather than shown disabled.
          const hasChanges = staged.length > 0 || unstaged.length > 0 || conflicted.length > 0;
          const stashCount = status.stashCount ?? 0;
          showMenu?.(rect.left, rect.bottom, [
            { label: "Pull", onClick: () => runNetwork("pull") },
            { label: "Push", onClick: () => runNetwork("push") },
            { label: "Fetch", onClick: manualFetch },
            {
              label: amend ? "✓ Amend Next Commit" : "Amend Next Commit",
              onClick: toggleAmend,
            },
            ...(hasChanges
              ? [
                  { label: "Stash", onClick: () => stash(false) },
                  { label: "Stash (Include Untracked)", onClick: () => stash(true) },
                ]
              : []),
            ...(stashCount > 0 ? [{ label: "Pop Latest Stash", onClick: stashPop }] : []),
          ]);
        }}
      >
        <Icon name="ellipsis" />
      </button>
    </>
  );

  return (
    <div className="git-panel">
      {actionsTarget && createPortal(headerActions, actionsTarget)}
      {error && (
        <div className="git-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {operation && (
        <div className="git-merge-banner">
          <Icon name="git-merge" />
          <span className="git-merge-banner-text">{OPERATION_LABEL[operation]} in progress</span>
          <button className="git-merge-abort-button" disabled={busy} onClick={() => setConfirmAbort(true)}>
            Abort
          </button>
        </div>
      )}

      <div className="git-commit-box">
        {/* The AI button sits inside the input, top-right, the way VS Code's
            own commit box places it — anchored to the top so it doesn't drift
            as the textarea auto-grows past one line. */}
        <div className="git-commit-input">
          <textarea
            ref={commitMessageRef}
            className="git-commit-message"
            placeholder={`Message (${status.branch ?? "detached HEAD"})`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canCommit) commit();
            }}
            disabled={busy}
            rows={1}
          />
          <button
            className="icon-button git-generate-button"
            title={
              generating
                ? "Writing a commit message…"
                : message.trim()
                  ? "Clear the message first to generate one"
                  : amend
                    ? "Write a commit message for the amended commit with AI"
                    : staged.length === 0
                      ? "No staged changes to describe"
                      : "Write a commit message for the staged changes with AI"
            }
            disabled={busy || generating || message.trim().length > 0 || (!amend && staged.length === 0)}
            onClick={() => void generateMessage()}
          >
            <Icon
              name={generating ? "loading" : "sparkle"}
              className={generating ? "codicon-modifier-spin" : undefined}
            />
          </button>
        </div>
        <label className="git-amend-toggle">
          <input type="checkbox" checked={amend} onChange={toggleAmend} disabled={busy} />
          Amend
        </label>
        <button
          className="git-commit-button"
          disabled={!canCommit}
          title={amend ? "Amend the last commit" : staged.length === 0 ? "No staged changes" : "Commit staged changes"}
          onClick={commit}
        >
          <Icon name="check" /> {amend ? "Commit (Amend)" : "Commit"}
        </button>
      </div>

      {creatingBranch && (
        <div className="git-credential-form">
          <input
            className="git-credential-input"
            placeholder="Branch name"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreateBranch();
              if (e.key === "Escape") cancelCreateBranch();
            }}
          />
          <div className="git-credential-buttons">
            <button className="git-credential-cancel" onClick={cancelCreateBranch}>
              Cancel
            </button>
            <button className="git-credential-submit" onClick={submitCreateBranch} disabled={!newBranchName.trim()}>
              Create
            </button>
          </div>
        </div>
      )}

      {authPrompt && (
        <div className="git-credential-form">
          <div className="git-auth-prompt-text">{authPrompt.prompt}</div>
          {authPrompt.kind === "hostkey" ? (
            <div className="git-credential-buttons">
              <button className="git-credential-cancel" onClick={cancelPrompt}>
                Cancel
              </button>
              <button className="git-credential-submit" onClick={() => replyPrompt({ answer: "yes" })}>
                Connect
              </button>
            </div>
          ) : (
            <>
              {authPrompt.kind === "username" && (
                <input
                  className="git-credential-input"
                  placeholder="Username"
                  value={authUsername}
                  onChange={(e) => setAuthUsername(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelPrompt();
                  }}
                />
              )}
              <input
                className="git-credential-input"
                placeholder={
                  authPrompt.kind === "passphrase"
                    ? "Passphrase"
                    : authPrompt.kind === "generic"
                      ? "Answer"
                      : "Password / token"
                }
                type={authPrompt.kind === "generic" ? "text" : "password"}
                value={authSecret}
                onChange={(e) => setAuthSecret(e.target.value)}
                autoFocus={authPrompt.kind !== "username"}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitPrompt();
                  if (e.key === "Escape") cancelPrompt();
                }}
              />
              {authPrompt.kind === "username" && (
                <label className="git-auth-remember">
                  <input
                    type="checkbox"
                    checked={authRemember}
                    onChange={(e) => setAuthRemember(e.target.checked)}
                  />
                  Remember credentials
                </label>
              )}
              <div className="git-credential-buttons">
                <button className="git-credential-cancel" onClick={cancelPrompt}>
                  Cancel
                </button>
                <button
                  className="git-credential-submit"
                  onClick={submitPrompt}
                  disabled={authPrompt.kind === "username" ? !authUsername : !authSecret}
                >
                  OK
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {confirmDiscard && (
        <div className="git-confirm">
          <div className="git-confirm-text">
            {confirmDiscard.paths.length === 1
              ? `Discard changes in ${basenameOf(confirmDiscard.paths[0])}?`
              : `Discard changes in ${confirmDiscard.paths.length} files?`}
            {confirmDiscard.untracked.length > 0 && " This deletes untracked file(s)."}
          </div>
          <div className="git-confirm-buttons">
            <button className="git-credential-cancel" onClick={() => setConfirmDiscard(null)}>
              Cancel
            </button>
            <button
              className="git-confirm-discard"
              onClick={() => {
                discard(confirmDiscard.paths, confirmDiscard.untracked);
                setConfirmDiscard(null);
              }}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {confirmAbort && operation && (
        <div className="git-confirm">
          <div className="git-confirm-text">
            Abort the {OPERATION_LABEL[operation].toLowerCase()}? This discards any conflict resolutions made so far.
          </div>
          <div className="git-confirm-buttons">
            <button className="git-credential-cancel" onClick={() => setConfirmAbort(false)}>
              Cancel
            </button>
            <button
              className="git-confirm-discard"
              onClick={() => {
                abortOperation();
                setConfirmAbort(false);
              }}
            >
              Abort
            </button>
          </div>
        </div>
      )}

      <div
        ref={gitGroupsRef}
        className="git-groups"
        onClick={(e) => e.target === e.currentTarget && clearSelection()}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest(".git-row, .git-group-header, button, input, textarea")) return;
          onMarqueeMouseDown(e);
        }}
        onKeyDown={resultNav.onKeyDown}
      >
        {marqueeRect && (
          <div
            className="marquee-rect"
            style={{ left: marqueeRect.left, top: marqueeRect.top, width: marqueeRect.width, height: marqueeRect.height }}
          />
        )}
        {conflicted.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Merge Changes"
              count={conflicted.length}
              actions={(() => {
                const target = groupTargetEntries("conflicted", conflicted);
                const isSelection = target.length !== conflicted.length;
                return [
                  {
                    icon: "add",
                    title: isSelection ? `Stage ${target.length} Selected` : "Stage All Changes",
                    onClick: () => stage(target.map((e) => e.path)),
                  },
                ];
              })()}
              tabIndex={conflictedHeaderRowProps.tabIndex}
              rowRef={conflictedHeaderRowProps.ref}
              onRowFocus={conflictedHeaderRowProps.onFocus}
            />
            {viewMode === "tree"
              ? renderTreeGroup(
                  "conflicted",
                  conflictedTree,
                  (entry) => {
                    const sel = groupSelectedEntries("conflicted", entry);
                    return {
                      staged: false,
                      clickHint: conflictClickHint,
                      actions: [
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ],
                    };
                  },
                  (entries) => [
                    { icon: "add", title: "Stage Changes", onClick: () => stage(entries.map((e) => e.path)) },
                  ],
                )
              : conflicted.map((entry) => {
                  const sel = groupSelectedEntries("conflicted", entry);
                  const fileRowProps = resultNav.getRowProps(`file:conflicted:${entry.path}`);
                  return (
                    <FileRow
                      key={entry.path}
                      entry={entry}
                      group="conflicted"
                      selected={selectedGroup === "conflicted" && selectedPaths.has(entry.path)}
                      onRowClick={(e) => handleRowClick("conflicted", entry, false, e)}
                      onRowContextMenu={(e) => handleRowContextMenu("conflicted", entry, false, e)}
                      longPress={bindMenu((x, y) => openRowMenu("conflicted", entry, false, x, y))}
                      clickHint={conflictClickHint}
                      actions={[
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ]}
                      tabIndex={fileRowProps.tabIndex}
                      rowRef={fileRowProps.ref}
                      onRowFocus={fileRowProps.onFocus}
                    />
                  );
                })}
          </div>
        )}

        {staged.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Staged Changes"
              count={staged.length}
              actions={(() => {
                const target = groupTargetEntries("staged", staged);
                const isSelection = target.length !== staged.length;
                return [
                  {
                    icon: "remove",
                    title: isSelection ? `Unstage ${target.length} Selected` : "Unstage All Changes",
                    onClick: () => unstage(target.map((e) => e.path)),
                  },
                ];
              })()}
              tabIndex={stagedHeaderRowProps.tabIndex}
              rowRef={stagedHeaderRowProps.ref}
              onRowFocus={stagedHeaderRowProps.onFocus}
            />
            {viewMode === "tree"
              ? renderTreeGroup(
                  "staged",
                  stagedTree,
                  (entry) => {
                    const sel = groupSelectedEntries("staged", entry);
                    return {
                      staged: true,
                      clickHint,
                      actions: [
                        {
                          icon: "remove",
                          title: sel.length > 1 ? `Unstage ${sel.length} Changes` : "Unstage Changes",
                          onClick: () => unstage(sel.map((e) => e.path)),
                        },
                      ],
                    };
                  },
                  (entries) => [
                    { icon: "remove", title: "Unstage Changes", onClick: () => unstage(entries.map((e) => e.path)) },
                  ],
                )
              : staged.map((entry) => {
                  const sel = groupSelectedEntries("staged", entry);
                  const fileRowProps = resultNav.getRowProps(`file:staged:${entry.path}`);
                  return (
                    <FileRow
                      key={entry.path}
                      entry={entry}
                      group="staged"
                      selected={selectedGroup === "staged" && selectedPaths.has(entry.path)}
                      onRowClick={(e) => handleRowClick("staged", entry, true, e)}
                      onRowContextMenu={(e) => handleRowContextMenu("staged", entry, true, e)}
                      longPress={bindMenu((x, y) => openRowMenu("staged", entry, true, x, y))}
                      clickHint={clickHint}
                      actions={[
                        {
                          icon: "remove",
                          title: sel.length > 1 ? `Unstage ${sel.length} Changes` : "Unstage Changes",
                          onClick: () => unstage(sel.map((e) => e.path)),
                        },
                      ]}
                      tabIndex={fileRowProps.tabIndex}
                      rowRef={fileRowProps.ref}
                      onRowFocus={fileRowProps.onFocus}
                    />
                  );
                })}
          </div>
        )}

        {unstaged.length > 0 && (
          <div className="git-group">
            <GroupHeader
              title="Changes"
              count={unstaged.length}
              actions={(() => {
                const target = groupTargetEntries("unstaged", unstaged);
                const isSelection = target.length !== unstaged.length;
                const targetUntracked = target.filter((e) => e.status === "untracked").map((e) => e.path);
                return [
                  {
                    icon: "add",
                    title: isSelection ? `Stage ${target.length} Selected` : "Stage All Changes",
                    onClick: () => stage(target.map((e) => e.path)),
                  },
                  {
                    icon: "discard",
                    title: isSelection ? `Discard ${target.length} Selected` : "Discard All Changes",
                    onClick: () =>
                      setConfirmDiscard({ paths: target.map((e) => e.path), untracked: targetUntracked }),
                  },
                ];
              })()}
              tabIndex={unstagedHeaderRowProps.tabIndex}
              rowRef={unstagedHeaderRowProps.ref}
              onRowFocus={unstagedHeaderRowProps.onFocus}
            />
            {viewMode === "tree"
              ? renderTreeGroup(
                  "unstaged",
                  unstagedTree,
                  (entry) => {
                    const sel = groupSelectedEntries("unstaged", entry);
                    const untracked = sel.filter((e) => e.status === "untracked").map((e) => e.path);
                    return {
                      staged: false,
                      clickHint,
                      actions: [
                        {
                          icon: "discard",
                          title: sel.length > 1 ? `Discard ${sel.length} Changes` : "Discard Changes",
                          onClick: () => setConfirmDiscard({ paths: sel.map((e) => e.path), untracked }),
                        },
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ],
                    };
                  },
                  (entries) => [
                    {
                      icon: "discard",
                      title: "Discard Changes",
                      onClick: () =>
                        setConfirmDiscard({
                          paths: entries.map((e) => e.path),
                          untracked: entries.filter((e) => e.status === "untracked").map((e) => e.path),
                        }),
                    },
                    { icon: "add", title: "Stage Changes", onClick: () => stage(entries.map((e) => e.path)) },
                  ],
                )
              : unstaged.map((entry) => {
                  const sel = groupSelectedEntries("unstaged", entry);
                  const untracked = sel.filter((e) => e.status === "untracked").map((e) => e.path);
                  const fileRowProps = resultNav.getRowProps(`file:unstaged:${entry.path}`);
                  return (
                    <FileRow
                      key={entry.path}
                      entry={entry}
                      group="unstaged"
                      selected={selectedGroup === "unstaged" && selectedPaths.has(entry.path)}
                      onRowClick={(e) => handleRowClick("unstaged", entry, false, e)}
                      onRowContextMenu={(e) => handleRowContextMenu("unstaged", entry, false, e)}
                      longPress={bindMenu((x, y) => openRowMenu("unstaged", entry, false, x, y))}
                      clickHint={clickHint}
                      actions={[
                        {
                          icon: "discard",
                          title: sel.length > 1 ? `Discard ${sel.length} Changes` : "Discard Changes",
                          onClick: () => setConfirmDiscard({ paths: sel.map((e) => e.path), untracked }),
                        },
                        {
                          icon: "add",
                          title: sel.length > 1 ? `Stage ${sel.length} Changes` : "Stage Changes",
                          onClick: () => stage(sel.map((e) => e.path)),
                        },
                      ]}
                      tabIndex={fileRowProps.tabIndex}
                      rowRef={fileRowProps.ref}
                      onRowFocus={fileRowProps.onFocus}
                    />
                  );
                })}
          </div>
        )}

        {staged.length === 0 && unstaged.length === 0 && conflicted.length === 0 && (
          <div className="git-empty">No changes.</div>
        )}
      </div>
    </div>
  );
}

// ---- CommitsPanel (the COMMITS pane) ----
// Registered as a second sidebar panel homed, by default, in the Source
// Control tab — so it arrives stacked under SOURCE CONTROL as its own
// collapsible pane, and the user can drag it into Explorer, the right
// sidebar, or a tab of its own. It shares GitPanel's status stream (for the
// repo root and the ahead/upstream counts behind the unpushed dots) and the
// module-level COMMITS store above, and owns nothing else — which is why
// unmounting it, as the host does whenever the pane is collapsed, costs
// nothing.
function CommitsPanel({ actionsTarget }: PanelProps) {
  const status = useSharedStatus();
  const [{ commits, limit, loading, root: loadedRoot }, setState] = useState<CommitsState>(
    () => commitsState,
  );

  useEffect(() => {
    setState(commitsState);
    commitsListeners.add(setState);
    return () => {
      commitsListeners.delete(setState);
    };
  }, []);

  const root = status?.root ?? null;

  // First mount in a repo, and every repo switch, starts from page one.
  // Re-expanding the pane in the SAME repo hits the store's cached list
  // instead, keeping whatever Load More depth was already paid for.
  useEffect(() => {
    if (root && root !== commitsState.root) fetchCommits(root, COMMITS_PAGE);
  }, [root]);

  const loadMore = () => {
    if (root) fetchCommits(root, limit + COMMITS_PAGE);
  };

  // COMMITS rows are newest-first (git log's default order), so the first
  // `ahead` entries are exactly the not-yet-pushed commits for a linear
  // history — an approximation that can mislabel right after a fetch that
  // hasn't been merged in yet, accepted as good enough over an extra
  // `git rev-list @{u}..HEAD` call per /log fetch.
  const unpushedCount = status?.upstream ? (status.ahead ?? 0) : 0;

  const headerActions = (
    <button
      className="icon-button"
      title="Refresh commits"
      disabled={loading || !root}
      onClick={() => refreshCommits()}
    >
      <Icon name="refresh" />
    </button>
  );

  return (
    <div className="git-panel git-commits-panel">
      {actionsTarget && createPortal(headerActions, actionsTarget)}
      {!root ? (
        <div className="git-empty">Not a git repository.</div>
      ) : commits.length === 0 ? (
        <div className="git-empty">{loading || loadedRoot !== root ? "Loading…" : "No commits yet."}</div>
      ) : (
        <div className="git-commits-list">
          {commits.map((commit, i) => (
            <CommitRow
              key={commit.hash}
              commit={commit}
              unpushed={i < unpushedCount}
              onClick={() => openCommitDiff(root, commit)}
            />
          ))}
          <button className="git-commits-load-more" disabled={loading} onClick={loadMore}>
            {loading ? "Loading…" : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- StashPanel (registerSidebarPanel component) ----
//
// The stash list as its own pane under SOURCE CONTROL, beside COMMITS: the
// panel's More Actions menu could only ever stash everything and pop the
// latest, which is the wrong shape for a stack you keep more than one thing
// in. Rows carry Apply (restore, keep the entry), Pop (restore and drop)
// and Drop, and a click opens the entry's diff — a stash entry is a commit,
// so that is the ordinary commit-diff path, not a viewer of its own.
function StashPanel({ actionsTarget }: PanelProps) {
  const status = useSharedStatus();
  const [{ stashes, loading, root: loadedRoot }, setState] = useState<StashesState>(
    () => stashesState,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The row awaiting confirmation — Drop is the one action here that
  // nothing in the UI can undo.
  const [confirmDrop, setConfirmDrop] = useState<StashEntry | null>(null);

  useEffect(() => {
    setState(stashesState);
    stashesListeners.add(setState);
    return () => {
      stashesListeners.delete(setState);
    };
  }, []);

  const root = status?.root ?? null;

  // First mount in a repo, and every repo switch, refetches; re-expanding
  // the pane in the same repo paints the cached list first.
  useEffect(() => {
    if (root && root !== stashesState.root) fetchStashes(root);
  }, [root]);

  const runOp = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Every one of these changes the working tree as well as the list:
      // refresh the panel's status and the FILES tree with it.
      refreshStatus();
      refreshFiles?.();
      refreshStashes();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = (entry: StashEntry) =>
    runOp(() => apiPost("/stash-apply", { cwd: root, ref: entry.ref }));
  const pop = (entry: StashEntry) => runOp(() => apiPost("/stash-pop", { cwd: root, ref: entry.ref }));
  const drop = (entry: StashEntry) => runOp(() => apiPost("/stash-drop", { cwd: root, ref: entry.ref }));
  const stashAll = (includeUntracked: boolean) =>
    runOp(() => apiPost("/stash", { cwd: root, includeUntracked }));

  const headerActions = (
    <>
      <button
        className="icon-button"
        title="Stash All Changes"
        disabled={busy || !root}
        onClick={() => stashAll(false)}
      >
        <Icon name="archive" />
      </button>
      <button
        className="icon-button"
        title="Refresh stashes"
        disabled={loading || !root}
        onClick={() => refreshStashes()}
      >
        <Icon name="refresh" />
      </button>
    </>
  );

  return (
    <div className="git-panel git-stash-panel">
      {actionsTarget && createPortal(headerActions, actionsTarget)}
      {error && (
        <div className="git-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {!root ? (
        <div className="git-empty">Not a git repository.</div>
      ) : stashes.length === 0 ? (
        <div className="git-empty">{loading || loadedRoot !== root ? "Loading…" : "No stashes."}</div>
      ) : (
        <div className="git-stash-list">
          {stashes.map((entry) => (
            <StashRow
              key={entry.hash}
              entry={entry}
              busy={busy}
              onClick={() => openStashDiff(root, entry)}
              actions={[
                { icon: "diff-added", title: "Apply (keep the stash)", onClick: () => apply(entry) },
                { icon: "inbox", title: "Pop (apply and drop)", onClick: () => pop(entry) },
                { icon: "trash", title: "Drop", onClick: () => setConfirmDrop(entry) },
              ]}
            />
          ))}
        </div>
      )}
      {confirmDrop && (
        <div className="git-confirm">
          <div className="git-confirm-text">
            Drop {confirmDrop.ref}? Its changes are lost.
          </div>
          <div className="git-confirm-buttons">
            <button onClick={() => setConfirmDrop(null)}>Cancel</button>
            <button
              className="git-confirm-discard"
              onClick={() => {
                drop(confirmDrop);
                setConfirmDrop(null);
              }}
            >
              Drop Stash
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// One stash entry. Deliberately not a FileRow, for the same reason CommitRow
// isn't: no data-path, so the panel's marquee selection can never pick these
// up.
function StashRow({
  entry,
  busy,
  actions,
  onClick,
}: {
  entry: StashEntry;
  busy: boolean;
  actions: RowAction[];
  onClick: () => void;
}) {
  return (
    <div className="git-stash-row" title={`${entry.ref}\n${entry.subject}`} onClick={onClick}>
      <Icon name="archive" />
      <span className="git-stash-subject">{entry.subject}</span>
      {/* Time and actions share one slot: the time holds the width (it is
          always rendered, just hidden on hover) and the actions sit over it,
          so hovering a row moves nothing. Same trailer idea as .git-row. */}
      <span className="git-stash-trailer">
        <span className="git-stash-time">{formatRelativeTime(entry.timestamp)}</span>
        <span className="git-stash-actions">
          {actions.map((a) => (
            <button
              key={a.title}
              className="icon-button"
              title={a.title}
              disabled={busy}
              onClick={(e) => {
                // The row itself opens a diff — an action must not also.
                e.stopPropagation();
                a.onClick();
              }}
            >
              <Icon name={a.icon} />
            </button>
          ))}
        </span>
      </span>
    </div>
  );
}

// A stash entry is a commit, so its diff is the commit diff — same key
// shape a COMMITS row uses.
function openStashDiff(root: string, entry: StashEntry) {
  const key = encodeDiffKey(root, "", false, false, undefined, entry.hash, true);
  openViewerTab?.("diff", key, { title: `${entry.ref} ${entry.subject}` });
}

// A COMMITS row click — reuses DiffView via the key's commitHash field
// (see encodeDiffKey/decodeDiffKey) rather than a dedicated viewer.
function openCommitDiff(root: string, commit: CommitEntry) {
  const key = encodeDiffKey(root, "", false, false, undefined, commit.hash);
  openViewerTab?.("diff", key, { title: `${commit.hash.slice(0, 7)} ${commit.subject}` });
}

// ---- ConflictView (registerFileViewer component, extensions: []) ----
// Conflict-marker parsing (ConflictBlock/TextRun/ConflictSegment,
// parseConflictSegments, buildResolvedContent, ResolutionChoice,
// ResolutionMap) lives in ../conflictModel.mjs — extracted so it can run
// under plain `node --test`, same pattern as statusModel.mjs.
// Reached the same way DiffView is — only via ctx.app.openViewerTab, from a
// conflicted row's click (see GitPanel's openEntry). Accept/Undo only touch
// in-memory `resolutions` state — nothing reaches disk until Save is
// clicked, same "buffer, then explicit persist" model CsvView's editable
// grid uses (down to reporting dirty state via setDirty so closing the tab
// mid-edit gets the host's confirm-before-discard prompt). Save writes
// whatever's currently decided (a partial save can still leave some blocks
// unresolved, keeping their markers) via the hash-guarded /resolve endpoint,
// then reloads — any block that got saved is simply gone from the fresh
// parse, since its markers no longer exist on disk. "Mark as Resolved"
// stages the file (git add) and is only enabled once nothing is left
// unresolved AND nothing is pending an unsaved decision.

interface ConflictProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
  setDirty?: (dirty: boolean) => void;
}

interface ConflictFileResponse {
  content: string | null;
  binary: boolean;
  tooLarge: boolean;
  hash: string | null;
}

const CHOICE_LABEL: Record<ResolutionChoice, string> = { ours: "Current", theirs: "Incoming", both: "Both" };

function ConflictView({ filePath, active, toolbarTarget, openInEditor, setDirty }: ConflictProps) {
  const parsed = useMemo(() => decodeConflictKey(filePath), [filePath]);
  const [data, setData] = useState<ConflictFileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resolutions, setResolutions] = useState<ResolutionMap>({});

  // Set when a background poll (below) finds the on-disk hash no longer
  // matches what's loaded — an edit made elsewhere (nvim, another tab)
  // while this resolver is open. Cleared by any successful load.
  const [staleHash, setStaleHash] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setResolutions({});
    setStaleHash(null);
    const params = new URLSearchParams({ cwd: parsed.cwd, path: parsed.path });
    apiGetJson<ConflictFileResponse>(`/conflict?${params}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [parsed.cwd, parsed.path]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  // Polls /conflict's hash while this tab is active and compares it to the
  // currently-loaded content's hash — otherwise an external edit only
  // surfaces once Save's own 409 hash-mismatch check fires, which can be
  // long after the user started deciding blocks against stale content.
  // Reuses the panel's poll cadence, floored at 3s so a fast
  // gitScm.pollInterval doesn't spam this endpoint; off entirely when that
  // setting is 0 (matching the main status poller's own "0 disables" rule).
  useEffect(() => {
    if (!active || !data?.hash) return;
    const interval = readPollInterval();
    if (interval === 0) return;
    const ms = Math.max(3000, interval);
    const timer = window.setInterval(async () => {
      try {
        const params = new URLSearchParams({ cwd: parsed.cwd, path: parsed.path });
        const fresh = await apiGetJson<ConflictFileResponse>(`/conflict?${params}`);
        if (fresh.hash !== data.hash) setStaleHash(fresh.hash);
      } catch {
        // Transient poll failure — Save's own 409 check is the backstop.
      }
    }, ms);
    return () => window.clearInterval(timer);
  }, [active, data?.hash, parsed.cwd, parsed.path]);

  const lines = useMemo(() => (data?.content != null ? data.content.split("\n") : null), [data]);
  const segments = useMemo(() => (lines ? parseConflictSegments(lines) : null), [lines]);
  const blocks = useMemo(
    () => segments?.filter((s): s is ConflictBlock => s.kind === "conflict") ?? [],
    [segments],
  );
  const remaining = useMemo(() => blocks.filter((b) => !resolutions[b.start]).length, [blocks, resolutions]);
  const dirty = Object.keys(resolutions).length > 0;

  useEffect(() => setDirty?.(dirty), [dirty, setDirty]);

  const acceptBlock = (block: ConflictBlock, choice: ResolutionChoice) => {
    setResolutions((prev) => ({ ...prev, [block.start]: choice }));
  };

  const undoBlock = (block: ConflictBlock) => {
    setResolutions((prev) => {
      const next = { ...prev };
      delete next[block.start];
      return next;
    });
  };

  // Bulk override for every block in the file, including ones already given
  // a different per-block choice — same in-memory-only, Undo-able, Save-to-
  // persist semantics as a single Accept click.
  const acceptAll = (choice: ResolutionChoice) => {
    setResolutions(Object.fromEntries(blocks.map((b) => [b.start, choice])));
  };

  const save = () => {
    if (!lines || !segments || !data?.hash) return;
    const content = buildResolvedContent(lines, segments, resolutions);
    setBusy(true);
    setError(null);
    apiPost("/resolve", { cwd: parsed.cwd, path: parsed.path, content, expectedHash: data.hash })
      .then(load)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const markResolved = () => {
    setBusy(true);
    setError(null);
    apiPost("/stage", { cwd: parsed.cwd, paths: [parsed.path] })
      .then(() => {
        refreshStatus();
        refreshFiles?.();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const controls = (
    <>
      <button className="icon-button" title="Reload" onClick={load}>
        <Icon name="refresh" />
      </button>
      <button
        className="icon-button"
        title="Open in Editor"
        onClick={() => openInEditor?.(`${parsed.cwd}/${parsed.path}`)}
      >
        <Icon name="go-to-file" />
      </button>
    </>
  );

  const statusText =
    remaining > 0
      ? `${remaining} conflict${remaining === 1 ? "" : "s"} remaining`
      : dirty
        ? "All conflicts resolved - Save to apply"
        : "All conflicts resolved";

  return (
    <div className={`git-conflict-host${active ? "" : " hidden"}`}>
      {error && <div className="git-diff-status git-diff-error">{error}</div>}
      {!error && staleHash !== null && (
        <div className="git-conflict-stale-banner">
          <span>
            File changed on disk.
            {dirty ? " Reloading discards your unsaved resolution choices." : ""}
          </span>
          <button className="git-conflict-stale-reload" onClick={load}>
            Reload
          </button>
        </div>
      )}
      {!error && data === null && <div className="git-diff-status">Loading…</div>}
      {!error && data?.tooLarge && (
        <div className="git-diff-status">File is too large to resolve here - open in Editor instead.</div>
      )}
      {!error && data?.binary && (
        <div className="git-diff-status">Binary file conflict - resolve in Editor, then Mark as Resolved.</div>
      )}
      {!error && data && !data.binary && !data.tooLarge && segments && (
        <>
          <div className="git-conflict-toolbar">
            <span className="git-conflict-count">{statusText}</span>
            <button
              className="git-conflict-save-button"
              disabled={busy || !dirty}
              title={dirty ? "Save resolved conflicts to disk" : "No unsaved changes"}
              onClick={save}
            >
              <Icon name="save" /> Save
            </button>
            <button
              className="git-conflict-resolve-button"
              disabled={busy || remaining > 0 || dirty}
              title={
                remaining > 0 ? "Resolve all conflicts first" : dirty ? "Save your changes first" : "Stage this file"
              }
              onClick={markResolved}
            >
              <Icon name="check" /> Mark as Resolved
            </button>
          </div>
          {blocks.length > 1 && (
            <div className="git-conflict-toolbar-secondary">
              <span className="git-conflict-accept-all-label">Accept All:</span>
              <button className="git-conflict-accept-all" disabled={busy} onClick={() => acceptAll("ours")}>
                Current
              </button>
              <button className="git-conflict-accept-all" disabled={busy} onClick={() => acceptAll("theirs")}>
                Incoming
              </button>
              <button className="git-conflict-accept-all" disabled={busy} onClick={() => acceptAll("both")}>
                Both
              </button>
            </div>
          )}
          <div className="git-conflict-body">
            {segments.map((seg, i) => {
              if (seg.kind === "text") {
                return (
                  <pre key={i} className="git-conflict-text">
                    {lines!.slice(seg.start, seg.end + 1).join("\n")}
                  </pre>
                );
              }
              const choice = resolutions[seg.start];
              if (choice) {
                const replacement =
                  choice === "ours" ? seg.ours : choice === "theirs" ? seg.theirs : [...seg.ours, ...seg.theirs];
                return (
                  <div key={i} className="git-conflict-block git-conflict-block-resolved">
                    <div className="git-conflict-side-header">
                      <span>Resolved: {CHOICE_LABEL[choice]}</span>
                      <button className="git-conflict-accept" disabled={busy} onClick={() => undoBlock(seg)}>
                        Undo
                      </button>
                    </div>
                    <pre className="git-conflict-side-body">{replacement.join("\n")}</pre>
                  </div>
                );
              }
              return (
                <div key={i} className="git-conflict-block">
                  <div className="git-conflict-side git-conflict-ours">
                    <div className="git-conflict-side-header">
                      <span>Current: {seg.oursLabel}</span>
                      <button className="git-conflict-accept" disabled={busy} onClick={() => acceptBlock(seg, "ours")}>
                        Accept Current
                      </button>
                    </div>
                    <pre className="git-conflict-side-body">{seg.ours.join("\n")}</pre>
                  </div>
                  {seg.base && (
                    <div className="git-conflict-side git-conflict-base">
                      <div className="git-conflict-side-header">
                        <span>Base{seg.baseLabel ? `: ${seg.baseLabel}` : ""}</span>
                      </div>
                      <pre className="git-conflict-side-body">{seg.base.join("\n")}</pre>
                    </div>
                  )}
                  <div className="git-conflict-side git-conflict-theirs">
                    <div className="git-conflict-side-header">
                      <span>Incoming: {seg.theirsLabel}</span>
                      <button
                        className="git-conflict-accept"
                        disabled={busy}
                        onClick={() => acceptBlock(seg, "theirs")}
                      >
                        Accept Incoming
                      </button>
                    </div>
                    <pre className="git-conflict-side-body">{seg.theirs.join("\n")}</pre>
                  </div>
                  <div className="git-conflict-block-footer">
                    <button
                      className="git-conflict-accept-both"
                      disabled={busy}
                      onClick={() => acceptBlock(seg, "both")}
                    >
                      Accept Both
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}

// ---- Status-bar item ----
//
// The branch readout at the bottom-left, VS Code's: branch name, a "*" when
// the tree is dirty, and the ahead/behind counts. It rides the same poller
// the sidebar badge does, so it costs no request of its own and stays
// correct whether or not the SOURCE CONTROL tab has ever been opened —
// which is the point, since the bar is visible when the sidebar isn't.
//
// A readout, not a control: clicking it reveals the panel, where every
// action (switch branch, sync, stage, commit) already lives with the error
// banner and credential form those actions need.

// The host hands every status-bar item a context (menus, popovers above the
// bar, the shared confirm dialog). This one uses none of it — its whole
// click is "open the panel" — so the prop is accepted and ignored.
function GitStatusBarItem(_props: { context: unknown }) {
  const status = useSharedStatus();

  // Whether this belongs in the bar at all is the host's business now: it
  // owns gitScm.statusBar through the gear menu's Status Bar list, and drops
  // the item entirely when that's off.
  //
  // Nothing to say when the active directory isn't a repo — an empty slot
  // is better than a placeholder nobody can act on.
  if (!status?.root) return null;

  const ahead = status.ahead ?? 0;
  const behind = status.behind ?? 0;
  const changes = changeCount(status);
  const operation = status.operation ? OPERATION_LABEL[status.operation] : null;
  const tooltip = [
    status.branch ? `Branch: ${status.branch}` : "Detached HEAD",
    operation ? `${operation} in progress` : null,
    changes > 0 ? `${changes} change${changes === 1 ? "" : "s"}` : "No local changes",
    status.upstream ? `${behind} behind, ${ahead} ahead of ${status.upstream}` : "No upstream branch",
    "Click to open Source Control",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      className="status-bar-item git-status-bar-item"
      title={tooltip}
      onClick={() => revealSidebarPanel?.("git")}
    >
      <Icon name="git-branch" />
      <span className="git-status-bar-branch">
        {status.branch ?? "detached HEAD"}
        {/* VS Code's dirty marker — the exact count is a tooltip away, and
            a number here would only repeat the sidebar's own badge. */}
        {changes > 0 && "*"}
      </span>
      {operation && <span className="git-status-bar-operation">{operation}</span>}
      {status.upstream && (behind > 0 || ahead > 0) && (
        <span className="git-status-bar-counts">
          {behind > 0 && (
            <>
              <Icon name="arrow-down" />
              {behind}
            </>
          )}
          {ahead > 0 && (
            <>
              <Icon name="arrow-up" />
              {ahead}
            </>
          )}
        </span>
      )}
    </button>
  );
}

// ---- activate() ----

export function activate(ctx: {
  registerSidebarPanel: (p: {
    id: string;
    title: string;
    icon?: string;
    focusBinding?: string;
    location?: "tab" | "explorer" | "run" | "commands";
    // Another of THIS extension's panels, by its unnamespaced id, whose tab
    // this one starts out inside — see the host's registerSidebarPanel.
    defaultTab?: string;
    component: typeof GitPanel | typeof CommitsPanel | typeof StashPanel;
  }) => void;
  registerFileViewer: (v: {
    id: string;
    extensions: string[];
    mode?: "default" | "preview";
    component: typeof DiffView | typeof ConflictView;
  }) => void;
  registerStatusBarItem: (item: {
    id: string;
    title?: string;
    placement?: "left" | "right";
    order?: number;
    visibilitySetting?: string;
    component: typeof GitStatusBarItem;
  }) => void;
  registerCommand: (cmd: { id: string; label: string; defaultBinding?: string; run: () => void }) => void;
  registerFileDecorationProvider: (provider: {
    id: string;
    provideDecoration: (
      path: string,
      isDir: boolean,
    ) => { badge?: string; tooltip?: string; className?: string } | undefined;
    provideRootDecoration?: (rootPath: string) => { label: string; tooltip?: string } | undefined;
  }) => { refresh(): void };
  app: {
    getActiveContext: () => ActiveContext;
    onDidChangeContext: (cb: (ctx: ActiveContext) => void) => () => void;
    openFileTab: (path: string) => void;
    openViewerTab: (viewerId: string, path: string, opts?: { title?: string }) => void;
    // Present only on hosts with the pluggable `editor` setting. Resolves
    // false when no editor claims the diff capability, which is the cue to
    // fall back to DiffView below.
    openDiff?: (req: {
      title: string;
      original: { content: string; label: string };
      modified: { content: string; label: string; path?: string; readOnlyReason?: string };
    }) => Promise<boolean>;
    openMerge?: (req: {
      title: string;
      path: string;
      ours: { content: string; label: string };
      theirs: { content: string; label: string };
      base?: { content: string; label: string } | null;
      markResolved: () => Promise<void>;
    }) => Promise<boolean>;
    refreshFiles: () => void;
    setSidebarBadge: (panelId: string, badge: number | null) => void;
    revealSidebarPanel: (panelId: string) => void;
    getFileIcon: (fileName: string) => IconResult;
    getFolderIcon: (folderName: string, expanded: boolean) => IconResult;
    onDidChangeIconTheme: (cb: () => void) => () => void;
  };
  serverFetch: (path: string, init?: RequestInit) => Promise<Response>;
  assetUrl: (relPath: string) => string;
  settings: SettingsApi;
}) {
  serverFetch = ctx.serverFetch;
  getActiveContext = ctx.app.getActiveContext;
  onDidChangeContext = ctx.app.onDidChangeContext;
  openViewerTab = ctx.app.openViewerTab;
  openDiffInEditor = ctx.app.openDiff ?? null;
  openMergeInEditor = ctx.app.openMerge ?? null;
  openFileTab = ctx.app.openFileTab;
  refreshFiles = ctx.app.refreshFiles;
  setSidebarBadge = ctx.app.setSidebarBadge;
  revealSidebarPanel = ctx.app.revealSidebarPanel;
  getFileIcon = ctx.app.getFileIcon;
  getFolderIcon = ctx.app.getFolderIcon;
  onDidChangeIconTheme = ctx.app.onDidChangeIconTheme;
  extSettings = ctx.settings;

  removeStylesheet = injectStylesheet(ctx.assetUrl, "dist/client.css");
  ctx.registerSidebarPanel({
    id: "git",
    title: "Source Control",
    icon: "source-control",
    focusBinding: "ctrl+shift+KeyG",
    component: GitPanel,
  });
  // Its own pane rather than a section inside GitPanel: it collapses,
  // resizes and moves on its own, and defaultTab: "git" is what puts it
  // under SOURCE CONTROL to start with instead of standing up a tab nobody
  // asked for. Registered second so it lands below (see the host's
  // append-only panel-order reconciliation).
  ctx.registerSidebarPanel({
    id: "commits",
    title: "Commits",
    icon: "git-commit",
    location: "tab",
    defaultTab: "git",
    component: CommitsPanel,
  });
  // Third, so it lands below COMMITS (append-only panel-order
  // reconciliation again) — the stack you dip into occasionally belongs
  // under the history you read constantly.
  ctx.registerSidebarPanel({
    id: "stash",
    title: "Stash",
    icon: "archive",
    location: "tab",
    defaultTab: "git",
    component: StashPanel,
  });
  // Far left of the bar, where VS Code puts it — before any other
  // extension's item, since the branch is the thing you glance at.
  ctx.registerStatusBarItem({
    id: "branch",
    title: "Branch",
    placement: "left",
    order: 0,
    // The host's Status Bar list drives this setting, and hides the item
    // when it's off — so the component itself no longer checks it.
    visibilitySetting: "gitScm.statusBar",
    component: GitStatusBarItem,
  });
  // extensions: [] — never auto-matched to a file; reached only via
  // ctx.app.openViewerTab from GitPanel's row clicks (see openEntry above).
  ctx.registerFileViewer({ id: "diff", extensions: [], mode: "default", component: DiffView });
  ctx.registerFileViewer({ id: "conflict", extensions: [], mode: "default", component: ConflictView });
  // FILES tree badges/row colors + the branch root decoration — replaces
  // the status enrichment core /api/fs used to inline.
  decorHandle = ctx.registerFileDecorationProvider({
    id: "status",
    provideDecoration,
    provideRootDecoration,
  });
  decorTimer = window.setInterval(decorPollTick, DECOR_POLL_MS);

  // Start the badge poller immediately so it's correct on app startup,
  // rather than only after the user opens the Source Control tab.
  setPollCwd(ctx.app.getActiveContext().cwd);
  removeContextListener = ctx.app.onDidChangeContext((c) => setPollCwd(c.cwd));
  removeSettingsListener = ctx.settings.onDidChange(onSettingsChanged);

  // Palette commands that work whether or not the Source Control tab is the
  // active sidebar tab — resolve cwd from the active context and fetch a
  // fresh status rather than trusting the module-level poller's cache
  // (whose interval may not have ticked yet for a directory just switched
  // to). No bulk stage/unstage endpoint exists (server.js has only
  // per-path /stage and /unstage) — these compose the full path list
  // client-side, the same way the panel's own "Stage All"/"Unstage All"
  // header buttons do.
  ctx.registerCommand({
    id: "stageAll",
    label: "Git: Stage All Changes",
    run: async () => {
      const cwd = ctx.app.getActiveContext().cwd;
      if (!cwd) return;
      try {
        const data = await apiGetJson<StatusResponse>(`/status?cwd=${encodeURIComponent(cwd)}`);
        const paths = (data.unstaged ?? []).map((e) => e.path);
        if (paths.length === 0) return;
        await apiPost("/stage", { cwd, paths });
        refreshStatus();
        refreshFiles?.();
      } catch {
        // No error UI to report to when the panel isn't mounted — a
        // subsequent status poll (or the panel's own next refresh) surfaces
        // any real problem instead.
      }
    },
  });
  ctx.registerCommand({
    id: "unstageAll",
    label: "Git: Unstage All Changes",
    run: async () => {
      const cwd = ctx.app.getActiveContext().cwd;
      if (!cwd) return;
      try {
        const data = await apiGetJson<StatusResponse>(`/status?cwd=${encodeURIComponent(cwd)}`);
        const paths = (data.staged ?? []).map((e) => e.path);
        if (paths.length === 0) return;
        await apiPost("/unstage", { cwd, paths });
        refreshStatus();
        refreshFiles?.();
      } catch {
        // See stageAll's comment above.
      }
    },
  });
  ctx.registerCommand({
    id: "refresh",
    label: "Git: Refresh",
    run: () => {
      refreshStatus();
      refreshFiles?.();
    },
  });
}

export function deactivate() {
  removeContextListener?.();
  removeContextListener = null;
  removeSettingsListener?.();
  removeSettingsListener = null;
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  if (fetchTimer != null) {
    window.clearInterval(fetchTimer);
    fetchTimer = null;
  }
  if (decorTimer != null) {
    window.clearInterval(decorTimer);
    decorTimer = null;
  }
  decorHandle = null;
  decorCache.clear();
  decorSeen.clear();
  pollCwd = null;
  currentStatus = null;
  commitsState = { commits: [], limit: COMMITS_PAGE, loading: false, root: null };
  commitsListeners.clear();
  stashesState = { stashes: [], loading: false, root: null };
  stashesListeners.clear();
  setSidebarBadge?.("git", null);
  revealSidebarPanel = null;
  getFileIcon = null;
  getFolderIcon = null;
  onDidChangeIconTheme = null;
  removeStylesheet?.();
  removeStylesheet = null;
}
