# denops — agent skill sheet

How to drive this MCP server. Fetch it at runtime with `execute("return await denops.skill({});")`;
prefer this over guessing, and re-read it after any server upgrade.

<!--
MAINTENANCE: this file is the prompt-facing contract. Any change to an op, tier, capability, config
knob, deployment step or error contract updates it in the SAME change; `tests/skill_test.ts` fails
when it drifts (unknown ops, missing families/counts). Keep it under ~130 lines.
-->

## 1. What this server is

Code Mode: only four-ish tools exist (`search`, `execute`, `approve`, and `grants` when a filesystem
root is configured). Everything else is an **op** you call from JavaScript inside `execute`:

```js
// execute() runs the BODY of an async function; return JSON-serializable data
const projects = await forge.projects.list({ account: "ebrains", limit: 5 });
return projects.items.map((p) => p.fullName); // → ["group/project", …]
```

Ops are namespaced globals (`forge.*`, `mail.*`, `mistral.*`, `fs.*`, `web.*`, `deploy.*`);
there is no `tools` object. Credentials never enter the sandbox: ops are the only egress, and there
is no `fetch`, `WebSocket`, filesystem or `Deno` API (use `web.fetch` for URLs).

This is server-level context, not an op, but for completeness: MCP clients authenticate per the
MCP OAuth spec — `authorization_code` + PKCE via dynamic client registration (an interactive
consent gates issuance) or `client_credentials`, with discovery at
`/.well-known/oauth-authorization-server[/mcp]` and the token endpoint at `/oauth/token`.

## 2. Discovery (do this first, cheaply)

| call                                  | gives you                                       |
| ------------------------------------- | ----------------------------------------------- |
| `api.search("")`                      | the whole registry with per-connector counts    |
| `api.search("query", "forge")`        | ranked matches; wildcards (`*`) list everything |
| `api.describe("forge.issues.create")` | full doc: args **and** return shape             |
| `denops.skill({})`                    | this document                                   |

`search`/`describe` are also MCP tools; a query that matches nothing returns the inventory, so one
call always tells you what exists. `denops.version` says what is actually deployed.

## 3. Call conventions

- Write one `execute` that loops over ops rather than many round trips; budgets are per run (wall
  clock, op count, 1 MB per op result) and `denops.budget` reads what is left of them.
- **Summary projections** are the default for list/get ops: narrow with
  `fields: ["id", "namespace.full_path"]` (dotted paths, arrays shaped per element) or ask for the
  raw upstream object with `full: true`. Width matters: five raw GitLab projects ≈ 130 KB.
- Errors come back as `{ status: "failed", error }` with the message only (no stack). Invalid JS is
  reported as `SyntaxError` before a sandbox starts, with the received code's length and head/tail
  excerpt — if that is not the code you sent, the string was truncated in transit; retry the call.
  Upstream HTTP error bodies are propagated
  verbatim — read them, they usually name the offending field.
- Approval-tier ops return `{ status: "awaiting_approval", pendingId, op, seq, summary, args }`.
  Show `summary` to the user, then call `approve(pendingId, "approve")`. A run that contains several
  approval ops re-suspends at each one, each with its own `pendingId`; approving one never approves
  the rest. Rejecting terminates the run; nothing is rolled back.

## 4. Connector crib sheet

**forge** (27 ops) — one family over several code hosts. `forge.accounts` lists
`{id, flavor:
 gitlab|forgejo|github, origin}`; **every op takes `account`**. Neutral vocabulary:
`projects.*`, `issues.*` + `issues.notes.*`, `pulls.*` (merge requests; also `.changes.get`,
`.comment`, `.merge`), `repository.branches/commits/tree/files`, `users.*`, `orgs.list` (groups on
GitLab). Results are normalized, not upstream JSON (`number` not iid; `state: open|closed|merged`;
`merged`/`draft` booleans), so one call shape works on every account; writes are approval-tier. Long
tail: `forge.api.get({account, path, query?})` (open, pinned to that account's API root) is
content-type aware: parsed JSON for `application/json`, otherwise `{text, contentType, bytes,
truncated?}` — e.g. Forgejo Actions job logs, `GET /repos/o/r/actions/jobs/<id>/logs`, are
`text/plain` (text capped at 256 KiB, `bytes` is the full size). Forgejo's `q` matches repo names only — use `projects.get({repo:"o/r"})` for exact
lookups. Adapters: **gitlab**, **forgejo**, **github** (paging is a `Link` cursor there, file reads
use the raw media type, and search has its own smaller rate limit). The old
`gitlab.*` family is **gone** as of 0.8.0 — `forge.*` with `account: "ebrains"` is its replacement,
and results are now normalized, so `p.fullName` replaces `p.path_with_namespace`. Long tail:
`forge.api.get` (open) and `forge.mutate` (approval; POST/PUT/**PATCH**/DELETE) reach any
endpoint under that account's API root (both content-type aware); credential-bearing paths (`variables`, `*_tokens`,
`secure_files`) are refused before an approval is created.

**mail** (10 ops) — `mailboxes.list`, `messages.list`, `messages.search` (server-side IMAP;
`mailboxes: string[]` searches a folder tree in one call, each hit carrying its `mailbox`),
`messages.get`/`getPart`/`flags.get`, `drafts.save` (open — a draft, never a send), `messages.raw`
and `messages.move` (approval). No SMTP. `messages.get` splits headers from body (`body` only, plus
`messageId`, `inReplyTo`, `references[]`, `contentType`, `headers`), so threading is inspectable
without the raw source. `drafts.save({account, body, replyTo:{mailbox,uid}, …})` writes a **threaded
reply** — `Message-ID`/`In-Reply-To`/`References`/`Date`, `Re: <subject>`, quoted parent, APPEND
with `\Draft`; never compose those headers yourself. Optional `from` sets the draft's From:
allow-listed to the account's own address (default) or a config `aliases` entry — anything else is
an invalid-args error, and unknown arg names are errors too (not silently dropped).

**mistral** (17 ops) — libraries and documents, metadata first: `libraries.list` → `documents.list`
(rows carry `size`, `mime_type`, `process_status`) → then `documents.read` for small text (inline,
else `truncated: true`), `documents.get({fields:["summary"]})` for the extracted summary, or
`documents.stage` (→ `{root, path, absPath, bytes, mime, sha256}`) to hand `root`+`path` to
`fs.grep`/`fs.read`. Writing is text-first: `documents.put` creates, `documents.replace` replaces by
name (refuses if several share it — pass `documentId`), `documents.upload` takes base64,
`staging.clear({olderThanHours?})` prunes. Writes/deletes are approval-tier for libraries that
already existed; one created in the same run can be written and cleaned up freely. **fs** (10 ops) —
named roots only (`fs.roots` lists them): `glob`, `list`, `read` (line windows with `hasMore`),
`grep` (regex, capped), `write`, `edit`/`editRegex`, `rm`, `exec`.

- **Capabilities are enforced before approval**: a write to a `write: false` root (or exec on
  `exec: false`) fails `capability_denied` and creates **no** pending; paths are confined to the
  root.
- **Grants are levelled**: approving the first op on a root records `fs:<root>:read` or
  `fs:<root>:write` (implies read); `fs.rm`/`fs.exec` are never grant-covered.
  `grants({action, key})`. **denops** (6 ops) — `denops.skill` (this document; `{ section }`
  filters), `denops.about` (version, skill freshness, connector families, `degraded` + why),
  `denops.version` (version, commit, CHANGELOG head — check this, do not probe whether a fix
  deployed), `denops.budget` (wall clock and ops left in THIS run — call it before a long loop),
  `denops.oplog` (redacted run log: statuses and counts plus each run's `codeBytes` — the received
  code's byte size — no args or bodies). A non-empty
  `about().degraded` means that family failed its startup probe: only its ops fail, the server is up.

**calendar** (8 ops) — CalDAV (iCloud, Nextcloud). `calendar.accounts`, `calendar.calendars.list`
(says which collections hold VEVENT vs VTODO — event ops are VEVENT-only and refuse a VTODO one
instead of reporting it empty), `calendar.events.list({account, calendar, from, to, limit?})` —
window **required**, ≤ 366 days, because one calendar can exceed 1 MB and the server expands
recurrence — `calendar.events.get` (by uid; keep the returned `etag`), `calendar.events.search`.
Writes are approval-tier: `calendar.events.create` (`If-None-Match: *`), `calendar.events.update`
and `calendar.events.delete` (both need the current `etag`; a stale one is refused, never
overwritten; update is read-modify-write so `VALARM`/vendor props survive).
`reminders: [{ minutesBefore, description? }]` sets DISPLAY alarms on create/update (positive =
before the start; `events.get` returns them; an update replaces DISPLAY alarms only).
**ATTENDEE/ORGANIZER and EMAIL alarms are refused**: iCloud auto-schedules and would send real mail.

**dav** (21 ops) — WebDAV files; `nextcloud: true` adds the trash/version trees. `dav.accounts` gives each `shareRoot` and why it is read-only if
it is; every op takes `path` relative to it ("" = root, no "/" or ".." prefix) and returns that form. Reads: `dav.list` (depth 1; `offset`/`nextOffset` page it), `dav.stat` (fresh
`etag`), `dav.get` (text only, 64 KiB default — **binary refused → `dav.stage`**),
`dav.find({pattern})` (parallel bounded walk; `stoppedBy`/`resumeFrom` say what it never reached),
`dav.grep({pattern, namePattern?})` (which files *mention* it — literal, bounded, counts what it
skipped), `dav.get` windows (`offset` → `nextOffset`), `dav.quota`, `dav.stage`/`dav.staging.clear`
(bytes onto the host: `staged` for `putStaged`, `fsRoot`+`path` for `fs.read`). On a Nextcloud
account: `dav.trash.list`/`restore`/`purge` (a delete is recoverable) and
`dav.versions.list`/`restore` (the bytes an overwrite replaced; restore keeps the current content). Writes are approval: `dav.edit({path, append?, prepend?, replace?})`
is read-modify-write in **one** call, and its write carries the etag of the read it just made
(literal `replace`; no match is an error unless that entry is `optional`); then `dav.put({path, text,
overwrite?, ifMatch?})`, `dav.putStaged`, `dav.mkdir`, `dav.move`, `dav.copy`, `dav.delete` (a
directory needs `recursive: true`; no grant covers it). **Create-only by default**
(`If-None-Match: *`): a 412 means re-read, or pass `overwrite: true` — which reports what it
replaced. Read-only accounts are refused before approval.

**web** (1 op) — `web.fetch({url, format?:"text"|"html", maxBytes?})`: one http(s) document as text
(HTML converted best-effort, no JS) or raw markup. Only hosts in the live config's `allowedHosts`
are reachable; private/loopback/link-local addresses are refused (SSRF guard) and redirects are
re-validated. A refused host is a config question for the operator, not something to work around.

**deploy** (3 ops) — ship this server's own code. Development happens on the laptop, never on the
server: edit there, run the gate (`deno task gate`), push `origin main`. Then
`deploy.status` (open: live commit, desired, last-good, origin/main, pending commits,
restart-pending), `deploy.promote` (approval: fetches origin/main, refuses a non-fast-forward,
runs the test suite in a throwaway worktree under the service's data dir, records intent),
`deploy.rollback({commit?})` (approval: last-good or an explicit sha). The supervisor — not the
op — checks out the commit, probes `/health`, soaks 60 s, advances `main`, and auto-reverts on
failure. There is no agent-writable code checkout on the server and no op that runs arbitrary
argv.

## 5. Error and approval semantics worth remembering

- `capability_denied:` — immutable config says no; don't retry, don't ask for approval.
- `invalid args for <op>: <field>: …` — the boundary rejected you; fix the argument, no approval.
- `unknown or unavailable op` — use `api.search`; the op may belong to a disabled connector.
- Approval summaries are written by the connector (commit subject + diffstat for deployments,
  mailbox/uids for moves). Quote them: they are the human's only view.

## 6. Ground rules

One user, one identity: you act with their credentials. Prefer read ops, batch work into one
`execute`, ask for approval rather than working around a gate. Never paste credentials into
`execute` output. Missing something? `api.search` first, then say what you need — the operator can
add an op.
