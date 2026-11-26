# Perch relay

A small server that lets Perch instances on different machines find and message
each other. It forwards encrypted frames and never sees their contents. Nothing
here depends on the rest of the Perch repository: this folder runs on its own.

Needs Node 24 or newer (it uses the built-in `node:sqlite`).

## Start with Node

```sh
npm ci --omit=dev
RELAY_ADMIN_SECRET=<a long random string> npm start
```

That line is kept in your shell history; for real use put the secret in an env
file (or a systemd `EnvironmentFile`) and load it. Behind a TLS proxy on the same
host, also set `RELAY_HOST=127.0.0.1`.

The relay listens on port 8787 for Perch machines and on `127.0.0.1:8788` for
admin commands (this machine only). State goes to `./data` unless you set
`RELAY_DATA_DIR`. Check it with `curl http://127.0.0.1:8787/healthz`.

Without `RELAY_ADMIN_SECRET` the relay still runs, but groups cannot be created
and admin commands are refused.

## Start with Docker Compose

```sh
echo 'RELAY_ADMIN_SECRET=<a long random string>' > .env
docker compose -f compose.example.yml up --build -d
```

The example publishes only `127.0.0.1:8787`. Put a TLS proxy (nginx, Caddy) in
front of it and pass WebSocket upgrade headers; keep the proxy's read timeout
above 60 seconds. Never proxy or publish the admin port.

The example pins its network to `172.30.87.0/24`. A reverse proxy running on the
host reaches the container from that network's gateway, `172.30.87.1`, so the
example sets `RELAY_TRUSTED_PROXIES` to that address. If you change the subnet,
change the gateway and `RELAY_TRUSTED_PROXIES` with it; if the proxy runs
elsewhere, use its address instead. The container has a healthcheck on
`/healthz`, and the `/data` folder in the image is owned by the `node` user the
relay runs as.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `RELAY_HOST` | `0.0.0.0` | Address the relay port binds to. |
| `RELAY_PORT` | `8787` | Port Perch machines connect to. `0` picks a free port. |
| `RELAY_ADMIN_PORT` | `8788` | Admin port, always bound to `127.0.0.1`. `0` picks a free port. |
| `RELAY_DATA_DIR` | `./data` (`/data` in the image) | Folder holding the relay's state. |
| `RELAY_ADMIN_SECRET` | none | Required to create groups and to run admin commands. |
| `RELAY_AUTH_MODE` | `token` | Only `token` is available in this version. |
| `RELAY_TRUSTED_PROXIES` | none | Comma-separated addresses or CIDR ranges of proxies whose forwarded client address is trusted. |
| `RELAY_MAX_PREAUTH_PER_ADDRESS` | `20` | Connections from one address that may be open before they sign in. |
| `RELAY_MAX_PENDING_PER_INVITE` | `5` | Join attempts that may wait on one invite at once. |
| `RELAY_MAX_FRAME_BYTES` | `262144` | Largest frame accepted (at least 4096). |
| `RELAY_FRAMES_PER_MINUTE` | `600` | Frames one machine may send per minute. |
| `RELAY_MAX_MACHINES` | `50` | Machines per group. |
| `RELAY_AUTH_FAILS_PER_MINUTE` | `5` | Failed sign-ins per address per minute before it is refused. |

A setting that is not a whole number in range stops the relay with a message
naming it.

## Admin commands

Run on the machine hosting the relay, with `RELAY_ADMIN_SECRET` (and
`RELAY_ADMIN_PORT` if you changed it) set:

```sh
node src/main.mjs groups                             # list groups
node src/main.mjs machines <group>                   # list a group's machines
node src/main.mjs remove-machine <group> <machine>   # block a machine (does not replace the group secret)
node src/main.mjs delete-group <group>               # delete a group and disconnect its machines
```

With Compose, run them inside the container (the secret is already set there):

```sh
docker compose -f compose.example.yml exec relay node src/main.mjs groups
```

## Where state lives

Everything is in the data folder (`RELAY_DATA_DIR`; the `relay-data` volume
mounted at `/data` with Compose), in the SQLite database `relay.sqlite` and its
`-wal` and `-shm` files. Back up that folder; stop the relay first for a
consistent copy.

## Tests

```sh
npm ci && npm test
```
