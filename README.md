# denops

A local, single-user MCP server that exposes large external APIs to LLM agents using the **Code
Mode** pattern: instead of enumerating every API operation as an MCP tool, the server advertises
three tools — `search`, `execute`, `approve` — and the model writes JavaScript that runs in a
sandboxed worker against pre-authenticated, handle-based API clients.

## Architecture

```
Host (main isolate)                          MCP endpoint /mcp (streamable HTTP, loopback)
  connector registry  ──  harness  ──  approval queue
  connector clients hold ALL credentials     JSONL op log under data/runs/<runId>.jsonl
        │ postMessage { op, args, callId }
Guest (worker, deno permissions: "none")     fetch/WebSocket/Deno.* stubbed to throw
  model-written JS + handles: debug.* gitlab.* mistral.* mail.*   api.search/api.describe
```

Security invariants:

- Credentials never enter the worker isolate; workers only get opaque proxy handles.
- The only egress from a worker is the enumerated op channel; tier policy (`open` / `approval` /
  absent-by-omission) is enforced at the host message boundary.
- Every op call is appended to a per-run JSONL log, which doubles as the replay log for approval
  resumes.
- Ops whose results exceed 1 MB fail with a model-actionable error; runs are bounded by wall-clock
  and op-count budgets.
- The HTTP edge is hardened: constant-time bearer auth (auth required whenever a token is set;
  non-loopback binds without a token are refused), a request-body cap, `no-store`/`nosniff`/HSTS
  headers, and fail2ban-style source banning (see "Exposure & brute-force protection" below).

## Install & run

Requires Deno 2.x.

```bash
cp config.yaml.example config.yaml   # edit: enable connectors, budgets
cp secrets.json.example secrets.json # fill in tokens; chmod 600 secrets.json
deno task start                      # derives --allow-net from config, then runs the server
```

`deno task start` reads `config.yaml` and starts the server with a minimal permission allowlist:
`--allow-net=127.0.0.1:<port>,<enabled connector hosts>` plus read access to config/secrets and
write access to `data/` only. The server refuses to work without these.

Endpoint: `http://127.0.0.1:3100/mcp` (streamable HTTP, stateless). Health: `/health`.

## MCP client config (Vibe Code / any streamable-HTTP client)

```toml
[[mcp_servers]]
name = "denops"
transport = "streamable-http"
url = "http://127.0.0.1:3100/mcp"
```

If `server.token` is set in `config.yaml` (or `serverToken` in `secrets.json`, or `server.tokenFile`
points at a secret file), clients must send `Authorization: Bearer <token>`. The comparison is
constant-time. Binding to a **non-loopback** host without any token configured is refused at
startup; on loopback without a token the server starts with a loud warning (local dev only).

## Exposure & brute-force protection

The server is designed to sit behind **Caddy** (or another TLS-terminating proxy) on the same host,
bound to loopback. Failed bearer auth attempts are tracked per source **subnet** (IPv4 /24, IPv6
/64) **and** per IP: `server.ban.maxFailures` (default 5) failures within `server.ban.windowMs`
(default 10 min) ban that subnet/IP for `server.ban.durationMs` (default 24 h) — banned sources get
`429` with a `Retry-After` header, even if they later present the correct token. A successful auth
clears the failure counter but never lifts an active ban. Loopback peers are exempt by default
(`server.skipLoopbackBan`).

Bans live in memory unless `server.ban.file` is set; the file (`<expiry-unix> <subnet>` per line) is
written atomically, reloaded at startup, and **hot-reloaded when edited on disk** — truncate it to
reset all live bans without a restart. `server.ban.blacklistFile` / `server.ban.whitelistFile` are
hot-reloaded CIDR lists (one CIDR or bare IP per line, `#` comments): blacklisted IPs are always
rejected, whitelisted IPs are exempt from blacklist _and_ auto-bans. In-memory ban state is bounded
(100k entries, oldest evicted first) so rotating attackers can't exhaust memory.

Because the proxy terminates the connection, set `server.trustedProxy` (e.g. `127.0.0.1`) so the
real client IP is taken from `X-Forwarded-For` — specifically the **right-most entry that is not
itself a trusted proxy**, which is where Caddy appends the true peer. Requests from untrusted peers
ignore `X-Forwarded-For` entirely, so clients can't spoof their way out of a ban. Without this,
every request shares the proxy's address and one attacker would get the proxy itself banned.

### config.yaml reference (server block)

```yaml
server:
  host: 127.0.0.1
  port: 3100
  # token: ""            # or secrets.json serverToken, or tokenFile below
  # tokenFile: /run/secrets/denops_token
  # requireToken: true   # hard-fail startup if no token is configured
  # maxBodyBytes: 4194304  # request body cap (default 4 MiB)
  # trustedProxy: 127.0.0.1  # trust X-Forwarded-For from this CIDR/IP only
  # skipLoopbackBan: true    # loopback peers are never banned (default true)
  # ban:
  #   file: data/bans            # persist auto-bans; truncate to reset live
  #   blacklistFile: blacklist.txt
  #   whitelistFile: whitelist.txt
  #   maxFailures: 5
  #   windowMs: 600000
  #   durationMs: 86400000
```

### Recommended Caddy deployment

```Caddyfile
# /etc/caddy/Caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:3100 {
        transport http {
            read_timeout 360s   # long-running execute runs
        }
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options    "nosniff"
        Referrer-Policy           "no-referrer"
    }
    # defense-in-depth rate limit on top of the in-app subnet bans
    rate_limit {
        zone   mcp_per_ip 10r/s 100r/m
        key    {remote_host}
    }
}
```

Caddy appends the real client IP to `X-Forwarded-For` automatically — do **not** configure it to
overwrite the header. Keep `server.trustedProxy: 127.0.0.1` so denops attributes bans to the real
client. Avoid tunnel-style exposure (e.g. Tailscale Funnel): funnel traffic arrives from
loopback/relay addresses, so every public client shares one subnet and subnet banning can't tell an
attacker from legitimate traffic.

```yaml
# config.yaml (server block) behind Caddy on the same host
server:
  host: 127.0.0.1
  port: 3100
  tokenFile: /run/secrets/denops_token
  trustedProxy: 127.0.0.1
  skipLoopbackBan: true
  ban:
    file: data/bans
    blacklistFile: /etc/denops/blacklist
    whitelistFile: /etc/denops/whitelist
```

Put your expected client networks (e.g. the LLM provider's connector egress ranges) in the whitelist
so legitimate traffic is never banned; the auto-ban handles everything else.

## Tools

- `search(query, connector?)` — fuzzy-search the op discovery index.
- `execute(code, description?)` — run a JS async function body in a fresh worker. Inside the
  sandbox, connector handles are globals: `gitlab.issues.list({ projectId, state })`,
  `mistral.libraries.list()`, `debug.echo({...})`, plus `api.search(...)` / `api.describe(op)`.
- `approve(pendingId, "approve" | "reject")` — resolve a gated op. Approve replays the run
  deterministically from its op log and executes the approved op live; reject terminates the run
  (already-executed ops are not auto-undone — the log records the rejection).

## Connectors

- **debug** — `debug.echo`, `debug.boom`, `debug.gated` (approval) for smoke-testing.
- **gitlab** — read-only ops against a pinned origin (`https://gitlab.ebrains.eu/api/v4` by
  default): projects, repository files/tree/commits/branches, issues, MRs, users, groups. Token from
  `secrets.json` (`gitlab.token`); start with a `read_api` token.
- **mistral** — Libraries API (`/v1/libraries`, `/v1/libraries/{id}/documents`, upload via
  `/v1/files` + document creation; the API key stays host-side). Deletes are approval-tier. Also
  exposes `mistral.connectors.list` (beta Connectors API).
- **imap** (`mail.*`) — multi-account IMAP via `imapflow`: `mail.accounts`, `mail.mailboxes.list`,
  `mail.messages.list/search/get/getPart/flags.get`, `mail.drafts.save` (open — deliberate
  draft-not-send), `mail.messages.raw` (approval). One persistent connection per account, ops
  serialized per account via a host-side queue. Send is absent by omission (no SMTP in v1).

### fs (local filesystem, root-allowlisted)

Read/write/glob/exec against **named, allowlisted root directories** — for working on specific
repos/paths through the chat instead of SSH. The model addresses roots by name (`root: "myrepo"`),
never by absolute path; every path is resolved with symlink resolution and rejected if it escapes
the root (`..`, absolute paths, symlink escapes).

```yaml
connectors:
  fs:
    enabled: true
    roots:
      - name: myrepo
        path: /srv/repos/myrepo
        write: true # enables fs.write / fs.edit / fs.editRegex
        exec: true # enables fs.exec
```

Ops: `fs.roots` (open), `fs.glob`, `fs.list`, `fs.read` (line-windowed), `fs.write`, `fs.edit`
(unique-match), `fs.editRegex`, `fs.exec` (`sh -c` with cwd=root, **scrubbed environment** so no
process env/secrets leak into children, per-call timeout ceiling, output cap, whole-process-group
kill on timeout, concurrency limit).

**Grant model (no per-op approval spam):** the first `fs.*` op on a root is approval-tier; approving
it records a persistent **root grant** (`data/root_grants.json`, atomic write, survives restarts)
and every later `fs.*` op on that root — including writes and exec — runs open. List/revoke grants
with the `grants` tool (`grants({action:"list"})`, `grants({action:"revoke", key:"fs:myrepo"})`) or
by deleting the key from the file. `write`/`exec` additionally require the root to be configured
with `write: true` / `exec: true`, so a grant alone never exceeds the root's configured
capabilities.

`deno task start` derives Deno permissions from the configured roots: `--allow-read`/`--allow-write`
per root (write only for `write: true` roots) and `--allow-run=/bin/sh,/usr/bin/setsid,/bin/kill`
only when at least one root has `exec: true`.

### Mistral Vibe/Work connector startup check

Set in `config.yaml`:

```yaml
connectors:
  mistral:
    enabled: true
    startup:
      verifyKey: true # fail fast if the API key is invalid (GET /v1/models)
      checkVibeConnector:
        enabled: true
        name: denops # connector name registered in your workspace
        expectServerUrl: "" # optional expected MCP server URL
        strict: false # true = fail startup if missing/mismatched
```

On startup the server calls the experimental beta Connectors API (`GET /v1/connectors`) and verifies
that a connector with the given name exists and points at this server. Results are logged to stderr;
with `strict: false` (default) a mismatch is a warning, not fatal. The API key needs the connector
access scope ("Private and shared connectors" in Studio).

## Development

```bash
deno task pending data list                                  # list pending approvals
deno task pending data approve <pendingId> config.yaml secrets.json   # replay + execute live
deno task pending data reject <pendingId>                   # terminate + record rejection
deno task test    # unit + mock-API + MCP smoke tests (no live calls)
deno task smoke:live  # read-only live smoke per enabled connector (needs real secrets)
deno task check   # typecheck
deno task lint && deno fmt --check
```

Live smoke tests per connector are gated behind real credentials and intentionally not part of
`deno task test`.

## Layout

```
src/server.ts            entry: config load, validation, MCP endpoint, hardened HTTP edge
src/config.ts            config.yaml / secrets.json loading (minimal YAML subset parser)
src/security/            http.ts (bearer gate, body cap, headers) + ban.ts (fail2ban-style CIDR bans)
src/harness/             registry, boundary validation, worker sandbox, JSONL log, approvals, discovery
src/guest/bootstrap.ts   injected worker prelude (handles, fetch/Deno stubs)
src/connectors/<name>/  client.ts (host-only credentials) + manifest.ts (ops, tiers, docs)
scripts/start.ts         deno task start wrapper: builds --allow-net from config
config.yaml.example  secrets.json.example
```
