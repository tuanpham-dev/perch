// What a commit row offers: the menu built for a COMMITS row (and reused by
// anything else that lists commits), plus the confirm wording each
// destructive entry asks with.
//
// MenuItem has no submenu and no disabled state (extensions/_shared/
// types.ts), so Reset is three sibling entries rather than a nested one, and
// an entry that wouldn't apply is left out instead of greyed — the same rule
// the More Actions menu already follows.
import type { MenuItem } from "../../_shared/types";
import { copyText } from "../../_shared/clipboard";
import { apiPost, shortHash, type CommitEntry, type StatusResponse } from "./host";

export type ResetMode = "soft" | "mixed" | "hard";

export const RESET_LABEL: Record<ResetMode, string> = {
  soft: "Soft - keep the changes staged",
  mixed: "Mixed - keep the changes unstaged",
  hard: "Hard - discard the changes",
};

export interface CommitMenuDeps {
  root: string;
  commit: CommitEntry;
  status: StatusResponse | null;
  // The panel's own runOp: reports errors in its error line and refreshes
  // status, files and the panes afterwards.
  run: (fn: () => Promise<void>) => void;
  confirm: (message: string, confirmLabel: string) => Promise<boolean>;
  ask: (message: string, defaultValue?: string) => Promise<string | null>;
}

export function buildCommitMenuItems({ root, commit, status, run, confirm, ask }: CommitMenuDeps): MenuItem[] {
  const short = shortHash(commit.hash);
  const branch = status?.branch ?? null;

  const reset = (mode: ResetMode) => async () => {
    // Only a hard reset can lose work that was never committed, so it is
    // the only one that asks — and it says what goes.
    if (mode === "hard") {
      const target = branch ? `Reset ${branch} to ${short}?` : `Reset to ${short}?`;
      if (!(await confirm(`${target} Uncommitted changes are discarded.`, "Reset"))) return;
    }
    run(() => apiPost("/reset", { cwd: root, hash: commit.hash, mode }));
  };

  return [
    { label: "Copy SHA", onClick: () => void copyText(commit.hash) },
    { label: "Copy Message", onClick: () => void copyText(commit.subject) },
    {
      label: "Checkout",
      onClick: async () => {
        if (!(await confirm(`Check out ${short} in detached HEAD state?`, "Checkout"))) return;
        run(() => apiPost("/checkout", { cwd: root, detach: commit.hash }));
      },
    },
    {
      label: "Create Branch Here…",
      onClick: async () => {
        const name = await ask(`New branch at ${short}`);
        if (!name) return;
        run(() => apiPost("/branch-create", { cwd: root, name, from: commit.hash, checkout: true }));
      },
    },
    {
      label: "Create Tag Here…",
      onClick: async () => {
        const name = await ask(`New tag at ${short}`);
        if (!name) return;
        const message = (await ask("Tag message (leave empty for a lightweight tag)")) ?? "";
        run(() => apiPost("/tag-create", { cwd: root, name, target: commit.hash, message }));
      },
    },
    {
      label: "Cherry-pick",
      onClick: () => run(() => apiPost("/cherry-pick", { cwd: root, hash: commit.hash })),
    },
    {
      label: "Revert",
      onClick: () => run(() => apiPost("/revert", { cwd: root, hash: commit.hash })),
    },
    { label: `Reset to Here: ${RESET_LABEL.soft}`, onClick: () => void reset("soft")() },
    { label: `Reset to Here: ${RESET_LABEL.mixed}`, onClick: () => void reset("mixed")() },
    { label: `Reset to Here: ${RESET_LABEL.hard}`, danger: true, onClick: () => void reset("hard")() },
  ];
}
