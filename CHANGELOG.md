# Changelog

Append an entry here in the **same commit** as any change that alters behaviour a caller can observe
— an op, an arg, a return shape, a tier, an error contract, the deploy loop. `denops.version` serves
the top entries (`{version, commit, changelog}`), so this file is how a run finds out what it is
actually talking to instead of probing behaviour.

Format: `## <version> — <YYYY-MM-DD>`, newest first, then a short bullet list. Keep bullets about
the API surface; implementation notes belong in the commit message.

## 0.12.1 — 2026-11-03

- **`dav.grep` no longer spends its budget on files that cannot contain text.** Measured against the
  AMU share minutes after 0.12.0: a depth-3 walk fetched 19 files, every one of them binary (macOS
  `._*` AppleDouble forks, PDFs, images) and returned `filesScanned: 0` — the caller paid for a search
  and got nothing, which is the worst shape of failure. Known-binary extensions and OS droppings are
  now skipped **by name** before any GET is issued and counted separately (`skipped.byName`), so
  `skipped.binary` means "we had to download it to find out". `stoppedBy` also says *why* the walk
  ended (`walk:time`, `walk:entries`, `walk:depth`) instead of a bare `walk`.

## 0.12.0 — 2026-11-03

Everything here is either a defect found by measuring against the live servers or documentation that
had silently rotted.

- **`dav.grep` (new, open): which files *mention* this text.** `{ account, path?, pattern,
  namePattern?, maxDepth?, maxFiles?, maxBytesPerFile?, maxMatches?, maxMs?, exclude? }` walks the
  same bounded, parallel tree as `dav.find` and reads candidates with a per-file cap. `pattern` is a
  literal case-insensitive substring on purpose — a caller-supplied regex is an invitation to
  catastrophic backtracking, and "the file that says docathon" is the actual question. Binary,
  oversized and unreadable files are **counted** in `skipped`, never silently dropped, and `stoppedBy`
  says whether the walk, the match cap or the clock ended it.
- **`dav.get` reads windows, and `size` is no longer a lie.** `offset` becomes a `Range` request
  (Nextcloud answers 206 + `content-range`), and `nextOffset` tells the caller where to continue, so a
  1.2 MB log is walkable instead of "first 64 KiB or nothing". Two bugs fell out of measuring that:
  an absent `content-length` was reported as `size: 0` because `Number(null)` is `0`, and a compressed
  body's `content-length` was reported as the file size. `size` now comes from `content-range` when
  present, from `content-length` only when the body is neither ranged nor encoded, and is omitted
  otherwise.
- **Non-UTF-8 text is flagged instead of silently mangled.** `get` sets `encodingIssue` (with a note
  pointing at `dav.stage`) and `dav.edit` **refuses** such a file outright: a lossy read followed by a
  write would corrupt it, which is worse than failing.
- **`exclude` globs on `list`/`find`/`grep`** keep macOS resource-fork junk (`._*`, `.DS_Store`) out
  of the payload. Opt-in: nothing is hidden that the caller did not ask to hide.
- **`dav.delete` and `dav.move` take an `ifMatch`**, closing the last ungated writes — `delete` now
  refuses (412) to remove a file that changed since it was read, instead of removing the wrong bytes.
- **`dav.stage` no longer clobbers.** A same-named download with identical bytes is reused
  (`reused: true`) instead of rewritten; different bytes at a taken name are refused with the escape
  hatch named, so one run cannot silently replace a file another is reading.
- **README.md is caught up and now mechanically watched.** It still documented a `gitlab (27 ops)`
  section a release after that family became `forge`, said `dev (4 ops)` when it was 5, called the
  mail family `imap`, undercounted `denops`, and had never gained `calendar` or `dav` sections at all.
  It now has all ten, and `tests/readme_test.ts` checks every family heading and its op count, sharing
  one connector fixture with the SKILL.md test (`tests/connector_set.ts`) — the duplication is how the
  drift happened. The SKILL.md check got stricter for the same reason: the count has to sit next to
  the family name, not merely appear somewhere in the file (which is how `denops` drifted from 5 to 6).
- `calendar` was missing from the shared fixture entirely, so the "every family is documented" gate
  had never actually looked at it; it does now.

## 0.11.0 — 2026-11-03

Brought the `dav` surface up to what a real reviewer's use of it asked for. Everything here came from
either a live probe of both Nextcloud servers or Mistral's shakedown of the live connector.

- **`dav.edit` (new, approval): read-modify-write in one call.** `{ account, path, append?, prepend?,
  replace?: [{ find, replace, all?, optional? }], createIfMissing?, ifMatch?, maxBytes? }` reads the
  file, applies the transforms and writes the result back carrying the etag of that same read — so a
  journal-style append is one approval and a few hundred bytes instead of `get` + full-body `put`. It
  is honest about its edges: a `find` that matches nothing is an error unless the entry says
  `optional` (a silent no-op is the one outcome worth failing on), transforms that produce identical
  text write nothing, a file above `maxBytes` is refused rather than half-edited, and a stale
  `ifMatch` is a 412 before anything is sent.
- **`dav.list` pages deterministically**: `offset` in, `offset`/`nextOffset` out alongside `count`,
  `total` and `more` — pass `nextOffset` back to continue. The server still sends the whole directory
  (PROPFIND cannot page), so the docs say so rather than implying a cheaper call.
- **`dav.find` got faster and more honest.** Depth-1 listings are now walked four at a time instead of
  one after another (the walk is latency-bound: on the AMU box a serial depth-4 walk burned the whole
  5 s budget after 27 entries), the default budget is 8 s (cap 20 s), and a capped walk now reports
  `unscanned` plus a `resumeFrom` sample of the directories it never reached, so a follow-up search
  continues instead of starting over. There is no server-side search to fall back on: WebDAV SEARCH
  returns **501 NotImplemented** on both servers (probed), and Nextcloud's full-text endpoint is an
  app endpoint, not a protocol.
- **`dav.put`/`dav.putStaged` with `overwrite: true` report what they replaced** (`replaced: { size,
  etag, modified }`, one PROPFIND, paid only on that path). The lost-update hole stays closed by
  `ifMatch`; this makes the explicit escape hatch visible instead of blind, so the bytes can still be
  recovered from Nextcloud's version history.
- **`dav.accounts` explains a read-only account** instead of leaving it a mystery. Probing both
  servers showed the AMU account is in fact writable (conditional PUT 201 → 204, wrong `If-Match` →
  412), i.e. `writable: false` is always a config choice here, never a credential limitation — so the
  note says which knob to turn.
- **Error messages carry the server's sentence, not its XML.** Sabre puts the useful text in
  `<s:message>`, and that sentence now replaces the raw markup on the statuses that fall through
  (`403`, `405`, `409`, `412`, `5xx`). `404` keeps the hand-written, actionable text instead —
  "paths are relative to the share root; run dav.list" beats "File with name … could not be
  located", and the server's phrasing is only appended where it adds something.

## 0.10.1 — 2026-11-03

- **`dav.get` reports the DAV `getetag`, not the GET response `ETag`.** Nextcloud appends `-gzip`
  to the ETag of a compressed response, so the value `get` used to return was one a following
  `dav.put({ ifMatch })` could never match — a guaranteed bogus 412 on the first write after a
  read. `get` now takes the etag from the same-depth PROPFIND it already makes to confirm the
  path is a file, which is the value Nextcloud compares `If-Match` against. Found by comparing
  `dav.stat` and `dav.get` on the same file on the live server, which is the kind of thing only a
  real Nextcloud says out loud.

## 0.10.0 — 2026-11-03

- **New `dav` family (14 ops): WebDAV / Nextcloud files, shaped for a caller with a byte budget.**
  `dav.accounts` (id, origin, `shareRoot`, writable — never credentials), then one address form
  everywhere: `path` relative to the account's share root, returned in the same form, so paths
  round-trip. `dav.list` (depth 1, `limit`/`sort`/`kind`, honest `more`), `dav.stat` (the etag the
  writes need), `dav.get` (text only, 64 KiB default, capped at 1 MiB), `dav.find` (bounded
  recursive name search that reports `stoppedBy`), `dav.quota`, `dav.stage` + `dav.putStaged`
  (bytes to/from the host staging root — no base64, no binary through the context window) and
  `dav.staging.clear`.
- **Writes are create-only by default.** `dav.put`/`dav.putStaged` send `If-None-Match: *` unless
  the caller passes `overwrite: true` or the `ifMatch` etag from `stat`/`get`; `dav.move`/`dav.copy`
  send `Overwrite: F`. A 412 is reported as "re-read and retry", never retried blind. `dav.delete`
  is approval-only with no grant shortcut and needs `recursive: true` for a directory. Mutating ops
  on a `writable: false` account are refused in `precheck`, before a human sees a prompt.
- **Confinement is structural, not filtered.** `dav` splits the caller's path into segments, refuses
  `..`/absolute/backslash/control characters, and percent-encodes each segment, so no caller text
  can become a URL path component it did not name; hrefs coming back from the server are adopted
  only when they sit under the share root. Credentials are pinned to the account `origin`
  (redirects re-pinned per hop, downgrade refused). `path` is validated in `argSchema`, so a
  traversal attempt never reaches an approval prompt.
- **`permissions.ts` derives the envelope for `dav`**: each account origin becomes a `--allow-net`
  entry (same branch as caldav, minus the iCloud wildcard) and `stagingRoot` is granted read+write,
  because `dav.stage` writes what `fs.read`/`fs.grep` then read. The returned `fsRoot`+`path` are
  resolved from the live `fs.roots`, so staging inside `denops-stage` needs no path surgery.
- **Two things only the real servers could teach, fixed here.** `dav.quota` asks for RFC 4331
  (`DAV:` namespace) *and* the `oc:` names: Nextcloud 33 answers only the former and 404s the
  latter, and it reports `-1` available bytes for "no limit", which is now surfaced as
  `unlimited: true` instead of a nonsense total. And `dav.get`/`dav.stage` refuse a directory
  before fetching anything — a `GET` on a collection returns the Nextcloud web UI, which was
  landing in the staging root as if it were the file.
- **`dav` is startup-validated** with one authenticated PROPFIND per share root; a bad app password
  shows up as `degraded` on `denops.about` and does not stop the server binding.
- Advisory, not fixed here: `calendar` discovery PROPFINDs the origin root, and Nextcloud answers
  **405** to that (`/remote.php/dav/` is the real root) — so a Nextcloud calendar account still
  needs a path-aware discovery patch before it can be configured.

## 0.9.1 — 2026-11-03

- **`forge.repository.files.get` and `repository.tree.list` behave the same on all three flavors when
  `ref` is omitted.** GitLab's file API rejects a missing `ref` ("ref is missing, ref is empty") while
  Forgejo and GitHub default to the default branch, so the gitlab adapter now resolves the default
  branch itself (once per repo, cached). Found by calling the same op against every account and
  comparing results, which is the check the family exists for.
- **`forge.repository.tree.list` at the repository root asks GitHub for `/contents`, not
  `/contents/`** — the slash form reached GitHub's edge as a distinct URL and failed with a 503. The
  same check surfaced it, and it left the op unusable (not merely inconsistent) on that account. The
  forgejo flavor now uses the same root form.
- **`forge.repository.tree.list` honours `page` on the flavors whose contents API has no paging**
  (forgejo, github). It sliced on `limit` only, so `page: 2` returned page 1 again and the caller
  could loop forever believing it was walking a large directory.
## 0.9.0 — 2026-11-03

- **`forge` gains a GitHub adapter** — the third flavor, so one account set spans git.ins-amu.fr,
  gitlab.ebrains.eu and api.github.com with the same 27 ops and the same normalized results. What
  differs is handled in `flavors/github.ts`: `Link: rel="next"` cursors (a full page is *not* the
  last page there), file bytes via `Accept: application/vnd.github.raw` (no `/raw` endpoint), a
  separate search endpoint per resource with its own envelope and its own rate limit, PRs in the
  issue list (filtered out) and PRs in the issue number space (`issues.get` refuses them), `merged`
  inferred from `merged_at` since `state=merged` does not exist, per-file patches that arrive inline,
  and 403 disambiguated between "insufficient scope" and "rate limited" by the headers.
- **One unusable account no longer takes the family down.** Ports are built per account; a flavor
  without an adapter or a bad origin fails that account's ops with a named error and a startup
  warning instead of aborting the server, and a failed startup probe is logged per account rather
  than degrading every `forge.*` op. `validateStartup` throws only when *no* account could be built.
- `apiPath: ""` is now legal, because GitHub's REST root is the origin itself.
- `forge.getText` sends the caller's media type: the GitHub auth headers set a default `Accept`, which
  was overriding the raw request (caught by the mock-server test for file reads).
- Conformance fixtures now cover all three flavors (`tests/fixtures/forge/{gitlab,forgejo,github}/`)
  under identical assertions; the GitHub ones were recorded after populating a scratch repo, and
  `temp_clone_token` is scrubbed from them on capture.

## 0.8.0 — 2026-11-03

**Breaking: the `gitlab.*` family is removed.** Use `forge.*` with `account: "ebrains"` (a `forge`
account with `flavor: gitlab` on gitlab.ebrains.eu). Consequences a caller will notice:

- op names and arguments change with the family (`forge.issues.get({account, repo, number})` instead
  of `gitlab.issues.get({projectId, issueIid})`), and `perPage` becomes `limit`.
- results are the family's normalized objects, so `path_with_namespace` → `fullName`, `iid` →
  `number`, `source_branch` → `sourceBranch`; lists return `{items, page, nextPage}` instead of a
  bare array. `fields`/`full` still work.
- `gitlab.get` → `forge.api.get({account, path, query})`; `gitlab.mutate` → `forge.mutate({account,
  method, path, body})` (approval, POST/PUT/PATCH/DELETE). Both are pinned to the account's API root,
  and credential-bearing paths (`variables`, `*_tokens`, `secure_files`) are now refused for writes
  as well as reads — writing CI variables is a credential write.
- the `gitlab:` connector config block is no longer read; `secrets.gitlab.token` is still used as the
  fallback for a `gitlab`-flavored account when `secrets.forge.<id>.token` is absent.

## 0.7.0 — 2026-11-03

- **`forge` gains a Forgejo adapter**, so one account set addresses both git.ins-amu.fr (Forgejo
  16.0.4) and gitlab.ebrains.eu with the same 26 ops and the same normalized results. Every
  divergence is handled in `flavors/forgejo.ts`: `{ok,data}` envelopes on search, `limit` instead of
  `per_page`, `PATCH` (which answers **201**), a merge that returns **200 with an empty body** (so
  the PR is re-read), issue comments that ignore paging (capped client-side), `state=merged` filtered
  on the `merged_at` flag, `/raw` for file reads, blob `sha` required for file updates, label names
  resolved to ids, and `head.ref` on a PR *detail* being `refs/pull/<n>/head` (the branch is in
  `head.label`). `forge.issues.get` refuses a number that is really a pull request and names
  `forge.pulls.get` instead.
- **`gitlab.*` now runs on the shared forge client** — same ops, arguments, tiers and upstream-shaped
  results, one implementation of auth, origin pinning, query handling and error extraction. The
  previous `GitLabClient` is gone; nothing about the family's contract changed except the error
  string prefix (`ebrains (gitlab) GET … -> 404: …`).
- **`gitlab.mutate` accepts `PATCH`**: the shared client supports it (Forgejo needs it for issues and
  repos, GitLab for the same), so the generic escape hatch no longer hides a verb the API uses.
- Conformance fixtures for Forgejo recorded from the live instance (`tests/fixtures/forge/forgejo/`)
  run through the same assertions as the GitLab ones — a flavor that drifts fails there.

## 0.6.0 — 2026-11-03

- **`forge.*` (26 ops): one family over several code hosts.** A `forge` account is a
  `{id, flavor, origin, apiPath}` pair with its credential in `secrets.forge.<id>.token`, so the
  same op names address GitLab, Forgejo and (once its adapter lands) GitHub: `forge.accounts`,
  `projects.*`, `issues.*` (+`issues.notes.*`), `pulls.*` (+`changes.get`, `comment`, `merge`),
  `repository.branches/commits/tree/files`, `users.*`, `orgs.list` (GitLab's groups).
- **Results are normalized, not upstream JSON**: `number` for the per-repo short id (GitLab
  calls it `iid`), `state: "open"|"closed"|"merged"`, `merged`/`draft` booleans, `{items, page, nextPage}`
  for every list, `{files, truncated}` for a change set. `fields`/`full` still apply; raw upstream
  payloads stay reachable through `forge.api.get`, which is pinned to the account's API root and
  refuses credential-bearing paths.
- **Page sizes are clamped per flavor** (GitLab/GitHub 100, Forgejo the instance's
  `max_response_items`), because forwarding `limit: 500` makes Forgejo answer 50 while the caller
  believes it has everything.
- **Errors carry status, flavor and a hint**, extracted per upstream: GitLab `{message}`, Forgejo
  `{message, errors[]}` where `message` can be empty or an internal function name, GitHub
  `{message, documentation_url}`. 401/403 hint at the token/scope, 404 at visibility, 405 at
  "already merged" (Forgejo's answer for re-merging).
- `pulls.create` rejects a pull request whose source and target branch are equal in **precheck**,
  before an approval exists.
- The existing `gitlab.*` family is unchanged and does not go through `forge` yet: this release adds
  the family alongside it, and the alias flip is a separate change. Conformance fixtures recorded
  from gitlab.ebrains.eu pin the normalized shapes (`tests/fixtures/forge/gitlab/`).

## 0.5.1 — 2026-11-03

- **Reminders on `calendar.events.create` / `calendar.events.update`.** Both take
  `reminders: [{ minutesBefore, description? }]` — positive minutes before the start, `0` at the
  start, negative after — which become `DISPLAY` VALARMs, and `calendar.events.get` returns the
  reminders an event already has (with `action`, so a caller can see an `EMAIL`/`AUDIO` alarm it did
  not set). Values are validated in `argSchema` before approval: an integer within ±4 weeks and at
  most 5 reminders.
- **`EMAIL` alarms are refused** for the same reason attendees are: the server sends real mail to
  real people. `AUDIO`/`EMAIL` alarms already on an event are left alone when reminders are replaced
  — only `DISPLAY` alarms are considered ours to rewrite.
- An update that sets `reminders: []` clears the display reminders and nothing else.

## 0.5.0 — 2026-11-03

- **`calendar.*` (8 ops): CalDAV, read and write.** Per-account Basic/bearer auth from
  `secrets.calendar.<id>`, discovery (`current-user-principal` → `calendar-home-set`, falling back
  to PROPFIND because iCloud answers `/.well-known/caldav` with 400), `calendars.list`,
  `events.list`, `events.get`, `events.search`, and approval-tier `events.create` / `events.update`
  / `events.delete`.
- Read paths require a bounded window (`from`/`to`, ≤ 366 days) and a limit: one real calendar
  serialises 332 events to ~1.3 MB, above `maxOpResultBytes`, so an unbounded listing is rejected
  rather than silently truncated. Recurrence is expanded by the server (time-range filter), so there
  is still no RRULE engine here, and a calendar is refused when it holds VTODO rather than VEVENT
  instead of looking empty.
- Writes are ETag-gated: `If-None-Match: *` on create, `If-Match` on update/delete, and a `412`
  becomes "it changed, re-read for a fresh etag" — never a blind retry. `events.update` is
  read-modify-write, so `VALARM`, `ATTENDEE`, `VTIMEZONE` and vendor properties survive a change.
- **Attendees are never written.** iCloud advertises `calendar-auto-schedule`, so a PUT carrying
  `ATTENDEE` can make the server email real invitations. Payloads with attendee/organizer fields are
  refused in `argSchema`, before an approval is requested; existing attendees are preserved
  untouched. Event times must carry a UTC offset (or be all-day dates) — no floating times.
- iCloud specifics handled in code: its per-partition `calendar-home-set` host
  (`pNN-caldav.icloud.com`) is granted as `--allow-net=*.icloud.com:443` and every URL — discovery
  hrefs, redirect hops, calendar hrefs — is pinned to the account's host or, for iCloud, the same
  registrable domain. `free-busy-query` is advertised but returns 400, so no op depends on it.

## 0.4.1 — 2026-11-03

- `dev.try` works again under the 0.4.x child envelope. Dropping `--allow-env`/`--allow-sys`
  outright killed the child before it ran anything: the app graph pulls imapflow → pino →
  thread-stream, which reads `NODE_V8_COVERAGE` **at import time** and `os.hostname()` for every log
  record. It failed closed with `Requires env access to "NODE_V8_COVERAGE"`, reported as a JSON
  `error` with exit code 0, so `dev.try` looked like an op that returns nothing. The child now gets
  exactly those two names — `--allow-env=NODE_V8_COVERAGE --allow-sys=hostname`, never unscoped —
  and the op result's `commit` stays `null`, which is the proof env access is still denied.

## 0.4.0 — 2026-11-03

- **A degraded connector no longer stops the server from starting.** `startup.validate: full`
  awaited every connector's reachability probe unguarded, so one unreachable dependency made
  `buildApp` reject, the server never bound its port, and Caddy answered **502 for every op** while
  the supervisor restarted the same commit forever. (Live cause: the Proton IMAP bridge on
  `127.0.0.1:1143` stopped running; `mail` was the first probe.) A failing probe now records that
  connector as **degraded** — still registered, its own ops fail when called, everything else keeps
  serving.
- `/health` returns `{ok: true, degraded: ["<connector>", …]}` and `denops.about` returns the same
  list with each error, so "up but degraded" is visible from a run instead of only in journald.
  Startup logs one `[startup] DEGRADED <connector>: …` line plus a summary.
- New `startup.failFast` (default **false**). `true` restores the previous all-or-nothing startup.
  Missing secrets, an impossible connector config and a non-loopback bind without a token remain
  fatal either way — only _reachability_ degrades.

## 0.3.1 — 2026-11-02

- `dev.try` now refuses, host-side, any op that is approval-tier in the **live** registry. The
  in-child tier check reads the dev checkout's own manifest, which the agent can edit; flipping an
  op to `open` there no longer lets `dev.try` run it without a human. The error names the op and
  says to promote instead.

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
