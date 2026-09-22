// Reading the touchKeys.keys setting, split out of the client so it can run
// under plain `node --test` - same reason git-scm's searchQuery.mjs lives
// beside its panel code rather than inside it.
//
// The layout is a JSON string the user can also paste by hand, and a paste
// is easy to damage: a copy out of a terminal that wrapped a long line keeps
// the continuation's indent, which lands inside a key name ("labe  l") or a
// value. A layout with a broken entry used to fall back to the default keys
// without a word, which looks exactly like the paste being ignored. Now it
// is reported instead, naming each broken key, and nothing else is guessed.

const FIELDS = ["label", "send", "when"];
const MAX_PROBLEMS = 5;

/**
 * @param {unknown} raw the stored setting
 * @param {Array<{label: string, send: string, when: string}>} defaults
 * @returns {{ keys: Array<{label: string, send: string, when: string}>, error: string | null }}
 */
export function parseLayout(raw, defaults) {
  if (typeof raw !== "string" || !raw.trim()) return { keys: defaults, error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { keys: [], error: `The layout isn't valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(parsed)) {
    return { keys: [], error: "The layout must be a JSON list of keys, like [{\"label\":\"Esc\",\"send\":\"{esc}\",\"when\":\"\"}]." };
  }
  const problems = [];
  parsed.forEach((entry, i) => {
    const name = `Key ${i + 1}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`${name} isn't an object with label, send and when.`);
      return;
    }
    const labelled = typeof entry.label === "string" && entry.label ? `${name} ("${entry.label}")` : name;
    for (const field of Object.keys(entry)) {
      if (!FIELDS.includes(field)) problems.push(`${labelled} has an unknown field "${field}".`);
    }
    for (const field of FIELDS) {
      if (!(field in entry)) problems.push(`${labelled} is missing "${field}".`);
      else if (typeof entry[field] !== "string") problems.push(`${labelled} has a "${field}" that isn't text.`);
    }
  });
  if (problems.length === 0) return { keys: parsed, error: null };
  const shown = problems.slice(0, MAX_PROBLEMS);
  if (problems.length > MAX_PROBLEMS) shown.push(`...and ${problems.length - MAX_PROBLEMS} more.`);
  return { keys: [], error: shown.join("\n") };
}
