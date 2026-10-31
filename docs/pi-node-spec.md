# Spec: `pi` connector — minimal Raspberry Pi / Linux node toolset for denops

Goal: manage a Raspberry Pi (or any small Linux appliance) **without SSH and without a free-form
shell**. denops itself is the only management plane: the node runs denops bound to loopback behind
Caddy (see README "Exposure & brute-force protection"), and the LLM drives the node through a new
enumerated `pi.*` connector — same Code Mode pattern as `gitlab.*` / `mistral.*` / `mail.*`.

Design rules:

1. **No shell op, ever.** There is no `pi.exec`. Absent-by-omission, like SMTP in the imap
   connector. If a task needs a shell, it is not in scope for this connector.
2. **Every mutating op is approval-tier** and additionally gated by a host-side **unit allowlist**
   (denops config), with systemd/polkit as a second layer.
3. **Reads are open-tier** and sourced from world-readable kernel interfaces (`/proc`, `/sys`),
   `statvfs`, or the systemd D-Bus API — never from parsing command output where an API exists.
4. **Result sizes are capped** by the existing `budgets.maxOpResultBytes`; log reads are
   line-capped.

## 1. Transport & privilege model

- denops runs on the Pi as `denops.service` (systemd unit, `Restart=always`, `User=denops` or root —
  see below), listening on `127.0.0.1:3100`, fronted by Caddy with the hardened config from the
  README.
- systemd control goes over the **system D-Bus socket** (`/run/dbus/system_bus_socket`) via
  `npm:dbus-next` talking to `org.freedesktop.systemd1` on PID 1 — no `systemctl` subprocess, no
  shell. Deno permission impact: add `/run/dbus/system_bus_socket` to the `start.ts` allowlist
  (unix-socket connect).
- Power ops use `org.freedesktop.login1.Manager` (`Reboot`/`PowerOff`).

Two privilege options (pick one at provisioning):

- **Appliance mode (simplest):** run denops as root (or `CAP_SYS_ADMIN`). systemd D-Bus allows root
  without polkit prompts.
- **Unprivileged mode:** run as user `denops` (member of `systemd-journal`), and install a polkit
  rule in `/etc/polkit-1/rules.d/49-denops.rules` that grants
  `org.freedesktop.systemd1.manage-units` / `manage-unit-files` / login1 power actions **only for
  allowlisted units and verbs** (`action.lookup("unit")` / `action.lookup("verb")`), e.g.
  `denops.service`, `ssh.service`, `apt-daily-upgrade.service`. The connector enforces the same
  allowlist in code — polkit is the outer gate, the allowlist is the inner one.

## 2. Op set

| Op                       | Tier     | Mechanism                                                                                                                                                                                                                                                          | Args                                                                                           |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `pi.status`              | open     | `/proc/uptime`, `/proc/loadavg`, `/proc/meminfo`, `statvfs("/")`, `/sys/class/thermal/thermal_zone0/temp`, `/proc/device-tree/model`, `/etc/os-release`, existence of `/var/run/reboot-required`, failed units via D-Bus `ListUnits` (filter `ActiveState=failed`) | `{}`                                                                                           |
| `pi.services.list`       | open     | D-Bus `ListUnits` → name, activeState, subState, enabled (via `ListUnitFiles`)                                                                                                                                                                                     | `{ state?: "active"\|"failed"\|"inactive" }`                                                   |
| `pi.services.get`        | open     | D-Bus `GetUnit` + `GetAll` properties (ActiveState, SubState, ExecMainStatus, since, description)                                                                                                                                                                  | `{ unit }` — unit must match allowlist **or** read-only? see note                              |
| `pi.services.control`    | approval | D-Bus `StartUnit`/`StopUnit`/`RestartUnit` mode `"replace"`                                                                                                                                                                                                        | `{ unit, action: "start"\|"stop"\|"restart" }` — unit must be in `connectors.pi.unitAllowlist` |
| `pi.services.setEnabled` | approval | D-Bus `EnableUnitFiles`/`DisableUnitFiles` (+ `Reload`)                                                                                                                                                                                                            | `{ unit, enabled: bool }` — allowlist                                                          |
| `pi.logs.tail`           | open     | fixed-argv `journalctl --no-pager -o json -n <n> -u <unit>` via `--allow-run=/usr/bin/journalctl`, **or** journald via D-Bus; unit allowlist; `n` ≤ `maxLogLines` (default 200)                                                                                    | `{ unit, lines?: int }` — allowlist                                                            |
| `pi.updates.status`      | open     | `/var/run/reboot-required` existence, `/var/lib/apt/lists` mtime, `/var/cache/apt/archives` size (du via dir walk), last unattended-upgrades log tail from `/var/log/unattended-upgrades/unattended-upgrades.log` (line-capped)                                    | `{}`                                                                                           |
| `pi.updates.apply`       | approval | D-Bus `StartUnit("apt-daily-upgrade.service", "replace")` (security upgrades via unattended-upgrades, already installed on Pi OS); optionally then `pi.power.reboot` if `/var/run/reboot-required`                                                                 | `{}`                                                                                           |
| `pi.power.reboot`        | approval | D-Bus login1 `Reboot(false)`                                                                                                                                                                                                                                       | `{}`                                                                                           |
| `pi.power.shutdown`      | approval | D-Bus login1 `PowerOff(false)`                                                                                                                                                                                                                                     | `{}`                                                                                           |
| `pi.network.status`      | open     | `/proc/net/dev` deltas, `/sys/class/net/*/operstate`, `/etc/hostname`, default route via `/proc/net/route`                                                                                                                                                         | `{}`                                                                                           |
| `pi.host.info`           | open     | `/proc/device-tree/model`, `/proc/cpuinfo` Revision/Serial, `/etc/os-release`, kernel from `/proc/version`, vcgencmd `measure_temp`/`get_throttled` via fixed-argv `--allow-run=/usr/bin/vcgencmd`                                                                 | `{}`                                                                                           |

Notes:

- `pi.services.get` / `pi.services.list` are read-only and need **no** allowlist (D-Bus read access
  is world-readable by design); only control/enable/logs are allowlisted.
- Unit-name validation in the connector: `^[A-Za-z0-9@:_.\\-]+\\.(service\|timer\|socket)$`, then
  membership in `connectors.pi.unitAllowlist` (exact string match, no wildcards). The approval
  summary (`summarizeOp`) must name the unit and verb in plain words.
- No `pi.files.*`: file access stays with the existing gitlab/mistral/mail connectors and the data
  dir; the node connector is deliberately about **host state**, not content.

## 3. Config (config.yaml)

```yaml
connectors:
  pi:
    enabled: true
    unitAllowlist: # exact unit names for control/setEnabled/logs
      - denops.service
      - ssh.service
      - apt-daily-upgrade.service
    maxLogLines: 200
    allowPowerOps: true # pi.power.* (default false even when connector enabled)
```

## 4. Deno permission changes (scripts/start.ts)

Add to the allowlist only what the connector needs — no blanket `--allow-run`:

```
--allow-run=/usr/bin/journalctl,/usr/bin/vcgencmd     # fixed-argv only, validated in connector
--allow-read=...,/proc/,/sys/class/thermal/,/sys/class/net/,/proc/net/,/etc/os-release,/etc/hostname,/var/run/reboot-required,/var/log/unattended-upgrades/
--allow-net=...,/run/dbus/system_bus_socket             # unix socket for dbus-next
```

`Deno.Command` must be invoked with a **fixed argv** (no user-controlled strings except the
pre-validated unit name appended as a separate argv element — never through a shell).

## 5. Provisioning a new Pi (no SSH afterwards)

1. Flash **Raspberry Pi OS Lite (Bookworm, 64-bit)** with Raspberry Pi Imager advanced options: set
   user + SSH **public key** (not password), hostname, Wi-Fi. This is the _last_ time SSH is needed.
2. Boot once over SSH, install denops + Caddy, drop the Caddyfile from the README (loopback reverse
   proxy to `127.0.0.1:3100`), install `unattended-upgrades` (security updates on;
   `Automatic-Reboot` off — reboots go through `pi.power.reboot` so they are explicit and logged),
   create `denops.service`, register the connector in Mistral Chat.
3. Verify from chat: `pi.status`, then **dogfood**:
   `pi.services.control { unit:
   "ssh.service", action: "stop" }` +
   `pi.services.setEnabled { unit: "ssh.service",
   enabled: false }` (approval) to close SSH
   permanently. From then on the only inbound is HTTPS → Caddy → denops (bearer token + subnet bans
   from PR #2).

## 6. Failure/edge behavior

- D-Bus unavailable (socket missing / polkit denial): op returns a model-actionable error
  (`"systemd D-Bus denied — check polkit rule / run as root"`), never a hang — wrap D-Bus calls in a
  per-op timeout (reuse `budgets.wallClockMs` mechanics).
- `journalctl` with `--no-pager -o json` — output parsed as JSONL, line-capped, then size-capped by
  `maxOpResultBytes`.
- `pi.updates.apply` is idempotent-ish: if `apt-daily-upgrade.service` is already active, return its
  status instead of queueing a duplicate.
- `pi.power.*` require `allowPowerOps: true` **and** approval **and** (unprivileged mode) the polkit
  login1 rule.

## 7. Tests (tests/pi_connector_test.ts)

- unit-name validation rejects `foo; reboot`, `../x.service`, empty, non-allowlisted
- allowlist enforcement: `pi.services.control` on non-allowlisted unit errors before any D-Bus call
  (mock the D-Bus layer)
- `pi.status` against a fixture proc/sys tree (parameterize base paths for tests)
- `summarizeOp` output for control/power ops includes unit + verb
- journalctl argv construction: unit passed as single argv element, `lines` clamped
- tier checks: control/setEnabled/power = approval, status/list/logs = open

## 8. Out of scope (deliberately)

- package install/remove beyond security updates (`apt install` = supply-chain surface; go through a
  curated image or GitLab CI-built images instead)
- arbitrary file read/write on the node, user management, firewall edits, shell exec
- GPIO/hardware control (needs device perms; add later as explicit `pi.gpio.*` if needed)
