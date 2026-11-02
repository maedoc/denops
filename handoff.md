# denops — handoff

State of the world as of 2026-11-01, written to be picked up cold. Companion docs: `README.md`
(reference: runbook, lessons, known gaps), `SKILL.md` (the prompt-facing contract served by
`denops.skill`, drift-tested), `AGENTS.md` (rules for agents editing this repo), `CHANGELOG.md`
(what each version can do, served by `denops.version`).

---

## 1. What this is

A local, single-user **MCP server** exposing large external APIs to LLM agents via **Code Mode**:
the server advertises `search`, `execute`, `approve` (and `grants` when a filesystem root exists);
the model writes one JavaScript async-function body per call that invokes host-side **ops**
(`gitlab.*`, `mail.*`, `mistral.*`, `fs.*`, `web.*`, `dev.*`, `deploy.*`, `denops.*`). Credentials
never enter the worker; the op channel is the only egress.

It also runs its own deployment pipeline: a dev worktree, a test/try/commit loop, and a promote →
probe → soak → auto-revert supervisor.

---

## 2. Where everything lives

| thing                   | path / endpoint                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| repo (this checkout)    | `/Users/duke/src/denops` — branch `main`                                                                                                         |
| remote                  | `git@github.com:maedoc/denops.git` (homelab has a working SSH key)                                                                               |
| live checkout (homelab) | `~/denops` — **detached** at `data/desired-commit`                                                                                               |
| dev worktree (agent's)  | `~/denops-dev` — branch `agent/dev`, no upstream (see §5 `dev.sync`)                                                                             |
| secrets (live)          | `~/denops/secrets.json` (0600, gitignored, outside the agent's fs root)                                                                          |
| live config             | `~/denops/config.yaml` (gitignored — an agent cannot edit it)                                                                                    |
| runtime state           | `~/denops/data/` — `bans`, `whitelist`, `runs/`, `root_grants.json`, `pending.json`, `desired-commit`, `last-good`, `deploy.jsonl`, `server.log` |
| service                 | `denops.service` (systemd, user `freebox`) → `scripts/live-supervisor.sh`                                                                        |
| MCP endpoint            | `https://wdmn.hd.free.fr/mcp` (bearer or static-client OAuth)                                                                                    |
| homelab access          | `ssh homelab` (passwordless sudo)                                                                                                                |

Local copies of `config.yaml` and `secrets.json` exist on the Mac so local tests and probes work.

---

## 3. Current state (verify before trusting)

```
local main / origin/main / live / desired / last-good / agent/dev    26c585f  (version 0.3.0)
service               active, /health 200
tests                 146 passing on macOS and on the homelab (Linux); lint clean
pending approvals     debug.gated (stale), deploy.promote (stale), fs.rm (stale) — safe to clear
drafts (amu)          Brouillons uid 99620 (human's) + 99621 (created by an agent, threading test)
fs grants             ["fs:denops-dev"]   (legacy unlevelled key = write-level)
staging               empty
imap accounts         proton, free, amu (woodman.m → imap.univ-amu.fr, messageIdDomain univ-amu.fr)
```

Deploy state is one call: `deploy.status` (`liveCommit`, `lastGood`, `mainCommit`, `devCommit`,
`devAhead/behind`, `devDirty`, `restartPending`, recent audit). Live config facts worth knowing:
`draftsMailbox: auto` for all three accounts, `connectors.web` enabled with `allowedHosts` +
`dnsServers`, `connectors.debug.enabled: false`, `dev.roots[denops-dev].syncFrom: origin/main`.

---

## 4. What shipped today (in order)

- `9c4d059` **`dev.try` confinement (P1–P4)**: the child that runs agent-written code got a _pinned_
  envelope (`src/permissions.ts`): read = the checkout (+ resolved secrets/config symlinks), write =
  its data dir, net = hosts the **live** config declares, **no `--allow-run`**. It also runs
  committed, checked code only — dirty tracked tree refused, needs the root's `checkTask` green for
  the current **tree** (`git stash create` → `^{tree}`), gated on exit code + tree identity, never
  stdout. `scripts/dev_try.ts` finally hands the connector the checkout's real config and secrets.
- `a743f32` … `26c585f` (0.2.0 → 0.3.0): threaded reply drafts (`mail.drafts.save({replyTo})`, RFC
  5322 assembled in `imap/rfc822.ts`, verified in OWA); `messages.get` splits headers from body;
  `messages.search({mailboxes})`; `draftsMailbox: auto`; new `web.fetch` with allowlist + SSRF
  guard; `denops.version|budget|oplog|logs`; `dev.sync`; `denops.about.permissions`; gitlab `state`
  optional and `per_page` actually sent; `debug.*` gated out of production.

`CHANGELOG.md` has the caller-visible detail. Three promotions auto-reverted before landing today —
each was a real bug in the change, not the pipeline: a flow-YAML list iterated per character into
`--allow-net`, `Deno.resolveDns` needing permission for the resolver rather than the name, and a
macOS-only test green.

---

## 5. The iteration surface (what an MCP-only session can do)

Write → check/test → try → commit → sync → promote → diagnose, entirely through ops:

```
fs.read/glob/grep  →  dev.run({task:"check"|"test"})  →  dev.try({root, op, args})  →
dev.git({action:"commit"})  →  dev.sync({root})  →  deploy.promote (approval)  →  supervisor
```

Diagnosis: `denops.version` (what is running), `denops.logs` (server stdout/stderr, redacted),
`denops.oplog` (per-run op audit, no args or bodies), `denops.budget`, `denops.about.permissions`
(the derived `--allow-net/read/write/run`), `deploy.status`, `data/deploy.jsonl`.

Three things still need a human/host shell, by design: editing `~/denops/config.yaml`, touching
`secrets.json`, and `git push` to GitHub.

---

## 6. Operating rules that are easy to get wrong

- **A promotion that changes `scripts/live-supervisor.sh` needs `sudo systemctl restart denops`
  afterwards** — the running bash read the old copy of the file from the live checkout.
- **Run the Linux test task before promoting**:
  `ssh homelab 'cd ~/denops-dev && git fetch origin && git reset --hard origin/main && deno task test'`
  — or just `dev.run({task:"test"})`, which runs it on the live host. A macOS-only green has been
  refused twice.
- Config is read only at startup: changes need a restart (`touch data/restart-request`, or
  `systemctl restart denops`).
- `deploy.promote` consumes the approval _before_ running, so a refused promotion (dirty tree, red
  tests) surfaces as `status: failed` on the `approve` call — read the body, not just the stream.
- `dev.try` iterates via commits: edit → `dev.git commit` → `dev.run("check")` → `dev.try`. A check
  run before the commit is fine (the gate keys on the tree), and everything shows up in the
  promotion diff.
- `agent/dev` has no upstream on origin; `dev.sync` fast-forwards to the configured `syncFrom`
  (`origin/main`). It never resets: divergence or a detached HEAD fails.
- Stale pending approvals accumulate in `data/pending.json`; deleting the file is safe while no run
  is in flight.
- The live tree is detached; `git pull` there fails by design. `origin/main` only advances when a
  human pushes from a normal checkout (this Mac repo).

---

## 7. Gotchas that cost real time (all observed)

- **Minimal YAML reader + `for…of` = a host grant.** `dnsServers: ["1.1.1.1:53", …]` came back as
  one string, and iterating it produced `--allow-net=…,[:53,1:53`. Flow sequences are parsed now,
  and both consumers refuse to iterate a string (`tests/config_yaml_test.ts`).
- **`Deno.resolveDns` under a scoped `--allow-net` needs the resolver** (`127.0.0.53:53`), not the
  name being resolved — hence `connectors.web.dnsServers` and `{nameServer}`.
- **`--allow-net` only gates the Deno process**, not subprocesses: `git fetch` (a `dev.*` child)
  reaches the network regardless. That is why `dev`/`deploy` are explicit config opt-ins.
- **`argSchema` runs before any client default.** A required-enum check on a field documented as
  optional rejects the call before the default can apply — that is how `gitlab.issues.list`
  hard-failed without `state` while its client-level test stayed green. Use `optOneOf`, and test at
  the boundary.
- **An unknown query parameter is a silent default, not an error.** `perPage` was copied verbatim to
  GitLab, which ignored it and always answered 20 rows. Query keys are emitted snake_case now.
- **`rejectUnknown` caps the number of keys; it does not reject unknown names.** Don't tell a caller
  an op validates arg names.
- **One child, one `--allow-all`, is a shell.** Today's headline fix; never re-introduce it (§4).
- Other classics, still true (see README "Lessons learned"): `kill -KILL -<pid>` on procps-ng,
  systemd's minimal `PATH`, `mtime` too coarse for hot-reload, approval replay keyed on the call
  index, sandbox errors must not carry stacks, never hard-code `content-type: application/json` for
  `FormData`.

---

## 8. Open items (roughly by value)

- **`dev.try` phase 2 (P5)**: a scoped read-only dev token for the child, and/or approval-gating
  `dev.try` when a connector manifest changed in the commit being tried. Today the child holds the
  checkout's credentials (symlink to the live `secrets.json`) and can reach live-declared hosts.
- **Quoted replies keep the parent's zero-width junk** (`U+200B–200F`, `U+FEFF`) — harmless in OWA
  and Apple Mail (verified), still worth stripping in `quoteBlock`.
- **No mail delete op**: cleaning up a draft is `mail.messages.move` (approval) to
  `Éléments supprimés`. Drafts 99620/99621 in amu `Brouillons` are still there.
- **Staging pruning is manual** (`mistral.staging.clear({olderThanHours})`); a TTL sweep was
  deferred.
- **`dev.run` output is capped** at 64 KiB per stream.
- Cosmetic: `origin/main` can sit one docs commit ahead of live (docs don't need a restart; they
  ride the next promotion).

---

## 9. First actions for a new session

1. Read `README.md`, `SKILL.md`, `AGENTS.md`, `CHANGELOG.md`; confirm §3 with `deploy.status` and
   `denops.version`.
2. `denops.logs({lines: 40})` — cheapest way to see whether the last restart was clean.
3. Clear `data/pending.json` if the stale entries are still there (`debug.gated`, `deploy.promote`,
   `fs.rm`).
4. Before promoting anything: `deno task check && deno task test` locally **and**
   `dev.run({task:"test"})` (Linux) — then `dev.git commit` (CHANGELOG in the same commit),
   `dev.sync`, `deploy.promote`.
5. If the change touches `scripts/live-supervisor.sh`: `sudo systemctl restart denops` after the
   soak.

---

## 10. Verify / probe commands

```bash
# local
cd /Users/duke/src/denops
deno task check && DENOPS_ALLOW_MOCK_ORIGIN=1 deno task test && deno lint src tests scripts

# the dev worktree (live host) — the Linux parity run
ssh homelab 'cd ~/denops-dev && git fetch origin && git reset --hard origin/main && deno task test'

# what is running / why it failed
ssh homelab 'cat ~/denops/data/last-good; tail -20 ~/denops/data/server.log; tail -3 ~/denops/data/deploy.jsonl'
# or from a run: denops.version, denops.logs, denops.oplog, deploy.status, denops.about.permissions
```

Mail/IMAP facts learned the hard way: the univ-amu account is `woodman.m` on `imap.univ-amu.fr` with
`messageIdDomain: univ-amu.fr`, and its Drafts folder is `Brouillons` (flagged `\Drafts`); a stale
unflagged `Drafts` also exists, which is why `draftsMailbox: auto` resolves the flag instead of the
name.
