// Subagents are found for a project folder whose name has characters Claude
// Code turns into "-" besides "/" and "." (an underscore, a space), and
// finished ones stay listed, running ones first.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const home = mkdtempSync(path.join(tmpdir(), "perch-subagents-"));
process.env.HOME = home;
const { getCounts, getSubagentDetails } = await import("./server.js");

test("finds a project with an underscore and a space, and keeps finished runs", async () => {
  const cwd = path.join(home, "my_app proj");
  mkdirSync(cwd, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const subagents = path.join(projectDir, "sess1", "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(path.join(projectDir, "sess1.jsonl"), "{}\n");
  for (const [id, ageMs] of [["old", 5 * 60_000], ["live", 0]]) {
    writeFileSync(path.join(subagents, `agent-${id}.meta.json`), JSON.stringify({ agentType: "Explore", description: id }));
    const jsonl = path.join(subagents, `agent-${id}.jsonl`);
    writeFileSync(jsonl, JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() - ageMs).toISOString(), message: { content: [] } }) + "\n");
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(jsonl, t, t);
  }
  const win = { key: "s:1", sessionName: "s", windowIndex: 1, cwd };
  const { counts, recent } = await getCounts([win]);
  assert.equal(counts["s:1"], 1);
  assert.equal(recent["s:1"], 1);
  const details = await getSubagentDetails(win);
  assert.deepEqual(details.map((d) => [d.description, d.status]), [["live", "running"], ["old", "completed"]]);
});
