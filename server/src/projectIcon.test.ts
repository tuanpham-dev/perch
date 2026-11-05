import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findProjectIcon } from "./projectIcon.js";

let root: string;
const put = (rel: string, body = "x") => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "perch-icon-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("findProjectIcon", () => {
  it("returns null when the folder has no icon", async () => {
    put("README.md");
    expect(await findProjectIcon(root)).toBeNull();
  });

  it("finds an icon in an asset folder, ignoring case and size suffixes", async () => {
    put("assets/Logo-512.PNG");
    expect(await findProjectIcon(root)).toBe(path.join(root, "assets/Logo-512.PNG"));
  });

  it("prefers an app icon to a logo, and svg to png", async () => {
    put("logo.svg");
    put("public/icon.png");
    put("public/icon.svg");
    expect(await findProjectIcon(root)).toBe(path.join(root, "public/icon.svg"));
  });

  it("does not match unrelated names that merely start with a keyword", async () => {
    put("iconography.png");
    put("logistics.svg");
    expect(await findProjectIcon(root)).toBeNull();
  });

  it("falls back to the <link rel=icon> of an index.html", async () => {
    put("index.html", '<html><head><link rel="icon" href="/brand/tab.svg"></head></html>');
    put("public/brand/tab.svg");
    expect(await findProjectIcon(root)).toBe(path.join(root, "public/brand/tab.svg"));
  });

  it("skips empty and oversized files", async () => {
    put("icon.png", "");
    expect(await findProjectIcon(root)).toBeNull();
  });
});
