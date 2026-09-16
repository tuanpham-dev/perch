// The "[restored …]" line a window carries when it comes back from a snapshot.
//
// Kept apart from restore.ts because of the one thing about it that is not
// obvious: the banner is appended to the *saved* scrollback, and that combined
// text is what gets persisted next time. Restore a session six times and its
// scrollback holds six banners — verified on a session that was never once
// used between reboots:
//
//     [restored 01:05:07]
//      ⛵ /works/perch  main
//     [restored 01:05:14]
//      ⛵ /works/perch  main
//     … four more pairs …
//
// The prompts are real output from each new shell and stay. The banners are
// ours, and only the newest one says anything: it marks where the current boot
// begins. Older ones mark boundaries in history that the prompts already show,
// while costing a line each out of a capped budget (2000 by default) — so on a
// machine that reboots daily, a quiet session slowly replaces its own history
// with notices about having been restored.
//
// So: strip every banner the saved scrollback carries, then add the new one.

/**
 * Switches off what the programs in the saved history turned on and can no
 * longer turn off: the alternate screen, focus and mouse reporting, bracketed
 * paste, application cursor keys, a hidden cursor. Left on, a replayed
 * terminal keeps them for the new shell, so switching browser tabs sends it
 * focus reports and a click sends it mouse reports, all as typed junk.
 */
export const MODE_RESET =
  '\x1b[0m\x1b[?1049l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1l\x1b>\x1b[?25h';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One banner line, with the dim SGR pair it is wrapped in (and the mode reset
 *  in front of it). Matching on the escape sequence rather than the words is
 *  what keeps this from eating a line of someone's own output that happens to
 *  say the same thing. */
const BANNER = new RegExp(`(?:${escapeRegExp(MODE_RESET)})?\\r?\\n?\\x1b\\[2m\\[restored [^\\]]*\\]\\x1b\\[0m\\r?\\n?`, 'g');

export function bannerText(when: Date): string {
  return `${MODE_RESET}\r\n\x1b[2m[restored ${when.toLocaleString()}]\x1b[0m\r\n`;
}

/** Saved scrollback with every previous banner removed and `banner` appended. */
export function appendBanner(saved: string, banner: string): string {
  return saved.replace(BANNER, '') + banner;
}

/** The same, for the byte-exact sidecar. latin1 throughout: it is the encoding
 *  the raw pipeline uses, so a round trip cannot alter a byte. */
export function appendBannerRaw(saved: Buffer, banner: string): Buffer {
  const stripped = saved.toString('latin1').replace(BANNER, '');
  return Buffer.concat([Buffer.from(stripped, 'latin1'), Buffer.from(banner, 'latin1')]);
}
