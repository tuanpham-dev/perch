// What the agent a preview sent its comments to is doing, from core's agent
// hooks (host.agentHooks): its last event per terminal window, numbered, so
// the tab can tell which came after its own send. The comment panel shows it
// ("working", "needs your input", "done"), so the user knows when Check Fixes
// is worth pressing. Plain ESM; mounted by each preview extension's server
// entry. Without hooks (an agent that doesn't report them, or a core without
// the pipeline) there is just nothing to show.
import { randomBytes } from "node:crypto";

const MAX_WINDOWS = 200;

export function mountAgentStateRoutes(router, host) {
  // window id ($PERCH_WINDOW) -> { seq, event }
  const last = new Map();
  let seq = 0;
  // Numbers start over when the server does; a send's baseline from before
  // then says nothing about these.
  const boot = randomBytes(6).toString("hex");
  host?.agentHooks?.subscribe?.({
    events: ["prompt-submit", "permission", "stop"],
    onEvent(event) {
      if (!event.paneId || !event.event) return;
      last.delete(event.paneId);
      last.set(event.paneId, { seq: ++seq, event: event.event });
      if (last.size > MAX_WINDOWS) last.delete(last.keys().next().value);
    },
  });

  // ?window=<id>: that window's last event and its number. `seq` alone is
  // the latest number overall, the baseline a send takes before it goes.
  router.get("/agent-state", (req, res) => {
    const id = typeof req.query.window === "string" ? req.query.window : "";
    const entry = id ? last.get(id) : undefined;
    res.json({ boot, seq, last: entry ?? null, hooks: typeof host?.agentHooks?.subscribe === "function" });
  });
}
