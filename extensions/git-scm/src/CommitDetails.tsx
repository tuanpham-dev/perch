// The commit details tab: one commit's header, its message, and the files
// it touched — reached from a COMMITS row, a STASH row, a tag, or a parent
// link in another details tab.
//
// It replaces "click a commit, get one combined patch": a 40-file commit is
// unreadable as a single diff, and the header (who, when, which parents,
// which refs point here) was nowhere at all. The combined patch is still
// one click away as Full Diff, and a file row opens that file's own diff
// through whichever editor the app's `editor` setting selects, exactly as a
// working-tree diff does.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import FileIcon from "../../_shared/FileIcon";
import DiffView from "./DiffView";
import { useSplit } from "./useSplit";
import Icon from "../../_shared/Icon";
import { copyText } from "../../_shared/clipboard";
import {
  apiGetJson,
  decodeCommitKey,
  encodeDiffKey,
  formatAbsoluteTime,
  formatRelativeTime,
  getFileIcon,
  openCommitDetails,
  openDiffInEditor,
  openViewerTab,
  shortHash,
  type FileStatus,
} from "./host";

interface CommitFile {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  added: number;
  removed: number;
  binary: boolean;
}

interface CommitRef {
  name: string;
  head: boolean;
  tag: boolean;
}

interface CommitInfo {
  hash: string;
  author: string;
  email: string;
  timestamp: number;
  parents: string[];
  refs: CommitRef[];
  message: string;
  files: CommitFile[];
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
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

interface Props {
  filePath: string;
  active: boolean;
  toolbarTarget?: HTMLDivElement | null;
  reloadKey?: number;
}

// Below this the tab is too narrow for a list and a diff side by side, so
// it becomes one column and a file opens in a tab the way it always did.
const TWO_COLUMN_MIN = "(min-width: 900px)";

export default function CommitDetails({ filePath, active, toolbarTarget, reloadKey }: Props) {
  const { root, hash, firstParent } = decodeCommitKey(filePath);
  const [info, setInfo] = useState<CommitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // The file whose diff fills the right column. Null until one is picked,
  // and reset whenever the tab is pointed at another commit.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [wide, setWide] = useState(() => window.matchMedia(TWO_COLUMN_MIN).matches);
  const split = useSplit("gitScm.commitSplitWidth");

  useEffect(() => {
    const mq = window.matchMedia(TWO_COLUMN_MIN);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams({ cwd: root, hash });
      if (firstParent) params.set("firstParent", "1");
      const data = await apiGetJson<CommitInfo>(`/commit-info?${params}`);
      setInfo(data);
      // Open on the first file rather than an empty right column: a commit
      // is usually read to see what it did, and one file is the common case.
      setSelectedPath(data.files[0]?.path ?? null);
    } catch (err) {
      setInfo(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [root, hash, firstParent]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const copyHash = async () => {
    await copyText(hash);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  // The whole commit as one patch — what a COMMITS row used to open, kept
  // for the times a single scroll through everything is what you want.
  const openFullDiff = () => {
    openViewerTab?.("diff", encodeDiffKey(root, "", false, false, undefined, hash, firstParent), {
      title: `${shortHash(hash)} full diff`,
    });
  };

  // What a file row does: on a wide tab it fills the right column, which is
  // why the two-column layout exists. Everywhere else it opens the diff the
  // way it always did.
  const selectFile = (file: CommitFile) => {
    if (wide) {
      setSelectedPath(file.path);
      return;
    }
    openFile(file);
  };

  // One file's two revisions, through the configured editor when it claims
  // the diff capability, and through this extension's own DiffView when it
  // doesn't — the same fallback a working-tree diff takes. Reached from the
  // right column's own "Open in Editor", and from a row click on a narrow
  // tab.
  const openFile = (file: CommitFile) => {
    const fallback = () =>
      openViewerTab?.(
        "diff",
        encodeDiffKey(root, file.path, false, false, file.oldPath ?? undefined, hash, firstParent),
        { title: `${basenameOf(file.path)} (${shortHash(hash)})` },
      );
    if (!openDiffInEditor) {
      fallback();
      return;
    }
    const params = new URLSearchParams({ cwd: root, hash, path: file.path });
    if (file.oldPath) params.set("origPath", file.oldPath);
    void apiGetJson<{
      original: { content: string; label: string };
      modified: { content: string; label: string; path?: string; readOnlyReason?: string };
    }>(`/diff-sides?${params}`)
      .then(async (sides) => {
        const handled = await openDiffInEditor!({
          title: `${basenameOf(file.path)} (${shortHash(hash)})`,
          original: sides.original,
          modified: sides.modified,
        });
        if (!handled) fallback();
      })
      .catch(fallback);
  };

  const toolbar = (
    <>
      <button className="icon-button" title="Copy SHA" onClick={() => void copyHash()}>
        <Icon name={copied ? "check" : "copy"} />
      </button>
      <button className="icon-button" title="Full Diff" onClick={openFullDiff}>
        <Icon name="diff" />
      </button>
    </>
  );

  const totals = info?.files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );

  const [subject, ...bodyLines] = (info?.message ?? "").split("\n");
  const body = bodyLines.join("\n").replace(/^\n+/, "");

  const selectedFile = info?.files.find((f) => f.path === selectedPath) ?? null;

  return (
    <div
      className={`git-commit-details${wide ? " two-column" : ""}${split.dragging ? " dragging" : ""}`}
      ref={wide ? split.containerRef : undefined}
      style={wide ? { gridTemplateColumns: `${split.width}px 1px 1fr` } : undefined}
    >
      {active && toolbarTarget && createPortal(toolbar, toolbarTarget)}
      {error ? (
        <div className="git-error">{error}</div>
      ) : !info ? (
        <div className="git-empty">Loading…</div>
      ) : (
        <>
          <div className="git-commit-summary">
          <div className="git-commit-head">
            <h2 className="git-commit-subject-line">{subject}</h2>
            {body && <pre className="git-commit-body">{body}</pre>}
            <dl className="git-commit-meta">
              <dt>Commit</dt>
              <dd>
                <button className="git-commit-hash" title="Copy SHA" onClick={() => void copyHash()}>
                  {info.hash}
                </button>
              </dd>
              <dt>Author</dt>
              <dd>
                {info.author}
                {info.email && <span className="git-commit-email"> &lt;{info.email}&gt;</span>}
              </dd>
              <dt>Date</dt>
              <dd title={formatRelativeTime(info.timestamp)}>{formatAbsoluteTime(info.timestamp)}</dd>
              {info.parents.length > 0 && (
                <>
                  <dt>{info.parents.length > 1 ? "Parents" : "Parent"}</dt>
                  <dd className="git-commit-parents">
                    {info.parents.map((parent) => (
                      <button
                        key={parent}
                        className="git-commit-parent"
                        onClick={() => openCommitDetails(root, parent, "commit")}
                      >
                        {shortHash(parent)}
                      </button>
                    ))}
                  </dd>
                </>
              )}
              {info.refs.length > 0 && (
                <>
                  <dt>Refs</dt>
                  <dd className="git-commit-refs">
                    {info.refs.map((ref) => (
                      <span
                        key={`${ref.name}${ref.tag ? ":tag" : ""}`}
                        className={`git-commit-ref${ref.head ? " head" : ""}${ref.tag ? " tag" : ""}`}
                      >
                        {ref.tag && <Icon name="tag" />}
                        {ref.name}
                      </span>
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>

          <div className="git-commit-files-header">
            <span>
              {info.files.length} {info.files.length === 1 ? "file" : "files"} changed
            </span>
            {totals && (info.files.length > 0) && (
              <span className="git-commit-totals">
                <span className="git-added">+{totals.added}</span>{" "}
                <span className="git-removed">-{totals.removed}</span>
              </span>
            )}
          </div>
          <div className="git-commit-files">
            {info.files.length === 0 ? (
              <div className="git-empty">This commit changes no files.</div>
            ) : (
              info.files.map((file) => {
                const icon = getFileIcon?.(basenameOf(file.path));
                const dir = dirOf(file.path);
                return (
                  <div
                    key={file.path}
                    className={`git-commit-file${wide && file.path === selectedPath ? " selected" : ""}`}
                    role="button"
                    tabIndex={0}
                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    onClick={() => selectFile(file)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        selectFile(file);
                      }
                    }}
                  >
                    <span className={`git-row-status git-status-${file.status}`}>
                      {STATUS_LABEL[file.status]}
                    </span>
                    {icon && <FileIcon className="git-row-file-icon" result={icon} />}
                    <span className="git-commit-file-name">{basenameOf(file.path)}</span>
                    {dir && <span className="git-commit-file-dir">{dir}</span>}
                    <span className="git-commit-file-stat">
                      {file.binary ? (
                        <span className="git-commit-binary">binary</span>
                      ) : (
                        <>
                          <span className="git-added">+{file.added}</span>{" "}
                          <span className="git-removed">-{file.removed}</span>
                        </>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
          </div>
          {wide && <div className="git-commit-split-handle" title="Drag to resize" {...split.handleProps} />}
          {wide && (
            <div className="git-commit-diff-pane">
              {selectedFile ? (
                <>
                  <div className="git-commit-diff-head">
                    <span className="git-commit-diff-path" title={selectedFile.path}>
                      {selectedFile.oldPath ? `${selectedFile.oldPath} → ${selectedFile.path}` : selectedFile.path}
                    </span>
                    <button
                      className="icon-button"
                      title="Open in Editor"
                      onClick={() => openFile(selectedFile)}
                    >
                      <Icon name="link-external" />
                    </button>
                  </div>
                  {/* Keyed by the file so switching rows remounts rather
                      than showing the previous file's diff while the next
                      one loads. */}
                  <DiffView
                    key={selectedFile.path}
                    filePath={encodeDiffKey(
                      root,
                      selectedFile.path,
                      false,
                      false,
                      selectedFile.oldPath ?? undefined,
                      hash,
                      firstParent,
                    )}
                    active
                  />
                </>
              ) : (
                <div className="git-empty">Select a file to see its diff.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
