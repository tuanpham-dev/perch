// DiffView — extracted from client.tsx (mechanical move, plans/orca-features-
// implementation.md's T19) so the line-annotation feature (T9/T10) below
// doesn't grow client.tsx's already-large file further. Reached the same way
// it always was: only via ctx.app.openViewerTab, from GitPanel/ConflictView's
// diff-key composite paths (see client.tsx's encodeDiffKey/decodeDiffKey).
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../../_shared/Icon";
import type { MenuItem } from "../../_shared/types";
import {
  agentWindows,
  fetchSessions,
  resolveAgentTargets,
  sendToAgent,
  type AgentTargetProgram,
} from "../../_shared/agentTarget";
import { apiGetJson, decodeDiffKey, extSettings, statusListeners } from "./client";

interface DiffProps {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  openInEditor?: (path: string) => void;
  showMenu?: (x: number, y: number, items: MenuItem[]) => void;
}

interface DiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
  // File line numbers, computed by walking the hunk from its header's
  // "@@ -oldStart,oldLen +newStart,newLen @@" — null on whichever axis a
  // pure add/del line doesn't advance.
  oldLine: number | null;
  newLine: number | null;
}

interface Hunk {
  header: string;
  lines: DiffLine[];
}

// "@@ -12,7 +12,9 @@" -> { oldStart: 12, newStart: 12 }; malformed/missing
// counts default to 1, same as git's own convention for a 1-line hunk.
function parseHunkHeader(header: string): { oldStart: number; newStart: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return { oldStart: m ? Number(m[1]) : 1, newStart: m ? Number(m[2]) : 1 };
}

export function parseHunks(diffText: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 1;
  let newLine = 1;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("@@")) {
      const start = parseHunkHeader(line);
      oldLine = start.oldStart;
      newLine = start.newStart;
      current = { header: line, lines: [] };
      hunks.push(current);
    } else if (current) {
      if (line.startsWith("+")) {
        current.lines.push({ kind: "add", text: line.slice(1), oldLine: null, newLine });
        newLine++;
      } else if (line.startsWith("-")) {
        current.lines.push({ kind: "del", text: line.slice(1), oldLine, newLine: null });
        oldLine++;
      } else if (line.startsWith(" ")) {
        current.lines.push({ kind: "ctx", text: line.slice(1), oldLine, newLine });
        oldLine++;
        newLine++;
      }
      // Lines like "\ No newline at end of file" are dropped — nothing
      // useful to render for a unified-diff viewer.
    }
  }
  return hunks;
}

// ---- Line selection + comment (T9) ----

interface Selection {
  hunkIndex: number;
  // Inclusive line indices within that hunk's lines[] array, start <= end.
  start: number;
  end: number;
}

function lineNumberOf(line: DiffLine): number | null {
  return line.kind === "del" ? line.oldLine : line.newLine;
}

// A drafted-but-not-yet-sent comment — the selection it was written against,
// captured by value (not a live Selection reference) so it survives after
// the user moves on to select and comment on a different range.
interface PendingComment extends Selection {
  id: number;
  text: string;
}

// "L2-2" / "L7-9" line-range label shown on an inline pending-comment card —
// same axis-picking as buildContextBlock's range, just terser. Falls back to
// a plain word when a stale hunkIndex/hunk mismatch leaves no lines to read.
function rangeLabel(hunk: Hunk | undefined, selection: Selection): string {
  const numbers = (hunk?.lines.slice(selection.start, selection.end + 1) ?? [])
    .map(lineNumberOf)
    .filter((n): n is number => n !== null);
  return numbers.length > 0 ? `L${Math.min(...numbers)}-${Math.max(...numbers)}` : "selected lines";
}

// The comment box's context block: repo-relative path, the line range the
// selection covers (whichever axis — old for pure deletions, new otherwise
// — each selected line actually advances), the selected lines verbatim with
// their +/-/space marker, then the user's own comment. Sent unsubmitted by
// default (gitScm.sendAutoSubmit) so the user reviews before Enter.
function buildContextBlock(path: string, hunk: Hunk, selection: Selection, comment: string): string {
  const lines = hunk.lines.slice(selection.start, selection.end + 1);
  const numbers = lines.map(lineNumberOf).filter((n): n is number => n !== null);
  const range = numbers.length > 0 ? `lines ${Math.min(...numbers)}-${Math.max(...numbers)}` : "the selected lines";
  const body = lines
    .map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)
    .join("\n");
  const location = path ? `In ${path} around ${range} of this diff hunk:` : `Around ${range} of this diff hunk:`;
  return `${location}\n${body}\n\n${comment}`;
}

// Joins every pending comment's own context block into one message — sent
// as a single review, not one send-keys call per comment.
function buildCombinedText(path: string, hunks: Hunk[], pending: PendingComment[]): string {
  return pending.map((pc) => buildContextBlock(path, hunks[pc.hunkIndex], pc, pc.text)).join("\n\n---\n\n");
}

// Which panes count as an agent comes from core's registry (Settings → AI
// Providers), and from nowhere else. This extension had its own agentPrograms
// setting until the migration; it is gone, not deprecated.
function agentTargets(): Promise<AgentTargetProgram[]> {
  return resolveAgentTargets();
}

function readSendAutoSubmit(): boolean {
  return extSettings?.get("gitScm.sendAutoSubmit") === true;
}

export default function DiffView({ filePath, active, toolbarTarget, openInEditor, showMenu }: DiffProps) {
  const parsed = useMemo(() => decodeDiffKey(filePath), [filePath]);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards the status-triggered auto-refresh below from piling up a new
  // fetch on every poll tick while a previous one is still in flight — a
  // manual Reload or a filePath change is never skipped this way.
  const fetchingRef = useRef(false);
  // Every fetchDiff call gets a fresh id; a response only applies if it's
  // still the most recent one requested — otherwise a slow response from a
  // stale filePath (or an overtaken auto-refresh) could land after a newer
  // request already started, clobbering its result with old data.
  const requestIdRef = useRef(0);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState(false);
  // Comments drafted via "Add Comment" but not yet sent — Send to Agent
  // (in the toolbar) delivers all of them together in one message.
  const [pendingComments, setPendingComments] = useState<PendingComment[]>([]);
  const nextPendingId = useRef(0);
  // Each pending comment shows as a small numbered badge; clicking one
  // toggles its full card open (multiple can be open at once).
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const closeComment = useCallback(() => {
    setCommentOpen(false);
    setComment("");
    setSendError(null);
  }, []);

  const fetchDiff = useCallback(() => {
    const id = ++requestIdRef.current;
    fetchingRef.current = true;
    let url: string;
    if (parsed.commitHash) {
      const params = new URLSearchParams({ cwd: parsed.cwd, hash: parsed.commitHash });
      // Stash entries only — see encodeDiffKey's firstParent comment.
      if (parsed.firstParent) params.set("firstParent", "1");
      url = `/commit-diff?${params}`;
    } else {
      const params = new URLSearchParams({
        cwd: parsed.cwd,
        path: parsed.path,
        staged: parsed.staged ? "1" : "0",
        untracked: parsed.untracked ? "1" : "0",
      });
      if (parsed.origPath) params.set("origPath", parsed.origPath);
      url = `/diff?${params}`;
    }
    return apiGetJson<{ diff: string }>(url)
      .then((data) => {
        if (requestIdRef.current !== id) return;
        setDiffText(data.diff);
        setError(null);
      })
      .catch((err) => {
        if (requestIdRef.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (requestIdRef.current === id) fetchingRef.current = false;
      });
  }, [parsed]);

  // Fresh load whenever the tab's target changes — resets to the loading
  // state, unlike the background refresh below, which keeps showing the
  // last-good diff while it refetches.
  useEffect(() => {
    setDiffText(null);
    setError(null);
    setSelection(null);
    closeComment();
    setPendingComments([]);
    setExpandedIds(new Set());
    setEditingId(null);
    setEditText("");
    fetchDiff();
  }, [filePath, fetchDiff, closeComment]);

  // Refetches whenever the shared status poller reports a change (staged,
  // committed, or edited elsewhere) while this tab is the active one — a
  // diff tab left open across a background poll would otherwise show
  // indefinitely stale content.
  useEffect(() => {
    if (!active) return;
    const onStatus = () => {
      if (!fetchingRef.current) fetchDiff();
    };
    statusListeners.add(onStatus);
    return () => {
      statusListeners.delete(onStatus);
    };
  }, [active, fetchDiff]);

  // A commit-diff's raw text leads with `git show --format=fuller`'s commit
  // metadata block (hash/author/dates/message) before the first "@@" hunk —
  // split it off so it can render as its own header above the hunks, unlike
  // a plain file diff's pre-hunk lines (diff --git/index/---/+++), which
  // stay dropped exactly as before (see parseHunks — it already skips
  // anything before the first "@@").
  const { commitHeader, diffBody } = useMemo(() => {
    if (!parsed.commitHash || diffText === null) return { commitHeader: "", diffBody: diffText ?? "" };
    const lines = diffText.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("@@"));
    if (idx === -1) return { commitHeader: diffText, diffBody: "" };
    return { commitHeader: lines.slice(0, idx).join("\n"), diffBody: lines.slice(idx).join("\n") };
  }, [parsed.commitHash, diffText]);

  const hunks = useMemo(() => (diffBody ? parseHunks(diffBody) : []), [diffBody]);

  const onLineClick = useCallback(
    (hunkIndex: number, lineIndex: number, shiftKey: boolean) => {
      setSelection((prev) => {
        if (shiftKey && prev && prev.hunkIndex === hunkIndex) {
          return { hunkIndex, start: Math.min(prev.start, lineIndex), end: Math.max(prev.start, lineIndex) };
        }
        return { hunkIndex, start: lineIndex, end: lineIndex };
      });
      closeComment();
    },
    [closeComment],
  );

  // Queues the drafted comment rather than sending it — lets the user select
  // and comment on more ranges (elsewhere in this hunk or another one)
  // before delivering everything as one message via sendAllComments.
  const addComment = useCallback(() => {
    if (!selection || !comment.trim()) return;
    const id = nextPendingId.current++;
    setPendingComments((prev) => [...prev, { ...selection, id, text: comment.trim() }]);
    closeComment();
    setSelection(null);
  }, [selection, comment, closeComment]);

  const removePendingComment = useCallback((id: number) => {
    setPendingComments((prev) => prev.filter((pc) => pc.id !== id));
    setExpandedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEditingId((prev) => (prev === id ? null : prev));
  }, []);

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const startEdit = useCallback((pc: PendingComment) => {
    setEditingId(pc.id);
    setEditText(pc.text);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText("");
  }, []);

  const saveEdit = useCallback(() => {
    const text = editText.trim();
    if (editingId === null || !text) return;
    setPendingComments((prev) => prev.map((pc) => (pc.id === editingId ? { ...pc, text } : pc)));
    setEditingId(null);
    setEditText("");
  }, [editingId, editText]);

  const sendAllComments = useCallback(async () => {
    if (pendingComments.length === 0) return;
    // The diff may have refreshed (background status poll, or a manual
    // Reload) since a comment was queued — hunks[] can have shifted or
    // shrunk underneath a stale hunkIndex. Drop anything that no longer
    // resolves rather than sending a comment against the wrong lines.
    const valid = pendingComments.filter((pc) => hunks[pc.hunkIndex]);
    const dropped = pendingComments.length - valid.length;
    if (valid.length === 0) {
      setSendError("The diff changed since these comments were added - please re-add them.");
      setPendingComments([]);
      return;
    }
    const text = buildCombinedText(parsed.path, hunks, valid);
    setSendBusy(true);
    setSendError(null);
    try {
      const [sessions, agents] = await Promise.all([fetchSessions(), agentTargets()]);
      const targets = agentWindows(sessions, parsed.cwd, agents);
      const submit = readSendAutoSubmit();
      if (targets.length === 0) {
        setSendError("No agent is running in this repo - start one first.");
        return;
      }
      const finish = () => {
        setPendingComments([]);
        if (dropped > 0) {
          setSendError(`${dropped} comment${dropped === 1 ? "" : "s"} dropped - the diff had changed since they were added.`);
        }
      };
      if (targets.length === 1) {
        await sendToAgent(targets[0].sessionName, text, submit, { windowIndex: targets[0].windowIndex });
        finish();
        return;
      }
      // Several candidate agent panes — let the user pick which one gets it.
      const rect = document.querySelector(".git-diff-pending-panel")?.getBoundingClientRect();
      const x = rect ? rect.left : 0;
      const y = rect ? rect.bottom : 0;
      showMenu?.(x, y, [
        ...targets.map((t) => ({
          label: `${t.sessionName} · ${t.windowName || `#${t.windowIndex}`}`,
          onClick: () => {
            void sendToAgent(t.sessionName, text, submit, { windowIndex: t.windowIndex })
              .then(finish)
              .catch((err: Error) => setSendError(err.message));
          },
        })),
      ]);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendBusy(false);
    }
  }, [pendingComments, hunks, parsed.path, parsed.cwd, showMenu]);

  const controls = (
    <>
      <button className="icon-button" title="Reload" onClick={() => fetchDiff()}>
        <Icon name="refresh" />
      </button>
      {!parsed.commitHash && (
        <button
          className="icon-button"
          title="Open in Editor"
          onClick={() => openInEditor?.(`${parsed.cwd}/${parsed.path}`)}
        >
          <Icon name="go-to-file" />
        </button>
      )}
    </>
  );

  return (
    <div className={`git-diff-host${active ? "" : " hidden"}`}>
      {error && <div className="git-diff-status git-diff-error">{error}</div>}
      {!error && diffText === null && <div className="git-diff-status">Loading…</div>}
      {!error && diffText !== null && diffText === "" && (
        <div className="git-diff-status">No differences.</div>
      )}
      {/* Commit metadata (hash/author/dates/message) from `git show
          --format=fuller`, split off ahead of the first "@@" hunk — see the
          commitHeader/diffBody useMemo above. */}
      {!error && commitHeader && <pre className="git-diff-raw git-diff-commit-header">{commitHeader}</pre>}
      {/* A pure rename (100% similarity) or a mode-only/binary change
          produces diff header lines but no "@@" hunks — fall back to the
          raw diff text rather than rendering a blank pane. Skipped for a
          commit diff whose body is empty (idx===-1 case above) — its full
          text is already shown by commitHeader just above. */}
      {!error &&
        diffText !== null &&
        diffText !== "" &&
        hunks.length === 0 &&
        !(parsed.commitHash && diffBody === "") && <pre className="git-diff-raw">{diffText}</pre>}
      {!error && hunks.length > 0 && (
        <div className="git-diff-body">
          {hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex} className="git-diff-hunk">
              <div className="git-diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, lineIndex) => {
                const selected =
                  selection?.hunkIndex === hunkIndex &&
                  lineIndex >= selection.start &&
                  lineIndex <= selection.end;
                const commented = pendingComments.some(
                  (pc) => pc.hunkIndex === hunkIndex && lineIndex >= pc.start && lineIndex <= pc.end,
                );
                // Cards render right after the last line of their range (GitHub
                // review style) — a comment covering several lines shows once,
                // anchored to where its range ends, not once per covered line.
                const commentsHere = pendingComments.filter(
                  (pc) => pc.hunkIndex === hunkIndex && pc.end === lineIndex,
                );
                // The "Comment" trigger / compose box for the LIVE selection
                // anchors the same way — right after its last line — so what
                // you're about to add lands exactly where it'll render once saved.
                const showComposer = selection?.hunkIndex === hunkIndex && selection.end === lineIndex;
                return (
                  <Fragment key={lineIndex}>
                    <div
                      className={`git-diff-line git-diff-line-${line.kind}${selected ? " git-diff-line-selected" : ""}${commented ? " git-diff-line-commented" : ""}`}
                      onClick={(e) => onLineClick(hunkIndex, lineIndex, e.shiftKey)}
                    >
                      <span className="git-diff-line-marker">
                        {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                      </span>
                      <span className="git-diff-line-text">{line.text}</span>
                    </div>
                    {commentsHere.map((pc) => {
                      const number = pendingComments.findIndex((p) => p.id === pc.id) + 1;
                      const expanded = expandedIds.has(pc.id);
                      const editing = editingId === pc.id;
                      return (
                        <div key={pc.id} className="git-diff-comment-marker">
                          <button
                            type="button"
                            className="git-diff-comment-badge"
                            title={pc.text}
                            onClick={() => toggleExpanded(pc.id)}
                          >
                            {number}
                          </button>
                          {expanded && (
                            <div className="git-diff-inline-comment">
                              <div className="git-diff-inline-comment-header">
                                <span className="git-diff-inline-comment-range">{rangeLabel(hunk, pc)}</span>
                                <div className="git-diff-inline-comment-actions">
                                  {!editing && (
                                    <button
                                      type="button"
                                      className="icon-button"
                                      title="Edit this comment"
                                      onClick={() => startEdit(pc)}
                                    >
                                      <Icon name="edit" />
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="icon-button"
                                    title="Remove this comment"
                                    onClick={() => removePendingComment(pc.id)}
                                  >
                                    <Icon name="close" />
                                  </button>
                                </div>
                              </div>
                              {editing ? (
                                <div className="git-diff-comment-edit">
                                  <textarea
                                    autoFocus
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Escape") {
                                        e.preventDefault();
                                        cancelEdit();
                                      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                        e.preventDefault();
                                        saveEdit();
                                      }
                                    }}
                                  />
                                  <div className="git-diff-comment-buttons">
                                    <button
                                      type="button"
                                      className="git-diff-btn-primary"
                                      disabled={!editText.trim()}
                                      onClick={saveEdit}
                                    >
                                      Save
                                    </button>
                                    <button type="button" className="git-diff-btn-ghost" onClick={cancelEdit}>
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <div className="git-diff-inline-comment-text">{pc.text}</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {showComposer && (
                      <div className="git-diff-comment-anchor">
                        {!commentOpen && (
                          <button
                            type="button"
                            className="git-diff-comment-trigger"
                            onClick={() => setCommentOpen(true)}
                          >
                            <Icon name="comment" /> Comment
                          </button>
                        )}
                        {commentOpen && (
                          <div className="git-diff-comment-box">
                            <textarea
                              autoFocus
                              placeholder="What should the agent do with these lines?"
                              value={comment}
                              onChange={(e) => setComment(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  closeComment();
                                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                  e.preventDefault();
                                  addComment();
                                }
                              }}
                            />
                            <div className="git-diff-comment-buttons">
                              <button
                                type="button"
                                className="git-diff-btn-primary"
                                disabled={!comment.trim()}
                                onClick={addComment}
                              >
                                Add Comment
                              </button>
                              <button type="button" className="git-diff-btn-ghost" onClick={closeComment}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </Fragment>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {pendingComments.length > 0 && (
        <div className="git-diff-pending-panel">
          <div className="git-diff-pending-summary">
            <span className="git-diff-pending-count">
              {pendingComments.length} comment{pendingComments.length === 1 ? "" : "s"} pending
            </span>
            <button
              type="button"
              className="git-diff-btn-primary"
              disabled={sendBusy}
              onClick={() => void sendAllComments()}
            >
              <Icon name="send" /> {sendBusy ? "Sending…" : "Send to Agent"}
            </button>
            <button
              type="button"
              className="git-diff-btn-ghost"
              disabled={sendBusy}
              onClick={() => setPendingComments([])}
            >
              Clear
            </button>
          </div>
          {sendError && <div className="git-diff-comment-error">{sendError}</div>}
        </div>
      )}
      {active && toolbarTarget && createPortal(controls, toolbarTarget)}
    </div>
  );
}
