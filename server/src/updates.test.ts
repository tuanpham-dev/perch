// The update checker: which release counts as newest per channel, what a
// failed check leaves behind, and when a background check is due. The
// settings file lives in a temp config dir set before import.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const configDir = await mkdtemp(path.join(tmpdir(), "perch-updates-test-"));
process.env.PERCH_CONFIG_DIR = configDir;
delete process.env.PERCH_UPDATE_API;

const { CHECK_INTERVAL_MS, checkDue, checkIfChannelChanged, checkNow, latestFor, resetUpdateState, updateStatus } = await import("./updates.js");
const { appVersion } = await import("./version.js");

async function setSettings(settings: Record<string, unknown>) {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "settings.json"), JSON.stringify({ settings }));
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, html_url: `https://example.test/${tag}`, ...extra });

// A version guaranteed to be newer than whatever this checkout is.
const newer = (() => {
  const [maj] = appVersion().split(".");
  return `${Number(maj) + 1}.0.0`;
})();

const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

afterAll(async () => {
  await rm(configDir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetUpdateState();
  await setSettings({});
});

describe("latestFor", () => {
  const releases = [release("v0.1.0"), release("v0.3.0-rc.1", { prerelease: true }), release("v0.2.0"), release("v9.0.0", { draft: true }), release("nightly")];

  it("takes the newest full release on Stable", () => {
    expect(latestFor(releases, "stable")).toEqual({ version: "0.2.0", url: "https://example.test/v0.2.0" });
  });

  it("includes pre-releases on Beta, never drafts", () => {
    expect(latestFor(releases, "beta")?.version).toBe("0.3.0-rc.1");
  });

  it("treats a pre-release-looking tag as a pre-release even unflagged", () => {
    expect(latestFor([release("v0.4.0-beta.1")], "stable")).toBeNull();
  });
});

describe("checkNow", () => {
  it("reports a newer release as available", async () => {
    await checkNow(answer([release(`v${newer}`)]), () => 1000);
    const s = updateStatus();
    expect(s.available).toBe(true);
    expect(s.latest?.version).toBe(newer);
    expect(s.lastSuccessAt).toBe(1000);
    expect(s.error).toBeNull();
  });

  it("isn't available when the newest release is this version or older", async () => {
    await checkNow(answer([release(`v${appVersion()}`), release("v0.0.1")]));
    expect(updateStatus().available).toBe(false);
  });

  it("keeps the last success time when a later check fails", async () => {
    await checkNow(answer([release(`v${newer}`)]), () => 1000);
    await checkNow(answer({ message: "rate limited" }, 403), () => 2000);
    const s = updateStatus();
    expect(s.error).toBe("GitHub's rate limit was hit");
    expect(s.available).toBe(false);
    expect(s.lastSuccessAt).toBe(1000);
    expect(s.checkedAt).toBe(2000);
  });

  it("checks again right away after a channel switch", async () => {
    await checkNow(answer([release(`v${newer}`)]));
    await setSettings({ updateChannel: "beta" });
    let asked = 0;
    checkIfChannelChanged(async () => {
      asked++;
      return new Response(JSON.stringify([release(`v${newer}-rc.9`, { prerelease: true })]));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toBe(1);
    expect(updateStatus().latest?.version).toBe(`${newer}-rc.9`);
  });

  it("names an unreachable GitHub plainly", async () => {
    await checkNow(async () => {
      throw new TypeError("fetch failed");
    });
    expect(updateStatus().error).toBe("GitHub couldn't be reached");
  });

  it("forgets an answer for the other channel", async () => {
    await setSettings({ updateChannel: "beta" });
    await checkNow(answer([release(`v${newer}-rc.1`, { prerelease: true })]));
    expect(updateStatus().available).toBe(true);
    await setSettings({ updateChannel: "stable" });
    expect(updateStatus().latest).toBeNull();
  });
});

describe("checkDue", () => {
  it("is due at first, then only after 6 hours", async () => {
    expect(checkDue(0)).toBe(true);
    await checkNow(answer([]), () => 1000);
    expect(checkDue(1000 + CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(checkDue(1000 + CHECK_INTERVAL_MS)).toBe(true);
  });

  it("is never due with automatic checks off", async () => {
    await setSettings({ checkForUpdates: false });
    expect(checkDue(0)).toBe(false);
    expect(updateStatus().autoCheck).toBe(false);
  });
});
