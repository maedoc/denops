# denops

A local, single-user MCP server that exposes large external APIs to LLM agents using the **Code
Mode** pattern: instead of enumerating every API operation as an MCP tool, the server advertises
`search`, `execute`, `approve` (plus `grants` when a filesystem root is configured) and the model
writes JavaScript that runs in a sandboxed worker against pre-authenticated, host-side API clients.

It ships with connectors for GitLab, IMAP mail, Mistral libraries, the local filesystem, and — for
this deployment — a narrow "dev/deploy" surface that lets an agent improve the server's own code
without a shell, with an approval-gated, auto-reverting deployment pipeline.

---

## Architecture

```
Host (main isolate)                            MCP endpoint /mcp (streamable HTTP, loopback)
  connector registry ── harness ── approval queue
  connector clients hold ALL credentials       JSONL op log under data/runs/<runId>.jsonl
        │ postMessage { op, args, callId }
Guest (worker, deno permissions: "none")       fetch/WebSocket/Deno.* stubbed
  model-written JS + handles: debug.* gitlab.* mail.* mistral.* fs.* dev.* deploy.*
```

Security invariants:

- Credentials never enter the worker isolate; workers only get opaque proxy handles.
- The only egress from a worker is the enumerated op channel; tier policy (`open` / `approval` /
  absent-by-omission) is enforced at the host message boundary, **per op call** (see Approvals).
- Every op call is appended to a per-run JSONL log, which doubles as the replay log for approval
  resumes.
- Results larger than 1 MB fail the op; runs are bounded by wall-clock and op-count budgets.
- The HTTP edge is hardened: constant-time bearer auth, a request-body cap, `no-store`/`nosniff`/
  HSTS/referrer-policy headers, fail2ban-style source banning, and (optionally) static-client OAuth
  with OIDC discovery.
- Errors cross the sandbox boundary as `name: message` only — no stacks, no sandbox internals.

---

## Install & run

Requires Deno 2.x and (for exec) Linux `setsid`.

```bash
cp config.yaml.example config.yaml     # edit: enable connectors, budgets
cp secrets.json.example secrets.json   # fill in tokens; chmod 600 secrets.json
deno task start                        # derives --allow-* from config, then runs the server
```

`deno task start` reads `config.yaml`, spawns the server with a minimal permission set derived from
the _enabled connectors only_ (`--allow-net` per origin, `--allow-read`/`--allow-write` per
filesystem/dev root, `--allow-run` only for `fs.exec` and the `dev`/`deploy` task tables), and logs
the derived allowlist at startup. Adding or removing roots therefore requires a restart.

Endpoints: `http://127.0.0.1:3100/mcp` (streamable HTTP, stateless), `GET /health`.

### Running under systemd (this deployment)

`deploy/denops.service` runs `scripts/live-supervisor.sh` as user `freebox`:

```bash
sudo cp deploy/denops.service /etc/systemd/system/denops.service
sudo systemctl daemon-reload && sudo systemctl enable --now denops
journalctl -fu denops
```

---

## Authentication

### Bearer token

If `server.token` is set in `config.yaml` (or `serverToken` in `secrets.json`, or `server.tokenFile`
points at a secret file), clients must send `Authorization: Bearer <token>`. Comparison is
constant-time. Binding to a non-loopback host without a token is refused at startup.

### OAuth (clients that only speak OAuth)

`server.oauth` serves a **static-client** authorization surface; the client secret _is_ the bearer
token, and `/oauth/token` hands that same value back as the access token, so `/mcp` keeps validating
one value:

| endpoint                                      | purpose                                                         |
| --------------------------------------------- | --------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource`   | RFC 9728 resource metadata                                      |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata                                            |
| `GET /.well-known/openid-configuration`       | OIDC-style discovery (clients that ignore RFC 8414)             |
| `GET /.well-known/jwks.json`                  | empty key set — no `id_token` is issued                         |
| `POST /register`                              | RFC 7591 dynamic client registration (public client, PKCE only) |
| `GET/POST /authorize`                         | consent page; requires the access token to be pasted in         |
| `POST /oauth/token`                           | `client_credentials` **or** `authorization_code` + PKCE (S256)  |

```yaml
server:
  oauth:
    clientId: mistral # the single pre-registered client
    publicUrl: https://mcp.example.com # default: request Host
    ttlSec: 3600 # advisory expires_in
    redirectHosts: [...] # default: Google/Anthropic/OpenAI redirecters + loopback
```

Deliberate limits: one identity, no refresh tokens, no `id_token`, `expires_in` advisory, access
token == client secret. `/authorize` never auto-approves: whoever completes it must paste the access
token, and codes are single-use, 5-minute, bound to client + exact redirect URI + PKCE challenge.
`/mcp` 401s advertise `resource_metadata="…"` so spec-aware clients start the flow. Token-endpoint
failures feed the same bans as bad bearer tokens.

---

## Exposure & brute-force protection

The server is designed to sit behind **Caddy** (or another TLS-terminating proxy) on the same host,
bound to loopback. Failed auth attempts are tracked per source subnet (IPv4 `/24`, IPv6 `/64`)
**and** per IP: `server.ban.maxFailures` (default 5) within `server.ban.windowMs` (10 min) bans that
subnet/IP for `server.ban.durationMs` (24 h); banned sources get `429 + Retry-After` even with a
correct token. A success clears the failure counter but never lifts an active ban. Loopback peers
are exempt by default (`server.skipLoopbackBan`).

With a proxy in front, set `server.trustedProxy: 127.0.0.1` so the real client IP is taken from
`X-Forwarded-For` — specifically the **right-most entry that is not itself a trusted proxy** (where
Caddy appends the true peer). Requests from untrusted peers ignore the header, so clients cannot
spoof their way out of a ban.

Reference Caddyfile (no `header` block: the app sets HSTS/nosniff/no-store/referrer-policy, and
Caddy would append duplicates):

```caddyfile
wdmn.example.org {
	reverse_proxy 127.0.0.1:3100 {
		transport http { read_timeout 360s }
		flush_interval -1          # MCP replies with text/event-stream
	}
	log { output stderr format console }
}
```

Bans live in memory unless `server.ban.file` is set (`<expiry-unix> <subnet>` per line, written
atomically, hot-reloaded when its mtime/size changes — truncate it to reset live bans).
`blacklistFile`/`whitelistFile` are hot-reloaded CIDR lists; whitelisted sources are exempt from
blacklists _and_ auto-bans (use it for legitimate client egress ranges, e.g. an LLM provider).

---

## Code mode contract

Tools: `search(query, connector?)`, `execute(code, description?)`, `approve(pendingId, decision)`,
and `grants(action, key?)` when a `fs` root is configured. The MCP `initialize` result also carries
an agent-oriented guide (`instructions`, see `src/guide.ts`).

`execute` runs the **body of an async function** in a fresh worker:

```js
const p = await gitlab.projects.list({ perPage: 5 });
return p.map((x) => x.path_with_namespace);
```

- Ops are namespaced globals (`gitlab.*`, `mail.*`, `mistral.*`, `fs.*`, `dev.*`, `deploy.*`), plus
  `api.search(query, connector)` and `api.describe(op)` **inside** the sandbox. There is no `tools`
  object; `Object.keys(globalThis)` is not the registry.
- No `fetch`, `WebSocket`, `XMLHttpRequest`, filesystem or `Deno` APIs in the sandbox. Inert Deno
  data (`noColor`, `build`, `version`, `pid`) is readable so library internals don't explode.
- Prefer one `execute` that loops over ops to many round trips.

Discovery: `api.search("")` lists the registry with per-connector counts; `api.search("*")` and
other wildcards list everything; a query that matches nothing returns the inventory rather than a
dead end; `api.describe(op)` gives the doc, including argument and return shapes.

### Payload shaping

List/get ops return **summary projections** by default (GitLab objects are ~4 KB each; five projects
were 130 KB). Narrow with `fields: ["id","namespace.full_path"]` (dotted paths, arrays shaped per
element) or ask for the raw object with `full: true`. Shaped ops say so in their doc line.

### Approvals

Ops marked `[approval]` suspend the run and return
`{ status: "awaiting_approval", pendingId, op, seq, summary, args }`. `summary` is connector-written
(e.g. "Ship 6182f6c… : \"fix: …\" / 1 file changed / files: src/server.ts"), so a human sees _what
will happen_. `approve(pendingId, "approve")` replays the run deterministically from its log and
executes that one op live; `"reject"` terminates it.

Replay is keyed by the op's **call index**, not its name: a run with three approval ops asks three
times, each call executes once, and approving one never approves the rest. A replayed run that hits
another approval op returns that op's new `pendingId`.

### Errors and limits

Failures return `{ status: "failed", error }` with the message only. Invalid JavaScript is reported
as `SyntaxError` before a sandbox starts (and cannot take the server down); invalid arguments are
rejected at the host boundary with the offending field named; upstream HTTP error bodies are
propagated verbatim (e.g. FastAPI's `422 … loc ['file','file']`), which is what makes one-shot
diagnosis possible.

Budgets per run: `budgets.wallClockMs` (default 120 s), `maxOpsPerRun` (200), `maxOpResultBytes` (1
MB), `maxOpArgsBytes`, `maxLogBytes`.

---

## Connectors

Enable in `config.yaml`; every connector's ops appear in `search` and are tiered individually.

### debug (3 ops) — smoke tests

`debug.echo`, `debug.boom`, `debug.gated` (approval-tier: exercises the approval round trip).

### gitlab (27 ops) — read + write, curated and generic

| group         | ops                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| projects      | `projects.list`, `projects.get`, `projects.search`, `projects.create` _(approval)_, `projects.update` _(approval)_                                                          |
| issues        | `issues.list` (defaults `state: opened`), `issues.get`, `issues.notes.list`, `issues.create` _(approval)_, `issues.update` _(approval)_, `issues.notes.create` _(approval)_ |
| MRs           | `mergeRequests.list`, `mergeRequests.get`, `mergeRequests.changes.get`, `mergeRequests.create` _(approval)_, `mergeRequests.comment` _(approval)_                           |
| repo          | `repository.files.get`, `repository.files.create` _(approval)_, `repository.tree.list`, `repository.commits.list`, `repository.branches.list`                               |
| people/groups | `users.current`, `users.get` (exact username), `users.search` (fuzzy — prefer `users.get` for `assignee_ids`), `groups.list`                                                |
| generic       | `gitlab.get({path, query?})` (open, any GET under `/api/v4`), `gitlab.mutate({method, path, query?, body?})` _(approval)_                                                   |

Generic ops resolve against the pinned origin and API root (no scheme/host/`..`/`//`/whitespace),
validate `query`/`body`, and refuse credential-bearing reads (`variables`, `*_tokens`,
`secure_files`, `identities`, …). Issue write ops accept `assignee_ids`, `due_date` (`YYYY-MM-DD`),
`labels` and `milestone_id`.

### imap (10 ops) — mail, read-only plus drafts

`mail.accounts`, `mail.mailboxes.list`, `mail.messages.list` (newest-first,
`{mailbox,total,page,limit,messages[]}`), `mail.messages.search` (server-side IMAP SEARCH, returns
`{mailbox,count,messages[{uid,subject,from,date,flags}]}` — envelopes included),
`mail.messages.get`, `mail.messages.getPart`, `mail.messages.flags.get`, `mail.drafts.save` (open —
deliberate draft-not-send), `mail.messages.raw` _(approval)_, `mail.messages.move` _(approval,
cross-account SHA-256 verified copy-then-expunge)_. No SMTP: send is absent by omission.

Background connection errors (socket inactivity, server BYE, dropped tunnel) are absorbed: the
account marks itself disconnected and reconnects on the next op, instead of taking the process down.

### mistral — Libraries API (15 ops)

Read, and _write knowledge back_:

| group     | ops                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| libraries | `libraries.list`, `libraries.get`, `libraries.create`, `libraries.delete` _(approval)_, `libraries.share`/`unshare` _(approval)_, `libraries.shares.list`         |
| documents | `documents.list`, `documents.get`, `documents.read`, `documents.stage`, `documents.put`, `documents.replace`, `documents.upload`, `documents.delete` _(approval)_ |
| workspace | `connectors.list`, `connectors.get`, `models.list`                                                                                                                |

Reading is staged in two steps because documents have no `/content` endpoint:

1. **metadata first** — `documents.list`/`documents.get` return summaries carrying `size`,
   `mime_type`, `process_status` and the extracted `summary` (ask for it with
   `fields: ["name","size","summary"]`). A 553 KB PDF is 627 characters of summary, so an agent can
   often answer without downloading.
2. **then decide** — `documents.read` returns text inline for `text/*`-ish types up to
   `inlineReadMaxBytes` (default 64 KiB) and _refuses binary_ with guidance; `documents.stage`
   downloads any document (via `GET .../documents/{id}/signed-url`, fetched **without** the API key)
   into `stagingRoot`, returning `{ path, bytes, mime, sha256 }`. That directory is exposed as the
   read-only `denops-stage` fs root, so `fs.grep`/`fs.read` can work through it.

Writing takes text, not base64: `documents.put({libraryId, fileName, text, contentType?})`;
`documents.replace` is **replace-by-name** (the oldest document with that name is deleted and
re-uploaded, or a new document is created), which is how a canvas accumulates revisions.
`documents.upload` remains for base64 payloads. Uploads are a single multipart POST to
`/libraries/{id}/documents` — the Files API (`/files`) is a different surface that requires a
`purpose` and rejects document payloads.

```yaml
connectors:
  mistral:
    enabled: true
    stagingRoot: /home/freebox/denops-stage # also a read-only fs root
    inlineReadMaxBytes: 65536
```

Uploads/overwrites are open for now (a deliberate decision); deletes are approval-tier unless the
library was created earlier in the same run, which is tracked in the run state.

### fs — local filesystem, root-allowlisted

Read/write/glob/exec against **named, allowlisted root directories**. The model addresses roots by
name (`root: "denops-dev"`), never by absolute path; every path is resolved with symlink resolution
and rejected if it escapes the root (`..`, absolute paths, symlink escapes — a `secrets.json`
symlink inside a root is refused).

```yaml
connectors:
  fs:
    enabled: true
    roots:
      - name: denops-dev
        path: /home/freebox/denops-dev
        write: true # enables fs.write / fs.edit / fs.editRegex
        exec: false # see "no shell" below
```

Ops: `fs.roots` (open), `fs.glob`, `fs.list`, `fs.read` (line-windowed:
`{content, offset,
returnedLines, totalLines, hasMore}`), `fs.write`, `fs.edit` (unique match),
`fs.editRegex`, `fs.exec` (`sh -c`, cwd=root, scrubbed env, per-call timeout ceiling, output cap,
whole-process-group kill on timeout, concurrency limit).

**Grant model:** the first `fs.*` op on a root is approval-tier; approving it records a persistent
root grant (`data/root_grants.json`, atomic, survives restarts) and later ops on that root run open.
`write`/`exec` also require the root to be configured accordingly, so a grant never exceeds the
root's capabilities. Manage with `grants({action:"list"|"revoke", key:"fs:denops-dev"})`.

**No shell by default.** `fs.exec` is off in this deployment: it runs with the service user's full
authority, so it can read secrets regardless of the root. Instead, code work goes through `dev`.

### dev (4 ops) — work on code without a shell

```yaml
connectors:
  dev:
    enabled: true
    roots:
      - name: denops-dev
        path: /home/freebox/denops-dev
        tasks: # argv tables, never a shell
          check: [deno, check, src/server.ts, tests/]
          test: [deno, task, test]
          fmt: [deno, fmt, src/, tests/, scripts/]
```

| op                                  | tier                          | does                                                                       |
| ----------------------------------- | ----------------------------- | -------------------------------------------------------------------------- |
| `dev.roots`                         | open                          | configured roots + task names                                              |
| `dev.run({root, task})`             | open                          | runs one declared task; returns `{code, stdout, stderr}`                   |
| `dev.git({root, action, message?})` | `commit` = approval           | `status`, `diff`, `log`, `commit -am "<msg>"` — no model-supplied flags    |
| `dev.try({root, op, args})`         | open (open-tier targets only) | runs one op from the **dev checkout's own registry** against the real APIs |

`dev.try` refuses approval-tier ops: those are exercised by promoting. Every call is logged.

### deploy (3 ops) — intent for the supervisor

| op                           | tier     | does                                                                                                        |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `deploy.status`              | open     | live/main/desired/last-good/dev shas, ahead/behind, dirty flags, restart pending, recent audit              |
| `deploy.promote`             | approval | checks the dev tree is clean, runs the dev root's `test` task, records `desired-commit`, requests a restart |
| `deploy.rollback({commit?})` | approval | same, to `last-good` or an explicit sha from the audit log                                                  |

`deploy` never runs the server; the supervisor does.

---

## Deployment & supervision

`scripts/live-supervisor.sh` is the only thing that decides which commit runs:

```
data/desired-commit   commit to run (written by deploy.promote / deploy.rollback)
data/last-good        last commit that started, answered /health, and survived the soak
data/restart-request  written by the deploy connector to request a restart
data/deploy.jsonl     append-only audit: promote-test, promote, soak-ok, main-advanced, rollback,
                      auto-revert (with reason), crash
```

Each start: `git checkout --detach <desired>` → `deno cache src/server.ts` → start `deno task start`
(setsid, so the whole group is signalled) → require `GET /health` within 25 s → soak 60 s. Failures
before the soak revert `desired-commit` to `last-good` automatically and log `auto-revert` with a
reason (`checkout`, `deno-cache`, `startup`, `crash`). Crashes _after_ the soak restart the same
commit with backoff; too many consecutive failures exit so systemd backs off.

`main` is advanced to a commit **only after it passes the soak** (and only if it descends from
`main`), so a failed promotion never lands on the branch a later promotion fast-forwards from.
Because the live checkout runs detached, updating the live tree is done through the dev branch and
`deploy.promote`, not `git pull` in `~/denops`.

Rehearsed on the live deployment: healthy promote (soak → last-good → main advanced), a commit that
passed 92 tests but threw at startup (auto-revert in ~2 s, main untouched), recovery by reverting
the break, and an explicit rollback to a previous sha.

---

## Agent workflow (dev loop)

1. `dev.roots` / `deploy.status` — see the worktree, tasks, and what is live.
2. `fs.glob` / `fs.read` — read code in `~/denops-dev`.
3. `fs.write` / `fs.edit` / `fs.editRegex` — add an op (e.g. a new `gitlab.*`), with a test.
4. `dev.run({task:"check"})`, `dev.run({task:"test"})` — iterate until green.
5. `dev.try({op:"gitlab.x.y", args:{…}})` — exercise the new op against the real API.
6. `dev.git({action:"commit", message:"…"})` — approval.
7. `deploy.promote` — approval; the supervisor restarts, probes, soaks, and either promotes
   (`last-good`, `main` advanced) or auto-reverts. `deploy.status` shows what happened.

Secrets live outside the agent's root (`~/denops/secrets.json`), and the dev worktree's
`secrets.json` is a symlink to it — refused by `fs.read` as a root escape.

---

## MCP client configuration

```toml
[[mcp_servers]]
name = "denops"
transport = "streamable-http"
url = "https://mcp.example.com/mcp"
# bearer clients:
# headers = { Authorization = "Bearer <token>" }
```

OAuth-only clients can be pointed at the same URL with no header: they discover the metadata,
register (or use the pre-registered `clientId`), and complete the consent page by pasting the access
token.

---

## Operations runbook

| task                           | command                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| logs                           | `journalctl -fu denops` (supervisor + server + access panels)                                               |
| deploy state                   | `deploy.status` op, or `cat ~/denops/data/{desired-commit,last-good}`, `tail data/deploy.jsonl`             |
| roll back                      | `deploy.rollback` op (approval); or `printf '<sha>\n' > data/desired-commit` + touch `data/restart-request` |
| reset bans                     | `: > data/bans` (hot-reloaded)                                                                              |
| exempt a range                 | append CIDR to `data/whitelist` (hot-reloaded)                                                              |
| rotate the token               | update `secrets.json` `serverToken`, restart; clients (incl. OAuth `client_secret`) use the new value       |
| typecheck / test               | `deno task check`, `deno task test` (mock HTTP + MCP smoke; no live calls)                                  |
| live smoke                     | `deno task smoke:live` (read-only, needs real credentials)                                                  |
| pending approvals from the CLI | `deno task pending data list`, `… approve <id> config.yaml secrets.json`, `… reject <id>`                   |

---

## Testing

`deno task test` runs unit, mock-API (a local HTTP server standing in for GitLab/Mistral), MCP smoke
(buildApp + real streamable-HTTP request/response), security (bans, headers, gate), OAuth (both
flows), and hermetic dev/deploy rehearsals in throwaway git repos — no network, no real credentials.
`DENOPS_ALLOW_MOCK_ORIGIN=1` is set by the task so the Mistral client accepts a mock origin.

Lint and format: `deno lint src tests scripts`, `deno fmt`.

---

## Lessons learned (each of these was a live bug)

- **`kill -KILL -<pid>` is not portable.** procps-ng's `kill` (Ubuntu) truncates multi-digit
  negative PIDs to their first digit, so `kill -KILL -19567` became `kill(-1, SIGKILL)` — it killed
  the login session, not the process group. Always pass `--`, prefer in-process `Deno.kill`, and
  never signal a pid you didn't validate.
- **Replay state must be keyed by call, not op name.** Keying by op name made three `issues.create`
  calls share one result and one approval.
- **An unparsable worker module is fatal.** A guest syntax error surfaced as "Uncaught (in promise)
  Error: Unhandled error in child worker" and killed the server; parse the guest in the host first
  and keep a narrow `unhandledrejection` guard.
- **Unhandled `'error'` events are fatal.** imapflow's 5-minute socket timeout took the whole
  process down; the connector now handles `error`/`close` and reconnects lazily.
- **Sandbox errors must not carry stacks.** Frames pointed into the injected prelude's `data:` URL
  (the whole sandbox source). Guest code now loads from a `blob:` URL and errors cross the boundary
  as `name: message`.
- **Deno denies `/proc/<pid>/stat` without `--allow-all`**, so a `/proc`-based guard silently
  degrades under a scoped `--allow-run`; rely on structural guarantees instead.
- **Caddy appends response headers.** Setting HSTS/nosniff on both sides duplicated them; the app
  owns them.
- **`--allow-run` scoping matters.** `Deno.kill` needs an unscoped `--allow-run`; `proc.kill` works
  for your own children. `fs.exec` also needs `/usr/bin/setsid` and `/bin/kill` allowed.
- **systemd starts services with a minimal PATH** — the supervisor must add `~/.deno/bin`.
- **mtime is too coarse for hot-reload** — two edits in the same millisecond share an mtime; hot
  reload keys on `mtime:size`.
- **Fuzzy search looks like a small registry.** `search` silently capped at 20 with no totals, and a
  miss said "no matching ops"; both now report the true size and show the inventory.

---

## Layout

```
src/server.ts              entry: config load, MCP endpoint, tools, connector wiring
src/config.ts              config.yaml / secrets.json loading (minimal YAML subset incl. scalar lists)
src/security/              http.ts (gate, bans, headers), ban.ts (CIDR bans), oauth.ts (static-client AS)
src/harness/               registry, boundary validation, worker sandbox, JSONL log, approvals, discovery
src/guest/bootstrap.ts     injected worker prelude (handles, stub surface, error boundary)
src/guide.ts               agent-oriented `instructions` returned at initialize
src/connectors/<name>/     client.ts (host-only credentials) + manifest.ts (ops, tiers, docs)
scripts/start.ts           derives Deno permissions from config, then runs the server
scripts/live-supervisor.sh the only thing that decides which commit runs (restart/soak/auto-revert)
scripts/dev_try.ts         runner behind dev.try (one op from a checkout's own registry)
scripts/pending.ts         CLI for pending approvals
deploy/denops.service      systemd unit for the supervisor
tests/                     unit, mock-API, MCP smoke, security, OAuth, dev/deploy rehearsals
```

## Limits and non-goals

Single user, single identity. No per-op RBAC, no multi-tenant isolation, no SMTP send, no `fs.exec`
by default, no shell in the sandbox, no id_tokens (the OAuth surface exists to satisfy clients that
demand OAuth, not to federate identities). Rollback restores code, not `data/` — keep on-disk
formats backward compatible or migrate additively.
