# Port forwarding and the port proxy

Two ways to reach a port listening on the server: a one-line tunnel CLI, and
the server's own proxy, which needs nothing installed at all.

If something on the server listens on a port (a dev server, a database) and you want `localhost:PORT` on your own machine to reach it — like `ssh -L`, but without SSH access — pipe the tunnel CLI from the server straight into Node (nothing is written to disk):

```bash
curl -s http://<host>:3001/tunnel.mjs | node --input-type=module - --url http://<host>:3001 3000
```

Now `http://localhost:3000` on your machine reaches `127.0.0.1:3000` on the server. Forward multiple ports in one command, and use `LOCAL:REMOTE` when you want a different local port:

```bash
curl -s http://<host>:3001/tunnel.mjs | node --input-type=module - --url http://<host>:3001 3000 8080:80
```

Or skip the port list entirely with `--all`, which forwards every port currently listening inside the server's terminal sessions and keeps watching: a dev server you start later appears as a new local forward within seconds, and forwards whose remote port goes away are closed — no restart, no editing arguments:

```bash
curl -s http://<host>:3001/tunnel.mjs | node --input-type=module - --url http://<host>:3001 --all
```

A port that can't be bound locally (something on your machine already uses it) is reported once and skipped; explicit specs can be mixed in and keep priority over `--all` for their local ports. Run `--all` from your own machine, not from a shell inside one of the server's own terminals — there the tunnel's own listeners are indistinguishable from servers started in those terminals and would keep vanished ports alive.

The command works as-is on Windows too (`cmd` or PowerShell 7+): `curl` ships with Windows 10+, and nothing is stored on disk, so there's no Unix-only path involved. (On legacy Windows PowerShell 5.1, write `curl.exe` — bare `curl` is aliased to `Invoke-WebRequest` there.) If you'd rather keep a saved copy, `curl -O http://<host>:3001/tunnel.mjs` then `node tunnel.mjs ...` works the same way.

`--url` defaults to `$PERCH_URL`, then `http://127.0.0.1:3001`. All forwards share a single WebSocket connection, multiplexed per-connection — the CLI is a single dependency-free file (Node 20+, stdlib only), always served fresh from the server it's connecting to, so it never drifts out of sync with the server's protocol.

The port readout in the status bar (a plug icon and a count) opens a list of the server's listening ports, with a button that copies this command for you — just run it locally. It always forwards **everything** (`--all`, auto-forwarding whatever is listening at any moment) rather than a fixed set you pick: a snapshot went stale the moment a dev server restarted on a different port.

While a tunnel is connected, the app shows which ports it has actually bound locally — a marker on those rows, and a highlighted plug in the status bar once every listening port is covered. Clicking a forwarded port opens `http://localhost:<port>` directly instead of routing through the proxy. The CLI reports only ports it really bound (it skips any whose local port is already taken), so the marker never points at a dead address; a tunnel started from a command copied before this feature existed reports nothing and simply shows no marker. If your browser session is carrying a `Cookie` or `Authorization` header (because Perch is fronted by a reverse-proxy auth layer), the copy button automatically bakes it into the command via `-H`/`--header`, so the download and the tunnel both authenticate the same way your browser did. The copied command contains the real secret, so it lands in your shell history like any credential-bearing command.

If you're running the CLI by hand instead of using the panel's copy button, pass auth through yourself with URL credentials or headers (once for the download, once for the tunnel):

```bash
curl -su user:pass https://myhost/tunnel.mjs | node --input-type=module - --url https://user:pass@myhost 3000
curl -s -H 'Cookie: session=...' https://myhost/tunnel.mjs | node --input-type=module - --url https://myhost --header 'Cookie: session=...' 3000
```

The [nginx config](DEPLOYMENT.md#behind-nginx) needs no changes — `/ws/tunnel` is covered by the same `location /` WebSocket proxy block as terminal sessions. Note that if a proxy strips the `Cookie`/`Authorization` header before forwarding upstream (some hardening configs explicitly clear `Authorization`), the panel has no way to detect that and will silently omit the header — same as if there were no auth layer at all.

### Browser-native proxy (no CLI download)

Each row in the status bar's port list also has three one-click actions — no CLI, no download, works from a phone:

- **Open in browser** — opens the port in a new tab.
- **Copy URL** — copies the same URL to your clipboard.
- **Kill process** — sends the owning process `SIGTERM` (after a confirmation), escalating to `SIGKILL` after 5 seconds if it's still holding the port.

This works because the server itself proxies local ports — code-server's `--proxy-domain` model — with two ways to reach a port:

```
https://perch.example.com/proxy/3000/       # always available, prefix stripped before forwarding
https://perch.example.com/absproxy/3000/    # prefix kept — for an app configured with a matching base path
```

`/proxy/<port>/` works with zero setup, but an app that references its own assets by absolute path (e.g. `/assets/index.js` rather than `./assets/index.js`) will 404 under a stripped prefix unless it's configured with a matching base path (Vite's `base`, Next's `basePath`, etc.) — the server also falls back to routing an absolute-path request to whichever port referred it (via the `Referer` header), which covers most dev servers without any config at all. `/absproxy/<port>/` is the escape hatch for apps you *have* configured with a base path.

For the case where every app should work completely unmodified, set `PROXY_DOMAIN` to route by subdomain instead of path prefix — same idea as code-server's `--proxy-domain`:

```bash
PROXY_DOMAIN=proxy.example.com npm start
# or: perch start --proxy-domain proxy.example.com
```

A request to `3000.proxy.example.com` now reaches port 3000 directly, with no path rewriting — comma-separate multiple domains if you need more than one. This requires wildcard DNS (`*.proxy.example.com` → this server) and, if you're serving over HTTPS, a wildcard TLS certificate for that domain too — a browser only sends a `Secure` cookie back to HTTPS subdomains, so without wildcard TLS the auth cookie (see [Authentication](DEPLOYMENT.md#authentication) above) won't reach them. If you hit that, opening `https://3000.proxy.example.com/?token=<secret>` once mints the cookie for that specific subdomain directly.

All of this sits behind the same gates as everything else: `ALLOWED_HOSTS`/`PROXY_DOMAIN` decide which Host headers are accepted, and `AUTH_TOKEN` (when set) gates proxied requests exactly like `/api/*` — a proxied port is never reachable without a valid token any more than the app itself is.
