# Relay: agents on different machines

Run Perch on more than one machine and let their agents see and message each
other. A small relay server, which you host, introduces the machines and
forwards their traffic. For where this sits in the product, see
[Features](FEATURES.md); for the relay's own folder, see
[relay/README.md](../relay/README.md).

## What it is for

You have Perch on a laptop, a build box and a home server. With a relay, a
Claude Code agent on the laptop can list the build box's projects, read its
terminals, follow an agent there with `wait_for_agent`, and send that agent a
message, which then answers through `reply_to_agent`. The same works from the
build box to the laptop.

Machines that join the same **group** can reach each other; machines outside
the group cannot. Everything the machines say to each other is encrypted
between them, so the relay only passes it along (see
[What the relay can and cannot see](#what-the-relay-can-and-cannot-see)).

Joining gives the other machines in the group read and send access to this
one's terminals and AI agents, by default. Change that any time with **Others
may** (below).

## Quick start

You need a relay, then one machine to create a group on it, then an invite for
each further machine.

**1. Run a relay** (on a server both machines can reach; see
[Self-hosting](#self-hosting) for the full story):

```bash
cd relay
npm ci --omit=dev
RELAY_ADMIN_SECRET=<a long random string> npm start
```

Typed like this, the secret is kept in your shell history. For anything beyond
a quick try, put `RELAY_ADMIN_SECRET=...` in a file only you can read (`chmod
600`) and load it, for example `set -a; . ./relay.env; set +a; npm start`, or a
systemd unit with `EnvironmentFile=/etc/perch-relay.env`.

Check it:

```bash
curl http://127.0.0.1:8787/healthz
```

**2. Create a group** from the first machine. Either in Settings → Assistant →
Relay → **Create a new group…** (relay address and admin secret), or:

```bash
perch relay create wss://relay.example.com --name laptop
```

With no secret in the environment, `create` asks for the admin secret at a
hidden prompt. To use it from a script, pipe it from a file or a secret
manager (`pass show perch-relay | perch relay create wss://relay.example.com
--name laptop`) or set `PERCH_RELAY_ADMIN_SECRET=... perch relay create ...`
(your shell history records that line).

`--name` is this machine's name in the group (letters, digits, `.`, `_`, `-`, up
to 40, no spaces); without it, the CLI uses the host name, as Settings does.
The address must start with `wss://`. For a relay on a network you trust you
can use `ws://` by adding `--allow-insecure` (a `ws://` address on this machine,
`localhost` or `127.0.0.1`, needs no flag); in Settings that is **Allow
unencrypted connection**. Without TLS the admin secret (sent once, at create)
and the metadata listed under
[What the relay can see](#what-the-relay-can-and-cannot-see) cross the network
in the clear, and an attacker on the path can tamper with traffic or cut it off.
The invite secret itself never leaves the machines; only its public id does.

**3. Invite another machine.** From a machine in the group:

```bash
perch relay invite
```

The invite is printed once, on its own line, and is not stored anywhere it can
be shown again. It lasts 24 hours and admits one machine; change that with
`--uses <1-20>` and `--expires <10m|1h|24h|7d>` (any number of minutes, hours or
days from 10 minutes to 7 days). In Settings: **Invite a machine**.

**4. Join** from the new machine. The invite is read from a hidden prompt, or
piped in:

```bash
perch relay join --name buildbox                 # asks for the invite
cat invite.txt | perch relay join --name buildbox
```

For scripts, `PERCH_RELAY_INVITE=<the invite> perch relay join --name buildbox`
works too, but your shell history records it.

Or Settings → Assistant → Relay, paste the invite, **Join**. Within a few
seconds each machine lists the other as online and verified:

```bash
perch relay machines
```

An invite carries the relay's address, so joining needs nothing else. A
member that holds the invite has to be online while you join (see
[Known limits](#known-limits)).

Secrets are never taken as command-line arguments, where `ps` and shell
history would keep them. The admin secret (`create`) and the invite (`join`)
come from, in order: the environment variable (`PERCH_RELAY_ADMIN_SECRET`,
`PERCH_RELAY_INVITE`), the first line of standard input when it is piped, or a
hidden prompt in a terminal. `--invite` and `--admin-secret` are not flags.

## Using it from an agent

Run Claude Code against `perch mcp` (see the
[Assistant extension](../extensions/assistant/README.md)). Once this machine is
in a group:

- `list_machines` lists the group: each name, whether it is this machine,
  online or last seen, verified or not, and what it accepts from others. It is
  always available; until this machine joins a group it says how to join.
- `list_projects`, `agent_status`, `agent_conversation`, `read_terminal`,
  `wait_for_agent` and `send_to_agent` take an optional `machine` argument, a
  name from `list_machines`. Without it they act on this machine.
- `reply_to_agent` answers the agent on another machine whose message arrived
  in this window; give it a `to` address (`machine/project:index`, as printed
  in the message) to send to any agent in the group.

Text from another machine is typed only into a window where Perch detects a
running AI agent; anything else is refused and nothing is typed. It arrives as
one prompt submission that starts with a line saying which machine it came from
and that it is another AI agent, not the user. Calls give up after 30 seconds
without an answer; `wait_for_agent` waits its own limit (default 120 s, at most
600 s) plus 30 s.

`list_machines` and `reply_to_agent` are listed whether or not this machine has
joined, except that when Assistant **Read-only** is on, `send_to_agent` and `reply_to_agent` are hidden and refused here, and other machines cannot type into agents here either,
whatever **Others may** says; the Relay section shows when this applies.

## Controlling who can do what

Under Settings → Assistant → Relay, **Others may** sets what other machines may
do on this one. The same from a terminal:

```bash
perch relay permission read-only    # off, read-only or send
```

- **Off**: every call from other machines is refused, including one already
  waiting in `wait_for_agent`.
- **Read-only**: they can list and read, not type into agents.
- **Read and send**: they can also type into your agents. This is where a
  machine starts when it creates or joins a group.

A change applies to the next call, with no reconnect. It never limits what this
machine may do on others, and it is kept with the group membership, so settings
import, export and reset do not change it.

The Relay section also lists the other machines (with a **Remove** button, and
a "blocked by relay admin" or "not verified" tag when it applies), the open
invites, and an **Activity** list of the calls other machines made here and the
membership events: who, which tool, which target, allowed or refused, never any
text or results. It keeps the newest 200 calls and 200 events. A status bar item
shows the connection.

Other commands:

```bash
perch relay status            # relay, connection, this machine, Others may
perch relay invites           # open invites, with ids
perch relay revoke <id>       # cancel an invite
perch relay rename <name>     # this machine's name (letters, digits . _ -, up to 40)
perch relay label "build"     # a label the relay can see (letters, digits . _ -, up to 40, no spaces); --clear removes it
perch relay remove <machine>  # remove a machine and replace the group secret
perch relay leave             # leave, and delete this machine's keys
```

`remove` and `leave` ask first; pass `--yes` (or `-y`) when there is no
terminal. All of them take `--port <n>` to target one Perch instance when more
than one runs. Names that two machines share show as `name~xxxx`. A removed
machine disappears from the list.

## Self-hosting

The relay is the `relay/` folder: a small Node program with one dependency
(`ws`) that does not need the rest of the repository. You can copy that folder
anywhere. It needs Node 24 or newer (it uses the built-in `node:sqlite`).

**With Node:**

```bash
cd relay
npm ci --omit=dev
RELAY_ADMIN_SECRET=<a long random string> npm start
```

The relay listens on port 8787 for Perch machines and on `127.0.0.1:8788` for
admin commands (this machine only). State goes to `./data` unless you set
`RELAY_DATA_DIR`. Without `RELAY_ADMIN_SECRET` the relay still runs, but groups
cannot be created and admin commands are refused.

**With Docker Compose:**

```bash
cd relay
echo 'RELAY_ADMIN_SECRET=<a long random string>' > .env
docker compose -f compose.example.yml up --build -d
```

The example publishes only `127.0.0.1:8787` and keeps state in the `relay-data`
volume. The admin port is never published.

### TLS behind nginx

Perch machines expect `wss://`, so put a TLS proxy in front. Idle connections carry a keepalive
every 25 seconds, so keep the proxy's idle timeout above 60 seconds,
and pass the WebSocket upgrade headers:

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Set `RELAY_TRUSTED_PROXIES` to the proxy's address (or CIDR range), so the
relay limits each client by its own address rather than the proxy's:

```bash
RELAY_HOST=127.0.0.1 RELAY_TRUSTED_PROXIES=127.0.0.1 npm start   # plus RELAY_ADMIN_SECRET, from an env file
```

With Node behind a proxy on the same host, also set `RELAY_HOST=127.0.0.1`
(the default is `0.0.0.0`), so the relay port is not reachable around the
proxy. Keep `RELAY_ADMIN_SECRET` in an env file or a systemd
`EnvironmentFile`, not on the command line.
Never proxy or publish the admin port (`RELAY_ADMIN_PORT`, 8788). It is bound to
`127.0.0.1` on purpose, and the admin secret should only be typed on the relay
host or to `perch relay create`.

### Environment and limits

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
| `RELAY_FRAMES_PER_MINUTE` | `600` | Frames one machine may send per minute. Each frame over it is refused; a connection that sends 50 more in that minute is closed. |
| `RELAY_MAX_MACHINES` | `50` | Machines per group. |
| `RELAY_AUTH_FAILS_PER_MINUTE` | `5` | Failed sign-ins per address per minute before it is refused. |

A setting that is not a whole number in range stops the relay with a message
naming it. A call or result larger than one frame is split and reassembled, up
to 8 MB in total.

### Admin commands

Run on the machine hosting the relay, with `RELAY_ADMIN_SECRET` (and
`RELAY_ADMIN_PORT` if you changed it) set:

```bash
node src/main.mjs groups                             # list groups
node src/main.mjs machines <group>                   # list a group's machines
node src/main.mjs remove-machine <group> <machine>   # block a machine
node src/main.mjs delete-group <group>               # delete a group and disconnect its machines
```

They show ids, relay labels, counts and times, never names. `remove-machine`
makes the relay refuse that machine from now on; it does **not** replace the
group secret, so to really remove a machine, remove it from a Perch in the group
(`perch relay remove`). `delete-group` disconnects every member and refuses
their next connection. With Compose, run them inside the container:

```bash
docker compose -f compose.example.yml exec relay node src/main.mjs groups
```

### Backup

Everything is in the data folder (`RELAY_DATA_DIR`; the `relay-data` volume with
Compose): the SQLite database `relay.sqlite` and its `-wal` and `-shm` files.
Back up that folder, and stop the relay first for a consistent copy. The
relay holds no keys that can read anything, so losing it loses the groups, not
secrets; machines would need a new group.

## What the relay can and cannot see

The relay can see:

- the group id and each machine's id,
- a relay label, if you set one (`perch relay label`),
- each machine's public keys,
- the invites: their ids, expiry and number of uses, and which machine created
  and which admitted on each,
- the group's key epoch, and removal records naming the machine that removed and
  the one removed,
- the admin secret, once, when a group is created,
- the size and timing of each message, and which machines talk to each other,
- the address each machine connects from.

So whoever runs the relay can see the group's membership history by machine id,
though not who the ids belong to.

It cannot see, because they exist only encrypted between machines or never
leave them: machine names, project and window names, tool names, arguments,
message text, results, invite secrets, or the group secret.

The relay's admin list therefore shows ids, labels and last-seen times, and no
names. The health response (`/healthz`) holds no group or machine data.

## How trust works

- **The group secret** is a random key every member holds. It is how members
  recognise one another; it never reaches the relay.
- **An invite** is a one-time (or few-time) token a member creates. The new
  machine proves it holds the invite, and a member that holds the same invite,
  and is online, checks it and passes the new machine the group secret, over an
  encrypted channel only the two of them can read. That is why a member must be
  online to admit you.
- **Machines are pinned.** Each machine remembers every other's key when it
  first sees it, and refuses a call from a machine whose key changed. A machine
  that cannot be verified is shown as "not verified" and Perch will not talk to
  it.
- **Removing a machine replaces the group secret.** The remaining members get a
  new one, and the removed machine is left holding a secret that no longer
  works. Members who are offline catch up when they reconnect.
- **The relay cannot add or remove machines by itself.** Adding needs an invite
  held by a member; removal needs a record signed by a member. A hostile relay
  can refuse service, drop frames or hold back messages, but it cannot read
  them, forge membership, or make a machine delete its keys.

## Known limits

- **The encryption has had no outside audit.** The session, invite and
  re-keying protocol is assembled from standard primitives and checked by its
  own tests and review, not by an independent audit or an audited library.
  Treat a group's contents as protected by that, and weigh it accordingly.
- **A removed machine and a hostile relay together** can, for a member that was
  offline during the removal, present the removed machine to it until that member
  next connects to an honest relay.
- **Blocking from the relay admin does not re-key.** `remove-machine` stops a
  machine from connecting to that relay, but it still holds the group secret.
- **A member that holds the invite must be online to admit you.** If none is,
  the join fails and says so; try again when one is.
- **A join interrupted after the invite was accepted** (the admitting machine
  goes offline or crashes at that moment) spends one use of the invite; ask for
  a new one.
- **Every member can invite, admit and remove**, because members already read
  and send on each other. There are no roles.
- **`AUTH_TOKEN` protects the Relay section.** The Relay section and `perch
  relay` are part of the Perch UI and API, so a Perch that is open to the network
  without [`AUTH_TOKEN`](DEPLOYMENT.md#authentication) lets whoever can reach it
  invite, remove or turn the permission up. Give the CLI the same token as other
  scripts.
- **Two Perch instances sharing one configuration folder** (the default
  `~/.config/perch`) share one membership, but only the first holds the relay
  link. The second reports an "already connected" error for `list_machines` and
  any call naming a machine, and works locally as usual. Give a second instance
  its own `PERCH_CONFIG_DIR`.
- **Older Perch**: the relay ships in this release and later. An older Assistant
  has no Relay section, and `perch relay` says "This Perch's Assistant has no
  relay support; update or restart Perch." A newer Assistant on a Perch that
  lacks the secrets and storage support it needs shows "The relay needs Perch
  0.9 or later." in the Relay section.
