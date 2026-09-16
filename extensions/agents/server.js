// The Codex half of this extension: the trust blocks its CLI needs in
// ~/.codex/config.toml before it will run a hook at all.
//
// Codex refuses to run any hook whose handler is not trusted there, and it
// does so SILENTLY - no warning, nothing in its log, the hook simply never
// fires. A hooks.json on its own is inert, which is why this file exists and
// why the Claude agent beside it needs nothing.
//
// Verified against codex-cli 0.146.1 on 2026-09-11, in an isolated CODEX_HOME:
// with the blocks absent, not one hook fired; with them present, SessionStart
// and UserPromptSubmit both fired and codex logged "hook: SessionStart
// Completed". Both runs failed to authenticate (401), and the hooks fired
// anyway - so this has nothing to do with quota or login.
//
// The algorithm is reverse-engineered rather than documented: cross-read from
// the Orca desktop app's source (stablyai/orca, src/main/codex/) and then
// confirmed by firing. A codex release that changes the canonical form would
// break it silently again, which is what the paired control test guards.
import { createHash } from "node:crypto";

// codex names an event in PascalCase in hooks.json and in snake_case in the
// trust key. Derived rather than tabled, so an event added to the manifest
// needs no change here.
function eventLabel(rawEvent) {
  return rawEvent
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// Sorts every object's keys, at every depth: the hash is taken over a
// canonical serialization, so key order must not be able to change it.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

// The hash codex computes for a handler it is asked to trust: the event's
// label plus the handler as codex normalizes it - `async` defaulted to false
// and `timeout` defaulted to 600 and floored at 1, both present whether or
// not hooks.json spelled them out.
function trustedHash(handler) {
  const identity = {
    event_name: eventLabel(handler.rawEvent),
    hooks: [
      {
        type: "command",
        command: handler.command,
        timeout: Math.max(1, handler.timeoutSeconds ?? 600),
        async: false,
      },
    ],
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex")}`;
}

function escapeTomlBasicString(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

function trustKey(hookFile, handler) {
  return `${hookFile}:${eventLabel(handler.rawEvent)}:${handler.group}:${handler.handler}`;
}

// Drops every [hooks.state."<hookFile>:…"] block, header line through to the
// next table header. Only blocks keyed on THIS hooks.json go: a trust block
// for a hook file the user manages elsewhere is none of our business.
//
// Deliberately a line scan rather than a TOML parse: this file is the user's,
// it may hold comments, ordering and formatting that matter to them, and a
// parse-and-reserialize round trip would quietly rewrite all of it.
function stripOurBlocks(content, hookFile) {
  const prefix = `[hooks.state."${escapeTomlBasicString(hookFile)}:`;
  const lines = content.split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("[")) {
      // Any table header ends the block we were dropping; this one starts a
      // new drop only if it is ours.
      dropping = trimmed.startsWith(prefix);
      if (dropping) continue;
    }
    if (!dropping) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export function activate({ host }) {
  // Claude needs nothing here: its hooks run as written.
  //
  // Optional-called even though this extension is bundled and so can never
  // meet a core older than itself: it is the worked example the extension
  // docs point at, and an agent extension installed from the registry CAN
  // land on a core with no companion support. Throwing in activate() aborts
  // the whole extension.
  if (typeof host.agentHooks?.provideCompanion !== "function") {
    console.warn("agents: this Perch instance cannot write hook companions - Codex hooks will not fire until it can.");
    return;
  }
  host.agentHooks.provideCompanion("codex", ({ hookFile, handlers, current }) => {
    const body = stripOurBlocks(current, hookFile);
    if (handlers.length === 0) return body === "" ? "" : `${body.trimEnd()}\n`;

    const blocks = handlers.map((handler) =>
      [
        `[hooks.state."${escapeTomlBasicString(trustKey(hookFile, handler))}"]`,
        "enabled = true",
        `trusted_hash = "${trustedHash(handler)}"`,
      ].join("\n"),
    );
    const head = body.trim() === "" ? "" : `${body.trimEnd()}\n\n`;
    return `${head}${blocks.join("\n\n")}\n`;
  });
}
