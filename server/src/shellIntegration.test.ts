import { describe, expect, it } from "vitest";
import { browserVar, zshEnv } from "./mux.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bashInitBody, powershellScriptBody, shellQuotedPath, zshWrapperFiles } from "./shellIntegration.js";

describe("PowerShell integration script", () => {
  it("reports to the right port and names its own source line", async () => {
    const body = await powershellScriptBody(3002);
    expect(body).toContain("http://127.0.0.1:3002/api/command-events/report");
    expect(body).not.toContain("__PORT__");
    expect(body).not.toContain("__SOURCE_LINE__");
    expect(body).toMatch(/# {3}if \(Test-Path '.*shell-integration\.ps1'\) \{ \. '.*shell-integration\.ps1' \}/);
  });

  it("does nothing outside the app's terminals", async () => {
    const body = await powershellScriptBody(3001);
    expect(body).toMatch(/if \(-not \$env:PERCH_WINDOW/);
  });
});

describe("browserVar", () => {
  it("names a shim whose path has a space by its bare name", () => {
    expect(browserVar("/home/me/.config/perch/bin/open-in-browser", "linux")).toBe("/home/me/.config/perch/bin/open-in-browser");
    expect(browserVar("/Users/me/Library/Application Support/x/bin/open-in-browser", "darwin")).toBe("open-in-browser");
    expect(browserVar("C:\\Users\\Me Too\\open-in-browser.cmd", "win32")).toBe("C:\\Users\\Me Too\\open-in-browser.cmd");
  });
});

describe("shellQuotedPath", () => {
  it("writes a path under home relative to $HOME", () => {
    expect(shellQuotedPath("/home/me/.config/perch/x.sh", "/home/me")).toBe('"$HOME/.config/perch/x.sh"');
    expect(shellQuotedPath("/home/meme/x.sh", "/home/me")).toBe('"/home/meme/x.sh"');
  });

  it.skipIf(process.platform === "win32")("survives spaces and shell metacharacters", () => {
    const home = mkdtempSync(path.join(tmpdir(), "quoted-"));
    const dir = path.join(home, "Application Support", 'a"$b`c');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "shell-integration.sh");
    writeFileSync(file, "echo sourced\n");
    for (const [word, env] of [[shellQuotedPath(file, home), { ...process.env, HOME: home }], [shellQuotedPath(file, "/elsewhere"), process.env]] as const) {
      const out = execFileSync("sh", ["-c", `[ -f ${word} ] && . ${word}`], { env, encoding: "utf8" });
      expect(out).toBe("sourced\n");
    }
  });
});

describe("zsh wrappers", () => {
  it("read the user's file from their ZDOTDIR (or ~) and come back to the wrapper dir", () => {
    const files = zshWrapperFiles();
    expect(Object.keys(files).sort()).toEqual([".zlogin", ".zprofile", ".zshenv", ".zshrc"]);
    for (const name of [".zshenv", ".zprofile", ".zlogin"]) {
      expect(files[name]).toContain("ZDOTDIR=${PERCH_USER_ZDOTDIR:-$HOME}");
      expect(files[name]).toContain(`[ -f "$ZDOTDIR/${name}" ] && . "$ZDOTDIR/${name}"`);
      expect(files[name]).toContain("ZDOTDIR=$_perch_zdotdir");
    }
  });

  it("records a ZDOTDIR the user's .zshenv sets, and .zshrc ends with the integration and the user's ZDOTDIR", () => {
    const files = zshWrapperFiles();
    expect(files[".zshenv"]).toMatch(/\.zshenv"\n\[ "\$ZDOTDIR" = "\$HOME" \] \|\| export PERCH_USER_ZDOTDIR=\$ZDOTDIR\n/);
    const rc = files[".zshrc"]!.split("\n");
    expect(rc).toContain('[ -f "$ZDOTDIR/.zshrc" ] && . "$ZDOTDIR/.zshrc"');
    expect(rc.at(-2)).toBe('if [ -n "${PERCH_USER_ZDOTDIR-}" ]; then ZDOTDIR=$PERCH_USER_ZDOTDIR; else unset ZDOTDIR; fi');
    expect(rc.at(-3)).toMatch(/^\[ -f ".*shell-integration\.sh" \] && \. ".*shell-integration\.sh"$/);
  });
});

describe("bash init file", () => {
  it("reads the system bashrc bash was built for, then ~/.bashrc, then the integration", () => {
    const linux = bashInitBody("linux").split("\n").filter((l) => l && !l.startsWith("#"));
    expect(linux[0]).toBe("[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc");
    expect(linux[1]).toBe('[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"');
    expect(linux[2]).toMatch(/shell-integration\.sh" \] && \. ".*shell-integration\.sh"$/);
    expect(bashInitBody("darwin")).toContain("[ -f /etc/bashrc ] && . /etc/bashrc");
  });
});

describe("zshEnv", () => {
  it("points ZDOTDIR at the wrappers only once they exist, and keeps the user's ZDOTDIR", () => {
    expect(zshEnv(undefined, "/c/zsh", false)).toEqual({});
    expect(zshEnv(undefined, "/c/zsh", true)).toEqual({ ZDOTDIR: "/c/zsh" });
    expect(zshEnv("/home/me/.config/zsh", "/c/zsh", true)).toEqual({ ZDOTDIR: "/c/zsh", PERCH_USER_ZDOTDIR: "/home/me/.config/zsh" });
    // A server started from inside one of its own terminals must not record
    // the wrapper dir as the user's.
    expect(zshEnv("/c/zsh", "/c/zsh", true)).toEqual({ ZDOTDIR: "/c/zsh" });
  });
});
