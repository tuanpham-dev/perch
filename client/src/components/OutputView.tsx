import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import Icon from "./Icon";

// The bottom panel's OUTPUT view (plans/bottom-panel-views.md): the server's
// log channels (server/src/logChannels.ts), one at a time. The host mounts
// this only while OUTPUT is the view showing, so the polling below starts
// and stops with the component and nothing runs for a hidden view.
//
// Polling rather than a socket, at the same cadence the ports feed uses:
// 2 s meets the spec's "new lines within 2 seconds", and a `since` cursor
// keeps each poll to the lines that arrived since the last one.

const LINES_POLL_MS = 2_000;
const CHANNELS_POLL_MS = 5_000;
// Matches the server's own ring, so the view never holds more than the
// server would answer with.
const MAX_LOCAL_LINES = 2_000;
const CHANNEL_KEY = "outputChannel";
const DEFAULT_CHANNEL = "Perch";
// The picker's first entry: every channel merged, each line prefixed with
// its channel's name.
const ALL_CHANNEL = api.ALL_LOG_CHANNELS;
// How close to the bottom still counts as following (a fraction of a line).
const FOLLOW_SLOP_PX = 4;

function timeOf(at: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// The console wrap prefixes warnings and errors (logChannels.ts).
function levelOf(text: string): "warn" | "error" | null {
  if (text.startsWith("[error] ")) return "error";
  if (text.startsWith("[warn] ")) return "warn";
  return null;
}

function readStoredChannel(): string {
  try {
    return localStorage.getItem(CHANNEL_KEY) || DEFAULT_CHANNEL;
  } catch {
    return DEFAULT_CHANNEL;
  }
}

export default function OutputView() {
  const [channels, setChannels] = useState<string[]>([DEFAULT_CHANNEL]);
  const [channel, setChannel] = useState<string>(readStoredChannel);
  const [lines, setLines] = useState<api.LogLine[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The last seq the server had handed out when it last answered (the
  // `since` of the next poll); reset with the lines on a channel change.
  const cursorRef = useRef(0);
  const listRef = useRef<HTMLPreElement | null>(null);
  // Whether the view is pinned to the bottom. Scrolling up unpins it;
  // scrolling back down pins it again (see onScroll).
  const followingRef = useRef(true);

  useEffect(() => {
    try {
      localStorage.setItem(CHANNEL_KEY, channel);
    } catch {
      // Storage unavailable: the choice just doesn't stick.
    }
  }, [channel]);

  const pollLines = useCallback(async () => {
    try {
      const { lines: fresh, cursor } = await api.readLog(channel, cursorRef.current);
      cursorRef.current = cursor;
      setError(null);
      if (fresh.length === 0) return;
      setLines((prev) => {
        // Only lines past what is already held: two polls in flight at once
        // (StrictMode's doubled mount effect, a Retry beside the timer) can
        // both answer from the same cursor.
        const last = prev.length > 0 ? prev[prev.length - 1].seq : 0;
        const add = fresh.filter((l) => l.seq > last);
        if (add.length === 0) return prev;
        const next = prev.length === 0 ? add : [...prev, ...add];
        return next.length > MAX_LOCAL_LINES ? next.slice(next.length - MAX_LOCAL_LINES) : next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [channel]);

  // Lines: reset and refetch on a channel change, then poll.
  useEffect(() => {
    cursorRef.current = 0;
    setLines([]);
    followingRef.current = true;
    void pollLines();
    const timer = window.setInterval(() => {
      if (!document.hidden) void pollLines();
    }, LINES_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pollLines]);

  // Channels: a new extension channel appears once it first logs.
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      api
        .listLogChannels()
        .then(({ channels: next }) => {
          if (!cancelled) setChannels(next);
        })
        .catch(() => {
          // The lines poll reports the error; the picker keeps its last list.
        });
    };
    poll();
    const timer = window.setInterval(() => {
      if (!document.hidden) poll();
    }, CHANNELS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Keep the bottom in view after every append while following.
  useEffect(() => {
    const el = listRef.current;
    if (el && followingRef.current) el.scrollTop = el.scrollHeight;
  }, [lines, filter]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    followingRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - FOLLOW_SLOP_PX;
  };

  const onClear = () => {
    api
      .clearLog(channel)
      .then(() => {
        setLines([]);
        followingRef.current = true;
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  const needle = filter.trim().toLowerCase();
  const all = channel === ALL_CHANNEL;
  // In All, the channel name is part of the line, so it filters too.
  const shown = needle
    ? lines.filter((l) => (all ? `${l.channel} ${l.text}` : l.text).toLowerCase().includes(needle))
    : lines;

  return (
    <div className="output-view">
      <div className="output-view-toolbar">
        <select
          id="output-view-channel"
          aria-label="Channel"
          value={channel === ALL_CHANNEL || channels.includes(channel) ? channel : DEFAULT_CHANNEL}
          onChange={(e) => setChannel(e.target.value)}
        >
          <option value={ALL_CHANNEL}>All</option>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          id="output-view-filter"
          type="search"
          placeholder="Filter"
          aria-label="Filter lines"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="output-view-spacer" />
        <button className="icon-button" title={all ? "Clear every channel" : "Clear this channel"} onClick={onClear}>
          <Icon name="clear-all" />
        </button>
      </div>
      {error ? (
        <div className="output-view-error">
          <span>Couldn't load Output: {error}</span>
          <button className="icon-button" title="Retry" onClick={() => void pollLines()}>
            <Icon name="refresh" />
          </button>
        </div>
      ) : (
        <pre className="output-view-lines" ref={listRef} onScroll={onScroll}>
          {shown.length === 0 && (
            <div className="output-view-empty">
              {lines.length === 0 ? "Nothing logged yet." : "No lines match the filter."}
            </div>
          )}
          {shown.map((line) => {
            const level = levelOf(line.text);
            return (
              <div key={line.seq} className={`output-view-line${level ? ` level-${level}` : ""}`}>
                <span className="output-view-time">{timeOf(line.at)}</span>
                {all && <span className="output-view-channel">[{line.channel}]</span>}
                <span className="output-view-text">{line.text}</span>
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}
