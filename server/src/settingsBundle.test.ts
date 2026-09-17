// Covers what a bundle guarantees: it carries exactly the allowlisted keys
// and never a secret or a local path, it refuses a file it can't read, and it
// reports honestly which extensions an importer can actually install.
//
// PERCH_CONFIG_DIR is redirected to a temp dir and EXTENSION_REGISTRY is
// emptied before the modules are imported, because both resolve their paths
// at module scope and the shipped default registry would otherwise make these
// tests hit the network (same pattern as settingsStore.test.ts).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const configDir = await mkdtemp(path.join(tmpdir(), "perch-bundle-test-"));
process.env.PERCH_CONFIG_DIR = configDir;
process.env.EXTENSION_REGISTRY = "";

const { BUNDLE_VERSION, SHAREABLE_KEYS, buildBundle, parseBundle, summarizeBundle } = await import(
  "./settingsBundle.js"
);
const { writeSettingsDoc, writeAiSecret, writeExtensionSecret } = await import("./settingsStore.js");

const registryDir = path.join(configDir, "catalog");

beforeEach(async () => {
  await writeSettingsDoc({});
});

afterAll(async () => {
  await rm(configDir, { recursive: true, force: true });
});

function bundleOf(extra: Record<string, unknown> = {}) {
  return { perchSettingsBundle: BUNDLE_VERSION, exportedAt: "2026-09-17T00:00:00.000Z", extensions: [], ...extra };
}

describe("buildBundle", () => {
  it("carries every allowlisted key the document holds", async () => {
    await writeSettingsDoc({
      settings: { fontSize: 15 },
      keybindings: { "terminal.copy": [{ key: "ctrl+c" }] },
      extensionSettings: { "perch.git": { showBranch: false } },
      extensionRegistries: ["/srv/catalog"],
      sidebarLayout: { left: ["explorer"], right: [], panelHome: {}, hiddenPanels: [] },
      statusBarLayout: { left: [], right: ["core.terminals"], hidden: [] },
      sidebarPanels: { order: ["projects"], collapsed: {}, sizes: {} },
    });
    const bundle = await buildBundle();
    for (const key of SHAREABLE_KEYS) expect(bundle, `missing ${key}`).toHaveProperty(key);
    expect(bundle.perchSettingsBundle).toBe(BUNDLE_VERSION);
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // The whole point of the allowlist. If this ever fails, a secret is leaving
  // the machine in a file the user is about to send to someone.
  it("never carries a secret, a project path or a usage stat", async () => {
    await writeSettingsDoc({
      settings: { fontSize: 15 },
      projects: [{ path: "/home/someone/private-client-work", name: "nda" }],
      commandUsage: { "terminal.copy": { count: 91, last: 1 } },
      pinnedSessions: ["/home/someone/private-client-work"],
    });
    await writeAiSecret("anthropic", "sk-ant-should-never-appear");
    await writeExtensionSecret("perch.jira", "token", "jira-should-never-appear");

    const bundle = await buildBundle();
    expect(bundle).not.toHaveProperty("projects");
    expect(bundle).not.toHaveProperty("commandUsage");
    expect(bundle).not.toHaveProperty("pinnedSessions");
    expect(bundle).not.toHaveProperty("aiSecrets");
    expect(bundle).not.toHaveProperty("extensionSecrets");

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("sk-ant-should-never-appear");
    expect(serialized).not.toContain("jira-should-never-appear");
    expect(serialized).not.toContain("private-client-work");
  });

  it("omits a key the document does not hold", async () => {
    await writeSettingsDoc({ settings: { fontSize: 15 } });
    const bundle = await buildBundle();
    expect(bundle).toHaveProperty("settings");
    expect(bundle).not.toHaveProperty("statusBarLayout");
  });

  // Builtins ship with any install, so a row for one would be noise an
  // importer can do nothing with.
  it("lists no builtin extensions", async () => {
    expect((await buildBundle()).extensions.every((e) => !e.id.startsWith("perch."))).toBe(true);
  });
});

describe("parseBundle", () => {
  it("accepts a well-formed bundle", () => {
    const result = parseBundle(bundleOf({ settings: { fontSize: 12 } }));
    expect(result).not.toHaveProperty("error");
    expect("bundle" in result && result.bundle.settings).toEqual({ fontSize: 12 });
  });

  it("rejects anything that is not a JSON object", () => {
    for (const value of [null, "{}", 7, [], undefined]) {
      const result = parseBundle(value);
      expect("error" in result && result.error).toContain("expected a JSON object");
    }
  });

  it("rejects a JSON file that is not a bundle", () => {
    const result = parseBundle({ settings: { fontSize: 12 } });
    expect("error" in result && result.error).toContain("version marker");
  });

  // Refusing is the honest answer: applying only the parts this build
  // understands would silently drop the rest.
  it("rejects a bundle from a newer build", () => {
    const result = parseBundle(bundleOf({ perchSettingsBundle: BUNDLE_VERSION + 1 }));
    expect("error" in result && result.error).toContain("newer Perch");
  });

  it("drops malformed extension rows and normalizes the rest", () => {
    const result = parseBundle(
      bundleOf({
        extensions: [
          { id: "good", version: "1.2.3", source: "/srv/catalog" },
          { id: "no-version" },
          { id: "blank-source", version: "1.0.0", source: "" },
          { version: "1.0.0" },
          "nope",
          null,
        ],
      }),
    );
    expect("bundle" in result && result.bundle.extensions).toEqual([
      { id: "good", version: "1.2.3", source: "/srv/catalog" },
      { id: "no-version", version: "0.0.0", source: null },
      { id: "blank-source", version: "1.0.0", source: null },
    ]);
  });
});

describe("summarizeBundle", () => {
  it("counts what each category contributes", async () => {
    const parsed = parseBundle(
      bundleOf({
        settings: { fontSize: 15, cursorBlink: true },
        keybindings: { a: [], b: [], c: [] },
        extensionRegistries: ["/one", "/two"],
        // One arrangement, however many ids it names.
        statusBarLayout: { left: ["a", "b", "c", "d"], right: [], hidden: [] },
      }),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    const counts = Object.fromEntries(
      (await summarizeBundle(parsed.bundle)).categories.map((c) => [c.key, c.count]),
    );
    expect(counts).toEqual({ settings: 2, keybindings: 3, extensionRegistries: 2, statusBarLayout: 1 });
  });

  it("marks a row with no recorded source as not installable", async () => {
    const parsed = parseBundle(bundleOf({ extensions: [{ id: "orphan", version: "1.0.0" }] }));
    if ("error" in parsed) throw new Error(parsed.error);
    const [row] = (await summarizeBundle(parsed.bundle)).extensions;
    expect(row.installable).toBe(false);
    expect(row.reason).toContain("no registry source recorded");
  });

  it("marks a row whose source this machine cannot reach as not installable", async () => {
    const parsed = parseBundle(
      bundleOf({ extensions: [{ id: "elsewhere", version: "1.0.0", source: "/not/configured/here" }] }),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    const [row] = (await summarizeBundle(parsed.bundle)).extensions;
    expect(row.installable).toBe(false);
    expect(row.reason).toContain("not configured here");
  });

  it("marks a row installable once its source is configured", async () => {
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      path.join(registryDir, "index.json"),
      JSON.stringify({ extensions: [{ name: "here", version: "1.0.0", file: "here.perch" }] }),
    );
    await writeSettingsDoc({ extensionRegistries: [registryDir] });

    const parsed = parseBundle(
      bundleOf({ extensions: [{ id: "here", version: "1.0.0", source: registryDir }] }),
    );
    if ("error" in parsed) throw new Error(parsed.error);
    const [row] = (await summarizeBundle(parsed.bundle)).extensions;
    expect(row.installable).toBe(true);
    expect(row.reason).toBeUndefined();
  });
});
