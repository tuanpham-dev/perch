// Claude Code's transcripts: ~/.claude/projects/<folder slug>/<session id>.jsonl,
// one JSON entry per line - user and assistant messages, tool calls and their
// results, plus bookkeeping lines (custom-title, ai-title, summary, ...).
// The slug is the folder's path with every character that isn't a letter or
// digit turned into "-" (/home/me/.app -> -home-me--app). Running CLIs list
// their current session in ~/.claude/sessions/<pid>.json.
//
// Read-only: nothing here writes to Claude Code's files.
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  FileCache,
  mapLimit,
  oneLine,
  parseJsonl,
  toolLine,
  type SessionMessage,
  type SessionReader,
  type SessionSummary,
} from "./types.js";

type Entry = Record<string, unknown>;

export function claudeProjectDirs(root: string, cwd: string): string[] {
  // Claude Code's own rule, then the narrower one older viewers used, in case
  // a version ever differed; duplicates collapse.
  const slugs = new Set([cwd.replace(/[^a-zA-Z0-9]/g, "-"), cwd.replace(/[\\/:.]/g, "-")]);
  return [...slugs].map((slug) => path.join(root, slug));
}

// Prompts the user typed, as opposed to what Claude Code adds to the
// conversation on their behalf (command caveats, slash-command echoes,
// meta lines, tool results).
function userText(entry: Entry): string | null {
  if (entry.type !== "user" || entry.isMeta === true || entry.isSidechain === true) return null;
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => (b as Entry)?.type === "tool_result")) return null;
    text = content
      .filter((b) => (b as Entry)?.type === "text")
      .map((b) => String((b as Entry).text ?? ""))
      .join("\n");
  }
  text = text.trim();
  if (!text || text.startsWith("<local-command") || text.startsWith("<command-") || text.startsWith("<system-reminder>")) {
    return null;
  }
  return text;
}

function assistantBlocks(entry: Entry): SessionMessage[] {
  if (entry.type !== "assistant" || entry.isSidechain === true) return [];
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: SessionMessage[] = [];
  for (const raw of content) {
    const block = raw as Entry;
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push({ role: "assistant", text: block.text.trim() });
    } else if (block?.type === "tool_use" && typeof block.name === "string") {
      out.push({ role: "tool", text: toolLine(block.name, block.input) });
    }
  }
  return out;
}

// Every message in a transcript, in order.
export function claudeMessages(entries: Entry[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const entry of entries) {
    const user = userText(entry);
    if (user !== null) out.push({ role: "user", text: user });
    else out.push(...assistantBlocks(entry));
  }
  return out;
}

// The title Claude Code itself shows: a name the user gave it, else its own
// generated title, else an older summary line; else the first prompt.
export function claudeTitle(entries: Entry[]): string {
  let custom = "";
  let ai = "";
  let summary = "";
  let firstPrompt = "";
  for (const entry of entries) {
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") custom = entry.customTitle;
    else if (entry.type === "ai-title" && typeof entry.aiTitle === "string") ai = entry.aiTitle;
    else if (entry.type === "summary" && typeof entry.summary === "string") summary = entry.summary;
    else if (!firstPrompt) firstPrompt = userText(entry) ?? "";
  }
  return oneLine(custom || ai || summary || firstPrompt || "Untitled conversation");
}

interface Parsed {
  title: string;
  messageCount: number;
}

export function createClaudeReader(root = path.join(homedir(), ".claude", "projects")): SessionReader {
  const cache = new FileCache<Parsed>();

  async function filesFor(cwd: string): Promise<{ id: string; file: string }[]> {
    const out: { id: string; file: string }[] = [];
    for (const dir of claudeProjectDirs(root, cwd)) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith(".jsonl")) out.push({ id: name.slice(0, -".jsonl".length), file: path.join(dir, name) });
      }
    }
    return out;
  }

  return {
    async list(cwd) {
      const files = await filesFor(cwd);
      const rows = await mapLimit(files, 8, async ({ id, file }): Promise<SessionSummary | null> => {
        try {
          const info = await stat(file);
          let parsed = cache.get(file, info.mtimeMs, info.size);
          if (!parsed) {
            const entries = parseJsonl(await readFile(file, "utf8"));
            parsed = { title: claudeTitle(entries), messageCount: claudeMessages(entries).filter((m) => m.role !== "tool").length };
            cache.set(file, info.mtimeMs, info.size, parsed);
          }
          // A file with nothing but bookkeeping (a session opened and closed)
          // isn't a conversation anyone wants back.
          if (parsed.messageCount === 0) return null;
          return { id, cwd, title: parsed.title, lastActiveAt: info.mtimeMs, messageCount: parsed.messageCount };
        } catch {
          return null;
        }
      });
      return rows.filter((r): r is SessionSummary => r !== null);
    },

    async messages(id, cwd, limit) {
      const match = (await filesFor(cwd)).find((f) => f.id === id);
      if (!match) return [];
      try {
        return claudeMessages(parseJsonl(await readFile(match.file, "utf8"))).slice(-limit);
      } catch {
        return [];
      }
    },

    async sessionForProcess(pid) {
      try {
        const record = JSON.parse(await readFile(path.join(path.dirname(root), "sessions", `${pid}.json`), "utf8"));
        return typeof record?.sessionId === "string" ? record.sessionId : null;
      } catch {
        return null;
      }
    },
  };
}
