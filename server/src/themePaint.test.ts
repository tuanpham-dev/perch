// What the server paints into the SPA shell and manifest from the client's
// reported theme vars. XDG_CONFIG_HOME is redirected before the import,
// because themePaint resolves its file path once at module scope.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const configHome = await mkdtemp(path.join(tmpdir(), "perch-theme-paint-test-"));
delete process.env.PERCH_CONFIG_DIR;
process.env.XDG_CONFIG_HOME = configHome;
const { paintIndexHtml, paintManifest, readThemePaint, sanitizeThemePaint, writeThemePaint } = await import(
  "./themePaint.js"
);

afterAll(() => rm(configHome, { recursive: true, force: true }));

const SHELL = `<html lang="en"><head><meta name="theme-color" content="#21252b" /></head></html>`;

describe("sanitizeThemePaint", () => {
  it("keeps color-shaped vars and drops anything that could break out of an attribute", () => {
    expect(
      sanitizeThemePaint({
        "--bg": "#FFFFFF",
        "--shadow": "rgba(0, 0, 0, 0.16)",
        "--evil": '#fff" onload="alert(1)',
        "--semi": "red;background:url(x)",
        "not-a-var": "#000",
        "--num": 3,
      }),
    ).toEqual({ "--bg": "#FFFFFF", "--shadow": "rgba(0, 0, 0, 0.16)" });
  });

  it("rejects non-objects and empty results", () => {
    expect(sanitizeThemePaint(null)).toBeNull();
    expect(sanitizeThemePaint(["--bg"])).toBeNull();
    expect(sanitizeThemePaint({ "--bg": "<b>" })).toBeNull();
  });
});

describe("paintIndexHtml", () => {
  it("leaves the shell alone without a paint", () => {
    expect(paintIndexHtml(SHELL, null)).toBe(SHELL);
  });

  it("puts the vars on <html> and the title bar color in theme-color", () => {
    const html = paintIndexHtml(SHELL, { "--bg": "#FFFFFF", "--titlebar-bg": "#F8F8F8" });
    expect(html).toContain(`<html lang="en" style="--bg:#FFFFFF;--titlebar-bg:#F8F8F8">`);
    expect(html).toContain(`<meta name="theme-color" content="#F8F8F8" />`);
  });
});

describe("paintManifest", () => {
  it("sets the splash background and title bar colors", () => {
    const manifest: Record<string, unknown> = { theme_color: "#21252b", background_color: "#21252b" };
    paintManifest(manifest, { "--bg": "#FFFFFF", "--titlebar-bg": "#F8F8F8" });
    expect(manifest).toEqual({ theme_color: "#F8F8F8", background_color: "#FFFFFF" });
  });
});

describe("writeThemePaint", () => {
  it("stores a paint, clears it with null, and refuses garbage", async () => {
    await writeThemePaint({ "--bg": "#FFFFFF" });
    expect(readThemePaint()).toEqual({ "--bg": "#FFFFFF" });
    await expect(writeThemePaint("nope")).rejects.toThrow();
    expect(readThemePaint()).toEqual({ "--bg": "#FFFFFF" });
    await writeThemePaint(null);
    expect(readThemePaint()).toBeNull();
  });
});
