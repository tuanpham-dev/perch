// The extension notification seam's one non-obvious guarantee: a per-window
// cooldown, and that asking to notify never creates push.json on a machine
// where no browser ever subscribed. XDG_CONFIG_HOME points at a temp dir
// before import, because configDir resolves once at module scope.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const configHome = await mkdtemp(path.join(tmpdir(), "perch-push-test-"));
process.env.XDG_CONFIG_HOME = configHome;
delete process.env.PERCH_CONFIG_DIR;

const { EXTENSION_RATE_LIMIT_MS, notifyExtension, resetExtensionNotifyCooldowns, shouldNotifyExtension } =
  await import("./push.js");

afterAll(async () => {
  await rm(configHome, { recursive: true, force: true });
});

beforeEach(() => resetExtensionNotifyCooldowns());

describe("shouldNotifyExtension", () => {
  it("allows the first notification for a window", () => {
    expect(shouldNotifyExtension("w1", 1_000)).toBe(true);
  });

  it("suppresses a second one inside the cooldown", () => {
    expect(shouldNotifyExtension("w1", 1_000)).toBe(true);
    expect(shouldNotifyExtension("w1", 2_000)).toBe(false);
  });

  it("allows one again once the cooldown has passed", () => {
    expect(shouldNotifyExtension("w1", 1_000)).toBe(true);
    expect(shouldNotifyExtension("w1", 1_000 + EXTENSION_RATE_LIMIT_MS + 1_000)).toBe(true);
  });

  it("keeps windows independent", () => {
    expect(shouldNotifyExtension("w1", 1_000)).toBe(true);
    expect(shouldNotifyExtension("w2", 1_500)).toBe(true);
  });
});

describe("notifyExtension", () => {
  it("resolves without creating push.json when push was never set up", async () => {
    await expect(notifyExtension("w3", "title", "body")).resolves.toBeUndefined();
    expect(existsSync(path.join(configHome, "perch", "push.json"))).toBe(false);
  });
});
