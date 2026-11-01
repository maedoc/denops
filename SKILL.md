# denops — agent skill sheet

How to drive this MCP server. Fetch it at runtime with `execute("return await denops.skill({});")`;
prefer this over guessing, and re-read it after any server upgrade.

<!--
MAINTENANCE (humans and agents): this file is the prompt-facing contract. Whenever an op, tier,
capability, config knob, deployment step or error contract changes, update it in the SAME change.
`tests/skill_test.ts` fails if this file and the live op registry disagree (missing or unknown op
names), so drift is caught by `deno task test` before a promotion. Keep it under ~120 lines.
-->

## 1. What this server is

Code Mode: only four-ish tools exist (`search`, `execute`, `approve`, and `grants` when a filesystem
root is configured). Everything else is an **op** you call from JavaScript inside `execute`:

```js
// execute() runs the BODY of an async function; return JSON-serializable data
const projects = await gitlab.projects.list({ perPage: 5 });
return projects.map((p) => p.path_with_namespace);
```

Ops are namespaced globals (`gitlab.*`, `mail.*`, `mistral.*`, `fs.*`, `dev.*`, `deploy.*`). There
is no `tools` object. Credentials never enter the sandbox; ops are the only egress. No `fetch`,
`WebSocket`, filesystem or `Deno` APIs.

## 2. Discovery (do this first, cheaply)

| call                                   | gives you                                       |
| -------------------------------------- | ----------------------------------------------- |
| `api.search("")`                       | the whole registry with per-connector counts    |
| `api.search("query", "gitlab")`        | ranked matches; wildcards (`*`) list everything |
| `api.describe("gitlab.issues.create")` | full doc: args **and** return shape             |
| `denops.skill({})`                     | this document                                   |

`search`/`describe` are also available as MCP tools. A query that matches nothing returns the
inventory, so a single call always tells you what exists.

## 3. Call conventions

- Write one `execute` that loops over ops rather than many round trips; budgets are per run (wall
  clock, op count, 1 MB per op result).
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

**mail** (10 ops) — `mailboxes.list`, `messages.list` (`{mailbox,total,page,limit,messages[]}`),
`messages.search` (server-side IMAP search; returns envelopes with the uids),
`messages.get`/`getPart`/`flags.get`, `drafts.save` (open — draft, never send), `messages.raw` and
`messages.move` (approval). No SMTP: sending does not exist.

**mistral** (17 ops) — libraries and documents. Discovery is metadata-first: `libraries.list` →
`documents.list` (each row has `size`, `mime_type`, `process_status`) → then decide:

- small text → `documents.read({libraryId, documentId})` (inline, ≤ `inlineReadMaxBytes`, else
  `truncated: true`);
- binary (PDF…) → read the extracted `summary` via
  `documents.get({libraryId, documentId, fields:["summary"]})`, or `documents.stage` to download it;
- search a big staged file → `documents.stage` returns `{root, path, absPath, bytes, mime, sha256}`
  and you pass `root`+`path` straight to `fs.grep`/`fs.read`. Grep skips binary files
  (`skippedBinary`). Writing is text-first: `documents.put({libraryId, fileName, text})` creates,
  and `documents.replace({libraryId, fileName, text})` is replace-by-name (refuses if several
  documents share the name — pass `documentId` then). `documents.upload` takes base64 for binaries.
  `staging.clear({olderThanHours?})` prunes staged copies. Writes/deletes are approval-tier for
  libraries that already existed; a library created in the same run can be written and cleaned up
  freely. Mistral assigns the stored `mime_type` itself (text uploads become `text/plain`).

**fs** (10 ops) — named roots only (`fs.roots` lists them). `glob`, `list`, `read` (line windows
with `hasMore`), `grep` (regex, capped), `write`, `edit`/`editRegex`, `rm`, `exec`.

- **Capabilities are enforced before approval**: writing to a `write: false` root (or exec on
  `exec: false`) fails with `capability_denied` and creates **no** pending. Paths are confined to
  the root (symlinks that escape are refused).
- **Grants are levelled**: approving the first op on a root records `fs:<root>:read` (browse/search)
  or `fs:<root>:write` (write/edit; implies read). `fs.rm` and `fs.exec` are never grant-covered —
  they ask every time. `grants({action:"list"|"revoke", key})`.

**denops** (2 ops) — `denops.skill` (this document; `{ section }` filters) and `denops.about`
(version, skill freshness, connector families).

**debug** (3 ops) — `debug.echo`, `debug.boom`, `debug.gated`; harmless smoke tests, and the fastest
way to check the execute/approval plumbing.

**dev** (4 ops) / **deploy** (3 ops) — working on this server's own code without a shell:
`dev.roots` (roots + task names), `dev.run({root, task})` (`check`, `test`, `fmt`, `lint`… argv from
config, no shell), `dev.git({root, action:"status"|"diff"|"log"|"commit", message?})`,
`dev.try({root, op, args})` (runs one **open-tier** op from the dev checkout's own registry against
the real APIs — this is how you validate new code before shipping), `deploy.status`,
`deploy.promote` (approval: runs the test task, records intent), `deploy.rollback({commit?})`.
Promotion flow: edit → `dev.run("check")`/`dev.run("test")` → `dev.try` → `dev.git commit` →
`deploy.promote` (human approves) → the supervisor restarts into it, probes `/health`, soaks 60 s,
then advances `main` and records it as last-good. Failure → automatic revert. `deploy.status` shows
live/main/dev shas, ahead/behind, dirty flags (untracked scratch files do not block a promotion).

## 5. Error and approval semantics worth remembering

- `capability_denied:` — immutable config says no; don't retry, don't ask for approval.
- `invalid args for <op>: <field>: …` — the boundary rejected you; fix the argument, no approval.
- `unknown or unavailable op` — use `api.search`; the op may belong to a disabled connector.
- Approval summaries are written by the connector (commit subject + diffstat for deployments,
  mailbox/uids for moves). Quote them to the user; they are the human's only view.

## 6. Ground rules

One user, one identity: you act with their credentials. Prefer read ops, batch work into one
`execute`, and ask for approval rather than working around a gate. Never paste credentials into
`execute` output; secrets live host-side. If something is missing, `api.search` first, then say what
you need — the operator can add an op.
