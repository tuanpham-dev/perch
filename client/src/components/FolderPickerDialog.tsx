import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import Icon from "./Icon";
import { childPath, parentPath as parentOf } from "../lib/paths";

interface Props {
  // Seed path — the "default new session dir" setting when set, else "~".
  initialPath: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}

// Code-server-style "Open Folder" dialog: an editable path input over a
// browsable listing of the current folder's subdirectories (the existing
// /api/fs listing endpoint — files are filtered out here). Typing
// prefix-matches a subfolder name and selects it; DOM focus never leaves the
// input — ArrowUp/ArrowDown move that selection, and Enter activates it
// (descend, or ascend for ".."), falling back to listing the typed path
// verbatim when nothing is selected. Clicking a row also descends. "New
// Folder" creates a folder in the currently listed directory (via the
// existing /api/mkdir endpoint) and descends into it. "Open Folder" resolves
// with the last successfully listed folder. The server echoes back the
// expanded absolute path on every listing, so navigation always works on
// canonical paths even when the user types "~/…". A failed listing (typo'd
// path) shows its error inline and disables the confirm until a valid folder
// is listed again.
export default function FolderPickerDialog({ initialPath, onPick, onCancel }: Props) {
  // What the user is asked to list next (input Enter / row click / "..").
  const [requestPath, setRequestPath] = useState(initialPath);
  // The last successfully listed folder — what descend/ascend/confirm act on.
  const [listedPath, setListedPath] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(initialPath);
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Index into the combined [".." (if any), ...dirs] list — set by
  // ArrowUp/ArrowDown or by a typeahead prefix match; null means nothing
  // selected (Enter falls back to listing the raw input).
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  // Guards against an out-of-order response landing after a faster, newer
  // one (typing a new path while a slow listing is still in flight).
  const requestSeq = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (creatingFolder) newFolderInputRef.current?.focus();
  }, [creatingFolder]);

  useEffect(() => {
    if (selectedIndex === null) return;
    listRef.current?.querySelector<HTMLElement>(".folder-picker-entry.selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    const seq = ++requestSeq.current;
    api
      .listDir(requestPath)
      .then((listing) => {
        if (seq !== requestSeq.current) return;
        setDirs(listing.entries.filter((e) => e.dir).map((e) => e.name));
        setListedPath(listing.path);
        setInputValue(listing.path);
        setError(null);
        setSelectedIndex(null);
        setCreatingFolder(false);
      })
      .catch((err: Error) => {
        if (seq !== requestSeq.current) return;
        setError(err.message);
      });
  }, [requestPath]);

  // Listed paths are `~`-shortened (the server echoes them that way — see
  // /api/fs). "~" itself gets no ".." row: the picker treats home as its
  // effective root; anywhere outside is reachable by typing an absolute
  // path.
  const parentPath = listedPath === null || listedPath === "~" ? null : parentOf(listedPath);
  // Index offset of the first dir entry in the combined selection list —
  // 1 when a ".." row is showing, else 0.
  const parentOffset = parentPath !== null ? 1 : 0;
  const entryCount = parentOffset + dirs.length;

  const descend = (name: string) => {
    if (listedPath === null) return;
    setRequestPath(childPath(listedPath, name));
  };

  const activateEntryAt = (index: number) => {
    if (parentPath !== null && index === 0) {
      setRequestPath(parentPath);
      return;
    }
    const name = dirs[index - parentOffset];
    if (name !== undefined) descend(name);
  };

  const handleInputChange = (value: string) => {
    setInputValue(value);
    if (value === listedPath) {
      setSelectedIndex(null);
      return;
    }
    // Typeahead only applies to a name typed *inside the listed folder*:
    // either a bare name ("wo") or the listed path plus one more segment
    // ("~/wo"). An absolute path typed from scratch ("/works" while "~" is
    // listed) is a request to go there, so its last segment must not
    // prefix-match a subfolder of the listed folder ("~/works") and hijack
    // Enter into descending there instead.
    const slash = value.lastIndexOf("/");
    const segment = value.slice(slash + 1);
    const insideListed = slash === -1 || (listedPath !== null && childPath(listedPath, segment) === value);
    if (!segment || !insideListed) {
      setSelectedIndex(null);
      return;
    }
    const lower = segment.toLowerCase();
    const match = dirs.findIndex((name) => name.toLowerCase().startsWith(lower));
    setSelectedIndex(match === -1 ? null : match + parentOffset);
  };

  const submitNewFolder = () => {
    const name = newFolderName.trim();
    if (!name || listedPath === null) return;
    api
      .makeDir(listedPath, name)
      .then(() => {
        setCreatingFolder(false);
        descend(name);
      })
      .catch((err: Error) => setError(err.message));
  };

  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <div
        className="dialog folder-picker"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="dialog-message">Open Folder</div>
        <input
          ref={inputRef}
          className="dialog-input"
          value={inputValue}
          placeholder="~/path/to/project"
          spellCheck={false}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (selectedIndex !== null) activateEntryAt(selectedIndex);
              else if (inputValue.trim()) setRequestPath(inputValue.trim());
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              if (entryCount > 0) setSelectedIndex((prev) => (prev === null ? 0 : Math.min(prev + 1, entryCount - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelectedIndex((prev) => (prev === null ? null : Math.max(prev - 1, 0)));
            }
          }}
        />
        {error && <div className="folder-picker-error">{error}</div>}
        <div className="folder-picker-list" ref={listRef}>
          {creatingFolder && (
            <div className="folder-picker-entry folder-picker-new">
              <Icon name="folder" />
              <input
                ref={newFolderInputRef}
                className="folder-picker-new-input"
                value={newFolderName}
                placeholder="Folder name"
                spellCheck={false}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitNewFolder();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setCreatingFolder(false);
                  }
                }}
              />
            </div>
          )}
          {parentPath !== null && (
            <button
              className={`folder-picker-entry${selectedIndex === 0 ? " selected" : ""}`}
              onClick={() => setRequestPath(parentPath)}
            >
              <Icon name="folder" />
              <span>..</span>
            </button>
          )}
          {dirs.map((name, i) => (
            <button
              key={name}
              className={`folder-picker-entry${selectedIndex === i + parentOffset ? " selected" : ""}`}
              onClick={() => descend(name)}
            >
              <Icon name="folder" />
              <span>{name}</span>
            </button>
          ))}
          {listedPath !== null && dirs.length === 0 && !error && !creatingFolder && (
            <div className="folder-picker-empty">No subfolders</div>
          )}
        </div>
        <div className="dialog-buttons">
          <button
            className="dialog-button secondary new-folder-button"
            disabled={listedPath === null}
            onClick={() => {
              setCreatingFolder(true);
              setNewFolderName("");
            }}
          >
            New Folder
          </button>
          <button className="dialog-button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="dialog-button primary"
            disabled={error !== null || listedPath === null}
            onClick={() => listedPath !== null && onPick(listedPath)}
          >
            Open Folder
          </button>
        </div>
      </div>
    </div>
  );
}
