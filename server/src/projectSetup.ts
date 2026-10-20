// A project's committed terminal setup: `.perch/project.json` in the project
// folder, listing the terminals to open (each a name, and optionally a
// command and a folder inside the project) and whether to tile them in a
// grid. Perch offers to open them when the folder is opened.
//
// The file comes from the repository, so its commands are someone else's
// until the user has seen them. Trust is recorded per folder against the
// sha256 of the file's exact bytes: a file never approved, or changed since,
// is shown for review; an approved, unchanged one is offered in one click;
// "never" stops the offers for that folder. The record is a file of its own
// (<config>/project-setup-trust.json), not a settings-document key: the
// client PUTs whole settings documents, which would overwrite a key the
// server wrote, and it stays out of settings bundles by construction.
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./configDir.js";
import { expandHome, shortenHome } from "./files.js";
import { createWindow, declaredWindows, listSessions } from "./terminals.js";

export const SETUP_FILE = path.join(".perch", "project.json");
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TERMINALS = 24;

export interface SetupTerminal {
  name: string;
  command?: string;
  // Relative to the project folder, as written.
  cwd?: string;
}

export interface ProjectSetup {
  terminals: SetupTerminal[];
  grid: boolean;
}

export type Trust = "new" | "changed" | "approved" | "never";

export type SetupReading =
  | { status: "none" }
  | { status: "invalid"; error: { message: string; path: string } }
  | { status: "ok"; setup: ProjectSetup; hash: string; trust: Trust };

class SetupError extends Error {
  constructor(
    message: string,
    readonly where: string,
  ) {
    super(message);
  }
}

// The file's contents as a ProjectSetup, or a SetupError naming what's wrong
// and where. `root` is the absolute project folder.
export function parseSetup(text: string, root: string): ProjectSetup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new SetupError(`Not valid JSON: ${(err as Error).message}`, SETUP_FILE);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SetupError("The file must hold a JSON object", SETUP_FILE);
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.terminals)) throw new SetupError('"terminals" must be a list', "terminals");
  if (obj.terminals.length > MAX_TERMINALS) {
    throw new SetupError(`At most ${MAX_TERMINALS} terminals`, "terminals");
  }
  if (obj.grid !== undefined && typeof obj.grid !== "boolean") throw new SetupError('"grid" must be true or false', "grid");
  const names = new Set<string>();
  const terminals = obj.terminals.map((t, i): SetupTerminal => {
    const where = `terminals[${i}]`;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new SetupError("Each terminal must be an object", where);
    const entry = t as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) throw new SetupError("A terminal needs a name", `${where}.name`);
    if (name.length > 60) throw new SetupError("Names can be at most 60 characters", `${where}.name`);
    if (names.has(name)) throw new SetupError(`Two terminals are named "${name}"`, `${where}.name`);
    names.add(name);
    const out: SetupTerminal = { name };
    if (entry.command !== undefined) {
      if (typeof entry.command !== "string") throw new SetupError('"command" must be a string', `${where}.command`);
      const command = entry.command.trim();
      if (/[\r\n]/.test(command)) throw new SetupError('"command" must be one line', `${where}.command`);
      if (command.length > 4096) throw new SetupError('"command" is too long', `${where}.command`);
      if (command) out.command = command;
    }
    if (entry.cwd !== undefined) {
      if (typeof entry.cwd !== "string") throw new SetupError('"cwd" must be a string', `${where}.cwd`);
      const resolved = path.resolve(root, entry.cwd);
      const rel = path.relative(root, resolved);
      if (path.isAbsolute(entry.cwd) || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new SetupError('"cwd" must be a folder inside the project', `${where}.cwd`);
      }
      if (rel) out.cwd = entry.cwd;
    }
    return out;
  });
  return { terminals, grid: obj.grid === true };
}

// ---- Trust ----

interface TrustRecord {
  hash?: string;
  never?: boolean;
}

const trustFile = () => path.join(configDir, "project-setup-trust.json");
let trustWrites: Promise<unknown> = Promise.resolve();

async function readTrust(): Promise<Record<string, TrustRecord>> {
  try {
    const parsed = JSON.parse(await readFile(trustFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// One read-modify-write at a time, temp-then-rename at 0600.
function updateTrust(fn: (doc: Record<string, TrustRecord>) => void): Promise<void> {
  const run = trustWrites.then(async () => {
    const doc = await readTrust();
    fn(doc);
    await mkdir(path.dirname(trustFile()), { recursive: true, mode: 0o700 });
    const tmp = `${trustFile()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, trustFile());
  });
  trustWrites = run.catch(() => {});
  return run;
}

const hashOf = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const rootOf = (cwd: string) => path.resolve(expandHome(cwd));

// ---- Reading ----

export async function readProjectSetup(cwd: string): Promise<SetupReading> {
  const root = rootOf(cwd);
  let bytes: Buffer;
  try {
    const file = path.join(root, SETUP_FILE);
    if ((await stat(file)).size > MAX_FILE_BYTES) {
      return { status: "invalid", error: { message: "The file is larger than 64 KB", path: SETUP_FILE } };
    }
    bytes = await readFile(file);
  } catch {
    return { status: "none" };
  }
  let setup: ProjectSetup;
  try {
    setup = parseSetup(bytes.toString("utf8"), root);
  } catch (err) {
    if (err instanceof SetupError) return { status: "invalid", error: { message: err.message, path: err.where } };
    throw err;
  }
  const hash = hashOf(bytes);
  const record = (await readTrust())[root];
  const trust: Trust = record?.never ? "never" : record?.hash === hash ? "approved" : record?.hash ? "changed" : "new";
  return { status: "ok", setup, hash, trust };
}

export async function setNever(cwd: string, never: boolean): Promise<void> {
  const root = rootOf(cwd);
  await updateTrust((doc) => {
    const record = doc[root] ?? {};
    if (never) record.never = true;
    else delete record.never;
    if (Object.keys(record).length === 0) delete doc[root];
    else doc[root] = record;
  });
}

// Folders the user said never to offer the setup for, `~`-shortened.
export async function listNever(): Promise<string[]> {
  const doc = await readTrust();
  return Object.entries(doc)
    .filter(([, r]) => r.never)
    .map(([root]) => shortenHome(root))
    .sort();
}

// ---- Opening ----

export interface OpenedTerminal {
  name: string;
  index: number;
  created: boolean;
}

// Opens the setup in `session` (a session rooted in the project): each
// terminal is a window of that name, created with its command unless one of
// that name is already there. Refused unless `hash` is the file's current
// hash - the user approved what they saw, and what they saw is what runs.
// Records the approval.
export async function openProjectSetup(cwd: string, session: string, hash: string): Promise<{ terminals: OpenedTerminal[]; grid: boolean }> {
  const reading = await readProjectSetup(cwd);
  if (reading.status !== "ok") throw Object.assign(new Error("There's no valid setup file to open"), { status: 400 });
  if (reading.hash !== hash) {
    throw Object.assign(new Error("The setup file changed since it was shown. Review it again."), { status: 409 });
  }
  const root = rootOf(cwd);
  await updateTrust((doc) => {
    doc[root] = { hash };
  });
  const existing = await declaredWindows(session);
  const out: OpenedTerminal[] = [];
  for (const t of reading.setup.terminals) {
    const same = existing.find((w) => w.name === t.name);
    if (same) {
      out.push({ name: t.name, index: same.index, created: false });
      continue;
    }
    const dir = t.cwd ? path.resolve(root, t.cwd) : root;
    const index = await createWindow(session, dir, t.name, t.command);
    out.push({ name: t.name, index, created: true });
  }
  return { terminals: out, grid: reading.setup.grid };
}

// ---- Saving ----

// The current terminals of every session rooted in the project, as a setup
// file: names, folders relative to the project, and the commands they were
// started with. With `write`, writes it (refusing to replace an existing
// file unless `overwrite`) and records it as approved: the user wrote it.
export async function saveProjectSetup(
  cwd: string,
  opts: { write: boolean; overwrite: boolean },
): Promise<{ content: string; exists: boolean; written: boolean }> {
  const root = rootOf(cwd);
  const file = path.join(root, SETUP_FILE);
  const sessions = (await listSessions()).filter((s) => !s.name.startsWith("perch-view-") && rootOf(s.path) === root);
  const terminals: SetupTerminal[] = [];
  const names = new Set<string>();
  for (const s of sessions) {
    for (const w of await declaredWindows(s.name)) {
      let name = w.name || "terminal";
      for (let n = 2; names.has(name); n++) name = `${w.name} ${n}`;
      names.add(name);
      const entry: SetupTerminal = { name };
      if (w.declaredCommand) entry.command = w.declaredCommand;
      const rel = path.relative(root, rootOf(w.cwd));
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) entry.cwd = rel.split(path.sep).join("/");
      terminals.push(entry);
    }
  }
  let previous: Buffer | null = null;
  try {
    previous = await readFile(file);
  } catch {
    previous = null;
  }
  const grid = previous ? (() => {
    try {
      return parseSetup(previous.toString("utf8"), root).grid;
    } catch {
      return false;
    }
  })() : false;
  const content = `${JSON.stringify({ terminals, ...(grid ? { grid } : {}) }, null, 2)}\n`;
  if (!opts.write) return { content, exists: previous !== null, written: false };
  if (previous !== null && !opts.overwrite) {
    throw Object.assign(new Error(`${SETUP_FILE} already exists`), { status: 409 });
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await updateTrust((doc) => {
    doc[root] = { hash: hashOf(Buffer.from(content)) };
  });
  return { content, exists: previous !== null, written: true };
}
