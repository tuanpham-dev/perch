// Waiting for a condition instead of guessing how long it takes.
//
// These tests drive a real daemon over a real socket, spawning real shells. On
// an idle machine a shell starts in well under a second, and a fixed sleep of
// 500ms looks like it works. Under load — a full test run, several suites at
// once, a busy CI box — it doesn't, and the test fails on timing rather than on
// behaviour. That is the worst kind of failing test: it reports a bug that
// isn't there, and it does so only sometimes.
//
// So: poll for what the test is actually waiting for, with a budget generous
// enough that exceeding it means something is genuinely wrong.

/** How long to keep trying before calling it a real failure. */
export const WAIT_TIMEOUT = 30_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `check` until it returns a truthy value, and return it.
 *
 * `label` is what shows up when it times out — write it as the thing being
 * waited for ("the shell reports 50 rows"), because that message is the whole
 * diagnostic when this fails on a machine you can't inspect.
 */
export async function waitFor<T>(
  label: string,
  check: () => T | Promise<T>,
  { timeout = WAIT_TIMEOUT, interval = 50 }: { timeout?: number; interval?: number } = {},
  // Returns NonNullable because it only returns on a truthy value — callers
  // that poll for an object shouldn't have to re-narrow what the poll
  // guaranteed.
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  let last: T | undefined;
  for (;;) {
    try {
      last = await check();
      if (last) return last as NonNullable<T>;
      lastError = undefined;
    } catch (err) {
      // A check that throws is just a not-yet: the socket isn't up, the file
      // isn't written, the shell hasn't printed a prompt. Only the last one
      // matters, and only if we run out of time.
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const detail = lastError instanceof Error ? ` (last error: ${lastError.message})`
        : last !== undefined ? ` (last value: ${JSON.stringify(last)})` : "";
      throw new Error(`timed out after ${timeout}ms waiting for ${label}${detail}`);
    }
    await sleep(interval);
  }
}

/** Poll until `read()` matches, then return the matching text. Reads that throw
 *  count as "not yet" — the session may not exist for another moment. */
export function waitForMatch(
  label: string,
  read: () => string,
  pattern: RegExp,
  options?: { timeout?: number; interval?: number },
): Promise<string> {
  return waitFor(label, () => {
    const text = read();
    return pattern.test(text) ? text : "";
  }, options);
}
