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
const projects = await gitlab.projects.list({ perPage: 5 });
return projects.map((p) => p.path_with_namespace); // → ["group/project", …]
```

Ops are namespaced globals (`gitlab.*`, `mail.*`, `mistral.*`, `fs.*`, `web.*`, `dev.*`,
`deploy.*`); there is no `tools` object. Credentials never enter the sandbox: ops are the only
egress, and there is no `fetch`, `WebSocket`, filesystem or `Deno` API (use `web.fetch` for URLs).

## 2. Discovery (do this first, cheaply)

| call                                   | gives you                                       |
| -------------------------------------- | ----------------------------------------------- |
| `api.search("")`                       | the whole registry with per-connector counts    |
| `api.search("query", "gitlab")`        | ranked matches; wildcards (`*`) list everything |
| `api.describe("gitlab.issues.create")` | full doc: args **and** return shape             |
| `denops.skill({})`                     | this document                                   |

`search`/`describe` are also MCP tools; a query that matches nothing returns the inventory, so one
call always tells you what exists. `denops.version` says what is actually deployed.

## 3. Call conventions

- Write one `execute` that loops over ops rather than many round trips; budgets are per run (wall
  clock, op count, 1 MB per op result) and `denops.budget` reads what is left of them.
- **Summary projections** are the default for list/get ops: narrow with
  `fields: ["id", "namespace.full_path"]` (dotted paths, arrays shaped per element) or ask for the
  raw upstream object with `full: true`. Width matters: five raw GitLab projects ≈ 130 KB.
- Errors come back as `{ status: "failed", error }` with the message only (no stack). Invalid JS is
  reported as `SyntaxError` before a sandbox starts. Upstream HTTP error bodies are propagated
  verbatim — read them, they usually name the offending field.
- Approval-tier ops return `{ status: "awaiting_approval", pendingId, op, seq, summary, args }`.
  Show `summary` to the user, then call `approve(pendingId, "approve")`. A run that contains several
  approval ops re-suspends at each one, each with its own `pendingId`; approving one never approves
  the rest. Rejecting terminates the run; nothing is rolled back.

## 4. Connector crib sheet

**gitlab** (27 ops) — `projects.*`, `issues.*`, `mergeRequests.*`, `repository.*`, `users.*`,
`groups.list`. Writes are approval-tier. `issues.list` defaults to `state: "opened"`; issue writes
accept `assignee_ids`, `due_date` (`YYYY-MM-DD`), `labels`, `milestone_id`. For assignees use
`users.get({ username })` (exact) — `users.search` is a substring match and returns near-matches.
Anything without a curated op: `gitlab.get({ path, query? })` (open) and
`gitlab.mutate({ method, path, body? })` (approval) reach the rest of `/api/v4`; paths are relative
to the pinned origin, and credential-bearing reads (`variables`, `*_tokens`, `secure_files`) are
refused.

**mail** (10 ops) — `mailboxes.list`, `messages.list`, `messages.search` (server-side IMAP;
`mailboxes: string[]` searches a folder tree in one call and each hit carries its `mailbox`),
`messages.get`/`getPart`/`flags.get`, `drafts.save` (open — draft, never send), `messages.raw` and
`messages.move` (approval). No SMTP. `messages.get` splits headers from body: `body` is the body
only, plus `messageId`, `inReplyTo`, `references[]`, `contentType`, `headers` — inspect threading
without the raw source.
`drafts.save({account, body, replyTo:{mailbox,uid}, includeQuote?, subject?, to?})` makes the draft
a **threaded reply**: the server writes `Message-ID`/`In-Reply-To`/`References`/`Date`/
`MIME-Version`, defaults `Re: <parent subject>` + parent `From`, quotes the parent, APPENDs with
`\Draft`. Never compose those headers yourself. **mistral** (17 ops) — libraries and documents,
metadata first: `libraries.list` → `documents.list` (rows carry `size`, `mime_type`,
`process_status`) → then `documents.read` for small text (inline, else `truncated: true`),
`documents.get({fields:["summary"]})` for the extracted summary, or `documents.stage` (→
`{root, path, absPath, bytes, mime, sha256}`) to hand `root`+`path` to `fs.grep`/`fs.read`. Writing
is text-first: `documents.put` creates, `documents.replace` replaces by name (refuses if several
share it — pass `documentId`), `documents.upload` takes base64, `staging.clear({olderThanHours?})`
prunes. Writes/deletes are approval-tier for libraries that already existed; one created in the same
run can be written and cleaned up freely. **fs** (10 ops) — named roots only (`fs.roots` lists
them): `glob`, `list`, `read` (line windows with `hasMore`), `grep` (regex, capped), `write`,
`edit`/`editRegex`, `rm`, `exec`.

- **Capabilities are enforced before approval**: a write to a `write: false` root (or exec on
  `exec: false`) fails `capability_denied` and creates **no** pending; paths are confined to the
  root.
- **Grants are levelled**: approving the first op on a root records `fs:<root>:read` or
  `fs:<root>:write` (implies read); `fs.rm`/`fs.exec` are never grant-covered.
  `grants({action, key})`. **denops** (5 ops) — `denops.skill` (this document; `{ section }`
  filters), `denops.about` (version, skill freshness, connector families), `denops.version`
  (version, commit, CHANGELOG head — check this instead of probing whether a fix deployed),
  `denops.budget` (remaining wall clock and op count for THIS run — call it before long loops or
  multi-step writes), `denops.oplog` (read-only, redacted run log: recent runs, their ops, statuses,
  approval/error counts; no args, no result bodies).

**web** (1 op) — `web.fetch({url, format?:"text"|"html", maxBytes?})`: one http(s) document as text
(HTML converted best-effort, no JS) or raw markup. Only hosts in the live config's `allowedHosts`
are reachable; private/loopback/link-local addresses are refused (SSRF guard) and redirects are
re-validated. A refused host is a config question for the operator, not something to work around.

**dev** (4 ops) / **deploy** (3 ops) — work on this server's own code without a shell: `dev.roots`,
`dev.run({root, task})` (`check`/`test`/`fmt`/`lint`… argv from config, no shell; returns
`{code, stdout, stderr, sha, dirty}` and records the outcome against the current **tree**, by exit
code and tree identity, never by output), `dev.git({root, action, message?})`,
`dev.try({root, op, args})` (one **open-tier** op from the dev checkout's own registry, against the
real APIs), `deploy.status`, `deploy.promote` (approval: runs the test task, records intent),
`deploy.rollback({commit?})`. `dev.try` runs **committed, checked code only** — a dirty tracked tree
is refused and the root's `check` must have passed for this tree — inside a pinned child (read =
checkout + secrets symlink, write = its `dataDir`, net = hosts the **live** config declares, no
subprocess), so `NotCapable` means the op left that envelope. Returns
`{code, stdout, stderr, commit, subject, dirty, check}`. Flow: edit → `dev.run("check")`/`("test")`
→ `dev.git commit` → `dev.try` → `deploy.promote` (human approves) → supervisor restarts, probes
`/health`, soaks 60 s, advances `main`; failure auto-reverts. `deploy.status` shows live/main/dev
shas, ahead/behind and dirty flags (untracked files never block).

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
