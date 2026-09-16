// ports server hook: list/kill routes over the core host.ports API. The
// port-attribution engine itself (terminal pids + /proc walk + ss) stays
// in core server/src/ports.ts — it also feeds the WS tunnel's security
// gate, so this extension consumes the same data rather than re-scanning.
import { spawnSync } from "node:child_process";

const KILL_GRACE_MS = 5_000;

function endTree(pid, force) {
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
  if (r.error) throw r.error;
}

export function activate({ router, host }) {
  router.get("/list", async (_req, res) => {
    try {
      res.json(await host.ports.list());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/kill/:port", async (req, res) => {
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: "invalid port" });
      return;
    }
    const entry = await host.ports.find(port);
    if (!entry || entry.pid === undefined) {
      res.status(404).json({ error: "port not found in any terminal session" });
      return;
    }
    const pid = entry.pid;
    try {
      // Windows has no SIGTERM; taskkill without /F asks the process tree to
      // close, the escalation below forces it.
      if (process.platform === "win32") endTree(pid, false);
      else process.kill(pid, "SIGTERM");
    } catch (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    res.status(204).end();
    // Grace period for a clean shutdown; escalate to SIGKILL only if the same
    // pid is still holding the port afterward (an already-exited or since-
    // reused pid is left alone).
    setTimeout(() => {
      host.ports
        .find(port)
        .then((stillThere) => {
          if (stillThere?.pid !== pid) return;
          if (process.platform === "win32") endTree(pid, true);
          else process.kill(pid, "SIGKILL");
        })
        .catch(() => {});
    }, KILL_GRACE_MS).unref();
  });
}
