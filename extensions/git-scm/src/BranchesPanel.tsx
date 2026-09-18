// BRANCHES: the repository's local branches, its remote branches and its
// tags, with the operations that act on them. Its own sidebar pane (like
// COMMITS and STASH) rather than a section inside GitPanel, so it collapses,
// resizes and moves on its own.
//
// The listing is one /refs round trip, held module-level for the same reason
// the COMMITS and STASH stores are: the host unmounts a collapsed pane, and
// a collapse shouldn't throw the list away. It refreshes when the status
// poll reports that HEAD, the branch or its upstream moved (a switch or a
// commit in a terminal shows up on the next tick), after every operation
// here, and on a slow timer for everything else — a branch created in
// another worktree moves no ref this repo's status reports.
import { useCallback, useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import { useLongPressMenu } from "../../_shared/useLongPressMenu";
import {
  ApiError,
  apiGetJson,
  apiPost,
  confirmDialog,
  formatAbsoluteTime,
  formatRelativeTime,
  historyListeners,
  openCommitDetails,
  promptDialog,
  refreshFiles,
  refreshStatus,
  revealSidebarPanel,
  runNetworkOp,
  shortHash,
  useSharedStatus,
  type HistoryChange,
  type PanelProps,
} from "./host";

// ---- Types (mirror server.js's /refs reply) ----

export interface LocalBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  // The upstream is configured but no longer exists on the remote.
  gone: boolean;
  hash: string;
  timestamp: number;
  subject: string;
}

export interface RemoteBranch {
  remote: string;
  name: string;
  // "origin/main" — what git wants as a ref, kept whole so the row never
  // has to re-join the two halves.
  ref: string;
  hash: string;
  timestamp: number;
}

export interface TagRef {
  name: string;
  hash: string;
  // An annotated tag is its own object; targetHash is the commit under it.
  targetHash: string | null;
  annotated: boolean;
  timestamp: number;
  subject: string;
}

interface RefsResponse {
  current: string | null;
  detached: boolean;
  local: LocalBranch[];
  remotes: RemoteBranch[];
  tags: TagRef[];
}

interface RefsState extends RefsResponse {
  loading: boolean;
  root: string | null;
}

const EMPTY_REFS: RefsState = {
  current: null,
  detached: false,
  local: [],
  remotes: [],
  tags: [],
  loading: false,
  root: null,
};

// ---- Store ----

let refsState: RefsState = EMPTY_REFS;
const refsListeners = new Set<(state: RefsState) => void>();
// Whoever wants to know the list changed — the quick-switcher provider's
// refresh() handle, registered from activate().
const refsChangeListeners = new Set<() => void>();

function setRefsState(next: RefsState) {
  refsState = next;
  refsListeners.forEach((cb) => cb(next));
  refsChangeListeners.forEach((cb) => cb());
}

export function onRefsChange(cb: () => void): () => void {
  refsChangeListeners.add(cb);
  return () => refsChangeListeners.delete(cb);
}

export function getRefs(): RefsState {
  return refsState;
}

async function fetchRefs(root: string) {
  setRefsState({ ...refsState, root, loading: true });
  try {
    const data = await apiGetJson<RefsResponse>(`/refs?cwd=${encodeURIComponent(root)}`);
    // A repo switch mid-flight makes this response the wrong listing —
    // drop it and let the switch's own fetch win.
    if (refsState.root !== root) return;
    setRefsState({ ...data, loading: false, root });
  } catch {
    // Best-effort — keep the last-good list; the pane's error line carries
    // whatever the user's own action failed with.
    if (refsState.root === root) setRefsState({ ...refsState, loading: false });
  }
}

export function refreshRefs() {
  if (refsState.root) fetchRefs(refsState.root);
}

// A switch, a commit or a push moves refs this pane lists.
function onHistoryChange(change: HistoryChange) {
  if (change.refsChanged && refsState.root === change.root) fetchRefs(change.root);
}

historyListeners.add(onHistoryChange);

export function resetRefsStore() {
  refsState = EMPTY_REFS;
  refsListeners.clear();
  refsChangeListeners.clear();
  historyListeners.delete(onHistoryChange);
}

function useRefs(): RefsState {
  const [state, setState] = useState<RefsState>(() => refsState);
  useEffect(() => {
    setState(refsState);
    refsListeners.add(setState);
    return () => {
      refsListeners.delete(setState);
    };
  }, []);
  return state;
}

// Nothing in this repo's own status moves when a branch is created in
// another worktree or by a background tool, so the pane also re-reads on a
// slow beat while it is mounted.
const REFS_POLL_MS = 15_000;

// ---- Collapsed groups ----

const COLLAPSED_KEY = "gitScm.branchesCollapsed";
type GroupId = "remotes" | "tags";

function readCollapsed(): Set<GroupId> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    // Remotes start collapsed: a repo with a dozen remote branches would
    // otherwise bury the local ones the user actually switches between.
    if (!Array.isArray(raw)) return new Set<GroupId>(["remotes"]);
    return new Set(raw.filter((id): id is GroupId => id === "remotes" || id === "tags"));
  } catch {
    return new Set<GroupId>(["remotes"]);
  }
}

function writeCollapsed(ids: Set<GroupId>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // A storage quota or a private window — collapse state is a
    // convenience, never a correctness matter.
  }
}

// ---- Checkout helpers, shared with the quick-switcher provider ----

export async function checkoutLocal(root: string, name: string) {
  await apiPost("/checkout", { cwd: root, branch: name });
}

// A remote row: start tracking it under the same local name, or just switch
// when that local branch already exists (the server decides, since only it
// can see whether refs/heads/<name> is there).
export async function checkoutRemote(root: string, branch: RemoteBranch) {
  await apiPost("/checkout", { cwd: root, branch: branch.name, track: branch.ref });
}

// ---- Rows ----

interface RowProps {
  icon: string;
  label: string;
  detail?: string;
  title?: string;
  current?: boolean;
  disabled?: boolean;
  indent?: boolean;
  onClick: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  longPress: ReturnType<ReturnType<typeof useLongPressMenu>>;
}

function RefRow({
  icon,
  label,
  detail,
  title,
  current,
  disabled,
  indent,
  onClick,
  onContextMenu,
  longPress,
}: RowProps) {
  return (
    <div
      className={`git-ref-row${current ? " current" : ""}${indent ? " indent" : ""}`}
      title={title}
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!disabled) onClick();
      }}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={onContextMenu}
      {...longPress}
    >
      <Icon name={icon} className="git-ref-icon" />
      <span className="git-ref-name">{label}</span>
      {current && <Icon name="check" className="git-ref-current" />}
      {detail && <span className="git-ref-detail">{detail}</span>}
    </div>
  );
}

function GroupRow({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button className="git-ref-group" onClick={onToggle} aria-expanded={!collapsed}>
      <Icon name={collapsed ? "chevron-right" : "chevron-down"} />
      <span className="git-ref-group-label">{label}</span>
      <span className="git-ref-group-count">{count}</span>
    </button>
  );
}

// ---- Panel ----

export default function BranchesPanel({ actionsTarget, showMenu }: PanelProps) {
  const status = useSharedStatus();
  const refs = useRefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<GroupId>>(() => readCollapsed());
  const bindMenu = useLongPressMenu();

  const root = status?.root ?? null;

  // First mount in a repo, and every repo switch, refetches; re-expanding
  // the pane in the same repo paints the cached list first.
  useEffect(() => {
    if (root && root !== refsState.root) fetchRefs(root);
  }, [root]);

  useEffect(() => {
    if (!root) return;
    const timer = window.setInterval(() => {
      if (refsState.root === root) fetchRefs(root);
    }, REFS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [root]);

  const toggleGroup = (id: GroupId) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsed(next);
      return next;
    });
  };

  // Every operation here changes something the rest of the panel renders:
  // refresh the status (branch name, ahead/behind, the status bar), the
  // FILES tree (a switch rewrites the working tree) and this listing.
  const runOp = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refreshStatus();
      refreshFiles?.();
      refreshRefs();
    }
  }, []);

  // A remote operation can stop to ask for credentials, and that form lives
  // in SOURCE CONTROL — reveal it so the question isn't asked off-screen.
  const runRemote = useCallback(
    (kind: Parameters<typeof runNetworkOp>[0], params: Record<string, unknown>) =>
      runOp(async () => {
        revealSidebarPanel?.("git");
        await runNetworkOp(kind, { cwd: root, ...params });
      }),
    [root, runOp],
  );

  const ask = async (message: string, defaultValue?: string): Promise<string | null> => {
    const answer = await promptDialog?.(message, defaultValue);
    const trimmed = answer?.trim();
    return trimmed ? trimmed : null;
  };

  const confirm = async (message: string, label: string): Promise<boolean> =>
    (await confirmDialog?.(message, label)) ?? false;

  const createBranch = async (from?: string) => {
    const name = await ask(from ? `New branch from ${from}` : "New branch name");
    if (!name || !root) return;
    await runOp(() => apiPost("/branch-create", { cwd: root, name, from, checkout: true }));
  };

  const createTag = async (target?: string) => {
    const name = await ask(target ? `New tag at ${target}` : "New tag name");
    if (!name || !root) return;
    const message = (await promptDialog?.("Tag message (leave empty for a lightweight tag)"))?.trim() ?? "";
    await runOp(() => apiPost("/tag-create", { cwd: root, name, target, message }));
  };

  const deleteBranch = async (name: string) => {
    if (!root) return;
    if (!(await confirm(`Delete branch ${name}?`, "Delete"))) return;
    await runOp(async () => {
      try {
        await apiPost("/branch-delete", { cwd: root, name, force: false });
      } catch (err) {
        // git refuses a branch whose work isn't merged anywhere. That's the
        // one refusal worth offering to override, and only after saying so.
        if (err instanceof ApiError && err.unmerged) {
          if (!(await confirm(`Branch ${name} is not fully merged. Delete anyway?`, "Delete Anyway"))) return;
          await apiPost("/branch-delete", { cwd: root, name, force: true });
          return;
        }
        throw err;
      }
    });
  };

  const renameBranch = async (name: string) => {
    const newName = await ask(`Rename branch ${name} to`, name);
    if (!newName || !root || newName === name) return;
    await runOp(() => apiPost("/branch-rename", { cwd: root, name, newName }));
  };

  const localMenu = (branch: LocalBranch): MenuItem[] => {
    const isCurrent = branch.name === refs.current;
    const items: MenuItem[] = [];
    if (!isCurrent) items.push({ label: "Switch to Branch", onClick: () => void runOp(() => checkoutLocal(root!, branch.name)) });
    items.push({ label: "Create Branch From…", onClick: () => void createBranch(branch.name) });
    items.push({ label: "Create Tag Here…", onClick: () => void createTag(branch.name) });
    if (!isCurrent) {
      items.push({ label: "Merge into Current", onClick: () => void runOp(() => apiPost("/merge", { cwd: root, ref: branch.name })) });
      items.push({ label: "Rebase Current onto This", onClick: () => void runOp(() => apiPost("/rebase", { cwd: root, ref: branch.name })) });
    }
    if (isCurrent && !branch.upstream) {
      items.push({ label: "Publish Branch", onClick: () => void runRemote("publish", {}) });
    }
    items.push({ label: "Rename…", onClick: () => void renameBranch(branch.name) });
    if (!isCurrent) items.push({ label: "Delete", danger: true, onClick: () => void deleteBranch(branch.name) });
    items.push({ label: "Copy Name", onClick: () => void navigator.clipboard?.writeText(branch.name) });
    return items;
  };

  const remoteMenu = (branch: RemoteBranch): MenuItem[] => [
    { label: "Checkout as Local Branch", onClick: () => void runOp(() => checkoutRemote(root!, branch)) },
    { label: "Merge into Current", onClick: () => void runOp(() => apiPost("/merge", { cwd: root, ref: branch.ref })) },
    {
      label: "Delete Remote Branch",
      danger: true,
      onClick: async () => {
        if (!(await confirm(`Delete ${branch.ref} on the remote?`, "Delete"))) return;
        await runRemote("push-delete", { remote: branch.remote, branch: branch.name });
      },
    },
    { label: "Copy Name", onClick: () => void navigator.clipboard?.writeText(branch.ref) },
  ];

  const tagMenu = (tag: TagRef): MenuItem[] => [
    { label: "Create Branch From…", onClick: () => void createBranch(tag.name) },
    { label: "Push Tag", onClick: () => void runRemote("push-tag", { tag: tag.name }) },
    {
      label: "Delete Tag",
      danger: true,
      onClick: async () => {
        if (!(await confirm(`Delete tag ${tag.name}?`, "Delete"))) return;
        await runOp(() => apiPost("/tag-delete", { cwd: root, name: tag.name }));
      },
    },
    { label: "Copy Name", onClick: () => void navigator.clipboard?.writeText(tag.name) },
  ];

  const openMenu = (items: MenuItem[], e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu?.(e.clientX, e.clientY, items);
  };

  const headerActions = (
    <>
      <button
        className="icon-button"
        title="Create Branch…"
        disabled={busy || !root}
        onClick={() => void createBranch()}
      >
        <Icon name="add" />
      </button>
      <button
        className="icon-button"
        title="Create Tag…"
        disabled={busy || !root}
        onClick={() => void createTag()}
      >
        <Icon name="tag" />
      </button>
      <button
        className="icon-button"
        title="Refresh"
        disabled={busy || !root}
        onClick={() => refreshRefs()}
      >
        <Icon name="refresh" className={refs.loading ? "git-spin" : undefined} />
      </button>
    </>
  );

  const upstreamDetail = (branch: LocalBranch): string => {
    if (!branch.upstream) return "no upstream";
    if (branch.gone) return `${branch.upstream} (gone)`;
    const counts = [branch.behind > 0 ? `↓${branch.behind}` : "", branch.ahead > 0 ? `↑${branch.ahead}` : ""]
      .filter(Boolean)
      .join(" ");
    return counts ? `${branch.upstream} ${counts}` : branch.upstream;
  };

  const byRemote = new Map<string, RemoteBranch[]>();
  for (const branch of refs.remotes) {
    const list = byRemote.get(branch.remote);
    if (list) list.push(branch);
    else byRemote.set(branch.remote, [branch]);
  }

  return (
    <div className="git-panel git-branches-panel">
      {actionsTarget && createPortal(headerActions, actionsTarget)}
      {error && (
        <div className="git-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {!root ? (
        <div className="git-empty">Not a git repository.</div>
      ) : refs.root !== root && refs.loading ? (
        <div className="git-empty">Loading…</div>
      ) : refs.local.length === 0 && refs.tags.length === 0 && refs.remotes.length === 0 ? (
        <div className="git-empty">No branches yet.</div>
      ) : (
        <div className={`git-ref-list${busy ? " busy" : ""}`}>
          {refs.detached && status?.head && (
            <div className="git-ref-row detached" title="HEAD is not on a branch">
              <Icon name="git-commit" className="git-ref-icon" />
              <span className="git-ref-name">detached at {shortHash(status.head)}</span>
            </div>
          )}
          {refs.local.map((branch) => (
            <RefRow
              key={branch.name}
              icon="git-branch"
              label={branch.name}
              detail={`${upstreamDetail(branch)} · ${formatRelativeTime(branch.timestamp)}`}
              title={`${branch.subject}\n${formatAbsoluteTime(branch.timestamp)}`}
              current={branch.name === refs.current}
              disabled={busy}
              onClick={() => {
                if (branch.name !== refs.current) void runOp(() => checkoutLocal(root, branch.name));
              }}
              onContextMenu={(e) => openMenu(localMenu(branch), e)}
              longPress={bindMenu((x, y) => showMenu?.(x, y, localMenu(branch)))}
            />
          ))}

          {refs.remotes.length > 0 && (
            <>
              <GroupRow
                label="Remotes"
                count={refs.remotes.length}
                collapsed={collapsed.has("remotes")}
                onToggle={() => toggleGroup("remotes")}
              />
              {!collapsed.has("remotes") &&
                [...byRemote.entries()].map(([remote, branches]) => (
                  <div key={remote}>
                    <div className="git-ref-subgroup">{remote}</div>
                    {branches.map((branch) => (
                      <RefRow
                        key={branch.ref}
                        icon="cloud"
                        label={branch.name}
                        detail={formatRelativeTime(branch.timestamp)}
                        title={branch.ref}
                        disabled={busy}
                        indent
                        onClick={() => void runOp(() => checkoutRemote(root, branch))}
                        onContextMenu={(e) => openMenu(remoteMenu(branch), e)}
                        longPress={bindMenu((x, y) => showMenu?.(x, y, remoteMenu(branch)))}
                      />
                    ))}
                  </div>
                ))}
            </>
          )}

          {refs.tags.length > 0 && (
            <>
              <GroupRow
                label="Tags"
                count={refs.tags.length}
                collapsed={collapsed.has("tags")}
                onToggle={() => toggleGroup("tags")}
              />
              {!collapsed.has("tags") &&
                refs.tags.map((tag) => (
                  <RefRow
                    key={tag.name}
                    icon="tag"
                    label={tag.name}
                    detail={`${shortHash(tag.targetHash ?? tag.hash)} · ${formatRelativeTime(tag.timestamp)}`}
                    title={tag.annotated ? `${tag.subject}\n${formatAbsoluteTime(tag.timestamp)}` : tag.subject}
                    disabled={busy}
                    indent
                    onClick={() => openCommitDetails(root, tag.targetHash ?? tag.hash, tag.name)}
                    onContextMenu={(e) => openMenu(tagMenu(tag), e)}
                    longPress={bindMenu((x, y) => showMenu?.(x, y, tagMenu(tag)))}
                  />
                ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
