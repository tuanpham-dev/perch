// Is there a newer Perch? (plans/app-versioning.md R7-R10). Asks GitHub's
// releases API at most every 6 hours while Settings → About allows it, and
// remembers the answer for the page (GET /api/updates). The page never asks
// GitHub itself, so one server makes one request however many tabs are open.
import { readSettingSync } from "./settingsStore.js";
import { compare, isPrerelease, valid } from "./semver.js";
import { appCommit, appVersion } from "./version.js";

export type Channel = "stable" | "beta";

export interface Release {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
}

export interface UpdateStatus {
  current: string;
  commit: string;
  channel: Channel;
  autoCheck: boolean;
  // The newest release on the channel, as of the last successful check.
  latest: { version: string; url: string } | null;
  available: boolean;
  checkedAt: number | null;
  lastSuccessAt: number | null;
  // Why the last check failed; null after a success.
  error: string | null;
  checking: boolean;
}

export const RELEASES_URL = "https://github.com/tuanpham-dev/perch/releases";
const API_URL = "https://api.github.com/repos/tuanpham-dev/perch/releases?per_page=30";
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;

/** The newest release a channel offers: never a draft, a pre-release only on Beta. */
export function latestFor(releases: Release[], channel: Channel): { version: string; url: string } | null {
  let best: { version: string; url: string } | null = null;
  for (const r of releases) {
    if (r.draft || !valid(r.tag_name)) continue;
    if (channel === "stable" && (r.prerelease || isPrerelease(r.tag_name))) continue;
    const version = r.tag_name.replace(/^v/, "");
    if (!best || compare(version, best.version) > 0) best = { version, url: r.html_url };
  }
  return best;
}

export function settingsChannel(): Channel {
  return readSettingSync("updateChannel") === "beta" ? "beta" : "stable";
}

export function settingsAutoCheck(): boolean {
  return readSettingSync("checkForUpdates") !== false;
}

interface State {
  latest: { version: string; url: string } | null;
  checkedChannel: Channel | null;
  checkedAt: number | null;
  lastSuccessAt: number | null;
  error: string | null;
  inFlight: Promise<void> | null;
}

const state: State = { latest: null, checkedChannel: null, checkedAt: null, lastSuccessAt: null, error: null, inFlight: null };

export function resetUpdateState(): void {
  Object.assign(state, { latest: null, checkedChannel: null, checkedAt: null, lastSuccessAt: null, error: null, inFlight: null });
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Checks GitHub now (once, however many callers ask at the same moment). */
export function checkNow(fetchImpl: Fetch = fetch, now = Date.now): Promise<void> {
  if (state.inFlight) return state.inFlight;
  const channel = settingsChannel();
  state.inFlight = (async () => {
    try {
      const res = await fetchImpl(process.env.PERCH_UPDATE_API || API_URL, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `perch/${appVersion()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub's rate limit was hit" : `GitHub answered ${res.status}`);
      const releases = (await res.json()) as Release[];
      if (!Array.isArray(releases)) throw new Error("GitHub sent something unexpected");
      state.latest = latestFor(releases, channel);
      state.checkedChannel = channel;
      state.lastSuccessAt = now();
      state.error = null;
    } catch (err) {
      state.error =
        err instanceof Error && err.name === "TimeoutError"
          ? "GitHub didn't answer in time"
          : err instanceof TypeError
            ? "GitHub couldn't be reached"
            : err instanceof Error
              ? err.message
              : String(err);
    } finally {
      state.checkedAt = now();
      state.inFlight = null;
    }
  })();
  return state.inFlight;
}

export function updateStatus(): UpdateStatus {
  const current = appVersion();
  const channel = settingsChannel();
  // An answer for the other channel doesn't count once the channel changes.
  const latest = state.checkedChannel === channel ? state.latest : null;
  return {
    current,
    commit: appCommit(),
    channel,
    autoCheck: settingsAutoCheck(),
    latest,
    // After a failed check nothing is announced (R10); About says why.
    available: !state.error && !!latest && valid(current) && compare(latest.version, current) > 0,
    checkedAt: state.checkedAt,
    lastSuccessAt: state.lastSuccessAt,
    error: state.error,
    checking: state.inFlight !== null,
  };
}

/** Whether a background check is due: allowed, and 6 hours since the last (or the channel changed). */
export function checkDue(now: number): boolean {
  if (!settingsAutoCheck()) return false;
  if (state.checkedChannel !== null && state.checkedChannel !== settingsChannel()) return true;
  return state.checkedAt === null || now - state.checkedAt >= CHECK_INTERVAL_MS;
}

/**
 * Starts a check when the channel changed since the last one (with automatic
 * checks on), so switching to Beta shows Beta's answer without waiting for
 * the next background tick.
 */
export function checkIfChannelChanged(fetchImpl: Fetch = fetch): void {
  if (settingsAutoCheck() && state.checkedChannel !== null && state.checkedChannel !== settingsChannel()) {
    void checkNow(fetchImpl);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Background checks: one shortly after startup, then whenever due. */
export function startUpdateChecks(): void {
  if (timer) return;
  const tick = () => {
    if (checkDue(Date.now())) void checkNow();
  };
  setTimeout(tick, 30_000).unref();
  timer = setInterval(tick, TICK_MS);
  timer.unref();
}
