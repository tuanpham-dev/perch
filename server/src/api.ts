import { listEngines } from "./multiplexer.js";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Router, urlencoded, type Request, type Response } from "express";
import {
  AiError,
  listAiProfiles,
  listProviderModels,
  probeCliProviders,
} from "./ai.js";
import {
  hookStateFor,
  HookWriteError,
  installHooks,
  isSafeAgentId,
  listAgents,
  probeAgentPrograms,
  resolveAgents,
  snippetFor,
  uninstallHooks,
} from "./agents.js";
import { agentsForSession } from "./agentWindows.js";
import { reportAgentHook, subscribedEvents, subscriberSummary } from "./agentHooks.js";
import {
  ConflictError,
  copyPath,
  createEmptyFile,
  deletePath,
  ensureDir,
  exists,
  expandHome,
  fuzzyScore,
  getGitRoot,
  isDirectory,
  isFile,
  listDir,
  listRepoFiles,
  movePath,
  renamePath,
  resolveDestination,
  shortenHome,
  uniquePath,
  walkFiles,
} from "./files.js";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  planWorktreeCleanup,
  cleanUpWorktrees,
  repoIdentity,
  WorktreeError,
  type Branch,
  type WorktreeInfo,
} from "./gitWorktrees.js";
import {
  emitApiMutation,
  extensionHookMiddleware,
  installFromPackageFile,
  listExtensions,
  resolveExtensionFile,
  setExtensionEnabled,
  uninstallExtension,
} from "./extensions.js";
import { hasReceivedEvents, paneHistory, recordEnd, recordStart } from "./commandEvents.js";
import { broadcastOpenTarget, broadcastOpenUrl, subscribeOpenUrl } from "./openUrl.js";
import { getTunnelablePorts } from "./ports.js";
import { tunnelStatus } from "./wsTunnel.js";
import { addSubscription, getVapidPublicKey, removeSubscription } from "./push.js";
import { getDefaultRegistry, getRegistryCatalog, getRegistryIcon, getRegistryReadme, resolvePackageForInstall } from "./registry.js";
import { shellIntegrationPath, shellIntegrationProfile, shellIntegrationSourceLine } from "./shellIntegration.js";
import { applyTerminalSettings } from "./terminalSettings.js";
import { isLoopbackAddress, primaryProxyDomain } from "./security.js";
import { resolveLinkPath } from "./pathLinks.js";
import {
  mergeSettingsDoc,
  readAiSecrets,
  readSettingsDoc,
  writeAiSecret,
  writeSettingsDoc,
} from "./settingsStore.js";
import {
  openDiffInWindow,
  openMergeInWindow,
  openFileInPaneWithKeys,
  openFileInWindow,
} from "./editor.js";
import {
  createSession,
  createWindow,
  createWindowTab,
  findWindow,
  invalidateSessionsCache,
  killSession,
  killWindow,
  killWindowTab,
  listSessionPanes,
  listSessions,
  openLazygitWindow,
  paneCurrentPath,
  renameSession,
  renameWindow,
  resetWindowName,
  selectWindow,
  sendTextToSession,
  WindowGoneError,
} from "./terminals.js";
import { writeZip } from "./zip.js";

export const api = Router();

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The session listing is cached for a beat (see terminals.ts) so N tabs polling
// for the same answer don't each pay to recompute it, and extensions keep
// their own equivalent caches (git-scm's decoration scan). Any mutation we
// perform can invalidate those, so drop/signal them once the request that
// made it has finished — cheaper and harder to forget than tagging each
// write/rename/delete/paste/transfer/upload route individually. On
// "finish", not before next(): invalidating up front would leave a window
// where a concurrent listing re-populates a cache from the pre-mutation
// tree, and that stale answer would then outlive the write.
api.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.on("finish", () => {
      invalidateSessionsCache();
      // Extension-facing "something on disk probably changed" signal —
      // server hooks subscribed via host.events.onApiMutation invalidate
      // their own caches on it (e.g. git-scm's decoration scan cache,
      // which replaced the core git cache this middleware used to drop).
      emitApiMutation();
    });
  }
  next();
});


function sendFsError(res: Response, err: unknown): void {
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
  } else {
    res.status(400).json({ error: errMessage(err) });
  }
}

api.get("/sessions", async (_req, res) => {
  try {
    res.json(await listSessions());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

api.post("/sessions", async (req, res) => {
  const name = typeof req.body?.name === "string" && req.body.name.trim() !== ""
    ? req.body.name.trim()
    : undefined;
  // Optional cwd from the client's "default new session dir" setting. The
  // setting can point at a path that doesn't exist (typo, different
  // machine) — fall back to the server default rather than failing the
  // create over a preference.
  const rawCwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() !== ""
    ? req.body.cwd.trim()
    : undefined;
  let cwd: string | undefined;
  if (rawCwd) {
    const expanded = expandHome(rawCwd);
    if (await isDirectory(expanded)) cwd = expanded;
  }
  // Project opens set exactCwd so the session starts at the registered folder
  // itself rather than its git root — only honored when cwd validated above.
  const exactCwd = req.body?.exactCwd === true && cwd !== undefined;
  try {
    res.status(201).json(await createSession(name, cwd, exactCwd));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Settings persistence: one JSON document, client-owned schema (see
// settingsStore.ts). Lives under /api so the host/origin guards apply.
// PUT replaces the whole document (standard PUT semantics — the body IS
// the new representation); PATCH deep-merges the body over the on-disk
// document instead, so a caller sending a partial body can't silently drop
// every sibling key it didn't mention. The client's own write-back
// (useSettingsSync.ts) already fetch-merges client-side before calling PUT
// with the complete doc, so it's unaffected either way — PATCH exists for
// callers that want to send just what changed.
api.get("/settings", async (_req, res) => {
  try {
    // The server-owned keys never leave the server — see settingsStore's
    // module comment. Clients learn which AI providers have a key from
    // GET /ai-key; an extension's own routes answer for its own secrets.
    const { aiSecrets: _aiOmitted, extensionSecrets: _extOmitted, ...doc } = await readSettingsDoc();
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Presence only, never the keys themselves — enough for the settings UI to
// show "set"/"not set" and for a provider picker to warn before you select a
// provider you have no key for.
api.get("/ai-key", async (_req, res) => {
  try {
    const secrets = await readAiSecrets();
    // Every id that has a key, profile ids and the pre-profiles
    // provider-keyed entries alike — the settings UI asks about whichever it
    // is showing, and both kinds resolve at call time (see ai.ts).
    const has: Record<string, boolean> = {};
    for (const id of Object.keys(secrets)) has[id] = true;
    res.json({ anthropic: !!secrets.anthropic, openai: !!secrets.openai, has });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Which CLI providers are installed on this machine — the settings UI greys
// out the ones that aren't, rather than letting someone pick a provider
// whose first real call would fail with "not found".
api.get("/ai-cli", async (_req, res) => {
  try {
    res.json(await probeCliProviders());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Every AI a caller may name: the stored API providers plus one entry per
// agent that can answer a single prompt. The agent-derived ones are not in
// the settings document at all, so the settings UI cannot build this list for
// itself - which is the whole point of the CLIs coming from the registry
// rather than from a second list somebody maintains
// (plans/cli-providers-from-agents.md).
api.get("/ai-profiles", async (_req, res) => {
  try {
    res.json({ profiles: await listAiProfiles() });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// The models a profile's own endpoint offers, for the Model field's picker.
// Errors carry ai.ts's typed code so the UI can say "add a key first" rather
// than showing a raw failure.
api.get("/ai-models", async (req, res) => {
  const profileId = typeof req.query.profileId === "string" ? req.query.profileId : undefined;
  try {
    res.json({ models: await listProviderModels(profileId) });
  } catch (err) {
    if (err instanceof AiError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: errMessage(err) });
  }
});

// The agent registry (agents.ts) — the one answer to "what is an AI agent",
// for core and for every extension that used to carry its own copy
// (plans/agent-platform-core.md). Enabled entries only, in the user's order:
// a disabled agent is one the user has taken out of circulation, so neither
// detection nor a launch picker should offer it.
//
// Read-only on purpose. The list is edited through the settings document like
// every other core setting (Settings → AI Providers), so there is exactly one
// writer and no second path that could disagree with it.
api.get("/agents", async (_req, res) => {
  try {
    // The Yolo/Manual choice travels WITH the list, so a consumer never has to
    // ask a second time. It used to be asked again per launch - a checkbox on
    // the worktree form and a menu row in jira - which meant one question in
    // three places and a local answer that could contradict the global one.
    const doc = await readSettingsDoc();
    const settings = (doc.settings ?? {}) as Record<string, unknown>;
    res.json({
      agents: await listAgents(),
      skipPermissions: settings.agentPermissions === "yolo",
    });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Which agent is running in which terminal, for extensions with no server
// hook of their own. Same resolver host.agents.forWindow uses, so both doors
// give the same answer — see agentWindows.ts for why core owns this rather
// than each extension matching command names for itself.
api.get("/agents/windows", async (req, res) => {
  const session = typeof req.query.session === "string" ? req.query.session : "";
  if (!session) {
    res.status(400).json({ error: "session is required" });
    return;
  }
  try {
    const windows = await agentsForSession(session);
    const index = req.query.window;
    if (index === undefined) {
      res.json({ windows });
      return;
    }
    const windowIndex = Number(index);
    if (!Number.isFinite(windowIndex)) {
      res.status(400).json({ error: "window must be a number" });
      return;
    }
    res.json({ windows: windows.filter((w) => w.windowIndex === windowIndex) });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// The only route that can write an API key. An empty/absent key clears it.
api.put("/ai-key", async (req, res) => {
  try {
    // The profile id the key belongs to. Keys used to be stored under a bare
    // provider name before profiles existed; that alias is gone with the
    // pre-profiles settings.
    const rawId = req.body?.profileId;
    const id = typeof rawId === "string" ? rawId.trim() : "";
    // Keys are stored under this id verbatim, so it has to look like an id
    // and not like a path or a prototype key.
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id) || id === "__proto__") {
      res.status(400).json({ error: "profileId must be a short id" });
      return;
    }
    const key = typeof req.body?.key === "string" ? req.body.key : "";
    await writeAiSecret(id, key || null);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.put("/settings", async (req, res) => {
  try {
    await writeSettingsDoc(req.body);
    void applyTerminalSettings().catch((err) => console.error("failed to apply terminal settings:", err));
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.patch("/settings", async (req, res) => {
  try {
    await mergeSettingsDoc(req.body);
    void applyTerminalSettings().catch((err) => console.error("failed to apply terminal settings:", err));
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Extensions: manifests discovered under ~/.config/perch/extensions/.
// See extensions.ts for the format and security posture (running an
// extension's server hook is running code as the server user — same threat
// model as the terminal this app already gives you).
api.get("/extensions", async (_req, res) => {
  try {
    res.json(await listExtensions());
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

api.post("/extensions/install", async (req, res) => {
  const tmpPath = path.join(tmpdir(), `perch-upload-${randomUUID()}.perch`);
  const out = createWriteStream(tmpPath);
  req.pipe(out);
  out.on("finish", async () => {
    try {
      res.status(201).json(await installFromPackageFile(tmpPath));
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
    }
  });
  out.on("error", (err) => {
    unlink(tmpPath).catch(() => {});
    res.status(500).json({ error: errMessage(err) });
  });
  req.on("error", (err) => {
    out.destroy();
    unlink(tmpPath).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: errMessage(err) });
  });
});

api.delete("/extensions/:id", async (req, res) => {
  try {
    await uninstallExtension(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/extensions/:id/enabled", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  try {
    res.json(await setExtensionEnabled(req.params.id, req.body.enabled));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Serves an extension's own files (theme JSON, icon fonts/SVGs, the client
// JS entry point) — resolveExtensionFile rejects traversal outside the
// extension's folder the same way resolveDestination does for the FILES
// panel.
api.get("/extensions/:id/file/*", async (req, res) => {
  const relPath = (req.params as unknown as { 0: string })[0] ?? "";
  const target = await resolveExtensionFile(req.params.id, relPath);
  if (!target) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  res.sendFile(target, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "file not found" });
  });
});

// Dispatches to a live extension's server hook router, or 404 if the
// extension has none/is disabled — see extensions.ts's serverHooks map.
api.use("/ext/:extId", extensionHookMiddleware);

// Extension registries: user-configured sources (settings doc's
// extensionRegistries) each serving an index.json catalog of installable
// extensions — see registry.ts for the source/entry resolution and its
// security posture (every request re-validates source against the current
// settings doc; no client-supplied path/URL is ever read directly).
api.get("/registry", async (req, res) => {
  // See getRegistryCatalog's doc: an optional client-supplied source list,
  // sidestepping the settings doc's debounced write-back.
  let sourcesOverride: string[] | undefined;
  if (typeof req.query.sources === "string") {
    try {
      const parsed: unknown = JSON.parse(req.query.sources);
      if (Array.isArray(parsed) && parsed.every((s): s is string => typeof s === "string")) {
        sourcesOverride = parsed;
      }
    } catch {
      // Malformed sources param — fall back to the persisted settings doc.
    }
  }
  try {
    res.json({ sources: await getRegistryCatalog(req.query.refresh === "1", sourcesOverride) });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// The app's built-in default registry (EXTENSION_REGISTRY env, else the
// shipped GitHub Pages catalog), or null when disabled. The client merges this
// ahead of the user's own sources for display — a static SPA can't read
// process.env, so it learns the value here.
api.get("/registry/default", (_req, res) => {
  res.json({ registry: getDefaultRegistry() });
});

api.post("/registry/install", async (req, res) => {
  const { source, id } = req.body ?? {};
  if (typeof source !== "string" || typeof id !== "string") {
    res.status(400).json({ error: "source and id must be strings" });
    return;
  }
  try {
    const packagePath = await resolvePackageForInstall(source, id);
    res.status(201).json(await installFromPackageFile(packagePath));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.get("/registry/readme", async (req, res) => {
  const { source, id } = req.query;
  if (typeof source !== "string" || typeof id !== "string") {
    res.status(400).json({ error: "source and id must be strings" });
    return;
  }
  try {
    res.type("text/markdown").send(await getRegistryReadme(source, id));
  } catch (err) {
    res.status(404).json({ error: errMessage(err) });
  }
});

api.get("/registry/icon", async (req, res) => {
  const { source, id } = req.query;
  if (typeof source !== "string" || typeof id !== "string") {
    res.status(400).json({ error: "source and id must be strings" });
    return;
  }
  try {
    const { data, contentType } = await getRegistryIcon(source, id);
    res.type(contentType).send(data);
  } catch (err) {
    res.status(404).json({ error: errMessage(err) });
  }
});

api.delete("/sessions/:name", async (req, res) => {
  try {
    await killSession(req.params.name);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Types text into a session's active pane, optionally submitting it — the
// shared primitive every "send this to the agent pane" extension flow (agent
// launcher, diff comments, element picker, GitHub handoff) drives through a
// plain fetch (a public core route, per docs/EXTENSION_API.md), so none of
// them needs its own send-text call.
api.post("/sessions/:name/send-text", async (req, res) => {
  const { text, submit, windowIndex } = req.body ?? {};
  if (typeof text !== "string" || text.length === 0) {
    res.status(400).json({ error: "text must be a non-empty string" });
    return;
  }
  if (text.length > 64 * 1024) {
    res.status(400).json({ error: "text exceeds 64KB" });
    return;
  }
  if (windowIndex !== undefined && !(Number.isInteger(windowIndex) && windowIndex >= 0)) {
    res.status(400).json({ error: "windowIndex must be a non-negative integer" });
    return;
  }
  try {
    await sendTextToSession(req.params.name, text, submit === true, windowIndex);
    res.status(204).end();
  } catch (err) {
    const message = errMessage(err);
    res.status(/can't find session|no session named/i.test(message) ? 404 : 400).json({ error: message });
  }
});

api.post("/sessions/:name/windows", async (req, res) => {
  const cwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() !== ""
    ? req.body.cwd.trim()
    : undefined;
  try {
    const index = await createWindow(req.params.name, cwd);
    res.status(201).json({ index });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/lazygit", async (req, res) => {
  const cwd = typeof req.body?.cwd === "string" && req.body.cwd.trim() !== ""
    ? req.body.cwd.trim()
    : undefined;
  try {
    res.json({ index: await openLazygitWindow(req.params.name, cwd) });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/windows/:index/select", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  try {
    await selectWindow(req.params.name, index);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/windows/:index/open-tab", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  try {
    const attachName = await createWindowTab(req.params.name, index);
    res.status(201).json({ attachName });
  } catch (err) {
    // Distinguished so the client can recover quietly (see useFileOpeners'
    // openFileInSession) instead of surfacing the backend's raw "can't find
    // window: N" — the window vanishing between two requests is an ordinary
    // race, not a real failure.
    if (err instanceof WindowGoneError) {
      res.status(404).json({ error: errMessage(err) });
      return;
    }
    res.status(400).json({ error: errMessage(err) });
  }
});

api.delete("/window-views/:attachName", async (req, res) => {
  try {
    await killWindowTab(req.params.attachName);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/windows/:index/rename", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  const newName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  // An empty name is "give it back to automatic naming" rather than an error: renaming
  // is one-way otherwise (see resetWindowName), and the UI's Reset Name
  // action is the only route back to a command-tracking name.
  try {
    if (newName) await renameWindow(req.params.name, index, newName);
    else await resetWindowName(req.params.name, index);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.delete("/sessions/:name/windows/:index", async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "invalid window index" });
    return;
  }
  try {
    await killWindow(req.params.name, index);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/rename", async (req, res) => {
  const newName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!newName) {
    res.status(400).json({ error: "new name is required" });
    return;
  }
  try {
    await renameSession(req.params.name, newName);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/sessions/:name/open-file", async (req, res) => {
  const raw = typeof req.body?.path === "string" ? req.body.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const filePath = expandHome(raw);
  const keysPane = typeof req.body?.keysPane === "string" ? req.body.keysPane : null;
  // Ctrl+click on a "file:line" terminal link (see resolve-paths below) —
  // only a positive integer is honored, anything else opens without a jump.
  const line =
    typeof req.body?.line === "number" && Number.isInteger(req.body.line) && req.body.line > 0
      ? req.body.line
      : undefined;
  try {
    if (!(await isFile(filePath))) {
      res.status(400).json({ error: "path is not a file" });
      return;
    }
    // keysPane completes a deferred open (see OpenFileResult.deferredPane):
    // the client already surfaced that pane's window/tab, so it's now safe
    // to inject the keystrokes the initial scan held back.
    if (keysPane) {
      await openFileInPaneWithKeys(keysPane, filePath, line);
      res.status(200).json({ windowIndex: null });
      return;
    }
    const result = await openFileInWindow(req.params.name, filePath, line);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Reads one side of a diff/merge out of a request body: content and label are
// required, `path` optional and expanded. Returns null when the shape is wrong,
// so the route can 400 rather than write a temp file full of "undefined".
function readEditorSide(raw: unknown, allowPath: boolean): { content: string; label: string; path?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const side = raw as { content?: unknown; label?: unknown; path?: unknown };
  if (typeof side.content !== "string" || typeof side.label !== "string" || !side.label) return null;
  if (!allowPath || typeof side.path !== "string" || !side.path) {
    return { content: side.content, label: side.label };
  }
  return { content: side.content, label: side.label, path: expandHome(side.path) };
}

// nvim's half of the `editor` setting's diff capability — see
// openDiffInWindow. The client sends both sides as text (git-scm resolved them
// from the index/HEAD); only the modified side may name a real working file,
// which is the one nvim is allowed to edit.
api.post("/sessions/:name/open-diff", async (req, res) => {
  const original = readEditorSide(req.body?.original, false);
  const modified = readEditorSide(req.body?.modified, true);
  if (!original || !modified) {
    res.status(400).json({ error: "original and modified sides with content and label are required" });
    return;
  }
  try {
    if (modified.path && !(await isFile(modified.path))) {
      res.status(400).json({ error: "modified.path is not a file" });
      return;
    }
    res.status(200).json(await openDiffInWindow(req.params.name, { original, modified }));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// nvim's half of the merge capability — the mergetool nvimdiff layout over a
// conflicted working file. See openMergeInWindow.
api.post("/sessions/:name/open-merge", async (req, res) => {
  const rawPath = typeof req.body?.path === "string" ? req.body.path : "";
  const ours = readEditorSide(req.body?.ours, false);
  const theirs = readEditorSide(req.body?.theirs, false);
  const base = req.body?.base === undefined ? undefined : readEditorSide(req.body?.base, false);
  if (!rawPath || !ours || !theirs || base === null) {
    res.status(400).json({ error: "path, ours, and theirs are required" });
    return;
  }
  const filePath = expandHome(rawPath);
  try {
    if (!(await isFile(filePath))) {
      res.status(400).json({ error: "path is not a file" });
      return;
    }
    res.status(200).json(await openMergeInWindow(req.params.name, { path: filePath, ours, theirs, base }));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Validates terminal-link file-path candidates for the ctrl+click link
// provider (see client/src/terminalLinks.ts), resolving each against the
// session's current window's cwd. The lookup order past that cwd (git
// top-level, diff a/ b/ prefixes) lives in resolveLinkPath. Only regular files
// come back — a path-shaped string in output (a comment, a log line) never
// turns into a false-positive link. A window is one terminal, so the screen
// cell a candidate may carry (`cells`) no longer picks between panes.
api.post("/sessions/:name/resolve-paths", async (req, res) => {
  const candidates = Array.isArray(req.body?.paths)
    ? req.body.paths.filter((p: unknown): p is string => typeof p === "string")
    : [];
  try {
    const activeCwd = await paneCurrentPath(req.params.name);
    const roots = new Map<string, Promise<string | null>>();
    const gitRoot = (dir: string) => {
      let root = roots.get(dir);
      if (!root) {
        root = getGitRoot(dir);
        roots.set(dir, root);
      }
      return root;
    };
    const results = await Promise.all(
      candidates.map((raw: string) => resolveLinkPath(raw, activeCwd, { isFile, gitRoot })),
    );
    res.status(200).json({ results });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// What the ports extension needs to build a proxy URL for a port — currently
// just the first configured PROXY_DOMAIN, if any (see security.ts). No
// domain means the panel falls back to /proxy/<port>/ on the app's own
// origin. Stays core (unlike the extracted /ports list/kill routes, now in
// extensions/ports/server.js) because it fronts proxy/tunnel infrastructure.
// The terminal engines Settings -> Terminal can choose from: the bundled
// daemon plus any an extension registered, which one is saved as the choice
// and which one this server is actually running on.
api.get("/terminal-engines", (_req, res) => {
  res.json({ engines: listEngines() });
});

api.get("/proxy-config", (_req, res) => {
  res.json({ domain: primaryProxyDomain() });
});

// Reflects the caller's own Cookie/Authorization headers back as JSON, so the
// PORTS panel can bake them into the copied tunnel command when perch is
// fronted by a reverse-proxy auth layer. This deliberately punctures HttpOnly
// (page JS can now read the session cookie) — acceptable under this app's
// trust model, where anyone past the auth layer already has a full shell via
// the terminal itself. Each response only ever contains what that request
// carried, so there's no cross-user data to leak.
api.get("/tunnel-auth", (req, res) => {
  res.json({
    cookie: req.headers.cookie ?? null,
    authorization: req.headers.authorization ?? null,
  });
});

// What the app needs to say whether a port is reachable at localhost:<port>:
// whether any tunnel client is connected, which ports it reports having
// bound, and whether that covers everything currently listening.
// `allForwarded` is the honest form of "all forwarded" — --all skips a port
// it cannot bind locally, so a connected tunnel is not a complete one.
api.get("/tunnel-status", async (_req, res) => {
  try {
    const status = tunnelStatus();
    const listening = await getTunnelablePorts();
    const forwarded = new Set(status.ports);
    res.json({
      ...status,
      allForwarded:
        status.connected && listening.size > 0 && [...listening].every((p) => forwarded.has(p)),
    });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Probed by the client's AuthGate on boot. Reaching this handler at all
// means the request already cleared the auth gate middleware in index.ts
// (or the gate is off) — there's nothing left to check here.
api.get("/auth", (_req, res) => {
  res.status(204).end();
});

api.get("/fs", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const dirPath = expandHome(raw);
  try {
    if (!(await isDirectory(dirPath))) {
      res.status(400).json({ error: "path is not a directory" });
      return;
    }
    // Plain listing only — git status badges and the branch pill are the
    // git-scm extension's file-decoration provider's job now (see
    // extensions/git-scm), not inlined here.
    // The echoed path is `~`-shortened, matching how session/window paths
    // leave the server everywhere else — the folder picker feeds it into
    // the projects registry, where equality against session_path must never
    // mix expanded and shortened forms. (FileTree keys by its own request
    // path and ignores this field.)
    res.json({ path: shortenHome(dirPath), entries: await listDir(dirPath) });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// Roots the FILES panel at the git repo containing `path`, falling back to
// `path` itself when it isn't inside a repo. Resolved on demand (only when the
// active window's cwd changes) rather than per-window in the sessions poll.
api.get("/fs/git-root", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const dirPath = expandHome(raw);
  try {
    if (!(await isDirectory(dirPath))) {
      res.status(400).json({ error: "path is not a directory" });
      return;
    }
    const root = await getGitRoot(dirPath);
    res.json({ root: shortenHome(root ?? dirPath) });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// ---- git worktrees ----
//
// Backs the PROJECTS tree's middle level: which repository each session's
// folder belongs to, and every worktree of that repository (including ones
// with no session, which is how a worktree stays reachable after its session
// dies). See plans/worktrees-into-projects.md.
//
// Paths cross this boundary `~`-shortened in both directions — expandHome on
// the way in, shortenHome on the way out — so nothing above the API line ever
// handles an absolute path.

function shortenWorktrees(worktrees: WorktreeInfo[]): WorktreeInfo[] {
  return worktrees.map((wt) => ({ ...wt, path: shortenHome(wt.path) }));
}

function shortenBranches(branches: Branch[]): Branch[] {
  return branches.map((b) => ({ ...b, checkedOutAt: b.checkedOutAt ? shortenHome(b.checkedOutAt) : null }));
}

// One or more `path` params, each answered with its repository and that
// repository's worktrees. `dirty=1` adds per-worktree uncommitted-changes
// state (one `git status` each — the expensive half of the tree's poll);
// `branches=1` adds the local branch list the create form's pickers need.
//
// The git work is deduplicated by repository: N session paths inside one repo
// cost one `git worktree list`, not N. A path that isn't in a repository
// answers `repo: null` — a normal answer for a session started outside one,
// not an error.
api.get("/git/worktrees", async (req, res) => {
  const raw = req.query.path;
  const paths = (Array.isArray(raw) ? raw : [raw]).filter((p): p is string => typeof p === "string" && p !== "");
  if (paths.length === 0) {
    res.status(400).json({ error: "at least one path is required" });
    return;
  }
  const wantDirty = req.query.dirty === "1";
  const wantBranches = req.query.branches === "1";
  try {
    // repoIdentity is one `git rev-parse` per path and is shared by every
    // worktree of a repo, so it decides which paths can share one listing.
    const byIdentity = new Map<string, Awaited<ReturnType<typeof listWorktrees>>>();
    const results = [];
    for (const p of [...new Set(paths)]) {
      const dirPath = expandHome(p);
      const identity = await repoIdentity(dirPath);
      if (!identity) {
        results.push({ path: p, repo: null, worktrees: [], branches: [] });
        continue;
      }
      let listing = byIdentity.get(identity);
      if (!listing) {
        listing = await listWorktrees(dirPath, { dirty: wantDirty, branches: wantBranches });
        byIdentity.set(identity, listing);
      }
      results.push({
        path: p,
        repo: listing.repo === null ? null : shortenHome(listing.repo),
        worktrees: shortenWorktrees(listing.worktrees),
        branches: shortenBranches(listing.branches),
      });
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Creates a worktree and stops there — the session rooted in it is the
// client's to create, so the tree can name it and record it as a project in
// one flow.
api.post("/git/worktrees/create", async (req, res) => {
  const { cwd, branch, base, mode, location } = req.body ?? {};
  if (typeof cwd !== "string" || !cwd || typeof branch !== "string" || !branch.trim()) {
    res.status(400).json({ error: "cwd and branch are required" });
    return;
  }
  try {
    const created = await createWorktree({
      cwd: expandHome(cwd),
      branch,
      base: typeof base === "string" ? base : undefined,
      mode: mode === "existing" ? "existing" : "new",
      location: typeof location === "string" ? location : undefined,
    });
    res.json({ path: shortenHome(created.path), branch: created.branch });
  } catch (err) {
    res.status(err instanceof WorktreeError ? err.status : 500).json({ error: errMessage(err) });
  }
});

// Removes a worktree's checkout, keeping its branch. Sessions inside it are
// the caller's to kill first — this route never touches the terminal backend.
api.post("/git/worktrees/remove", async (req, res) => {
  const { cwd, path: target, force } = req.body ?? {};
  if (typeof cwd !== "string" || !cwd || typeof target !== "string" || !target) {
    res.status(400).json({ error: "cwd and path are required" });
    return;
  }
  try {
    const removed = await removeWorktree({
      cwd: expandHome(cwd),
      path: expandHome(target),
      force: force === true,
    });
    res.json({ removed: shortenHome(removed.removed) });
  } catch (err) {
    res.status(err instanceof WorktreeError ? err.status : 500).json({ error: errMessage(err) });
  }
});

// Clean Up Worktrees, step one: what a bulk cleanup would remove and what
// it would keep, and why. Read-only.
api.post("/git/worktrees/cleanup/plan", async (req, res) => {
  const { cwd } = req.body ?? {};
  if (typeof cwd !== "string" || !cwd) {
    res.status(400).json({ error: "cwd is required" });
    return;
  }
  try {
    const plan = await planWorktreeCleanup(expandHome(cwd));
    const shorten = <T extends { path: string }>(entries: T[]) =>
      entries.map((e) => ({ ...e, path: shortenHome(e.path) }));
    res.json({ repo: shortenHome(plan.repo), removable: shorten(plan.removable), kept: shorten(plan.kept) });
  } catch (err) {
    res.status(err instanceof WorktreeError ? err.status : 500).json({ error: errMessage(err) });
  }
});

// Step two: removes the confirmed paths, each re-checked against a fresh plan.
// Branches are kept, and this route never touches the terminal backend.
api.post("/git/worktrees/cleanup", async (req, res) => {
  const { cwd, paths } = req.body ?? {};
  if (typeof cwd !== "string" || !cwd || !Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
    res.status(400).json({ error: "cwd and paths are required" });
    return;
  }
  try {
    const result = await cleanUpWorktrees({ cwd: expandHome(cwd), paths: paths.map((p: string) => expandHome(p)) });
    res.json({
      removed: result.removed.map((p) => shortenHome(p)),
      skipped: result.skipped.map((s) => ({ ...s, path: shortenHome(s.path) })),
    });
  } catch (err) {
    res.status(err instanceof WorktreeError ? err.status : 500).json({ error: errMessage(err) });
  }
});

// Backs the quick switcher's file search: recursively lists files under
// `path`, gitignore-aware via `git ls-files` in a repo, falling back to a
// capped directory walk otherwise. With `q`, the server fuzzy-filters and
// returns only the top matches (per-keystroke search) instead of the whole
// corpus; without it, the full capped listing (backward compatible).
const FS_FILES_CAP = 10000;
const FS_MATCH_CAP = 50;

api.get("/fs/files", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const dirPath = expandHome(raw);
  try {
    if (!(await isDirectory(dirPath))) {
      res.status(400).json({ error: "path is not a directory" });
      return;
    }
    const cap = q ? FS_MATCH_CAP : FS_FILES_CAP;
    const score = q ? (rel: string) => fuzzyScore(q, rel) : undefined;
    const repoFiles = await listRepoFiles(dirPath, cap, score);
    const { files, truncated } = repoFiles ?? (await walkFiles(dirPath, cap, score));
    res.json({ path: dirPath, files, truncated });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/mkdir", async (req, res) => {
  const dir = typeof req.query.dir === "string" ? req.query.dir : "";
  const relPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!dir || !relPath) {
    res.status(400).json({ error: "dir and path are required" });
    return;
  }
  try {
    const target = resolveDestination(expandHome(dir), relPath);
    await ensureDir(target);
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/fs/rename", async (req, res) => {
  const raw = typeof req.body?.path === "string" ? req.body.path : "";
  const newName = typeof req.body?.newName === "string" ? req.body.newName.trim() : "";
  if (!raw || !newName) {
    res.status(400).json({ error: "path and newName are required" });
    return;
  }
  try {
    const dest = await renamePath(expandHome(raw), newName);
    res.status(200).json({ path: dest });
  } catch (err) {
    sendFsError(res, err);
  }
});

api.delete("/fs", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  try {
    await deletePath(expandHome(raw));
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

// FILES-tree copy/cut/paste clipboard. In-memory (not per-session) so it
// crosses browsers/tabs/devices talking to this same server — cleared on a
// server restart, which is acceptable for a clipboard. Paste is a pure
// server-side cp/mv (see copyPath/movePath), never round-tripping bytes
// through the client.
let fsClipboard: { paths: string[]; mode: "copy" | "cut" } | null = null;

api.put("/fs/clipboard", async (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : null;
  const mode = req.body?.mode === "copy" || req.body?.mode === "cut" ? req.body.mode : null;
  if (!paths || paths.length === 0 || !paths.every((p: unknown) => typeof p === "string") || !mode) {
    res.status(400).json({ error: "paths (non-empty string[]) and mode ('copy'|'cut') are required" });
    return;
  }
  const expanded = (paths as string[]).map(expandHome);
  // Validate at copy time, not just at paste time, so a stale/mistyped path
  // surfaces immediately instead of silently failing whenever paste happens.
  for (const p of expanded) {
    if (!(await exists(p))) {
      res.status(400).json({ error: `no such file or folder: ${p}` });
      return;
    }
  }
  fsClipboard = { paths: expanded, mode };
  res.status(204).end();
});

api.get("/fs/clipboard", (_req, res) => {
  res.json(fsClipboard ?? { paths: [], mode: null });
});

api.delete("/fs/clipboard", (_req, res) => {
  fsClipboard = null;
  res.status(204).end();
});

api.post("/fs/paste", async (req, res) => {
  const destDirRaw = typeof req.body?.destDir === "string" ? req.body.destDir : "";
  if (!destDirRaw) {
    res.status(400).json({ error: "destDir is required" });
    return;
  }
  if (!fsClipboard) {
    res.status(400).json({ error: "clipboard is empty" });
    return;
  }
  const destDir = expandHome(destDirRaw);
  if (!(await isDirectory(destDir))) {
    res.status(400).json({ error: "destDir is not a directory" });
    return;
  }

  const { paths, mode } = fsClipboard;
  const pasted: string[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const src of paths) {
    try {
      const target =
        mode === "copy" ? await copyPath(src, destDir) : await movePath(src, destDir);
      if (target) pasted.push(target);
    } catch (err) {
      errors.push({ path: src, message: errMessage(err) });
    }
  }
  // A cut is a one-shot move: clear it once at least one source landed, so a
  // second Ctrl+V doesn't try to move already-moved files. A copy stays on
  // the clipboard so it can be pasted repeatedly.
  if (mode === "cut" && pasted.length > 0) {
    fsClipboard = null;
  }
  res.status(200).json({ pasted, errors });
});

// Drag-and-drop move/copy within the FILES tree. Deliberately NOT routed
// through the clipboard above: a drag must not clobber a pending cut/copy the
// user set earlier (set-clipboard-then-paste would silently discard it). Path
// safety (self-nesting, collisions, EXDEV) stays entirely in movePath/copyPath.
api.post("/fs/transfer", async (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : null;
  const mode = req.body?.mode === "move" || req.body?.mode === "copy" ? req.body.mode : null;
  const destDirRaw = typeof req.body?.destDir === "string" ? req.body.destDir : "";
  if (!paths || paths.length === 0 || !paths.every((p: unknown) => typeof p === "string") || !mode) {
    res.status(400).json({ error: "paths (non-empty string[]) and mode ('move'|'copy') are required" });
    return;
  }
  if (!destDirRaw) {
    res.status(400).json({ error: "destDir is required" });
    return;
  }
  const destDir = expandHome(destDirRaw);
  if (!(await isDirectory(destDir))) {
    res.status(400).json({ error: "destDir is not a directory" });
    return;
  }

  const done: string[] = [];
  const errors: { path: string; message: string }[] = [];
  for (const raw of paths as string[]) {
    const src = expandHome(raw);
    try {
      const target = mode === "copy" ? await copyPath(src, destDir) : await movePath(src, destDir);
      // movePath returns null for a no-op (destDir is already src's parent) —
      // nothing moved, so nothing to report as done.
      if (target) done.push(target);
    } catch (err) {
      errors.push({ path: src, message: errMessage(err) });
    }
  }
  res.status(200).json({ done, errors });
});

api.post("/newfile", async (req, res) => {
  const dir = typeof req.query.dir === "string" ? req.query.dir : "";
  const relPath = typeof req.query.path === "string" ? req.query.path : "";
  if (!dir || !relPath) {
    res.status(400).json({ error: "dir and path are required" });
    return;
  }
  try {
    const target = resolveDestination(expandHome(dir), relPath);
    await ensureDir(path.dirname(target));
    await createEmptyFile(target);
    res.status(201).json({ path: target });
  } catch (err) {
    sendFsError(res, err);
  }
});

api.get("/download", async (req, res) => {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  if (!raw) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  const targetPath = expandHome(raw);
  try {
    if (await isDirectory(targetPath)) {
      const name = path.basename(targetPath);
      res.setHeader("content-type", "application/zip");
      res.setHeader("content-disposition", `attachment; filename="${name}.zip"`);
      // Streamed as it's built, entries rooted at <name>/. A download the
      // browser abandons stops the walk.
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      writeZip(targetPath, name, res, abort.signal)
        .then(() => res.end())
        .catch((err) => {
          if (!res.headersSent) res.status(500).json({ error: errMessage(err) });
          else res.destroy();
        });
      return;
    }
    if (!(await isFile(targetPath))) {
      res.status(400).json({ error: "path is not a file or directory" });
      return;
    }
    // inline=1 (PdfView's iframe) needs no Content-Disposition: attachment —
    // unlike an <img>/<video> subresource load, an iframe *navigation*
    // honors that header and would download the file instead of rendering
    // it. sendFile derives the right Content-Type from the extension and
    // sets no disposition header at all.
    if (req.query.inline === "1") {
      res.sendFile(targetPath);
      return;
    }
    res.download(targetPath, path.basename(targetPath));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

api.post("/upload", async (req, res) => {
  const dir = typeof req.query.dir === "string" ? req.query.dir : "";
  const relPath = typeof req.query.path === "string" ? req.query.path : "";
  const conflict = req.query.conflict === "overwrite" || req.query.conflict === "fail"
    ? req.query.conflict
    : "rename";
  if (!dir || !relPath) {
    res.status(400).json({ error: "dir and path are required" });
    return;
  }

  let target: string;
  try {
    // {tmp}: this machine's temp folder, so a default that works on Linux
    // (/tmp) doesn't point nowhere on Windows.
    target = resolveDestination(expandHome(dir.replaceAll("{tmp}", tmpdir())), relPath);
    await ensureDir(path.dirname(target));
    if (conflict === "rename") {
      target = await uniquePath(target);
    } else if (conflict === "fail" && (await exists(target))) {
      res.status(409).json({ error: "file already exists" });
      return;
    }
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
    return;
  }

  const out = createWriteStream(target);
  req.pipe(out);
  out.on("finish", () => {
    res.status(201).json({ path: target });
  });
  out.on("error", (err) => {
    unlink(target).catch(() => {});
    res.status(500).json({ error: errMessage(err) });
  });
  req.on("error", (err) => {
    out.destroy();
    unlink(target).catch(() => {});
    if (!res.headersSent) res.status(500).json({ error: errMessage(err) });
  });
});

// Web-push notifications (plans/codeman-mobile-features.md Phase 4). Bells
// don't come through a route: the server hears them from the terminal engine
// directly (index.ts).

api.get("/push/vapid-key", async (_req, res) => {
  try {
    res.json({ publicKey: await getVapidPublicKey() });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

function isPushSubscriptionBody(
  body: unknown,
): body is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return (
    typeof b.endpoint === "string" &&
    typeof b.keys === "object" &&
    b.keys !== null &&
    typeof b.keys.p256dh === "string" &&
    typeof b.keys.auth === "string"
  );
}

api.post("/push/subscribe", async (req, res) => {
  if (!isPushSubscriptionBody(req.body)) {
    res.status(400).json({ error: "invalid push subscription" });
    return;
  }
  try {
    await addSubscription({ endpoint: req.body.endpoint, keys: req.body.keys });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

api.post("/push/unsubscribe", async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    res.status(400).json({ error: "endpoint is required" });
    return;
  }
  try {
    await removeSubscription(endpoint);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Browser-opener bridge (plans/browser-opener-bridge.md). POST /open-url is
// reached by a local curl (the $BROWSER shim, see
// server/src/openUrl.ts) — auth-exempt (isAuthExemptPath) with its own
// loopback check, plus a required custom header: cross-origin browser
// requests carrying it need a CORS preflight this server never approves, so
// a malicious page can't use the endpoint to pop windows. The SSE /events
// stream stays behind the normal auth gate.

const MAX_OPEN_URL_LENGTH = 2048;

api.post("/open-url", urlencoded({ extended: false }), (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (req.headers["x-perch-open"] === undefined) {
    res.status(403).json({ error: "missing header" });
    return;
  }
  const url = (req.body as Record<string, unknown> | undefined)?.url;
  if (typeof url !== "string" || !url || url.length > MAX_OPEN_URL_LENGTH) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: "invalid url" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.status(400).json({ error: "only http(s) urls are supported" });
    return;
  }
  // localPort rather than a threaded-through config value: it's exactly the
  // port this instance is serving on, which is what the client compares
  // loopback URLs against to decide app-origin vs port-proxy rewriting.
  broadcastOpenUrl(parsed.href, req.socket.localPort ?? 0);
  res.status(204).end();
});

api.get("/open-url/events", (_req, res) => {
  subscribeOpenUrl(res);
});

// `perch open` bridge (plans/cli-open-command.md). Same loopback +
// custom-header pattern as /open-url — a local curl from the CLI, not a
// browser — but broadcasts a named `open-target` event on the same SSE
// stream instead of the unnamed open-url messages, so existing subscribers
// (the shim's popup-open path) are unaffected.

const MAX_OPEN_TARGET_PATH_LENGTH = 4096;

api.post("/open-target", urlencoded({ extended: false }), async (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (req.headers["x-perch-open"] === undefined) {
    res.status(403).json({ error: "missing header" });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const rawPath = body?.path;
  if (typeof rawPath !== "string" || !rawPath || rawPath.length > MAX_OPEN_TARGET_PATH_LENGTH) {
    res.status(400).json({ error: "path is required" });
    return;
  }
  let line: number | undefined;
  if (body?.line !== undefined) {
    const n = Number(body.line);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: "line must be a positive integer" });
      return;
    }
    line = n;
  }
  let action: "editor" | "preview" | undefined;
  if (body?.action !== undefined) {
    if (body.action !== "editor" && body.action !== "preview") {
      res.status(400).json({ error: "action must be editor or preview" });
      return;
    }
    action = body.action;
  }
  const target = expandHome(rawPath);
  if (!(await exists(target))) {
    res.status(400).json({ error: "path does not exist" });
    return;
  }
  const dir = await isDirectory(target);
  const kind = dir ? "dir" : "file";
  const projectCwd = dir ? target : ((await getGitRoot(path.dirname(target))) ?? path.dirname(target));
  const delivered = broadcastOpenTarget({
    kind,
    path: shortenHome(target),
    projectCwd: shortenHome(projectCwd),
    line,
    action,
  });
  res.json({ delivered });
});

// Agent hook state, for Settings → AI Providers: what core would install, what is
// actually in each agent's config file right now, and who asked for it. One
// GET answers the whole panel, so "why is this stale" is answerable there
// rather than by reading two files and reasoning about enabled extensions.
api.get("/agent-hooks", async (_req, res) => {
  try {
    const [agents, events, installed] = await Promise.all([
      resolveAgents(),
      subscribedEvents(),
      probeAgentPrograms(),
    ]);
    const states = await Promise.all(
      agents.map(async (agent) => ({
        ...(await hookStateFor(agent, events)),
        label: agent.label,
        command: agent.command,
        skipPermissionsArgs: agent.skipPermissionsArgs,
        docsUrl: agent.docsUrl,
        iconUrl: agent.iconUrl,
        icon: agent.icon,
        enabled: agent.enabled,
        contributedBy: agent.contributedBy,
        // Whether this agent's CLI is actually on the machine. Settings →
        // AI Providers dims a row that is not, rather than offering it as if it
        // would run.
        installed: installed[agent.id] ?? false,
        // The snippet is offered for every agent that has a hook format,
        // installed or not: copying it by hand is the safe door, and the
        // Install button is the convenience.
        snippet: snippetFor(agent, events),
      })),
    );
    res.json({ events, subscribers: subscriberSummary(), agents: states });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// The two routes that write into a file core does not own. Both are ordinary
// authenticated browser POSTs — a deliberate press in Settings → AI Providers,
// never anything automatic (see agents.ts's writer rules).
async function writeAgentHooks(
  req: Request,
  res: Response,
  write: typeof installHooks,
): Promise<void> {
  const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : "";
  try {
    const events = await subscribedEvents();
    const agent = (await resolveAgents()).find((a) => a.id === agentId);
    if (!agent) {
      res.status(404).json({ error: "no such agent" });
      return;
    }
    res.json(await write(agent, events));
  } catch (err) {
    // A refusal (a file core cannot parse, a name collision, nothing
    // subscribed) is the user's to act on, not a server fault.
    if (err instanceof HookWriteError) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: errMessage(err) });
  }
}

api.post("/agent-hooks/install", (req, res) => {
  void writeAgentHooks(req, res, installHooks);
});

api.post("/agent-hooks/uninstall", (req, res) => {
  void writeAgentHooks(req, res, uninstallHooks);
});

// Agent hooks (plans/agent-platform-core.md Phase 2). Reached by the shim an
// AI agent's own hook execs — a local process, never the browser — so it
// follows /api/command-events/report exactly: auth-exempt by path
// (isAuthExemptPath), with its own loopback check plus the custom-header
// CSRF guard standing in for the auth it cannot carry. Everything the agent
// supplies arrives as the raw body or a header and is validated here; none
// of it has been through a shell.

// Event names as the agents spell them (SessionStart, PreToolUse). Bounded
// and plain so an unknown one can be carried through to a subscriber and
// logged without being a vector of its own.
const RAW_EVENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// The raw body parser for this route is registered in index.ts, ahead of the
// app-wide express.json() — see agentHookBodyParser.
api.post("/agent-hooks/report", async (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (req.headers["x-perch-hook"] === undefined) {
    res.status(403).json({ error: "missing header" });
    return;
  }
  const header = (name: string): string => {
    const value = req.headers[name];
    return typeof value === "string" ? value : "";
  };
  const agentId = header("x-perch-agent");
  const rawEvent = header("x-perch-event");
  if (!isSafeAgentId(agentId) || !RAW_EVENT_NAME.test(rawEvent)) {
    res.status(400).json({ error: "invalid report" });
    return;
  }
  const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  try {
    const outcome = await reportAgentHook({
      agentId,
      rawEvent,
      paneId: header("x-perch-pane"),
      body,
    });
    // Always 204 on a well-formed report, outcome in a header: the shim
    // discards its output anyway, and a hook must never look like it failed
    // because nothing happened to be listening.
    res.set("X-Perch-Hook-Outcome", outcome).status(204).end();
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

// Command events (plans/warp-features.md Phase 1). /report follows the
// /open-url pattern exactly: reached by a local curl (the
// shell-integration snippet, see server/src/shellIntegration.ts) rather than
// the browser, so it's auth-exempt (isAuthExemptPath) with its own
// loopback-only check plus the custom-header CSRF guard. The GET sibling is
// a normal authenticated browser endpoint — that's why report lives on its
// own subpath: the auth exemption is path-based and must not cover the GET.

const MAX_COMMAND_LENGTH = 4096;
const MAX_CWD_LENGTH = 1024;

// A window id, as the shell integration reports it from $PERCH_WINDOW:
// a uuid (the daemon) or tmux-<n> (the tmux backend).
const WINDOW_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tmux-\d+)$/;

api.post("/command-events/report", urlencoded({ extended: false }), async (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (req.headers["x-perch-events"] === undefined) {
    res.status(403).json({ error: "missing header" });
    return;
  }
  const body = req.body as Record<string, unknown> | undefined;
  const pane = typeof body?.pane === "string" ? body.pane : "";
  const event = body?.event;
  const shellPid = Number.parseInt(typeof body?.shell === "string" ? body.shell : "", 10);
  const seq = Number.parseInt(typeof body?.seq === "string" ? body.seq : "", 10);
  if (
    !WINDOW_ID.test(pane) ||
    (event !== "start" && event !== "end") ||
    !Number.isFinite(shellPid) ||
    !Number.isFinite(seq)
  ) {
    res.status(400).json({ error: "invalid report" });
    return;
  }
  const command = (typeof body?.command === "string" ? body.command : "").slice(0, MAX_COMMAND_LENGTH);
  const cwd = (typeof body?.cwd === "string" ? body.cwd : "").slice(0, MAX_CWD_LENGTH);
  const exitCode = Number.parseInt(typeof body?.exit === "string" ? body.exit : "", 10);
  // Routes the event to the right attach sockets, and doubles as validation
  // that the window exists.
  const found = await findWindow(pane).catch(() => null);
  if (!found) {
    // Window already gone (e.g. the command was `exit`) — nothing to record
    // against, and nobody attached to receive it.
    res.status(204).end();
    return;
  }
  if (event === "start") {
    recordStart(pane, found.session, found.session, shellPid, seq, command, cwd);
  } else {
    recordEnd(pane, found.session, found.session, shellPid, seq, command, Number.isFinite(exitCode) ? exitCode : 0, cwd);
  }
  res.status(204).end();
});

// The Settings card's install/status view: the canonical source line plus
// whether any report has ever arrived this server lifetime.
api.get("/command-events/status", (_req, res) => {
  res.json({
    receivedAny: hasReceivedEvents(),
    path: shellIntegrationPath,
    sourceLine: shellIntegrationSourceLine,
    profile: shellIntegrationProfile,
  });
});

api.get("/command-events", async (req, res) => {
  const session = typeof req.query.session === "string" ? req.query.session : "";
  if (!session) {
    res.status(400).json({ error: "session is required" });
    return;
  }
  const paneFilter = typeof req.query.pane === "string" ? req.query.pane : "";
  try {
    const sessionPanes = await listSessionPanes(session);
    const panes = sessionPanes
      .filter((p) => !paneFilter || p.id === paneFilter)
      .map((p) => {
        const { running, history } = paneHistory(p.id);
        return {
          pane: p.id,
          windowIndex: p.windowIndex,
          paneIndex: p.paneIndex,
          active: p.active,
          currentCommand: p.command,
          title: p.title,
          running,
          // Newest first — the order every consumer (history switcher,
          // sidebar) wants; slice so the reverse doesn't mutate the store.
          history: history.slice().reverse(),
        };
      });
    res.json({ receivedAny: hasReceivedEvents(), panes });
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});
