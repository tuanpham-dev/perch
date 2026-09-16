// Server hook for the command-history extension — one route: type text into
// a session's current window. History data itself comes from core's GET
// /api/command-events (fed by shell integration); this hook only exists
// because typing into a terminal from a sidebar panel or the quick switcher
// has no client-side channel (TerminalAccessoryContext.sendInput is
// accessory-only).

const MAX_TEXT_LENGTH = 4096;

export function activate({ router, host }) {
  router.post("/type", async (req, res) => {
    const { session, text, submit } = req.body ?? {};
    if (typeof session !== "string" || !session || typeof text !== "string" || !text) {
      res.status(400).json({ error: "session and text are required" });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(400).json({ error: "text too long" });
      return;
    }
    try {
      // Literal text; submit sends Enter separately after a short settle.
      await host.sessions.sendText(session, text, submit === true);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
