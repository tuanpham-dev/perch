// The hook writer, against a throwaway HOME.
//
// What is being pinned down is the promise core makes about writing into
// files it does not own: it touches its OWN entries and nothing else, in
// whichever of the two shapes an agent's descriptor declares. Every test
// seeds the file with hand-written entries first and asserts they are still
// there afterwards, because "core ate my hooks" is the one failure that
// cannot be undone from the UI.
//
// The descriptors below are written out in full rather than imported from the
// bundled extension: this tests the writer, and a test that took its
// descriptors from the same manifest the writer reads could not tell a broken
// writer from a broken manifest. The flat-wrapper one is synthetic - no agent
// core or the bundled extension ships uses that shape today (agy left), and a
// fixture is what keeps it expressible.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const home = await mkdtemp(path.join(tmpdir(), "agents-test-"));
// Both read at import time by agents.ts (the shim path) and by settingsStore.
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
// settingsStore puts the document under <XDG_CONFIG_HOME>/perch/, not
// directly in it.
const SETTINGS = path.join(process.env.XDG_CONFIG_HOME, "perch", "settings.json");
await mkdir(path.dirname(SETTINGS), { recursive: true });
const writeSettings = (settings) => writeFile(SETTINGS, JSON.stringify({ settings }));
await writeSettings({});

const agents = await import("./agents.ts");
const {
  agentHookShimPath,
  installHooks,
  uninstallHooks,
  hookStateFor,
  parseHookDescriptor,
  parseOneShot,
  oneShotArgs,
  setContributedAgentsSource,
  snippetFor,
} = agents;

// Stand in for the extension host. Without it every agent below is an orphan -
// hooks reporting as an id the registry cannot resolve - which is a state
// hookStateFor is right to call stale, and which would mask the states these
// tests are actually about.
let registry = [];
setContributedAgentsSource(async () => registry);

const EVENTS = ["session-start", "stop"];

function descriptor(overrides) {
  return parseHookDescriptor({
    file: "~/.agent/config.json",
    events: { "session-start": "SessionStart", stop: "Stop" },
    ...overrides,
  });
}

function agent(hooks, id = "ext.demo") {
  const preset = {
    id,
    label: "Demo",
    program: "demo",
    command: "demo",
    skipPermissionsArgs: "",
    hooks,
    docsUrl: "",
    iconUrl: "",
    icon: "hubot",
    enabled: true,
    contributedBy: "ext",
  };
  registry = [preset];
  return preset;
}

async function seed(file, doc) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

const readDoc = async (file) => JSON.parse(await readFile(file, "utf8"));

// ---- Descriptor validation ----

test("refuses a hook file outside $HOME", () => {
  assert.equal(parseHookDescriptor({ file: "/etc/passwd", events: { stop: "Stop" } }), null);
  assert.equal(parseHookDescriptor({ file: "~/../../etc/passwd", events: { stop: "Stop" } }), null);
  assert.equal(parseHookDescriptor({ file: "relative/path.json", events: { stop: "Stop" } }), null);
});

test("refuses a descriptor that can deliver nothing", () => {
  assert.equal(parseHookDescriptor({ file: "~/.a/b.json", events: {} }), null);
  // An event name core has no vocabulary for is dropped, not guessed at.
  assert.equal(parseHookDescriptor({ file: "~/.a/b.json", events: { invented: "Whatever" } }), null);
});

test("a companion must sit in the hook file's own directory", () => {
  assert.equal(descriptor({ companion: "~/.agent/trust.toml" }).companion, path.join(home, ".agent/trust.toml"));
  assert.equal(descriptor({ companion: "~/elsewhere/trust.toml" }).companion, null);
  assert.equal(descriptor({ companion: "/etc/trust.toml" }).companion, null);
});

// ---- Nested shape, merged into a file someone else owns ----

test("merges into a foreign file and leaves every foreign entry alone", async () => {
  const hooks = descriptor({ matcherEvents: ["PreToolUse"] });
  await seed(hooks.file, {
    someOtherSetting: { keep: true },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "/usr/bin/mine --hand-written" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/theirs" }] }],
    },
  });

  await installHooks(agent(hooks), EVENTS);
  const doc = await readDoc(hooks.file);

  assert.deepEqual(doc.someOtherSetting, { keep: true });
  const sessionStart = doc.hooks.SessionStart;
  assert.equal(sessionStart.length, 2, "the hand-written entry must survive beside core's");
  assert.equal(sessionStart[0].hooks[0].command, "/usr/bin/mine --hand-written");
  assert.ok(sessionStart[1].hooks[0].command.startsWith(agentHookShimPath));
  // An event core was not asked to install is untouched, matcher and all.
  assert.deepEqual(doc.hooks.PreToolUse, [
    { matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/theirs" }] },
  ]);
});

test("uninstall removes only core's handlers", async () => {
  const hooks = descriptor();
  await installHooks(agent(hooks), EVENTS);
  await uninstallHooks(agent(hooks), EVENTS);
  const doc = await readDoc(hooks.file);
  assert.equal(doc.hooks.SessionStart.length, 1);
  assert.equal(doc.hooks.SessionStart[0].hooks[0].command, "/usr/bin/mine --hand-written");
  assert.equal(doc.hooks.Stop, undefined, "an event left empty is pruned");
});

test("installing twice replaces core's entry rather than stacking a second", async () => {
  const hooks = descriptor();
  await installHooks(agent(hooks), EVENTS);
  await installHooks(agent(hooks), EVENTS);
  const doc = await readDoc(hooks.file);
  const core = doc.hooks.Stop.filter((e) => e.hooks[0].command.startsWith(agentHookShimPath));
  assert.equal(core.length, 1);
});

test("the matcher goes only on the events that accept one", async () => {
  const hooks = descriptor({
    matcherEvents: ["PreToolUse"],
    events: { "tool-start": "PreToolUse", stop: "Stop" },
  });
  await installHooks(agent(hooks), ["tool-start", "stop"]);
  const doc = await readDoc(hooks.file);
  const ours = (event) => doc.hooks[event].find((e) => e.hooks[0].command.startsWith(agentHookShimPath));
  assert.equal(ours("PreToolUse").matcher, "*");
  assert.equal("matcher" in ours("Stop"), false);
});

// ---- Whole-file shape with required top-level fields ----

test("whole-file agents get their required fields, and a user's value is kept", async () => {
  const hooks = descriptor({
    file: "~/.whole/hooks.json",
    ownership: "whole-file",
    extraFields: { description: "generated" },
  });
  await installHooks(agent(hooks), EVENTS);
  assert.equal((await readDoc(hooks.file)).description, "generated");

  await seed(hooks.file, { description: "mine, thanks", hooks: {} });
  await installHooks(agent(hooks), EVENTS);
  assert.equal((await readDoc(hooks.file)).description, "mine, thanks");
});

// ---- Flat wrapper shape (synthetic: the shape an external agent would use) ----

test("writes a flat wrapper, and refuses to overwrite someone else's", async () => {
  const hooks = descriptor({
    file: "~/.flat/hooks.json",
    container: { wrapper: "perch", extra: { enabled: true } },
    entry: "flat",
  });
  await seed(hooks.file, {
    "someone-elses": { enabled: true, Stop: [{ type: "command", command: "/usr/bin/theirs" }] },
  });
  await installHooks(agent(hooks), EVENTS);

  let doc = await readDoc(hooks.file);
  assert.deepEqual(doc["someone-elses"].Stop, [{ type: "command", command: "/usr/bin/theirs" }]);
  assert.equal(doc["perch"].enabled, true);
  // Flat: the event's value IS the handler list, with no inner "hooks".
  assert.ok(Array.isArray(doc["perch"].Stop));
  assert.equal(doc["perch"].Stop[0].hooks, undefined);
  assert.ok(doc["perch"].Stop[0].command.startsWith(agentHookShimPath));

  // A wrapper under core's own name that is not core's is refused outright.
  await seed(hooks.file, { "perch": { enabled: true, Stop: [{ type: "command", command: "/usr/bin/not-ours" }] } });
  await assert.rejects(() => installHooks(agent(hooks), EVENTS), /already has a hook named/);
  assert.equal((await readDoc(hooks.file))["perch"].Stop[0].command, "/usr/bin/not-ours");
});

test("flat wrappers uninstall by command, not by name", async () => {
  const hooks = descriptor({
    file: "~/.flat2/hooks.json",
    container: { wrapper: "renamed-since", extra: { enabled: true } },
    entry: "flat",
  });
  await installHooks(agent(hooks), EVENTS);
  // Core finds its own wrapper even under a name it would not write today.
  const renamed = descriptor({
    file: "~/.flat2/hooks.json",
    container: { wrapper: "perch", extra: { enabled: true } },
    entry: "flat",
  });
  await uninstallHooks(agent(renamed), EVENTS);
  assert.deepEqual(await readDoc(hooks.file), {});
});

// ---- Safety rails ----

test("a backup is kept every time core writes", async () => {
  const hooks = descriptor({ file: "~/.backup/hooks.json" });
  await seed(hooks.file, { hooks: {} });
  await installHooks(agent(hooks), EVENTS);
  await installHooks(agent(hooks), EVENTS);
  const backups = (await readdir(path.dirname(hooks.file))).filter((f) => f.includes("perch-backup"));
  assert.equal(backups.length, 2, "two writes, two distinct backups");
});

test("a file that is not JSON is reported, never overwritten", async () => {
  const hooks = descriptor({ file: "~/.broken/hooks.json" });
  await mkdir(path.dirname(hooks.file), { recursive: true });
  await writeFile(hooks.file, "{ this is not json");
  await assert.rejects(() => installHooks(agent(hooks), EVENTS), /not valid JSON/);
  assert.equal(await readFile(hooks.file, "utf8"), "{ this is not json");

  const state = await hookStateFor(agent(hooks), EVENTS);
  assert.equal(state.state, "not-installed");
  assert.match(state.error, /not valid JSON/);
});

test("an unsafe agent id is refused rather than escaped", async () => {
  const hooks = descriptor({ file: "~/.unsafe/hooks.json" });
  await assert.rejects(() => installHooks(agent(hooks, "evil; rm -rf /"), EVENTS), /not a usable agent id/);
  assert.equal(snippetFor(agent(hooks, "evil; rm -rf /"), EVENTS), null);
});

test("an agent with no descriptor is unsupported, not an error", async () => {
  const state = await hookStateFor(agent(null), EVENTS);
  assert.equal(state.state, "unsupported");
  assert.equal(state.file, null);
});

// ---- State ----

test("state goes not-installed -> installed -> stale as the wanted events change", async () => {
  const hooks = descriptor({ file: "~/.state/hooks.json" });
  assert.equal((await hookStateFor(agent(hooks), EVENTS)).state, "not-installed");
  await installHooks(agent(hooks), EVENTS);
  assert.equal((await hookStateFor(agent(hooks), EVENTS)).state, "installed");
  const narrowed = await hookStateFor(agent(hooks), ["stop"]);
  assert.equal(narrowed.state, "stale");
  assert.match(narrowed.staleReason, /no longer match/);
});

// ---- One-shot invocation ----
// The argv these build used to be a hardcoded table in ai.ts; the templates
// now come from a manifest, so the substitution rules are what keeps
// "commit message, please" from being handed to the wrong flag.

test("substitutes the prompt as its own argv entry", () => {
  const spec = parseOneShot({ args: ["-p", "{prompt}"], modelArgs: ["--model", "{model}"] });
  assert.deepEqual(oneShotArgs(spec, "hello world", ""), ["-p", "hello world"]);
  // Never shell-quoted and never split: a prompt that looks like a flag is
  // still one argument.
  assert.deepEqual(oneShotArgs(spec, "--help; rm -rf /", ""), ["-p", "--help; rm -rf /"]);
});

test("the model splice point places the flag where that CLI wants it", () => {
  // codex is the reason this is a splice point rather than a placeholder: its
  // model flag goes BEFORE the prompt.
  const codex = parseOneShot({ args: ["exec", "{modelArgs}", "{prompt}"], modelArgs: ["-m", "{model}"] });
  assert.deepEqual(oneShotArgs(codex, "hi", "gpt-5"), ["exec", "-m", "gpt-5", "hi"]);
  // With no model the splice point disappears entirely - no dangling flag.
  assert.deepEqual(oneShotArgs(codex, "hi", ""), ["exec", "hi"]);
});

test("a form that never places the prompt is refused", () => {
  assert.equal(parseOneShot({ args: ["-p"], modelArgs: [] }), null);
  assert.equal(parseOneShot({ args: [], modelArgs: [] }), null);
  assert.equal(parseOneShot(null), null);
  assert.equal(parseOneShot("claude -p"), null);
});

test("non-string tokens in a manifest are dropped rather than stringified", () => {
  const spec = parseOneShot({ args: ["-p", 42, "{prompt}", null], modelArgs: ["--model", "{model}", {}] });
  assert.deepEqual(spec.args, ["-p", "{prompt}"]);
  assert.deepEqual(spec.modelArgs, ["--model", "{model}"]);
});

test("the bundled agents' own templates produce the argv ai.ts used to hardcode", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../extensions/agents/package.json", import.meta.url), "utf8"),
  );
  const byId = Object.fromEntries(manifest.contributes.agents.map((a) => [a.id, parseOneShot(a.oneShot)]));
  // Exactly what the deleted CLI_PROVIDERS table built, for both agents.
  assert.deepEqual(oneShotArgs(byId.claude, "q", "opus"), ["-p", "--model", "opus", "q"]);
  assert.deepEqual(oneShotArgs(byId.claude, "q", ""), ["-p", "q"]);
  assert.deepEqual(oneShotArgs(byId.codex, "q", "gpt-5"), ["exec", "-m", "gpt-5", "q"]);
  assert.deepEqual(oneShotArgs(byId.codex, "q", ""), ["exec", "q"]);
});

after(async () => {
  // The fixture home is under the OS temp dir; leaving it is harmless and
  // removing it recursively from a test is not a risk worth taking.
});
