import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { configDir } from "./configDir.js";

// The settings document is client-owned and opaque to the server: the client
// defines the schema (settings + keybinding overrides) and merges over its
// own defaults, so the server never needs a schema update when a setting is
// added. The server only guarantees the doc is a plain JSON object and small.
//
// SERVER_OWNED_KEYS are the documented exceptions. A credential has to live
// somewhere the server can read at call time and no client can ever read
// back, and the client's own sync GETs this document, merges client-side,
// and PUTs it back WHOLE — so a value it could see would come straight back
// on the next save, and a value it could write would be a way to smuggle one
// in. Hence: server-owned, restored from disk on every writeSettingsDoc
// (whatever the incoming document says about them is discarded), stripped
// from GET /api/settings (see api.ts), and changed only by the dedicated
// writers below.
//
//   aiSecrets        API keys for the AI providers, keyed by profile id —
//                    read by ai.ts at call time.
//   extensionSecrets per-extension credentials, keyed by extension id then
//                    by name — reached by an extension's server hook through
//                    host.secrets (see extensions.ts). Core serves no route
//                    for these: an extension that wants a browser-facing
//                    field defines its own route on its own router.
const MAX_BYTES = 64 * 1024;
const AI_SECRETS_KEY = "aiSecrets";
const EXTENSION_SECRETS_KEY = "extensionSecrets";
const SERVER_OWNED_KEYS = [AI_SECRETS_KEY, EXTENSION_SECRETS_KEY] as const;

const settingsPath = path.join(configDir, "settings.json");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// One user setting, read synchronously — for the few choices the server has
// to make at startup before anything else runs. undefined when unset.
export function readSettingSync(key: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    return isPlainObject(parsed) && isPlainObject(parsed.settings) ? parsed.settings[key] : undefined;
  } catch {
    return undefined;
  }
}

export async function readSettingsDoc(): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    // Missing or corrupt file — the client treats {} as "use defaults".
    return {};
  }
}

// The only code that actually touches the file. Callers go through
// writeSettingsDoc (which protects every SERVER_OWNED_KEY) or one of the
// dedicated secret writers below (which are allowed to change them).
async function persist(doc: Record<string, unknown>): Promise<void> {
  const json = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("settings document too large");
  await mkdir(configDir, { recursive: true });
  // Temp-then-rename so a crash mid-write can't leave a truncated file. 0600
  // on the temp file, which rename carries over: the document can hold API
  // keys, so it must not be world-readable. A pre-existing 0644 file is
  // replaced (not edited) by the rename, so the first write tightens it —
  // and it cannot hold a secret before a write.
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(tmp, json, { mode: 0o600 });
  await rename(tmp, settingsPath);
}

export async function writeSettingsDoc(doc: unknown): Promise<void> {
  if (!isPlainObject(doc)) throw new Error("settings must be a JSON object");
  // Every server-owned key is restored from disk rather than taken from the
  // caller, so an incoming document can neither drop the stored values nor
  // introduce new ones — whatever it says about them is discarded.
  const next = { ...doc };
  const current = await readSettingsDoc();
  for (const key of SERVER_OWNED_KEYS) {
    const stored = current[key];
    if (isPlainObject(stored)) next[key] = stored;
    else delete next[key];
  }
  await persist(next);
}

// The stored API keys, provider id → key. Server-side callers only (ai.ts);
// nothing here is ever sent to a client.
export async function readAiSecrets(): Promise<Record<string, string>> {
  const stored = (await readSettingsDoc())[AI_SECRETS_KEY];
  if (!isPlainObject(stored)) return {};
  const out: Record<string, string> = {};
  for (const [provider, key] of Object.entries(stored)) {
    if (typeof key === "string" && key.trim()) out[provider] = key;
  }
  return out;
}

// Sets or (with a null/empty key) clears one provider's key. The one writer
// that may change aiSecrets, so it persists directly instead of going through
// writeSettingsDoc, which would restore the old value over it.
export async function writeAiSecret(provider: string, key: string | null): Promise<void> {
  const doc = await readSettingsDoc();
  const stored = doc[AI_SECRETS_KEY];
  const secrets: Record<string, unknown> = isPlainObject(stored) ? { ...stored } : {};
  if (key && key.trim()) secrets[provider] = key.trim();
  else delete secrets[provider];
  doc[AI_SECRETS_KEY] = secrets;
  await persist(doc);
}

// ---- Per-extension secrets ----
//
// extensionSecrets is { "<extensionId>": { "<name>": "<value>" } }. Extension
// ids are already constrained by extensions.ts's isSafeId before they reach
// here; names are stored verbatim as object keys, so they get the same
// validation PUT /api/ai-key applies to a profile id. Like writeAiSecret,
// every writer persists directly — going through writeSettingsDoc would
// restore the old value straight over the new one.
const SECRET_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function assertSecretName(name: string): void {
  if (!SECRET_NAME.test(name) || name === "__proto__") {
    throw new Error("secret name must be 1-64 chars of [A-Za-z0-9._-]");
  }
}

function extensionSecretsFor(doc: Record<string, unknown>, extId: string): Record<string, unknown> {
  const all = doc[EXTENSION_SECRETS_KEY];
  if (!isPlainObject(all)) return {};
  const own = all[extId];
  return isPlainObject(own) ? own : {};
}

// One extension's stored value, or null when it has none. Server-side callers
// only — nothing here is ever sent to a client.
export async function readExtensionSecret(extId: string, name: string): Promise<string | null> {
  assertSecretName(name);
  const value = extensionSecretsFor(await readSettingsDoc(), extId)[name];
  return typeof value === "string" && value.trim() ? value : null;
}

// The names one extension has stored, never the values — that's the shape a
// settings component needs to render "set"/"not set", and the one that is
// safe for an extension to forward to its own client.
export async function listExtensionSecretNames(extId: string): Promise<string[]> {
  const own = extensionSecretsFor(await readSettingsDoc(), extId);
  return Object.entries(own)
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([name]) => name);
}

// Sets or (with a null/blank value) clears one name. Clearing the last name
// drops the extension's namespace object too, so an uninstall-less extension
// that never stores anything doesn't leave `{}` behind forever.
export async function writeExtensionSecret(extId: string, name: string, value: string | null): Promise<void> {
  assertSecretName(name);
  const doc = await readSettingsDoc();
  const all = doc[EXTENSION_SECRETS_KEY];
  const next: Record<string, unknown> = isPlainObject(all) ? { ...all } : {};
  const own = { ...extensionSecretsFor(doc, extId) };
  if (value && value.trim()) own[name] = value.trim();
  else delete own[name];
  if (Object.keys(own).length > 0) next[extId] = own;
  else delete next[extId];
  if (Object.keys(next).length > 0) doc[EXTENSION_SECRETS_KEY] = next;
  else delete doc[EXTENSION_SECRETS_KEY];
  await persist(doc);
}

// Drops one extension's whole namespace — called on uninstall, never on
// disable (a disable/enable cycle must not cost the user their credentials).
export async function clearExtensionSecrets(extId: string): Promise<void> {
  const doc = await readSettingsDoc();
  const all = doc[EXTENSION_SECRETS_KEY];
  if (!isPlainObject(all) || !(extId in all)) return;
  const next = { ...all };
  delete next[extId];
  if (Object.keys(next).length > 0) doc[EXTENSION_SECRETS_KEY] = next;
  else delete doc[EXTENSION_SECRETS_KEY];
  await persist(doc);
}

// Recurses into plain-object values on both sides so a patch only has to
// name the keys it's actually changing, at any depth — e.g. patching one
// extension's settings ({ extensionSettings: { "foo.bar": {...} } })
// doesn't drop every other extension's entry, and patching one keybinding
// override doesn't drop the rest. Arrays and primitives are NOT merged
// recursively (an incoming array/primitive replaces the existing value
// wholesale) — index-merging a list like pinnedSessions would silently
// splice unrelated entries together, which is never what a caller wants.
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return result;
}

// Merges `patch` over the on-disk document (see deepMerge) and persists the
// result, instead of replacing the document outright — the PATCH
// counterpart to writeSettingsDoc's PUT-style full replace. Lets a caller
// (an extension settings panel, a future integration, or the client's own
// write-back) send just the keys it's changing without first having to
// fetch-merge-PUT the whole document itself.
export async function mergeSettingsDoc(patch: unknown): Promise<void> {
  if (!isPlainObject(patch)) throw new Error("settings must be a JSON object");
  const current = await readSettingsDoc();
  await writeSettingsDoc(deepMerge(current, patch));
}
