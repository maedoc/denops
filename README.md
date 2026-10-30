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

If `server.token` is set in `config.yaml` (and `serverToken` in `secrets.json`), clients must send
`Authorization: Bearer <token>`.

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
- **imap** — reserved (not yet implemented in this iteration).

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
deno task test    # unit + MCP smoke tests (mock/debug connector only)
deno task check   # typecheck
deno task lint && deno fmt --check
```

Live smoke tests per connector are gated behind real credentials and intentionally not part of
`deno task test`.

## Layout

```
src/server.ts            entry: config load, validation, MCP endpoint, tools
src/config.ts            config.yaml / secrets.json loading (minimal YAML subset parser)
src/harness/             registry, boundary validation, worker sandbox, JSONL log, approvals, discovery
src/guest/bootstrap.ts   injected worker prelude (handles, fetch/Deno stubs)
src/connectors/<name>/  client.ts (host-only credentials) + manifest.ts (ops, tiers, docs)
scripts/start.ts         deno task start wrapper: builds --allow-net from config
config.yaml.example  secrets.json.example
```
