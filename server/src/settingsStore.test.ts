// Covers the one thing the settings document guarantees that isn't obvious
// from its schema: SERVER_OWNED_KEYS (aiSecrets, extensionSecrets) are
// server-owned — a client-supplied document can neither read them back nor
// write them, however it's shaped. XDG_CONFIG_HOME is redirected to a temp
// dir before the module is imported, because settingsStore resolves its
// config path once at module scope.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const configHome = await mkdtemp(path.join(tmpdir(), "perch-settings-test-"));
process.env.XDG_CONFIG_HOME = configHome;

const {
  clearExtensionSecrets,
  listExtensionSecretNames,
  readExtensionSecret,
  readSettingsDoc,
  writeAiSecret,
  writeExtensionSecret,
  writeSettingsDoc,
} = await import("./settingsStore.js");

const settingsFile = path.join(configHome, "perch", "settings.json");

beforeEach(async () => {
  await rm(settingsFile, { force: true });
});

afterAll(async () => {
  await rm(configHome, { recursive: true, force: true });
});

describe("extension secrets", () => {
  it("round-trips a value", async () => {
    await writeExtensionSecret("jira", "apiToken", "ATATT-secret");
    expect(await readExtensionSecret("jira", "apiToken")).toBe("ATATT-secret");
  });

  it("keeps each extension's namespace separate", async () => {
    await writeExtensionSecret("a", "token", "from-a");
    await writeExtensionSecret("b", "token", "from-b");
    expect(await readExtensionSecret("a", "token")).toBe("from-a");
    expect(await readExtensionSecret("b", "token")).toBe("from-b");
  });

  it("lists names without values", async () => {
    await writeExtensionSecret("jira", "apiToken", "ATATT-secret");
    await writeExtensionSecret("jira", "webhook", "hook-secret");
    const names = await listExtensionSecretNames("jira");
    expect(names.sort()).toEqual(["apiToken", "webhook"]);
    expect(JSON.stringify(names)).not.toContain("secret");
  });

  it("clears one namespace and leaves the others", async () => {
    await writeExtensionSecret("a", "token", "from-a");
    await writeExtensionSecret("b", "token", "from-b");
    await clearExtensionSecrets("a");
    expect(await readExtensionSecret("a", "token")).toBeNull();
    expect(await readExtensionSecret("b", "token")).toBe("from-b");
  });

  it("rejects a name that isn't a safe object key", async () => {
    await expect(writeExtensionSecret("jira", "__proto__", "x")).rejects.toThrow(/secret name/);
    await expect(writeExtensionSecret("jira", "../escape", "x")).rejects.toThrow(/secret name/);
  });

  it("drops the namespace once its last name is cleared", async () => {
    await writeExtensionSecret("jira", "apiToken", "ATATT-secret");
    await writeExtensionSecret("jira", "apiToken", null);
    expect(await readExtensionSecret("jira", "apiToken")).toBeNull();
    expect(await readSettingsDoc()).not.toHaveProperty("extensionSecrets");
  });
});

describe("server-owned keys are unreachable from a document write", () => {
  it("cannot be introduced by a write", async () => {
    await writeSettingsDoc({ settings: { a: 1 }, extensionSecrets: { jira: { apiToken: "smuggled" } } });
    expect(await readExtensionSecret("jira", "apiToken")).toBeNull();
  });

  it("cannot be overwritten by a write", async () => {
    await writeExtensionSecret("jira", "apiToken", "real");
    await writeSettingsDoc({ extensionSecrets: { jira: { apiToken: "overwritten" } } });
    expect(await readExtensionSecret("jira", "apiToken")).toBe("real");
  });

  it("cannot be dropped by a write that omits them", async () => {
    await writeExtensionSecret("jira", "apiToken", "real");
    await writeAiSecret("anthropic", "sk-real");
    await writeSettingsDoc({ settings: { theme: "dark" } });
    expect(await readExtensionSecret("jira", "apiToken")).toBe("real");
    const doc = await readSettingsDoc();
    expect(doc.aiSecrets).toEqual({ anthropic: "sk-real" });
    expect(doc.settings).toEqual({ theme: "dark" });
  });

  it("guards aiSecrets the same way", async () => {
    await writeAiSecret("anthropic", "sk-real");
    await writeSettingsDoc({ aiSecrets: { anthropic: "sk-smuggled", openai: "sk-new" } });
    expect((await readSettingsDoc()).aiSecrets).toEqual({ anthropic: "sk-real" });
  });
});
