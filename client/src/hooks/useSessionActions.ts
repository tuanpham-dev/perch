import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import { copyText } from "../clipboard";
import {
  bumpRecent,
  isLinkedWorktreePath,
  projectName,
  projectTree,
  sessionNameForBranch,
  sessionNameForProject,
  type ProjectNode,
  type WorktreeNode,
} from "../lib/projects";
import { isRealTab, tabVirtualPath } from "../lib/tabs";
import type { SplitDirection } from "../lib/splits";
import type { AppSettings } from "../settings";
import type { MenuItem, Project, RepoInfo, Tab, TerminalSession, TerminalWindow, WorktreeBranch } from "../types";

// createWindow's server call returns void (see server/src/terminals.ts), so the
// window it just created isn't known until the next session list fetch —
// unlike openProject, whose own create call already carries the fresh
// session's windows. A direct fetch rather than waiting on the `sessions`
// prop: that's React state, still stale within this same callback
// invocation right after refresh() resolves.
async function findActiveWindowIndex(sessionName: string): Promise<number | undefined> {
  const freshSessions = await api.fetchSessions();
  return freshSessions.find((s) => s.name === sessionName)?.windows.find((w) => w.active)?.index;
}

// Types a command into a session that was created moments ago. The session
// does not exist the instant openProject resolves (the backend is caught up on the
// next poll), so a 404 is retried rather than surfaced.
async function sendTextWithRetries(
  sessionName: string,
  text: string,
  retries = 12,
  delayMs = 400,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await api.sendTextToSession(sessionName, text, true);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Session/window CRUD, project open/close/pin/recents (the projects
// registry — see plans/projects-not-sessions.md), and the context menus
// built on top of them (sessionMenuItems/projectMenuItems/
// windowMenuItems/tabMenuItems/recentProjectMenuItems). Takes the
// tab-closing primitives (closeTab/closeOtherTabs) and
// openWindowTab/openAllWindows/projects state as explicit parameters rather
// than reaching into those hooks directly. Sessions have no rename action
// anywhere — a project's name is its folder's, and session names are
// cosmetic (sessionNameForProject), so renaming would only make labels
// diverge.
export function useSessionActions(
  refresh: () => Promise<void>,
  showError: (err: unknown) => void,
  confirmDialog: (message: string, confirmLabel?: string) => Promise<boolean>,
  promptDialog: (message: string, defaultValue?: string) => Promise<string | null>,
  settingsRef: MutableRefObject<AppSettings>,
  tabs: Tab[],
  setTabs: Dispatch<SetStateAction<Tab[]>>,
  sessions: TerminalSession[],
  openSession: (name: string) => void,
  openWindowTab: (session: string, index: number) => Promise<string | null>,
  openAllWindows: (session: string) => Promise<void>,
  closeTab: (id: string) => Promise<void>,
  closeOtherTabs: (id: string) => Promise<void>,
  projects: Project[],
  setProjects: Dispatch<SetStateAction<Project[]>>,
  splitGroup: (direction: SplitDirection, tabId?: string) => Promise<void>,
  moveTabToAdjacentGroup: (tabId: string, direction: "next" | "previous") => void,
  // The FILES tree's resolved root (App.tsx's resolvedFilesRootDir) — the
  // base tabMenuItems' "Copy Relative Path" resolves against, matching the
  // tree's own copyFileRelativePath semantics.
  filesRootDir: string | null,
  // Which repository each session folder belongs to (useWorktrees). Read to
  // keep linked worktrees out of the recent-projects list, and to name a
  // cleanup's target.
  repoIndex: Map<string, RepoInfo>,
) {
  // Opens the project rooted in `cwd`: focuses the live session already
  // rooted there, or creates one — named after the folder, started in
  // exactly that folder (exactCwd) so session_path round-trips and the
  // panel's cwd matching holds. Every open (not a failed create) records
  // the folder into the recents registry via bumpRecent, except a linked
  // worktree: those are reached through their project's worktree level, so
  // opts.recordRecent: false skips it for a worktree the tree doesn't list
  // yet (one created moments ago), and isLinkedWorktreePath catches every
  // other route in (the folder picker, `perch open`). Returns the
  // session's name (undefined on failure) — useOpenTarget's file-open path
  // needs it as the open-file API's session target.
  const openProject = useCallback(
    async (
      cwd: string,
      preferredName?: string,
      opts: { recordRecent?: boolean } = {},
    ): Promise<string | undefined> => {
      const record = () => {
        if (opts.recordRecent === false) return;
        if (isLinkedWorktreePath(repoIndex, cwd, settingsRef.current.worktreeLocation)) return;
        setProjects((prev) => bumpRecent(prev, cwd));
      };
      try {
        const live = sessions.find((s) => s.path === cwd);
        if (live) {
          record();
          const activeIndex =
            live.windows.find((w) => w.active)?.index ?? live.windows[0]?.index;
          if (activeIndex !== undefined) await openWindowTab(live.name, activeIndex);
          return live.name;
        }
        // A worktree passes its branch's name (sessionNameForBranch) so the
        // session reads as the branch rather than as the checkout folder,
        // which for a custom worktree location may not resemble it at all.
        // Still uniquified against the live names, the same as the default.
        const taken = sessions.map((s) => s.name);
        const name = preferredName
          ? sessionNameForProject(preferredName, taken)
          : sessionNameForProject(cwd, taken);
        const created = await api.createSession(name, cwd, true);
        record();
        await refresh();
        const activeIndex = created.windows.find((w) => w.active)?.index;
        if (activeIndex !== undefined) await openWindowTab(created.name, activeIndex);
        return created.name;
      } catch (err) {
        showError(err);
        return undefined;
      }
    },
    [sessions, refresh, openWindowTab, showError, setProjects, repoIndex, settingsRef],
  );

  // Pins/unpins the project a session's folder belongs to (keyed by
  // session_path — rename-proof). Pinning a session in a folder that was
  // never opened as a project registers it; unpinning keeps the entry in
  // recents, it only stops surviving session death.
  // Pins/unpins a folder directly. Worktree rows need this: a worktree with
  // no session has no session name to key off, but it is still a folder the
  // registry can hold.
  const togglePinProject = useCallback(
    (cwd: string) => {
      if (!cwd) return;
      setProjects((prev) => {
        const existing = prev.find((p) => p.cwd === cwd);
        if (existing) return prev.map((p) => (p.cwd === cwd ? { ...p, pinned: !p.pinned } : p));
        return [...prev, { cwd, pinned: true, lastOpened: Date.now() }];
      });
    },
    [setProjects],
  );

  const togglePinSession = useCallback(
    (name: string) => {
      const path = sessions.find((s) => s.name === name)?.path;
      if (path) togglePinProject(path);
    },
    [sessions, togglePinProject],
  );

  const unpinProject = useCallback(
    (cwd: string) => {
      setProjects((prev) => prev.map((p) => (p.cwd === cwd ? { ...p, pinned: false } : p)));
    },
    [setProjects],
  );

  // Forgets a folder entirely (recents entry and pin alike) — the recent
  // dropdown's per-entry trailing action.
  const removeRecentProject = useCallback(
    (cwd: string) => {
      setProjects((prev) => prev.filter((p) => p.cwd !== cwd));
    },
    [setProjects],
  );

  const clearRecentProjects = useCallback(() => {
    setProjects((prev) => prev.filter((p) => p.pinned));
  }, [setProjects]);

  // The unconfirmed kill: the session kill + the window-tab cascade + tab cleanup.
  // Split out from killSession below so a caller that has already confirmed a
  // larger destructive action reuses this exact cleanup instead of prompting
  // twice — notably ctx.app.killSession (extensions.ts), whose contract is
  // caller-confirms. Killing the session behind the app's back is *not* equivalent: window-tabs
  // attach to synthetic grouped perch-view-* sessions whose shared windows
  // outlive the real session, so without closeWindowTab they linger as live but
  // orphaned tabs (viewSweeper only reaps them after 24h *unattached*).
  const killSessionNow = useCallback(
    async (name: string) => {
      try {
        await api.killSession(name);
        for (const t of tabs) {
          if (t.sessionName === name && t.windowIndex !== undefined) {
            api.closeWindowTab(t.attachName).catch(() => {});
          }
        }
        setTabs((prev) => prev.filter((t) => t.sessionName !== name));
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, tabs, setTabs],
  );

  // Closes the whole project a session belongs to: every live session
  // rooted in the same folder dies (a pathless session is just itself).
  // Confirm wording scales with what's actually being closed.
  // Kills a named set of sessions behind one confirm, with wording that
  // scales to what is actually being closed. Shared by closeProject (a whole
  // folder) and the tree's worktree rows (one worktree's sessions), so both
  // ask the same question the same way.
  const closeSessions = useCallback(
    async (label: string, members: TerminalSession[]) => {
      if (members.length === 0) return;
      const terminals = members.reduce((n, s) => n + s.windows.length, 0);
      const detail =
        members.length > 1
          ? `${terminals} terminals across ${members.length} sessions will be closed.`
          : terminals === 1
            ? "Its terminal will be closed."
            : `Its ${terminals} terminals will be closed.`;
      if (
        settingsRef.current.confirmBeforeKill &&
        !(await confirmDialog(`Close project "${label}"? ${detail}`, "Close Project"))
      )
        return;
      for (const s of members) await killSessionNow(s.name);
    },
    [confirmDialog, killSessionNow, settingsRef],
  );

  // Closes the whole project a session belongs to: every live session
  // rooted in the same folder dies (a pathless session is just itself).
  const closeProject = useCallback(
    async (name: string) => {
      const target = sessions.find((s) => s.name === name);
      const members =
        target?.path !== undefined && target.path !== ""
          ? sessions.filter((s) => s.path === target.path)
          : target
            ? [target]
            : [];
      if (members.length === 0) return;
      await closeSessions(target!.path ? projectName(target!.path) : name, members);
    },
    [closeSessions, sessions],
  );

  const createWindow = useCallback(
    async (session: string, cwd?: string) => {
      try {
        await api.createWindow(session, cwd);
        await refresh();
      } catch (err) {
        showError(err);
        return;
      }
      // the backend makes a freshly created window the active one; findActiveWindowIndex
      // fetches it fresh since createWindow's own response carries none.
      const activeIndex = await findActiveWindowIndex(session);
      if (activeIndex !== undefined) await openWindowTab(session, activeIndex);
    },
    [refresh, openWindowTab, showError],
  );

  // Switches which window the *shared* session tab follows (distinct from
  // openWindowTab, which pins a dedicated tab to one specific window).
  const selectWindowInSession = useCallback(
    async (session: string, index: number) => {
      try {
        await api.selectWindow(session, index);
      } catch (err) {
        showError(err);
        return;
      }
      openSession(session);
    },
    [openSession, showError],
  );

  const renameWindow = useCallback(
    async (session: string, win: TerminalWindow) => {
      const newName = (await promptDialog("New terminal name", win.name))?.trim();
      if (!newName || newName === win.name) return;
      try {
        await api.renameWindow(session, win.index, newName);
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, promptDialog],
  );

  // Back to the backend's own naming, which tracks whatever is running in the
  // window ("zsh", "npm", "claude"). Renaming a window is otherwise
  // one-way: the backend turns automatic naming off for any window that gets
  // renamed — by this app, by a rename from inside the terminal, or by a program's own
  // title escape — and it never turns itself back on, so a window renamed
  // once keeps that name for life even as the command changes.
  const resetWindowName = useCallback(
    async (session: string, win: TerminalWindow) => {
      try {
        await api.renameWindow(session, win.index, "");
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError],
  );

  const killWindow = useCallback(
    async (session: string, index: number) => {
      const winName = sessions.find((s) => s.name === session)?.windows.find((w) => w.index === index)?.name;
      if (
        settingsRef.current.confirmBeforeKill &&
        !(await confirmDialog(
          `Close terminal "${winName ?? index}"?`,
          "Close Terminal",
        ))
      )
        return;
      try {
        await api.killWindow(session, index);
        // The tab pinned to this exact window would otherwise silently
        // start showing whatever adjacent window the backend falls back to.
        // closeTab handles the window-tab cascade + neighbor-aware
        // activeTabId update in one place.
        const pinned = tabs.find(
          (t) => t.sessionName === session && t.windowIndex === index,
        );
        if (pinned) closeTab(pinned.id);
        await refresh();
      } catch (err) {
        showError(err);
      }
    },
    [refresh, showError, confirmDialog, tabs, closeTab, settingsRef, sessions],
  );

  // ---- The PROJECTS tree's rows ----
  //
  // Project and worktree rows are both "a folder with some sessions under
  // it", so their actions are the same handful with different targets. See
  // plans/worktrees-into-projects.md.

  // Every session under a project row, wherever it sits — directly on the
  // row for a plain folder, on its worktrees for a repository.
  const sessionsUnder = (node: ProjectNode): TerminalSession[] => [
    ...node.sessions,
    ...node.worktrees.flatMap((w) => w.sessions),
  ];

  // A worktree row's click: focus its most-recent terminal, or start a
  // session in it — named after its branch, not the checkout folder. Never
  // recorded into recents: the worktree is reached through its project. The
  // main worktree is the project's own folder, so that one still counts.
  const openWorktree = useCallback(
    async (node: WorktreeNode) => {
      const recordRecent = node.worktree.main;
      const live = node.sessions[0];
      if (live) {
        const activeIndex = live.windows.find((w) => w.active)?.index ?? live.windows[0]?.index;
        if (activeIndex !== undefined) await openWindowTab(live.name, activeIndex);
        if (recordRecent) setProjects((prev) => bumpRecent(prev, node.worktree.path));
        return;
      }
      const branch = node.worktree.branch;
      await openProject(node.worktree.path, branch ? sessionNameForBranch(branch) : undefined, { recordRecent });
    },
    [openWindowTab, openProject, setProjects],
  );

  const newTerminalInWorktree = useCallback(
    async (node: WorktreeNode) => {
      const live = node.sessions[0];
      if (live) await createWindow(live.name, node.worktree.path);
      else await openWorktree(node);
    },
    [createWindow, openWorktree],
  );

  const newTerminalInProject = useCallback(
    async (node: ProjectNode) => {
      // A repository row has no sessions of its own once they all live on
      // worktrees; its main worktree is the folder "new terminal here" means.
      const live = node.sessions[0] ?? node.worktrees.find((w) => w.worktree.main)?.sessions[0];
      if (live) await createWindow(live.name);
      else if (node.cwd) await openProject(node.cwd);
    },
    [createWindow, openProject],
  );

  // Clean Up Worktrees: removes, in one go, the worktrees of a repository
  // that are safe to lose — a directory that is already gone, or a clean
  // checkout whose commits are all merged. The server decides what is safe;
  // this adds the one thing it can't know, that a worktree still has a
  // session, and leaves those alone. The confirmation lists every removal
  // and every keep with its reason. Branches always survive.
  const cleanUpWorktrees = useCallback(
    async (node: ProjectNode): Promise<void> => {
      const cwd = node.cwd;
      if (!cwd) return;
      let plan: api.WorktreeCleanupPlan;
      try {
        plan = await api.planWorktreeCleanup(cwd);
      } catch (err) {
        showError(err);
        return;
      }
      const withSessions = new Set(node.worktrees.filter((w) => w.sessions.length > 0).map((w) => w.key));
      const label = (e: { path: string; branch: string | null }) => e.branch ?? projectName(e.path);
      const remove = plan.removable.filter((e) => !withSessions.has(e.path));
      const kept = [
        ...plan.removable
          .filter((e) => withSessions.has(e.path))
          .map((e) => ({ name: label(e), why: "has a session" })),
        ...plan.kept.map((e) => ({
          name: label(e),
          why: e.reason === "dirty" ? "uncommitted changes" : e.reason === "locked" ? "locked" : "not merged",
        })),
      ];
      const keptLines = kept.map((k) => `  ${k.name} - ${k.why}`).join("\n");
      const repoName = projectName(plan.repo);
      if (remove.length === 0) {
        showError(
          kept.length > 0
            ? `Nothing to clean up in ${repoName}. Every worktree is kept: ${kept.map((k) => `${k.name} (${k.why})`).join(", ")}.`
            : `Nothing to clean up in ${repoName}. It has no worktrees besides its own checkout.`,
        );
        return;
      }
      const removeLines = remove
        .map((e) => `  ${label(e)} - ${e.reason === "missing" ? "folder already deleted" : "merged, no changes"}`)
        .join("\n");
      const message =
        `Remove ${remove.length === 1 ? "1 worktree" : `${remove.length} worktrees`} from ${repoName}?\n\n${removeLines}` +
        (kept.length > 0 ? `\n\nKept:\n${keptLines}` : "") +
        "\n\nBranches are kept.";
      if (!(await confirmDialog(message, "Clean Up"))) return;
      try {
        const result = await api.cleanUpWorktrees({ cwd: plan.repo, paths: remove.map((e) => e.path) });
        await refresh();
        if (result.skipped.length > 0) {
          showError(
            `Removed ${result.removed.length}, skipped ${result.skipped.length}: ` +
              result.skipped.map((s) => `${projectName(s.path)} (${s.error})`).join(", "),
          );
        }
      } catch (err) {
        showError(err);
      }
    },
    [confirmDialog, refresh, showError],
  );

  // Menu for a project row: a plain folder or a repository header. Pin state
  // is the registry's flag for the row's folder.
  const projectMenuItems = useCallback(
    (node: ProjectNode): MenuItem[] => {
      const all = sessionsUnder(node);
      const items: MenuItem[] = [];
      if (node.sessions.length > 0) {
        items.push({ label: "Open All Terminals", onClick: () => openAllWindows(node.sessions[0].name) });
      } else if (node.cwd) {
        items.push({ label: "Open Project", onClick: () => void openProject(node.cwd!) });
      }
      items.push({ label: "New Terminal", onClick: () => void newTerminalInProject(node) });
      if (node.cwd) {
        items.push({
          label: node.pinned ? "Unpin Project" : "Pin Project",
          onClick: () => togglePinProject(node.cwd!),
        });
      }
      if (all.length > 0) {
        items.push({ label: "Close Project", danger: true, onClick: () => void closeSessions(node.label, all) });
      }
      // A repository row with a worktree level — the only kind with linked
      // worktrees to clean up.
      if (node.worktrees.length > 1) {
        items.push({ label: "", separator: true, onClick: () => {} });
        items.push({ label: "Clean Up Worktrees…", onClick: () => void cleanUpWorktrees(node) });
      }
      return items;
    },
    [
      cleanUpWorktrees,
      openProject,
      openAllWindows,
      newTerminalInProject,
      togglePinProject,
      closeSessions,
    ],
  );

  // The local branches a repository's create form offers. Fetched on demand
  // (not on the tree's poll): only the form ever wants them.
  const loadWorktreeBranches = useCallback(async (cwd: string): Promise<WorktreeBranch[]> => {
    try {
      const { results } = await api.getWorktrees([cwd], { branches: true });
      return results[0]?.branches ?? [];
    } catch {
      return [];
    }
  }, []);

  // Creates the checkout, opens a session rooted in it named after the
  // branch, and optionally runs a command in that session. The command is
  // not awaited — the form shouldn't stay busy for the retry window, and the
  // session exists only moments after openProject returns, so the send
  // retries rather than failing on the first 404.
  const createWorktreeSession = useCallback(
    async (opts: {
      cwd: string;
      branch: string;
      base?: string;
      mode: "new" | "existing";
      sessionName?: string;
      runCommand?: string;
    }): Promise<void> => {
      let created: { path: string; branch: string };
      try {
        created = await api.createWorktree({
          cwd: opts.cwd,
          branch: opts.branch,
          base: opts.base,
          mode: opts.mode,
          location: settingsRef.current.worktreeLocation,
        });
      } catch (err) {
        showError(err);
        return;
      }
      // Not in the tree's listing until its next poll, so the recents skip
      // has to be explicit here.
      const name = await openProject(
        created.path,
        opts.sessionName?.trim() || sessionNameForBranch(created.branch),
        { recordRecent: false },
      );
      if (!name || !opts.runCommand) return;
      void sendTextWithRetries(name, opts.runCommand).catch((err: unknown) => showError(err));
    },
    [openProject, showError, settingsRef],
  );

  // Removes a worktree, optionally killing its sessions first. The three
  // confirmations spell out what survives: the branch always does, and a
  // session left running would be sitting in a deleted directory.
  const removeWorktree = useCallback(
    async (node: WorktreeNode, alsoKillSessions: boolean): Promise<void> => {
      const wt = node.worktree;
      const names = node.sessions.map((s) => s.name).join(", ");
      const message = alsoKillSessions
        ? `Kill ${node.sessions.length > 1 ? `sessions "${names}"` : `session "${names}"`} and remove the worktree at ${wt.path}?\n\nThe branch "${node.label}" is kept.`
        : node.sessions.length > 0
          ? `Remove the worktree at ${wt.path}?\n\n${node.sessions.length > 1 ? `Sessions "${names}" are` : `Session "${names}" is`} left running - their shells will be sitting in a deleted directory. The branch "${node.label}" is kept.`
          : `Remove the worktree at ${wt.path}?\n\nThe branch "${node.label}" is kept.`;
      if (!(await confirmDialog(message, alsoKillSessions ? "Kill & Remove" : "Remove Worktree"))) return;
      if (alsoKillSessions) for (const s of node.sessions) await killSessionNow(s.name);
      try {
        await api.removeWorktree({ cwd: node.repo, path: wt.path });
        await refresh();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // git refuses to drop a worktree with modified/untracked files; that
        // is the one case worth a second, explicit prompt rather than an
        // error banner.
        if (!/use --force|contains modified or untracked/i.test(message)) {
          showError(err);
          return;
        }
        const forced = await confirmDialog(
          `${wt.path} has uncommitted changes.\n\nRemove it anyway? The changes are discarded and can't be recovered.`,
          "Force Remove",
        );
        if (!forced) return;
        try {
          await api.removeWorktree({ cwd: node.repo, path: wt.path, force: true });
          await refresh();
        } catch (forceErr) {
          showError(forceErr);
        }
      }
    },
    [confirmDialog, killSessionNow, refresh, showError],
  );

  // Menu for a worktree row: the session side, then the git side.
  const worktreeMenuItems = useCallback(
    (node: WorktreeNode): MenuItem[] => {
      const items: MenuItem[] = [
        {
          label: node.sessions.length > 0 ? "Open Session" : "Start Session Here",
          onClick: () => void openWorktree(node),
        },
        { label: "New Terminal", onClick: () => void newTerminalInWorktree(node) },
        {
          label: node.pinned ? "Unpin Project" : "Pin Project",
          onClick: () => togglePinProject(node.worktree.path),
        },
      ];
      if (node.sessions.length > 0) {
        items.push({
          label: "Close Project",
          danger: true,
          onClick: () => void closeSessions(node.label, node.sessions),
        });
      }
      // The main worktree is the repository itself — git refuses to remove
      // it, so the entries aren't offered.
      if (!node.worktree.main) {
        items.push({ label: "", separator: true, onClick: () => {} });
        if (node.sessions.length > 0) {
          items.push({
            label: "Kill Sessions & Remove Worktree…",
            danger: true,
            onClick: () => void removeWorktree(node, true),
          });
        }
        items.push({
          label: "Remove Worktree…",
          danger: true,
          onClick: () => void removeWorktree(node, false),
        });
      }
      return items;
    },
    [openWorktree, newTerminalInWorktree, togglePinProject, closeSessions, removeWorktree],
  );

  // The recent-projects header dropdown: pinned folders first, then the rest,
  // each group MRU-first. A pinned folder already in the sidebar (a project or
  // worktree row) is left out: it is one click away there. A row opens its
  // project; its trailing action unpins a pinned folder and forgets any other.
  // Footer offers the folder picker and the bulk clear (which keeps pins).
  const recentProjectMenuItems = useCallback(
    (openFolderPicker: () => void): MenuItem[] => {
      const onScreen = new Set<string>();
      for (const node of projectTree(sessions, projects, repoIndex)) {
        if (node.cwd) onScreen.add(node.cwd);
        for (const wt of node.worktrees) onScreen.add(wt.key);
      }
      const sorted = [...projects].sort((a, b) => b.lastOpened - a.lastOpened);
      const pinned = sorted.filter((p) => p.pinned && !onScreen.has(p.cwd));
      const recent = sorted.filter((p) => !p.pinned);
      const items: MenuItem[] = [
        ...pinned.map((p) => ({
          label: `${projectName(p.cwd)} - ${p.cwd}`,
          icon: "pinned",
          onClick: () => openProject(p.cwd),
          trailing: { icon: "close", title: "Unpin Project", onClick: () => unpinProject(p.cwd) },
        })),
        ...(pinned.length > 0 && recent.length > 0 ? [{ label: "", separator: true, onClick: () => {} }] : []),
        ...recent.map((p) => ({
          label: `${projectName(p.cwd)} - ${p.cwd}`,
          icon: "folder",
          onClick: () => openProject(p.cwd),
          trailing: { icon: "close", title: "Remove from Recent", onClick: () => removeRecentProject(p.cwd) },
        })),
      ];
      if (items.length === 0) {
        items.push({ label: "No recent projects", disabled: true, onClick: () => {} });
      }
      items.push({ label: "", separator: true, onClick: () => {} });
      items.push({ label: "Open Folder…", onClick: openFolderPicker });
      if (projects.some((p) => !p.pinned)) {
        items.push({ label: "Clear Recently Opened", onClick: clearRecentProjects });
      }
      return items;
    },
    [sessions, projects, repoIndex, openProject, unpinProject, removeRecentProject, clearRecentProjects],
  );

  const windowMenuItems = useCallback(
    (session: string, win: TerminalWindow): MenuItem[] => [
      { label: "Select Terminal", onClick: () => selectWindowInSession(session, win.index) },
      { label: "New Terminal", onClick: () => createWindow(session) },
      { label: "Rename Terminal…", onClick: () => renameWindow(session, win) },
      { label: "Reset Name", onClick: () => resetWindowName(session, win) },
      {
        label: "Close Terminal",
        danger: true,
        onClick: () => killWindow(session, win.index),
      },
    ],
    [selectWindowInSession, createWindow, renameWindow, resetWindowName, killWindow],
  );

  const tabMenuItems = useCallback(
    (tab: Tab): MenuItem[] => {
      // Splits always duplicate `tab` specifically (not whatever's active),
      // matching VS Code's own tab-context-menu split items — see
      // useTabs.ts's duplicateTabToGroup for what each tab kind duplicates
      // into the new group.
      const splitItems: MenuItem[] = [
        { label: "Split Up", onClick: () => splitGroup("up", tab.id) },
        { label: "Split Down", onClick: () => splitGroup("down", tab.id) },
        { label: "Split Left", onClick: () => splitGroup("left", tab.id) },
        { label: "Split Right", onClick: () => splitGroup("right", tab.id) },
        {
          label: "Move into Next Group",
          onClick: () => moveTabToAdjacentGroup(tab.id, "next"),
        },
      ];
      const closeItems: MenuItem[] = [
        { label: "Close Tab", onClick: () => closeTab(tab.id) },
        { label: "Close Other Tabs", onClick: () => closeOtherTabs(tab.id) },
      ];
      // A viewer tab shows a file, so its menu offers the same path copies
      // as the FILES tree's row menu (useFileActions), against the same
      // root. Falls back to the absolute path when the file lies outside
      // the current root — e.g. a preview left open after switching to a
      // session in another repo.
      const virtualPath = tabVirtualPath(tab);
      const pathItems: MenuItem[] =
        virtualPath === undefined
          ? []
          : [
              { label: "Copy Path", onClick: () => copyText(virtualPath).catch(showError) },
              {
                label: "Copy Relative Path",
                onClick: () => {
                  const rel =
                    filesRootDir && virtualPath.startsWith(filesRootDir + "/")
                      ? virtualPath.slice(filesRootDir.length + 1)
                      : virtualPath;
                  copyText(rel).catch(showError);
                },
              },
            ];
      // Virtual tabs (image/markdown preview) have no session — New
      // Window/Close Project don’t apply.
      if (!isRealTab(tab)) return [...splitItems, ...closeItems, ...pathItems];
      return [
        ...splitItems,
        ...closeItems,
        { label: "New Terminal", onClick: () => createWindow(tab.sessionName) },
        {
          label: "Close Project",
          danger: true,
          onClick: () => closeProject(tab.sessionName),
        },
      ];
    },
    [
      closeTab,
      closeOtherTabs,
      createWindow,
      closeProject,
      splitGroup,
      moveTabToAdjacentGroup,
      filesRootDir,
      showError,
    ],
  );

  return {
    closeProject,
    killSessionNow,
    createWindow,
    selectWindowInSession,
    renameWindow,
    resetWindowName,
    killWindow,
    togglePinSession,
    openProject,
    projectMenuItems,
    worktreeMenuItems,
    createWorktreeSession,
    loadWorktreeBranches,
    openWorktree,
    newTerminalInProject,
    newTerminalInWorktree,
    togglePinProject,
    cleanUpWorktrees,
    recentProjectMenuItems,
    windowMenuItems,
    tabMenuItems,
  };
}
