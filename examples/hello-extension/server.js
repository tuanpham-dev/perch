// Reference server entry — one route, mounted at /api/ext/<extensionId>/hello
// while this extension is installed and enabled. getSettings() resolves this
// extension's contributes.configuration values (manifest defaults overridden
// by whatever the user set in Settings → Hello Extension) — read fresh on
// every call, so a settings change reaches the next request without a
// server restart.
export function activate({ router, log, getSettings }) {
  router.get("/hello", async (req, res) => {
    log("GET /hello");
    const settings = await getSettings();
    res.json({
      message: `Hello from the sample extension's server hook! (mood: ${settings["hello.mood"]}, greeting: "${settings["hello.greeting"]}")`,
    });
  });
}
