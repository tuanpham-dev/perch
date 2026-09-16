import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIPBOARD_TOOLS, ensureClipboardShims } from "./clipboardShims.js";
import { withShimsFirst } from "./mux.js";

const posix = process.platform !== "win32";
const hasScript = posix && spawnSync("sh", ["-c", "command -v script"]).status === 0;

// Runs `command` on a real pty (script(1)), so the shim's /dev/tty exists, and
// returns everything the terminal received.
function onPty(command: string, env: NodeJS.ProcessEnv): string {
  return execFileSync("script", ["-q", "-c", command, "/dev/null"], { env, input: "" }).toString("latin1");
}

const OSC52 = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

describe.runIf(posix)("clipboard shims", () => {
  let root: string;
  let shims: string;
  // No display, and the shim folder first on PATH: a headless Perch terminal.
  let headless: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "perch-clip-"));
    shims = path.join(root, "bin");
    await ensureClipboardShims(shims);
    headless = { PATH: `${shims}:/usr/bin:/bin`, HOME: root, LANG: "C" };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("writes one executable shim per clipboard tool", () => {
    for (const name of CLIPBOARD_TOOLS) {
      const mode = statSync(path.join(shims, name)).mode & 0o777;
      expect(mode, name).toBe(0o755);
    }
  });

  it.runIf(hasScript)("turns a piped copy into one OSC 52 sequence on the terminal", () => {
    const out = onPty("printf hi | xclip -selection clipboard; echo EXIT=$?", headless);
    expect(out.split(OSC52("hi")).length - 1).toBe(1);
    expect(out).toContain("EXIT=0");
  });

  it.runIf(hasScript)("still copies with -p, which selects the primary selection rather than reading", () => {
    const out = onPty("printf hi | xsel -p -i; echo EXIT=$?", headless);
    expect(out).toContain(OSC52("hi"));
    expect(out).toContain("EXIT=0");
  });

  it.runIf(hasScript)("copies wl-copy's text arguments, skipping option values", () => {
    const out = onPty("wl-copy -t text/plain hello world < /dev/null; echo EXIT=$?", headless);
    expect(out).toContain(OSC52("hello world"));
  });

  it("prints nothing and succeeds for the read forms", () => {
    for (const [tool, flag] of [["xclip", "-o"], ["xclip", "-out"], ["xsel", "--output"]]) {
      const result = spawnSync(path.join(shims, tool), [flag], { env: headless });
      expect(result.status, `${tool} ${flag}`).toBe(0);
      expect(result.stdout.toString()).toBe("");
    }
  });

  it("runs the real tool, past the shim folder, when there is a display", () => {
    const real = path.join(root, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(path.join(real, "xclip"), '#!/bin/sh\necho "REAL xclip $*"\n');
    chmodSync(path.join(real, "xclip"), 0o755);
    const result = spawnSync(path.join(shims, "xclip"), ["-selection", "clipboard"], {
      env: { ...headless, PATH: `${shims}:${real}:/usr/bin:/bin`, DISPLAY: ":1" },
      input: "hi",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toBe("REAL xclip -selection clipboard\n");
  });
});

describe("withShimsFirst", () => {
  it("puts the shim folder first, once", () => {
    expect(withShimsFirst("/usr/bin:/shims:/bin", "/shims")).toBe("/shims:/usr/bin:/bin");
    expect(withShimsFirst("/usr/bin", "/shims")).toBe("/shims:/usr/bin");
    expect(withShimsFirst(undefined, "/shims")).toBe("/shims");
  });
});
