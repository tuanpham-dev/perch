// What a session reader answers, whichever agent it reads for: built-in
// formats (this folder) and extensions' own readers
// (host.agentSessions.provideReader) alike. See ../agentSessions.ts.

export interface SessionSummary {
  // The agent's own session id: what its resumeSession line takes.
  id: string;
  // The folder the conversation ran in, absolute.
  cwd: string;
  // The agent's own title for it when it has one, else the first prompt,
  // on one line.
  title: string;
  // Epoch ms of the newest entry (the file's mtime).
  lastActiveAt: number;
  // Prompts plus replies; tool calls and their results aren't counted.
  messageCount: number;
}

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface SessionReader {
  // Conversations that ran in `cwd` (absolute), any order.
  list(cwd: string): Promise<SessionSummary[]>;
  // The last `limit` messages of one, oldest first; [] when it can't be read.
  messages(id: string, cwd: string, limit: number): Promise<SessionMessage[]>;
  // Which session a running agent process has open, when the format can
  // tell; lets the browser mark a conversation as open in a window.
  sessionForProcess?(pid: number): Promise<string | null>;
}

// One line, at most `max` characters, for a title.
export function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// A tool call collapsed to one line: its name and the first thing it was
// given (a command, a path, a pattern).
export function toolLine(name: string, input: unknown): string {
  let first = "";
  if (typeof input === "string") first = input;
  else if (input && typeof input === "object") {
    const values = Object.values(input as Record<string, unknown>);
    const value = values.find((v) => typeof v === "string") as string | undefined;
    first = value ?? "";
  }
  return oneLine(`${name} ${first}`, 160);
}

// Parsed JSONL, skipping blank and half-written lines.
export function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") out.push(value as Record<string, unknown>);
    } catch {
      // the live end of a file still being written
    }
  }
  return out;
}

// A per-file cache keyed on mtime and size, so listing a folder again only
// re-reads what changed.
export class FileCache<T> {
  #entries = new Map<string, { mtimeMs: number; size: number; value: T }>();

  get(file: string, mtimeMs: number, size: number): T | undefined {
    const hit = this.#entries.get(file);
    return hit && hit.mtimeMs === mtimeMs && hit.size === size ? hit.value : undefined;
  }

  set(file: string, mtimeMs: number, size: number, value: T): void {
    if (this.#entries.size > 5000) this.#entries.clear();
    this.#entries.set(file, { mtimeMs, size, value });
  }
}

// Runs `fn` over `items` with at most `limit` in flight.
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
