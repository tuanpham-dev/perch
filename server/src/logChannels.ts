// In-memory log channels behind the bottom panel's OUTPUT view
// (plans/bottom-panel-views.md): one ring of recent lines per channel, the
// server's own prints under CORE_CHANNEL and one channel per extension that
// logs through its ctx.log. Nothing here touches disk, and a restart starts
// empty: this is a window onto what the process printed, not a log store.

import { format } from "node:util";

export const CORE_CHANNEL = "Perch";
// The id a reader passes for every channel at once, merged in arrival
// order. Not a channel name an extension could take: display names are
// words, and this is not one.
export const ALL_CHANNELS = "*";
export const MAX_LINES = 2000;

export interface LogLine {
  // Increases across every channel, so a reader can ask for "everything
  // after the last line I saw" and never miss or repeat one.
  seq: number;
  at: number;
  channel: string;
  text: string;
}

const channels = new Map<string, LogLine[]>();
let nextSeq = 1;

// One entry per line of `text`; a multi-line message keeps its line breaks
// as separate entries so the view can filter them one by one.
export function appendLog(channel: string, text: string, at = Date.now()): void {
  let lines = channels.get(channel);
  if (!lines) {
    lines = [];
    channels.set(channel, lines);
  }
  for (const line of text.split("\n")) {
    lines.push({ seq: nextSeq++, at, channel, text: line });
  }
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

// `cursor` is the highest seq handed out so far, across every channel: pass
// it back as `since` to get only what was appended after this answer.
export function readLog(channel: string, since = 0): { lines: LogLine[]; cursor: number } {
  if (channel === ALL_CHANNELS) return readAllLogs(since);
  return { lines: after(channels.get(channel) ?? [], since), cursor: nextSeq - 1 };
}

// Lines are appended in seq order, so the first one past `since` starts
// the answer.
function after(lines: LogLine[], since: number): LogLine[] {
  let start = 0;
  while (start < lines.length && lines[start].seq <= since) start++;
  return lines.slice(start);
}

// Every channel's lines past `since`, in the order they arrived (seq is
// global), capped like a single channel so the answer never outgrows one.
function readAllLogs(since: number): { lines: LogLine[]; cursor: number } {
  const merged: LogLine[] = [];
  for (const lines of channels.values()) merged.push(...after(lines, since));
  merged.sort((a, b) => a.seq - b.seq);
  return {
    lines: merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged,
    cursor: nextSeq - 1,
  };
}

// ALL_CHANNELS empties every channel.
export function clearLog(channel: string): void {
  if (channel === ALL_CHANNELS) {
    for (const lines of channels.values()) lines.splice(0);
    return;
  }
  channels.get(channel)?.splice(0);
}

// CORE_CHANNEL first, always (the view's default), then the rest by name.
export function listChannels(): string[] {
  const rest = [...channels.keys()].filter((c) => c !== CORE_CHANNEL).sort((a, b) => a.localeCompare(b));
  return [CORE_CHANNEL, ...rest];
}

// Tests only: every channel forgotten, the sequence restarted.
export function resetLogChannels(): void {
  channels.clear();
  nextSeq = 1;
}

// Routes everything the process prints through console.log/warn/error into
// CORE_CHANNEL as well as stdout/stderr. The server has no logger of its
// own - it prints from a dozen files - so wrapping console here is what makes
// the OUTPUT view's "Perch" channel complete, third-party prints included.
// An extension's ctx.log prefixes its lines "[ext:<id>]" and appends them to
// that extension's own channel itself, so those are left out here rather
// than shown twice.
export function captureConsole(): void {
  const wrap = (level: "log" | "warn" | "error") => {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const text = format(...args);
      if (text.startsWith("[ext:")) return;
      appendLog(CORE_CHANNEL, level === "log" ? text : `[${level}] ${text}`);
    };
  };
  wrap("log");
  wrap("warn");
  wrap("error");
}
