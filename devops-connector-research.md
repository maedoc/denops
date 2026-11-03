# Mining `~/lat-agent-inventory` for denops ops — 2026-11-03

Scope: what devops capability exists in the archived agent estates, which of it is portable into
denops's model (host-side credentialed op, open/approval tier, no shell in the sandbox), and what is
worth building first.

## 1. What is actually in the archive

|                                              |                            |
| -------------------------------------------- | -------------------------- |
| skill records (deduped, all estates)         | 1,311 → 625 distinct names |
| devops-relevant names, curated               | **72**, ~560 KB of prose   |
| live-estate skill usage counts available for | 83 skills                  |
| cron/automation jobs recorded                | 31 (openclaw), 2 (hermes)  |

Curated devops set by area (name count / KB):

| area                                 | n  | KB  | notes                                                  |
| ------------------------------------ | -- | --- | ------------------------------------------------------ |
| identity: AD, Kerberos, CIFS, mounts | 13 | 95  | the user's headline ask                                |
| hardware / VM / out-of-band          | 11 | 66  | iDRAC Redfish, Hyper-V, disk reclaim                   |
| scheduler / cluster                  | 12 | 103 | inslurm is the most-used skill in the estate (37 uses) |
| deploy / expose                      | 14 | 119 | docker service deploy, Caddy, DNS, static site         |
| CI / tickets / git                   | 10 | 100 | Forgejo Actions + issues, ci-watchdog                  |
| monitoring / alerting                | 10 | 69  | Prometheus/blackbox, threshold alerts, Mattermost      |
| backup                               | 2  | 10  | restic                                                 |

Most-used live skills (openclaw `use_count`): `inslurm-cluster` 37, `privileged-command-delegation`
9, `ad-user-provisioning` 9, `remote-cluster-test-runs` 10, `ssh-host-access` 7,
`restic-drive-backups` 5, `cluster-kerberos-tickets` 4, `gateway-incident-triage` 3,
`subnet-address-inventory` 2, `ad-replication-diagnostics` 2.

## 2. The decisive finding: transport, not topic

Rough classification of the 72 by how the skill actually executes:

| shape                                    | n  | portable as an op?                      |
| ---------------------------------------- | -- | --------------------------------------- |
| pure HTTP API (`curl`/`/api/`)           | 9  | **yes, directly**                       |
| mixed (HTTP + ssh/sudo)                  | 21 | partly — the HTTP half                  |
| shell-only (`ssh` + `sudo` + vendor CLI) | 41 | **no**, without a remote-exec primitive |

So the archive is overwhelmingly _knowledge for a shell_, not _clients for an API_. That is the
whole design question: denops's unit is a credentialed protocol call, and most of this knowledge is
about argv, sudo, quoting, CRLF and locale — precisely the things the sandbox has no answer for.

Two consequences:

1. The ~9 API-shaped skills port almost mechanically (each becomes a connector, mirroring
   `gitlab/`).
2. The rest is only actionable if denops grows a **host-command primitive**, or if the knowledge is
   served as text rather than as ops (see §6).

What the archive contributes regardless of transport: exact endpoints, the traps that cost hours
(SEL from `Managers/` not `Systems/`; latched `Critical` rollups; `RESULT_OK` markers vs.
French-locale `erreur`; CRLF before marker matching; proxy-ARP making ping sweeps lie; `squeue %j`
printing a name not an id), and the conservative policy decisions already made for each system
(auto-resume only transient Slurm reasons, never auto-restart `slurmctld`, never re-create a user to
"fix" a failure).

## 3. Tier A — build first (pure HTTP, read-mostly, high frequency)

### `prometheus` — the "is anything down / what is firing" connector

Target: Prometheus + Alertmanager + blackbox on `ubsvc` (`10.67.121.220`, config under
`/home/prom/`). Pure GET, so nearly all open-tier; this answers the most common recurring question
in the estate and replaces the diagnostic half of `prometheus-probe-monitoring`.

```
prometheus.targets({state?, job?})        /api/v1/targets        → health, lastError, lastScrape
prometheus.rules({type?, group?})         /api/v1/rules          → per-rule health + lastEvaluation
prometheus.query({expr, time?})           /api/v1/query
prometheus.queryRange({expr, start, end, step})
alerts.list({state})                      alertmanager /api/v2/alerts → the *delivery* side
alerts.silences.list()                    open
alerts.silences.create({matchers, duration, comment})   approval
blackbox.probe({module, target})          :9115/probe?module&target → probe_success + failure phase
```

`blackbox.probe` is the highest-value single op: it tests a module _and_ a target in one call, which
is the fast loop the skill describes, without touching config. Writes (`reload`, module edit, rule
edit) stay out of scope: they are file edits on a host, not API calls.

### `redfish` — out-of-band host health and power

Generic Redfish, so it covers the Dell iDRACs and any future HPE/Supermicro BMC. Works when the OS
is dead, which is exactly when nothing else does.

```
redfish.hosts()                                    open — the configured fleet
redfish.get({host, path})                          open — pinned per-host origin, anything in /redfish/v1
redfish.system.get({host})                         PowerState, Status.Health, Model, Serial, BIOS
redfish.sel.list({host, limit?})                   Managers/<id>/Logs/Sel  (NOT Systems/<id>)
redfish.chassis.get({host, part: "Thermal"|"Power"})
redfish.power.set({host, action})                  approval — On|ForceOff|GracefulShutdown|ForceRestart
```

Two archive facts belong in the op docs and the approval summary: a `Critical` rollup with all-OK
components is latched from a past SEL event, and a burst of `USR0034` means the controller is
rate-limiting logins for ~60 s — wait, do not retry. `power.set` needs a per-host debounce so a
double-click cannot cycle a host twice.

### `forgejo` — CI and tickets on the site git server

Already researched in `forgejo-connector-research.md` (1:1 gitlab op map,
`Authorization: token <PAT>`, swagger-driven paths). The archive adds the _CI_ use case that file
lists only under "beyond parity", and `inslurm`'s CI lives here, not on GitLab:

```
forgejo.runs.list({repo, branch?, limit})          open
forgejo.runs.get({repo, runId})                    open — judge on jobs, not on the status field
forgejo.runs.jobs({repo, runId})                   open
forgejo.jobs.logs({repo, jobId, grep?})            open — filtered lines, not the whole runner log
forgejo.dispatch({repo, workflow, ref})            approval
forgejo.secrets.list({repo})                        open — names only
forgejo.secrets.set({repo, name, secretKey})        approval — value read host-side, never an arg
```

`jobs.logs` must project (tail + decision lines: `PLAY|TASK|ok:|changed:|FAILED|exitcode`),
otherwise a single call blows the 1 MB op budget.

### `notify` / `mattermost` — an out-channel

Every "check X" duty in the estate ends in a message. Today denops can only answer the caller.

```
notify.send({target: "mattermost"|"mail", text, channel?})   approval
mattermost.channels.list()                                   open
mattermost.messages.list({channel, since, limit})            open
```

### `caddy` — edge changes without ssh

The proxy's admin API (`:2019/config/`) replaces "read the Caddyfile over ssh, edit, reload" for
exposure work (`service-exposure`, `godaddy-caddy-ingress`).

```
caddy.config.get()                open
caddy.routes.list()               open — host → upstream map (names the backend for a 502)
caddy.routes.patch({...})         approval — validate + rollback on non-200
```

Effort: each of these is a `client.ts` + `manifest.ts` + `shape.ts` projection + tests, i.e. a day
apiece at the `gitlab/` template's level. Prerequisite: `src/permissions.ts` derives `--allow-net`
from a single `origin` per connector; a fleet (N iDRACs, two Prometheus hosts) needs
`origins: [...]` — small change, and `dev.try`'s pinned envelope should consume the same list.

## 4. Tier B — the AD ask (one real protocol client)

The archive's AD knowledge is excellent and honest: `ad-user-provisioning` (12 KB), `ad-reset-user`,
`ad-replication-diagnostics`, plus `cluster-kerberos-tickets` for the keytab half. But the
_mechanism_ is `ssh` to a DC and PowerShell/ADSI — not an API. Three ways to get it into denops:

| option                                | shape                                          | verdict                                                           |
| ------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| LDAP(S) client in a connector         | BER encode/decode, LDAPS bind, search + modify | **recommended** — no shell, real tiers, testable                  |
| WinRM/PowerShell remoting             | SOAP over 5985/5986, NTLM or basic+HTTPS       | heavier protocol, and it is remote code execution by another name |
| `ssh` to the DC with pinned PS1 files | reuses the site scripts verbatim               | contradicts the op model; belongs to Tier C if anywhere           |

Proposed surface, deliberately read-first:

```
ad.domain.get()                                        open — rootDSE, naming contexts, functional level
ad.user.get({sam|mail|dn})                             open — enabled, pwdLastSet, mail, home, upn, ou, groups
ad.users.list({filter, ou, limit})                     open — capped
ad.group.members({group})                              open
ad.computers.list({filter?})                           open
ad.user.create({sam, cn, mail, ou, groups, home})      approval
ad.user.set({sam, attributes})                         approval
ad.user.resetPassword({sam})                           approval — returns the temp password once
ad.user.enable/disable({sam})                          approval
ad.group.member.add/remove({group, sam})               approval
```

Facts from the archive that belong in the op contract rather than in a new runbook:

- password writes only work via LDAP `unicodePwd` over TLS (quoted UTF-16LE), or ADSI `SetPassword`
  in a DC session; the AD module's `Set-ADAccountPassword` is rejected on this DC.
- a UPN change rotates that principal's Kerberos key → the summary must say "the user's keytab must
  be re-minted".
- AD Default Domain Policy here: 30-day minimum password age → an admin reset blocks self-service
  `passwd` for 30 days. The op result should say so, because that is the user's first question.
- staff accounts live in top-level `OU=TNG`; bulk-created accounts in `OU=TNG,OU=LNN Users` — a
  lookup that only searches the default base returns "user not found" for every staff member.
- `CN` must be unique in the OU; error 8305 means the display name collides, not the sam.

**Honest limit:** the _completion_ of an AD create in this estate is not an LDAP write. It is
cross-site replication (intersite `replInterval` 15 min, can stall), a `sss_cache -u` on the head, a
home dir with the numeric `user:domain users` ownership, group-object replication, and a keytab
mint. None of that is reachable over LDAP. So either the op returns "directory done, cluster side
pending" and a human finishes it, or Tier C exists — in which case `cluster.newUser` becomes one
approval.

Effort: LDAPS bind + search is ~300 lines and testable against any directory (an in-repo LDAP test
double is feasible); the write paths (`add`, `modify`, `unicodePwd`, `delete`) add roughly as much
again. Call it 3–5 days including tests, versus a day per Tier A connector.

## 5. Tier C — the architectural decision: a host-command primitive

41 of the 72 skills, including all of Slurm, systemd, restic, CIFS/NFS mounts, dnsmasq and Hyper-V,
need to run argv on a remote host. denops has no such op, by design. Three stances:

1. **Don't.** Keep those runbooks human-facing; an agent proposes the commands and the operator or a
   shell runs them. Zero risk, and the archive stays useful as guidance.
2. **`host.exec` with a fixed command catalog.** Config declares hosts (name, ssh target, user, key,
   read/mutate per command id); ops are `host.exec({host, command: "<id>", args})` where `command`
   is a pre-declared argv template — never free-form shell, never a `|`. Read ids open (`sinfo`,
   `squeue`, `systemctl is-active`, `df`, `journalctl -n`, `getent`, `id`), mutate ids approval with
   a `summarize()`. Requires `--allow-run` for `ssh` on the server (already the norm for `fs.exec`)
   and must stay out of `dev.try`'s pinned child envelope (already enforced).
3. **Per-system connectors over their own daemons.** `slurmrestd` for Slurm (not deployed here),
   `node_exporter`/textfile for host facts, `docker.sock` proxy API for containers. Cleanest, but
   each requires standing up an API that does not exist yet.

If Tier C happens, the highest-value catalog entries, ranked by the estate's own usage: `sinfo -N`,
`squeue`, `scontrol show job/node`, `sacct`, `systemctl is-active|status`, `journalctl -n`, `df -h`,
`klist`, `sssctl domain-status`, `resolvectl status`, `restic snapshots --json`, `docker ps`,
`passwd`/keytab mint on the head.

## 6. A cheap third option: serve the knowledge, not the capability

`denops.skill` already serves one document. A second read-only op set — `runbook.search`,
`runbook.get` — over a vetted subset of these 72 skills (site names/IPs moved to a private file, as
the skills themselves already ask) would let an agent that _is_ allowed to run shell (via `fs.exec`,
a laptop session, or a human) get the traps without re-deriving them. Effort: hours, not days. It
also keeps `SKILL.md` honest, since the crib sheet can point at the runbook op instead of growing.

## 7. The gap the archive makes obvious: nothing runs on a schedule

31 cron jobs and 2 automations in the estate; the live recurring duties are an hourly read-only
cluster watch, a daily OOM audit, a pre-shift probe, a daily automation-failure review, and battery
tiers. denops has no scheduler — every run is request-driven — so none of that transfers today. The
natural equivalent is a supervisor timer plus a `watch` connector limited to **open-tier ops only**,
emitting only on state change:

```
watch.list()                                       open
watch.add({name, every, op, args, notify, on: "change"|"always"})   approval
watch.remove({name})                               approval
watch.runs({name, limit})                          open
```

Paired with `notify.send`, that turns denops from a callable toolbox into the duty roster the estate
actually ran. It is also the only recommendation here that changes the server's shape rather than
its surface, so it should be its own decision, not a rider on a connector.

## 8. What not to port

- ~400 research/creative/model-routing skills (`llm-wiki`, `baoyu-*`, `torchtitan`, `mojo-*`, …) —
  no devops content, no ops.
- gateway/agent-platform internals (`openclaw-upkeep`, `gateway-incident-triage`, `hermes-*`,
  `plugin-*`, `skill-workshop-*`) — they operate a platform denops is replacing.
- site-value prose that is already stale (node inventories, IP maps, project ids, label ids). Those
  belong in config/memory or a private runbook file, re-verified before use — several skill files
  say so themselves and one is already four versions behind.
- anything that resets a password, deletes a user or cycles power without an approval summary.

## 9. Suggested sequencing

1. `forgejo` (already researched — finish it) + `prometheus` + `redfish` read ops → answers "did CI
   pass", "what is firing", "is the box alive". All read-tier, no policy risk.
2. `notify.send` + `mattermost` → alerts have somewhere to land.
3. `ad` read ops, then `ad.user.resetPassword` alone (highest value, smallest write surface), then
   create/set/group if it earns it.
4. `caddy` → exposure changes stop being file edits.
5. Decide Tier C (host exec) and the `watch` scheduler on their own merits; both are shape changes.
