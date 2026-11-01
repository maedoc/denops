# Changelog

Append an entry here in the **same commit** as any change that alters behaviour a caller can observe
— an op, an arg, a return shape, a tier, an error contract, the deploy loop. `denops.version` serves
the top entries (`{version, commit, changelog}`), so this file is how a run finds out what it is
actually talking to instead of probing behaviour.

Format: `## <version> — <YYYY-MM-DD>`, newest first, then a short bullet list. Keep bullets about
the API surface; implementation notes belong in the commit message.

## 0.3.0 — 2026-11-01

- `denops.logs({lines?, grep?})`: the supervisor now tees the server's stdout/stderr into
  `data/server.log` (2 MB tail kept across restarts) and this op returns it redacted — bearer
  tokens, `?token=`/`api_key=` parameters, `Authorization`/`PRIVATE-TOKEN` headers and 60+ char
  tokens masked. A failed start is diagnosable from a run instead of from journald.
- `denops.about` reports the live permission envelope (`permissions.net/read/write/run`), derived by
  the same `serverPlan()` the launcher uses.
- `dev.sync({root})` (approval): `git fetch --prune origin` + `merge --ff-only <syncFrom>` on the
  current branch. No caller-supplied ref, remote or flag, and never a reset — a diverged branch
  fails and a detached HEAD is refused, so local work cannot be discarded. `syncFrom` is
  operator-set per root (`origin/main` for denops-dev, whose branch has no upstream on origin) and
  defaults to the branch's upstream.

## 0.2.2 — 2026-11-01

- GitLab pagination works: `perPage`/`page` are camelCase at the op boundary but were copied
  verbatim into the query string, so GitLab ignored `perPage` and always answered with its default
  20 rows. Query keys are now emitted in the API's snake_case (`per_page`).

## 0.2.1 — 2026-11-01

- `gitlab.issues.list` no longer requires `state`: it accepts omission again and applies its
  documented `opened` default (the boundary check was the _required_ enum form, so the call died
  before the default could run). Same fix for `gitlab.mergeRequests.list` and
  `gitlab.issues.update`, where the docs also said `state?`. An invalid value is still refused.
- `debug.*` is no longer registered by default (`connectors.debug.enabled: false`): the family
  exists for harness tests and is not part of the served surface. It disappears from `api.search`
  and from the skill sheet, so the registry an agent sees is the production one.

## 0.2.0 — 2026-11-01

- `dev.try` now runs committed, checked code only (dirty tracked tree ⇒ refused; the root's `check`
  task must have passed for the current tree) and its child gets a pinned permission envelope: read
  = the checkout, write = its data dir, net = hosts the live config declares, no `--allow-run`.
  Result and run log carry `{commit, subject, dirty, check}`. `scripts/dev_try.ts` finally passes
  the checkout's real config and secrets to the connector.
- `mail.drafts.save` accepts `replyTo: {mailbox, uid}` and `includeQuote`, and owns RFC 5322:
  `Message-ID`, `In-Reply-To`, `References` (parent chain + parent Message-ID), `Date`,
  `MIME-Version` and a non-doubled `Re:` subject; appended with `\Draft` + `\Seen`. Without
  `replyTo`, `subject` and `to` are still required, and a fresh `Message-ID` is always minted.
  `draftsMailbox: auto` follows the account's `\Drafts` special-use folder. Result now reports
  `{mailbox, messageId, inReplyTo,
  references, subject, to, quoted, quoteSkipped?}`.
- `mail.messages.get.body` is the **body only** now (headers used to be embedded); the parsed
  envelope exposes `messageId`, `inReplyTo`, `references[]` and `contentType`, and the raw header
  block is returned separately as `headers` (capped, `truncated` on overflow).
- `mail.messages.search` accepts `mailboxes: string[]` (max 20) to search several folders in one
  call; results carry their `mailbox`, a failing folder is reported instead of aborting.
- New connector **web** (1 op): `web.fetch({url, format?, maxBytes?})` gets an http(s) document as
  text (HTML converted best-effort) or raw markup. Only hosts in `connectors.web.allowedHosts` are
  reachable, private/loopback/link-local addresses are refused (SSRF guard), every redirect hop is
  re-validated, and only textual content-types are returned.
- `denops.version` (version + commit + changelog head), `denops.budget` (remaining wall clock and op
  count for the run in flight) and `denops.oplog` (read-only, redacted run log: ops, statuses,
  approval/error counts, no args or result bodies).

## 0.1.0 — 2026-10-29

- First release: Code Mode MCP server over GitLab, IMAP mail, Mistral libraries and an allowlisted
  filesystem; approval tiers, root grants, static-client OAuth, brute-force banning, and the
  promote/soak/auto-revert deployment loop (`dev`, `deploy` connectors).
