import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { resolveGitRootDir } from "../hooks/useGitRootDir";
import { newlineModeFor, typedText } from "../lib/typedText";
import { resolveUploadDir } from "../lib/uploadDir";
import Icon from "./Icon";

// The "Send to agents" composer: a message (or a terminal selection) typed
// into the input of one or more agent windows, in any project. Opened from
// the terminal menu's "Send Selection to Agent…" (prefilled) and the
// "Agents: Compose Message…" command (empty) — see App.tsx.
//
// Delivery goes through the ordinary send-text route as keystrokes (see
// lib/typedText for why not a paste, and how each agent opens a new line),
// appended to whatever the target already has typed, and submitted only when
// "Submit after sending" is checked.

export interface ComposerSource {
  sessionName: string;
  windowIndex: number;
  label: string;
}

interface Target {
  key: string;
  sessionName: string;
  windowIndex: number;
  label: string;
  program: string;
  cwd: string | null;
}

type AgentState = "working" | "waiting" | "done" | "idle";
type Result = { ok: true } | { ok: false; reason: string };

// The send-text route takes at most 64KB.
const MAX_BYTES = 64 * 1024;

const isPhone = () => window.matchMedia("(max-width: 600px)").matches;

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} bytes`;
}

// Every window running a configured agent, across every session.
async function loadTargets(exclude: ComposerSource | null): Promise<Target[]> {
  const sessions = (await api.fetchSessions()).filter((s) => !s.name.startsWith("perch-view-"));
  const perSession = await Promise.all(
    sessions.map(async (s) => {
      try {
        const { windows } = await api.fetchAgentWindows(s.name);
        return windows.map((w): Target => {
          const win = s.windows.find((x) => x.index === w.windowIndex);
          return {
            key: `${s.name}\u0000${w.windowIndex}`,
            sessionName: s.name,
            windowIndex: w.windowIndex,
            label: `${basename(s.path) || s.name} · ${win?.name ?? w.program} · ${w.label}`,
            program: w.program,
            cwd: w.cwd ?? win?.cwd ?? s.path,
          };
        });
      } catch {
        return [];
      }
    }),
  );
  const list = perSession
    .flat()
    .filter((t) => !(exclude && t.sessionName === exclude.sessionName && t.windowIndex === exclude.windowIndex));
  // Two windows with the same name and agent read the same: tell them apart
  // by window number.
  const counts = new Map<string, number>();
  for (const t of list) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
  return list.map((t) => ((counts.get(t.label) ?? 0) > 1 ? { ...t, label: `${t.label} (window ${t.windowIndex + 1})` } : t));
}

// What the Agent Monitor extension knows about each agent window, when it's
// installed. Anything else (not installed, an error) means "unknown".
async function loadStates(): Promise<Map<string, AgentState>> {
  const states = new Map<string, AgentState>();
  try {
    const res = await fetch("/api/ext/perch.agent-monitor/agents");
    if (!res.ok) return states;
    const { agents } = (await res.json()) as { agents?: { sessionName: string; windowIndex: number; state: AgentState }[] };
    for (const a of agents ?? []) states.set(`${a.sessionName}\u0000${a.windowIndex}`, a.state);
  } catch {
    // not installed
  }
  return states;
}

// The token the caret is in, when it starts with "@": its start and query.
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export default function AgentComposer({
  initialText,
  source,
  sourceCwd,
  uploadDirSetting,
  submitAfter,
  onSubmitAfterChange,
  onClose,
}: {
  initialText: string;
  source: ComposerSource | null;
  // The folder @-mentions search and pasted images upload beside.
  sourceCwd: string | null;
  uploadDirSetting: string;
  submitAfter: boolean;
  onSubmitAfterChange: (value: boolean) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [states, setStates] = useState<Map<string, AgentState>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, Result>>(new Map());
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [matches, setMatches] = useState<string[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);
  const [searchRoot, setSearchRoot] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadTargets(source), loadStates()]).then(([list, st]) => {
      if (cancelled) return;
      setTargets(list);
      setStates(st);
      // One possible target: nothing to choose.
      if (list.length === 1) setSelected(new Set([list[0].key]));
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  useEffect(() => {
    if (!sourceCwd) return;
    resolveGitRootDir(sourceCwd).then(setSearchRoot);
  }, [sourceCwd]);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // @-mention search over the source project's files, per keystroke.
  useEffect(() => {
    if (!mention || !searchRoot) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api
        .listFiles(searchRoot, mention.query || undefined)
        .then((listing) => {
          if (cancelled) return;
          const base = listing.path.replace(/\/+$/, "");
          setMatches(listing.files.slice(0, 12).map((f) => `${base}/${f}`));
          setMatchIndex(0);
        })
        .catch(() => !cancelled && setMatches([]));
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mention, searchRoot]);

  const bytes = useMemo(() => new Blob([text]).size, [text]);
  const chosen = (targets ?? []).filter((t) => selected.has(t.key));

  // A path as the (first) chosen target will read it: relative to its
  // folder when the file is inside it, absolute otherwise.
  const pathFor = useCallback(
    (abs: string) => {
      const cwd = chosen[0]?.cwd;
      if (!cwd || cwd.startsWith("~")) return abs;
      const base = cwd.replace(/\/+$/, "");
      return abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
    },
    [chosen],
  );

  const insertAt = (start: number, end: number, insert: string) => {
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + insert.length, start + insert.length);
    });
  };

  const pickMention = (abs: string) => {
    if (!mention) return;
    const caret = textRef.current?.selectionStart ?? text.length;
    insertAt(mention.start, caret, `@${pathFor(abs)} `);
    setMention(null);
  };

  const onTextChange = (value: string, caret: number) => {
    setText(value);
    setResults(new Map());
    setMention(mentionAt(value, caret));
  };

  const uploadImages = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0 || !sourceCwd) return false;
    try {
      const dir = await resolveUploadDir(uploadDirSetting, sourceCwd);
      for (const file of images) {
        const name = file.name && file.name !== "image.png" ? file.name : `screenshot-${Date.now()}.png`;
        const { path } = await api.uploadFile(dir, name, file, "rename");
        const caret = textRef.current?.selectionStart ?? text.length;
        insertAt(caret, caret, `${path} `);
      }
    } catch (err) {
      setNotice(`Couldn't upload the image: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  };

  const toggle = (key: string) => {
    setResults(new Map());
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const send = async () => {
    if (sending || chosen.length === 0 || !text.trim()) return;
    if (bytes > MAX_BYTES) {
      setNotice(`This message is ${formatSize(bytes)}. Messages can be at most 64 KB.`);
      return;
    }
    setNotice(null);
    setSending(true);
    const fresh = await loadStates();
    setStates(fresh);
    const next = new Map<string, Result>();
    await Promise.all(
      chosen.map(async (t) => {
        if (fresh.get(t.key) === "waiting") {
          next.set(t.key, { ok: false, reason: "waiting on a question" });
          return;
        }
        try {
          await api.sendTextToSession(t.sessionName, typedText(text, newlineModeFor(t.program)), submitAfter, t.windowIndex);
          next.set(t.key, { ok: true });
        } catch (err) {
          next.set(t.key, { ok: false, reason: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    setResults(next);
    setSending(false);
    if ([...next.values()].every((r) => r.ok)) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && matches.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMatchIndex((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(matches[matchIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const stateLabel = (key: string) => states.get(key);

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className={`dialog agent-composer${isPhone() ? " sheet" : ""}`}
        role="dialog"
        aria-label="Send to agents"
        data-keyboard-capture="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="agent-composer-head">
          <div className="dialog-title">Send to agents</div>
          <button className="icon-button" title="Close" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="agent-composer-editor">
          <textarea
            ref={textRef}
            className="dialog-input agent-composer-text"
            value={text}
            placeholder="Write a message. @ mentions a file; paste or drop an image to attach it."
            onChange={(e) => onTextChange(e.target.value, e.target.selectionStart)}
            onKeyDown={onKeyDown}
            onClick={(e) => setMention(mentionAt(text, e.currentTarget.selectionStart))}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                void uploadImages(files);
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer.files);
              if (files.some((f) => f.type.startsWith("image/"))) {
                e.preventDefault();
                void uploadImages(files);
              }
            }}
            rows={10}
          />
          {mention && matches.length > 0 && (
            <div className="agent-composer-mentions" role="listbox">
              {matches.map((m, i) => (
                <button
                  key={m}
                  role="option"
                  aria-selected={i === matchIndex}
                  className={`agent-composer-mention${i === matchIndex ? " active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(m);
                  }}
                >
                  {searchRoot && m.startsWith(searchRoot) ? m.slice(searchRoot.replace(/\/+$/, "").length + 1) : m}
                </button>
              ))}
            </div>
          )}
        </div>
        {bytes > MAX_BYTES && <div className="agent-composer-error">This message is {formatSize(bytes)}. Messages can be at most 64 KB.</div>}
        <div className="agent-composer-to">To</div>
        <div className="agent-composer-targets">
          {targets === null && <div className="agent-composer-muted">Looking for agent windows…</div>}
          {targets?.length === 0 && <div className="agent-composer-muted">No agent windows are open.</div>}
          {targets?.map((t) => {
            const result = results.get(t.key);
            const state = stateLabel(t.key);
            return (
              <label key={t.key} className="agent-composer-target">
                <input type="checkbox" checked={selected.has(t.key)} onChange={() => toggle(t.key)} />
                <span className="agent-composer-target-label">{t.label}</span>
                {state && <span className={`agent-composer-state ${state}`}>{state}</span>}
                {result && (
                  <span className={`agent-composer-result ${result.ok ? "ok" : "bad"}`}>
                    {result.ok ? "Delivered" : `Not sent: ${result.reason}`}
                  </span>
                )}
              </label>
            );
          })}
        </div>
        {notice && <div className="agent-composer-error">{notice}</div>}
        <div className="dialog-buttons agent-composer-buttons">
          <label className="agent-composer-submit">
            <input type="checkbox" checked={submitAfter} onChange={(e) => onSubmitAfterChange(e.target.checked)} />
            Submit after sending
          </label>
          <button
            className="dialog-button primary"
            disabled={sending || chosen.length === 0 || !text.trim() || bytes > MAX_BYTES}
            onClick={() => void send()}
          >
            {sending ? "Sending…" : "Send"} <span className="agent-composer-hint">Ctrl+Enter</span>
          </button>
        </div>
      </div>
    </div>
  );
}
