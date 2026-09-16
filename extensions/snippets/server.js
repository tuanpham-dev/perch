// Server hook for the snippets extension — one route: type text into a
// session's current window through core's host.sessions. Extensions talk only
// to their own activate() context, so this is deliberately a copy of
// command-history/server.js's route rather than a cross-extension import.

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
