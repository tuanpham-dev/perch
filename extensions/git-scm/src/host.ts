// The host bridge, the fetch helpers, the diff-tab key codec and the shared
// status store — everything the panes have in common, extracted from
// client.tsx so BranchesPanel, CommitDetails and commitActions can reach
// them without importing the module that registers them (which would be a
// cycle).
//
// The bridge variables stay plain `let` exports: an ESM import is a live
// binding, so a consumer's `openViewerTab?.(…)` sees whatever bindHost()
// last assigned, exactly as it did when these lived in client.tsx.
import { useEffect, useState } from "react";
import type { IconResult } from "../../_shared/FileIcon";
import type { MenuItem } from "../../_shared/types";

// ---- Host bridge ----

export interface ActiveContext {
  sessionName: string | null;
  windowIndex: number | null;
  cwd: string | null;
}

export interface SettingsApi {
  get(key: string): unknown;
  onDidChange(cb: () => void): () => void;
}

export interface DiffRequest {
  title: string;
  original: { content: string; label: string };
  modified: { content: string; label: string; path?: string; readOnlyReason?: string };
}

export interface MergeRequest {
  title: string;
  path: string;
  ours: { content: string; label: string };
  theirs: { content: string; label: string };
  base?: { content: string; label: string } | null;
  markResolved: () => Promise<void>;
}

// Structurally matches the host's SidebarPanelHostProps (client/src/
// extensions.ts) — a local copy, not an import, per extensions/_shared's
// module comment on why extension code never imports client/src internals.
export interface PanelProps {
  actionsTarget?: HTMLDivElement | null;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

export let serverFetch: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;
export let getActiveContext: (() => ActiveContext) | null = null;
export let onDidChangeContext: ((cb: (ctx: ActiveContext) => void) => () => void) | null = null;
export let openViewerTab: ((viewerId: string, path: string, opts?: { title?: string }) => void) | null = null;
export let openDiffInEditor: ((req: DiffRequest) => Promise<boolean>) | null = null;
export let openMergeInEditor: ((req: MergeRequest) => Promise<boolean>) | null = null;
export let openFileTab: ((path: string) => void) | null = null;
export let refreshFiles: (() => void) | null = null;
export let setSidebarBadge: ((panelId: string, badge: number | null) => void) | null = null;
export let revealSidebarPanel: ((panelId: string) => void) | null = null;
export let confirmDialog: ((message: string, confirmLabel?: string) => Promise<boolean>) | null = null;
export let promptDialog: ((message: string, defaultValue?: string) => Promise<string | null>) | null = null;
export let extSettings: SettingsApi | null = null;
export let getFileIcon: ((fileName: string) => IconResult) | null = null;
export let getFolderIcon: ((folderName: string, expanded: boolean) => IconResult) | null = null;
export let onDidChangeIconTheme: ((cb: () => void) => () => void) | null = null;

export interface HostBindings {
  serverFetch: (path: string, init?: RequestInit) => Promise<Response>;
  getActiveContext: () => ActiveContext;
  onDidChangeContext: (cb: (ctx: ActiveContext) => void) => () => void;
  openViewerTab: (viewerId: string, path: string, opts?: { title?: string }) => void;
  openDiffInEditor: ((req: DiffRequest) => Promise<boolean>) | null;
  openMergeInEditor: ((req: MergeRequest) => Promise<boolean>) | null;
  openFileTab: (path: string) => void;
  refreshFiles: () => void;
  setSidebarBadge: (panelId: string, badge: number | null) => void;
  revealSidebarPanel: (panelId: string) => void;
  confirmDialog: ((message: string, confirmLabel?: string) => Promise<boolean>) | null;
  promptDialog: ((message: string, defaultValue?: string) => Promise<string | null>) | null;
  extSettings: SettingsApi;
  getFileIcon: (fileName: string) => IconResult;
  getFolderIcon: (folderName: string, expanded: boolean) => IconResult;
  onDidChangeIconTheme: (cb: () => void) => () => void;
}

export function bindHost(next: HostBindings) {
  serverFetch = next.serverFetch;
  getActiveContext = next.getActiveContext;
  onDidChangeContext = next.onDidChangeContext;
  openViewerTab = next.openViewerTab;
  openDiffInEditor = next.openDiffInEditor;
  openMergeInEditor = next.openMergeInEditor;
  openFileTab = next.openFileTab;
  refreshFiles = next.refreshFiles;
  setSidebarBadge = next.setSidebarBadge;
  revealSidebarPanel = next.revealSidebarPanel;
  confirmDialog = next.confirmDialog;
  promptDialog = next.promptDialog;
  extSettings = next.extSettings;
  getFileIcon = next.getFileIcon;
  getFolderIcon = next.getFolderIcon;
  onDidChangeIconTheme = next.onDidChangeIconTheme;
}

export function unbindHost() {
  serverFetch = null;
  getActiveContext = null;
  onDidChangeContext = null;
  openViewerTab = null;
  openDiffInEditor = null;
  openMergeInEditor = null;
  openFileTab = null;
  refreshFiles = null;
  setSidebarBadge = null;
  revealSidebarPanel = null;
  confirmDialog = null;
  promptDialog = null;
  extSettings = null;
  getFileIcon = null;
  getFolderIcon = null;
  onDidChangeIconTheme = null;
}

export function readPollInterval(): number {
  const raw = Number(extSettings?.get("gitScm.pollInterval"));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.max(1000, raw);
}

// ---- Relative time ----

const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
];
const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatRelativeTime(unixSeconds: number): string {
  const diffSeconds = unixSeconds - Math.floor(Date.now() / 1000);
  for (const [unit, secondsInUnit] of RELATIVE_TIME_UNITS) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return relativeTimeFormatter.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return relativeTimeFormatter.format(Math.round(diffSeconds / 60), "minute");
}

// The absolute date a commit row's relative age stands for, for a tooltip.
export function formatAbsoluteTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

// ---- Status types (mirrors server.js's parseStatus output) ----

export type FileStatus = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

export interface FileEntry {
  path: string;
  origPath?: string;
  status: FileStatus;
}

export type OperationKind = "merge" | "rebase" | "cherry-pick" | "revert";

export const OPERATION_LABEL: Record<OperationKind, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

export interface StatusResponse {
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
  // branch — prefills the commit box when Amend is toggled on.
  lastCommitMessage?: string | null;
  // Drives the More Actions menu's "Pop Latest Stash" enabled state.
  stashCount?: number;
  // HEAD's hash and the newest stash entry's hash: the status poll watches
  // them so COMMITS, STASH and BRANCHES follow commits, stashes and branch
  // switches made in a terminal, not only ones made from this panel.
  head?: string | null;
  stashHead?: string | null;
}

export interface CommitEntry {
  hash: string;
  author: string;
  timestamp: number;
  subject: string;
}

export interface StashEntry {
  // The commit the entry IS — what a row opens as an ordinary diff.
  hash: string;
  // "stash@{0}". Positional: every drop/pop renumbers the entries below it,
  // which is why every mutation here refetches rather than splicing.
  ref: string;
  timestamp: number;
  subject: string;
}

// ---- Shared fetch helpers ----

export class ApiError extends Error {
  cancelled?: boolean;
  // Set from the response status, so a caller can tell a refusal it should
  // act on (409 "not fully merged") from a plain failure.
  status?: number;
  unmerged?: boolean;
  constructor(message: string, cancelled?: boolean, status?: number, unmerged?: boolean) {
    super(message);
    this.cancelled = cancelled;
    this.status = status;
    this.unmerged = unmerged;
  }
}

export async function apiPost(path: string, body: unknown): Promise<void> {
  const res = await serverFetch!(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({}) as { error?: string; cancelled?: boolean; unmerged?: boolean });
    throw new ApiError(
      data.error || `${res.status} ${res.statusText}`,
      data.cancelled,
      res.status,
      data.unmerged,
    );
  }
}

// apiPost for the one route whose reply is the point (/generate-message),
// rather than a bare acknowledgement.
export async function apiPostJson<T>(path: string, body: unknown): Promise<T> {
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

// ---- Viewer-tab keys ----
// A diff tab's identity is its whole request, encoded into the one string
// openViewerTab takes as a path — cwd, the file, which side, and for a
// rename its orig path — since a transient in-memory map would be empty
// after a fresh page load. NUL can't appear in any of these fields, so it's
// a safe join separator. This composite string is never shown to the user;
// the tab's visible title is set separately via openViewerTab's `title`.
export const KEY_SEP = "\u0000";

// commitHash is a 6th, optional field appended after origPath — set only
// for a COMMITS-row or commit-details diff, empty/absent for every existing
// staged/working-tree/untracked diff. A key persisted before this field
// existed simply decodes with commitHash undefined (split() yields one
// fewer element than the destructure has names), so old tabs restore
// unchanged.
export function encodeDiffKey(
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
// working-tree distinction for an unmerged path) — reusing KEY_SEP keeps
// decode symmetric with encodeDiffKey even though there's nothing else to
// encode.
export function encodeConflictKey(cwd: string, path: string): string {
  return [cwd, path].join(KEY_SEP);
}

export function decodeConflictKey(key: string): { cwd: string; path: string } {
  const [cwd, path] = key.split(KEY_SEP);
  return { cwd, path };
}

// A commit-details tab: the repo, the commit, and whether its file list is
// read against the first parent (stash entries and merges).
export function encodeCommitKey(root: string, hash: string, firstParent?: boolean): string {
  return [root, hash, firstParent ? "1" : ""].join(KEY_SEP);
}

export function decodeCommitKey(key: string): { root: string; hash: string; firstParent: boolean } {
  const [root, hash, firstParent] = key.split(KEY_SEP);
  return { root, hash, firstParent: firstParent === "1" };
}

// A commit-details tab for one commit, by whatever opened it: a COMMITS
// row, a STASH row, a tag, or a parent link inside another details tab.
export function openCommitDetails(root: string, hash: string, subject: string, firstParent?: boolean) {
  openViewerTab?.("commit", encodeCommitKey(root, hash, firstParent), {
    title: `${shortHash(hash)} ${subject}`,
  });
}

// ---- Background status polling ----
// Drives the Source Control sidebar badge independent of GitPanel's mount
// state. Sidebar.tsx only mounts GitPanel once the git tab is selected, so
// without this the badge stayed empty until the user opened the tab at
// least once. Started/stopped from activate()/deactivate(); every pane
// subscribes to the same status stream instead of fetching its own copy.
let currentStatus: StatusResponse | null = null;
export const statusListeners = new Set<(status: StatusResponse | null) => void>();
const fetchErrorListeners = new Set<(message: string) => void>();
let pollCwd: string | null = null;
let pollTimer: number | null = null;
let lastPollMs = 0;

export function getCurrentStatus(): StatusResponse | null {
  return currentStatus;
}

export function onFetchError(cb: (message: string) => void): () => void {
  fetchErrorListeners.add(cb);
  return () => fetchErrorListeners.delete(cb);
}

// What changed between two status ticks, for the panes that hold their own
// lists. The store can't call refreshCommits/refreshRefs directly without
// importing the panes it exists to serve, so it publishes the change and
// each pane decides.
export interface HistoryChange {
  root: string;
  headChanged: boolean;
  stashChanged: boolean;
  // HEAD, the branch, its upstream or its ahead/behind counts moved — the
  // BRANCHES pane's cue that its listing is stale.
  refsChanged: boolean;
}

export const historyListeners = new Set<(change: HistoryChange) => void>();

// Run after every manual refresh (a post-operation refresh, the Refresh
// command): the FILES-tree decoration scan registers itself here so badges
// never lag a poll tick behind the panel.
const refreshHooks = new Set<() => void>();

export function registerRefreshHook(hook: () => void): () => void {
  refreshHooks.add(hook);
  return () => refreshHooks.delete(hook);
}

// How many files a status describes as changed. Distinct paths: a file
// that is both staged and modified again appears in two of the lists and
// is still one change. Behind the sidebar badge and the status-bar item's
// dirty marker, which must never disagree about it.
export function changeCount(status: StatusResponse | null): number {
  if (!status?.root) return 0;
  return new Set(
    [...(status.staged ?? []), ...(status.unstaged ?? []), ...(status.conflicted ?? [])].map((e) => e.path),
  ).size;
}

function updateBadge(status: StatusResponse | null) {
  const count = changeCount(status);
  setSidebarBadge?.("git", count > 0 ? count : null);
}

// What the last status said about history, stashes and refs, so a poll tick
// can tell a commit, stash or branch switch made outside the panel (in a
// terminal, by an agent) from one it already knows about. Compared within
// one repo only: a repo switch is the panes' own business.
interface SeenHistory {
  root: string;
  head: string | null;
  stashHead: string | null;
  stashCount: number;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

let seenHistory: SeenHistory | null = null;

export function setSharedStatus(next: StatusResponse | null) {
  currentStatus = next;
  updateBadge(next);
  statusListeners.forEach((cb) => cb(next));
  if (!next?.root) {
    seenHistory = null;
    return;
  }
  const now: SeenHistory = {
    root: next.root,
    head: next.head ?? null,
    stashHead: next.stashHead ?? null,
    stashCount: next.stashCount ?? 0,
    branch: next.branch ?? null,
    upstream: next.upstream ?? null,
    ahead: next.ahead ?? 0,
    behind: next.behind ?? 0,
  };
  if (seenHistory && seenHistory.root === now.root) {
    const headChanged = seenHistory.head !== now.head;
    const stashChanged =
      seenHistory.stashHead !== now.stashHead || seenHistory.stashCount !== now.stashCount;
    const refsChanged =
      headChanged ||
      seenHistory.branch !== now.branch ||
      seenHistory.upstream !== now.upstream ||
      seenHistory.ahead !== now.ahead ||
      seenHistory.behind !== now.behind;
    if (headChanged || stashChanged || refsChanged) {
      historyListeners.forEach((cb) => cb({ root: now.root, headChanged, stashChanged, refsChanged }));
    }
  }
  seenHistory = now;
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

export function refreshStatus() {
  if (pollCwd) fetchStatus(pollCwd);
  // Manual refreshes are exactly the moments (post-op, refresh button)
  // where tree badges must not lag a poll tick behind the panel.
  refreshHooks.forEach((hook) => hook());
}

export function restartPolling() {
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

export function pollIntervalChanged(): boolean {
  return readPollInterval() !== lastPollMs;
}

export function setPollCwd(cwd: string | null, onChange?: () => void) {
  if (cwd === pollCwd) return;
  pollCwd = cwd;
  restartPolling();
  onChange?.();
}

export function getPollCwd(): string | null {
  return pollCwd;
}

export function stopPolling() {
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
  pollCwd = null;
  currentStatus = null;
  seenHistory = null;
}

// Read the stream above from a component. Several things render off it —
// the panel, COMMITS, STASH, BRANCHES and the status-bar item — and none of
// them owns a fetch: whichever happen to be mounted all see the one poll
// started in activate(). The mount-time re-read covers the gap between the
// initial state and the subscription.
export function useSharedStatus(): StatusResponse | null {
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

// ---- Network operations and the credential relay ----
//
// Push, pull and their variants can stop to ask for a username, a password,
// an SSH passphrase or a host-key confirmation. The server parks each
// question against the op id and the client polls for it; that poll used to
// live inside GitPanel, which made it unreachable from any other pane. It
// runs here now: any pane can start a network op, and the one form that
// answers the questions stays in SOURCE CONTROL, where credential UI
// belongs (BRANCHES reveals that panel when a prompt appears).

// Mirrors server.js's pending-prompt shape: kind drives which form variant
// renders, prompt is git/ssh's own text shown verbatim (for hostkey it
// carries the fingerprint the user is confirming).
export interface AuthPrompt {
  id: string;
  kind: "username" | "password" | "passphrase" | "hostkey" | "generic";
  prompt: string;
}

export type NetworkKind =
  | "push"
  | "pull"
  | "pull-rebase"
  | "sync"
  | "publish"
  | "push-force-lease"
  | "push-delete"
  | "push-tag";

export const authPromptListeners = new Set<(prompt: AuthPrompt | null) => void>();

let activeOpId: string | null = null;
let activePrompt: AuthPrompt | null = null;

function setAuthPrompt(next: AuthPrompt | null) {
  if (activePrompt?.id === next?.id) return;
  activePrompt = next;
  authPromptListeners.forEach((cb) => cb(next));
}

export function getAuthPrompt(): AuthPrompt | null {
  return activePrompt;
}

// Fire-and-forget: the reply's outcome surfaces through the still-open
// network-op request, not this call.
export function replyToPrompt(body: Record<string, unknown>) {
  const prompt = activePrompt;
  const opId = activeOpId;
  if (!prompt || !opId) return;
  setAuthPrompt(null);
  apiPost("/prompt-reply", { op: opId, id: prompt.id, ...body }).catch(() => {});
}

export function cancelPrompt() {
  replyToPrompt({ cancel: true });
}

export async function runNetworkOp(kind: NetworkKind, params: Record<string, unknown>): Promise<void> {
  const opId = crypto.randomUUID();
  activeOpId = opId;
  // 300ms keeps a relayed prompt visible ≤ ~350ms after git asks; polling
  // only runs while this op's request is in flight.
  const pollTimer = window.setInterval(async () => {
    if (activeOpId !== opId) return;
    try {
      const data = await apiGetJson<{ prompt: AuthPrompt | null }>(`/prompt?op=${opId}`);
      if (activeOpId !== opId) return;
      setAuthPrompt(data.prompt);
    } catch {
      // Transient poll failure — the op request itself surfaces errors.
    }
  }, 300);
  try {
    await apiPost(`/${kind}`, { ...params, opId });
  } finally {
    window.clearInterval(pollTimer);
    if (activeOpId === opId) activeOpId = null;
    setAuthPrompt(null);
  }
}
