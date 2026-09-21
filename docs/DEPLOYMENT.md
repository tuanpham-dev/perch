# Running Perch in production

Serving the built app, putting it behind nginx, and locking it down. For the
managed install that does most of this for you, see [Install](INSTALL.md).

## Production

Builds the client and serves everything — static assets, `/api`, and `/ws` — from a single Express server:

```bash
npm run build
npm start          # listens on 127.0.0.1:3001 by default
```

Override the port with `PORT=<port> npm start`. The server always binds to `127.0.0.1` and has no authentication by default, so it's meant to be used locally, fronted by a reverse-proxy auth layer, or gated with `AUTH_TOKEN` (see [Authentication](#authentication) below). Set `NEW_SESSION_CWD` to change the working directory new sessions start in — without it, new sessions start in your home directory. (Settings → Behavior → Default projects folder only sets where the Open Folder dialog starts browsing.)

Set `APP_NAME` to rebrand the browser tab title and PWA name away from the "Perch" default — e.g. `APP_NAME="My Server" npm start`. It's applied dynamically as the server templates `index.html` and `manifest.webmanifest` per request, so (like the other config above) a restart is all it takes — no rebuild needed. `APP_NAME=... npm run dev` retitles the dev server's tab too, but the PWA manifest is only active in the production build (Vite's PWA plugin doesn't run in dev by default).

To run a second instance beside the one you use (a test build, say), give it its own `PORT`, `PERCH_CONFIG_DIR` and `PERCH_STATE_DIR`: the config directory (default `~/.config/perch`) holds settings, extensions and the shims terminals use to reach the server, and the state directory (default `~/.local/state/perch`) holds the terminal daemon's socket and saved sessions. Two instances sharing either would rewrite each other's shims or share one set of terminals.

The app ships with a built-in **default extension registry** so extensions are installable out of the box from the **Extensions** tab (`Ctrl+Shift+X`) — no manual setup. It appears there as a non-removable source tagged "default". Override it with `EXTENSION_REGISTRY` (a registry URL serving an `index.json`, or a local directory path); set `EXTENSION_REGISTRY=` (empty) to disable it entirely and ship no default. Users can still add their own registries alongside it. Read at request time, so a restart applies changes with no rebuild.

### Behind nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Terminals are long-lived WebSocket connections.
    proxy_read_timeout 1d;
    proxy_send_timeout 1d;
}
```

If you add `auth_basic` (nginx-level HTTP Basic Auth) in front of this, exempt the manifest and service worker from it — Chrome's internal PWA-installability check fetches them without your browser's cached Basic Auth credentials, so they'll get a 401 and the "Install app" option won't appear even though the site itself loads fine:

```nginx
location = /manifest.webmanifest {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
location = /sw.js {
    auth_basic off;
    proxy_pass http://127.0.0.1:3001;
}
```

`AUTH_TOKEN` (see [Authentication](#authentication) below) doesn't have this problem, since it's cookie-based and cookies ride along on every request automatically — it's the simpler option if you don't need Basic Auth for another reason.

The server only accepts requests whose `Host` (and, for browser requests, `Origin`) resolve to `localhost`, `127.0.0.1`, or `::1` by default — this blocks other websites' pages from reaching it via your browser (WebSockets ignore same-origin policy). Set `ALLOWED_HOSTS` to a comma-separated list of the hostname(s) you expose it as, e.g.:

```bash
ALLOWED_HOSTS=perch.example.com npm start
```

The `Host $host` line in the nginx config above forwards the real hostname through, so this only needs to be set once per domain. The `X-Forwarded-Proto` line lets the server mark the auth cookie (see below) `Secure` when you're serving over HTTPS.

### Authentication

Set `AUTH_TOKEN` to require a shared secret before anything under `/api` or either WebSocket endpoint (`/ws/attach`, `/ws/tunnel`) is reachable:

```bash
AUTH_TOKEN=<a-long-random-secret> npm start
```

Open the app with the token in the URL once:

```
https://perch.example.com/?token=<a-long-random-secret>
```

The server mints an HttpOnly cookie from that request and strips `?token=` from the address bar; every later request in that browser rides the cookie automatically. Visiting without a valid token shows a login form asking for it instead of the app.

Notes:

- **Off by default.** Leaving `AUTH_TOKEN` unset disables the gate entirely — identical to today's behavior.
- **The token appears once in plaintext** — in the URL you opened, and in your browser history unless you clear it. Treat that URL like a credential; don't paste it into chat or a public issue.
- **Scripts and the tunnel CLI** can't hold a cookie across invocations — pass the token as a header instead: `curl -H 'x-auth-token: <secret>' ...` or `node tunnel.mjs --header 'x-auth-token: <secret>' ...`. The PORTS panel's copy button already bakes in whatever `Cookie`/`Authorization` your browser session is carrying (see [Port forwarding](PORT_FORWARDING.md)), so the auth cookie — including one minted by `AUTH_TOKEN` — rides along automatically when you copy its generated command.
- **Static assets and `/tunnel.mjs`** stay reachable without a token — they're public code with nothing to protect. An extension's own `/api/ext/<id>/public/*` routes are likewise exempt from the gate, the same way they're exempt from the Origin check.
