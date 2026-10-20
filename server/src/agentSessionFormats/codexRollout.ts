// Codex's rollouts: ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<id>.jsonl.
// The first line is session_meta (the session id and the folder it ran in);
// messages are response_item lines with a role, tool calls are
// function_call / custom_tool_call items. Codex keeps no per-folder index, so
// listing a folder means reading each rollout's first line; that answer is
// cached per file. Running codex processes are matched to their rollout by
// the file they hold open (Linux only).
//
// Read-only: nothing here writes to Codex's files.
import { open, readdir, readFile, readlink, stat } from "node:fs/promises";
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

async function listRollouts(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
      }),
    );
  };
  await walk(root, 0);
  return out;
}

// session_meta from the first line, read without loading the whole file.
async function readMeta(file: string): Promise<{ id: string; cwd: string } | null> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const first = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    const entry = JSON.parse(first) as Entry;
    const payload = entry.payload as Entry | undefined;
    if (entry.type !== "session_meta" || !payload) return null;
    const id = typeof payload.id === "string" ? payload.id : typeof payload.session_id === "string" ? payload.session_id : "";
    const cwd = typeof payload.cwd === "string" ? payload.cwd : "";
    return id && cwd ? { id, cwd } : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

// What Codex adds to the conversation itself (environment context, AGENTS.md,
// instructions) starts with a tag; prompts the user typed don't.
function isInjected(text: string): boolean {
  return /^\s*</.test(text) || text.startsWith("# AGENTS.md");
}

export function codexMessages(entries: Entry[]): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "response_item") continue;
    const p = entry.payload as Entry | undefined;
    if (!p) continue;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant") && Array.isArray(p.content)) {
      const text = (p.content as Entry[])
        .filter((b) => b?.type === "input_text" || b?.type === "output_text")
        .map((b) => String(b.text ?? ""))
        .join("\n")
        .trim();
      if (!text || (p.role === "user" && isInjected(text))) continue;
      out.push({ role: p.role, text });
    } else if ((p.type === "function_call" || p.type === "custom_tool_call") && typeof p.name === "string") {
      let input: unknown = p.input ?? p.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          // custom tools take free text
        }
      }
      out.push({ role: "tool", text: toolLine(p.name, input) });
    }
  }
  return out;
}

interface Parsed {
  meta: { id: string; cwd: string } | null;
  title?: string;
  messageCount?: number;
}

export function createCodexReader(root = path.join(homedir(), ".codex", "sessions")): SessionReader {
  const cache = new FileCache<Parsed>();
  const fileById = new Map<string, string>();

  async function parsed(file: string, full: boolean): Promise<{ parsed: Parsed; mtimeMs: number } | null> {
    try {
      const info = await stat(file);
      let hit = cache.get(file, info.mtimeMs, info.size);
      if (!hit) {
        hit = { meta: await readMeta(file) };
        cache.set(file, info.mtimeMs, info.size, hit);
      }
      if (full && hit.meta && hit.title === undefined) {
        const messages = codexMessages(parseJsonl(await readFile(file, "utf8")));
        hit.title = oneLine(messages.find((m) => m.role === "user")?.text ?? "Untitled conversation");
        hit.messageCount = messages.filter((m) => m.role !== "tool").length;
      }
      if (hit.meta) fileById.set(hit.meta.id, file);
      return { parsed: hit, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  return {
    async list(cwd) {
      const files = await listRollouts(root);
      // First lines only, to find this folder's rollouts; then the full
      // read just for those.
      const metas = await mapLimit(files, 16, async (file) => ({ file, got: await parsed(file, false) }));
      const mine = metas.filter((m) => m.got?.parsed.meta && path.resolve(m.got.parsed.meta.cwd) === path.resolve(cwd));
      const rows = await mapLimit(mine, 8, async ({ file }): Promise<SessionSummary | null> => {
        const got = await parsed(file, true);
        const meta = got?.parsed.meta;
        if (!got || !meta || !got.parsed.messageCount) return null;
        return {
          id: meta.id,
          cwd: meta.cwd,
          title: got.parsed.title ?? "Untitled conversation",
          lastActiveAt: got.mtimeMs,
          messageCount: got.parsed.messageCount,
        };
      });
      return rows.filter((r): r is SessionSummary => r !== null);
    },

    async messages(id, _cwd, limit) {
      let file = fileById.get(id);
      if (!file) {
        for (const f of await listRollouts(root)) {
          if ((await parsed(f, false))?.parsed.meta?.id === id) {
            file = f;
            break;
          }
        }
      }
      if (!file) return [];
      try {
        return codexMessages(parseJsonl(await readFile(file, "utf8"))).slice(-limit);
      } catch {
        return [];
      }
    },

    async sessionForProcess(pid) {
      if (process.platform !== "linux") return null;
      let fds: string[];
      try {
        fds = await readdir(`/proc/${pid}/fd`);
      } catch {
        return null;
      }
      for (const fd of fds) {
        let target: string;
        try {
          target = await readlink(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        if (target.startsWith(root) && target.endsWith(".jsonl")) {
          return (await parsed(target, false))?.parsed.meta?.id ?? null;
        }
      }
      return null;
    },
  };
}
