// The extension notification seam's one non-obvious guarantee: a per-window
// cooldown, and that asking to notify never creates push.json on a machine
// where no browser ever subscribed. PERCH_CONFIG_DIR points at a temp dir
// before import, because configDir resolves once at module scope (and
// XDG_CONFIG_HOME would mean nothing on Windows).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const configHome = await mkdtemp(path.join(tmpdir(), "perch-push-test-"));
process.env.PERCH_CONFIG_DIR = path.join(configHome, "perch");

const { EXTENSION_RATE_LIMIT_MS, notifyExtension, resetExtensionNotifyCooldowns, shouldNotifyExtension } =
  await import("./push.js");
const { subscribeOpenUrl } = await import("./openUrl.js");

// A stand-in SSE response that records every frame written to it.
function fakeStream(): { frames: string[]; close: () => void } {
  const frames: string[] = [];
  let onClose = () => {};
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    on: (event: string, cb: () => void) => {
      if (event === "close") onClose = cb;
      return res;
    },
  };
  subscribeOpenUrl(res as never);
  return { frames, close: () => onClose() };
}

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

describe("notify alerts on the open-url stream", () => {
  it("broadcasts an extension alert even with no push.json, once per cooldown", async () => {
    const stream = fakeStream();
    try {
      await notifyExtension("w4", "Claude", "needs input");
      await notifyExtension("w4", "Claude", "needs input again");
      const alerts = stream.frames.filter((f) => f.startsWith("event: notify\n"));
      expect(alerts).toHaveLength(1);
      expect(JSON.parse(alerts[0]!.split("data: ")[1]!)).toEqual({ title: "Claude", body: "needs input", windowId: "w4" });
      expect(existsSync(path.join(configHome, "perch", "push.json"))).toBe(false);
    } finally {
      stream.close();
    }
  });
});
