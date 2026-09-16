// Reference client entry — exercises every v1 extension API surface:
// a command with a default keybinding, a file viewer for a made-up ".demo"
// extension, a sidebar panel that talks to this same extension's server
// hook, and contributes.configuration settings (see package.json's "hello.*"
// properties). Plain ESM, no build step — ctx.React is how it gets React
// without bundling its own copy.
export function activate(ctx) {
  const {
    React,
    registerCommand,
    registerFileViewer,
    registerSidebarPanel,
    registerStatusBarItem,
    app,
    serverFetch,
    settings,
  } = ctx;

  // Reads this extension's current setting values (declared default,
  // overridden by whatever the user set in Settings → Hello Extension) and
  // composes them into the greeting text.
  function buildGreeting() {
    const base = settings.get("hello.greeting");
    const mood = settings.get("hello.mood");
    let text =
      mood === "excited" ? `${base} 🎉` : mood === "formal" ? `${base} Sincerely, Hello Extension.` : base;
    if (settings.get("hello.shout")) text = `${text.toUpperCase()}!!!`;
    return Array.from({ length: settings.get("hello.repeatCount") }, () => text).join(" ");
  }

  registerCommand({
    id: "sayHello",
    label: "Hello Extension: Say Hello",
    defaultBinding: "ctrl+alt+KeyH",
    run: () => {
      const active = app.getActiveContext();
      const where = active.cwd ? ` (active window's cwd: ${active.cwd})` : "";
      window.alert(`${buildGreeting()}${where}`);
    },
  });

  // Session-level host APIs: reveal this extension's own panel, then open a
  // session as a tab — creating it in the given directory when it doesn't
  // exist yet (that's the whole flow the worktrees extension uses). Kill is
  // deliberately unconfirmed by the host, so confirm it here.
  registerCommand({
    id: "demoSession",
    label: "Hello Extension: Open Demo Session",
    run: () => {
      app.revealSidebarPanel("helloPanel");
      app.openSessionWindow("hello-demo", { createCwd: app.getActiveContext().cwd ?? undefined });
    },
  });

  registerCommand({
    id: "killDemoSession",
    label: "Hello Extension: Kill Demo Session",
    run: () => {
      if (window.confirm('Kill session "hello-demo"?')) app.killSession("hello-demo");
    },
  });

  registerFileViewer({
    id: "demoViewer",
    extensions: ["demo"],
    component: function DemoViewer({ filePath }) {
      const [text, setText] = React.useState("Loading…");
      React.useEffect(() => {
        let cancelled = false;
        fetch(`/api/download?inline=1&path=${encodeURIComponent(filePath)}`)
          .then((res) => res.text())
          .then((body) => {
            if (!cancelled) setText(body);
          })
          .catch((err) => {
            if (!cancelled) setText(`Failed to load: ${err}`);
          });
        return () => {
          cancelled = true;
        };
      }, [filePath]);
      return React.createElement(
        "div",
        { style: { padding: 16, fontFamily: "monospace", whiteSpace: "pre-wrap", color: "var(--fg)" } },
        React.createElement("h3", { style: { marginTop: 0 } }, `.demo viewer — ${filePath}`),
        text,
      );
    },
  });

  // A status-bar readout whose click opens a popover above the bar. The host
  // owns the popover's placement and dismissal; calling openPopover again
  // from the same item closes it, so no open/closed state is tracked here.
  registerStatusBarItem({
    id: "helloStatus",
    placement: "left",
    component: function HelloStatusItem({ context }) {
      return React.createElement(
        "button",
        {
          className: "status-bar-item",
          "data-menu-trigger": "true",
          title: "Hello Extension",
          onClick: (e) =>
            context.openPopover(
              e.currentTarget.getBoundingClientRect(),
              React.createElement("div", { style: { padding: 12 } }, buildGreeting()),
            ),
        },
        React.createElement("span", { className: "codicon codicon-smiley" }),
        React.createElement("span", null, "Hello"),
      );
    },
  });

  registerSidebarPanel({
    id: "helloPanel",
    title: "Hello",
    component: function HelloPanel() {
      const [message, setMessage] = React.useState("Loading…");
      // Live-apply demo: settings.onDidChange fires with no arguments
      // whenever any of this extension's settings change (a user edit in
      // Settings → Hello Extension, or the server doc syncing in) — re-read
      // via settings.get() rather than relying on the callback's payload.
      // No reload needed; try changing "Tone of the greeting" while this
      // panel is open.
      const [greeting, setGreeting] = React.useState(buildGreeting);
      React.useEffect(() => settings.onDidChange(() => setGreeting(buildGreeting())), []);
      React.useEffect(() => {
        let cancelled = false;
        serverFetch("/hello")
          .then((res) => res.json())
          .then((data) => {
            if (!cancelled) setMessage(data.message);
          })
          .catch((err) => {
            if (!cancelled) setMessage(`Server hook unreachable: ${err}`);
          });
        return () => {
          cancelled = true;
        };
      }, []);
      return React.createElement(
        "div",
        { style: { padding: "8px 12px", fontSize: 13 } },
        React.createElement("div", { style: { marginBottom: 6 } }, greeting),
        message,
      );
    },
  });
}
