#!/usr/bin/env bash
# live-supervisor.sh — the only thing that decides which commit runs.
#
# Contract (all under <live>/data/):
#   desired-commit   commit the supervisor should run (written by deploy.promote /
#                    deploy.rollback; absent means "keep running last-good")
#   last-good        last commit that started, answered /health, and survived the soak
#   restart-request  written by the deploy connector to ask for a restart
#   deploy.jsonl     append-only audit log of promote/rollback/soak/auto-revert
#
# Behaviour: check out the desired commit detached, warm the module graph, start the
# server, require /health, then soak it. A crash before the soak completes reverts
# to last-good automatically. A crash after it restarts the same commit with backoff.
set -uo pipefail

# systemd starts us with a minimal PATH; deno lives in ~/.deno/bin.
export PATH="${DENOPS_PATH:-$HOME/.deno/bin:/usr/local/bin:/usr/bin:/bin:$PATH}"
export HOME="${HOME:-/home/freebox}"

LIVE="${DENOPS_LIVE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE="$LIVE/data"
HEALTH_URL="${DENOPS_HEALTH_URL:-http://127.0.0.1:3100/health}"
SOAK_SEC="${DENOPS_SOAK_SEC:-60}"
STARTUP_TIMEOUT_SEC="${DENOPS_STARTUP_TIMEOUT_SEC:-25}"
BOOT_TIMEOUT_SEC="${DENOPS_BOOT_TIMEOUT_SEC:-180}"

mkdir -p "$STATE"
log() { printf '%s [supervisor] %s\n' "$(date -Is)" "$*" >&2; }
stop_child() {
  [ -z "$child" ] && return 0
  kill -TERM "-$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null
  for _ in $(seq 1 20); do
    kill -0 "$child" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -KILL "-$child" 2>/dev/null || kill -KILL "$child" 2>/dev/null
  return 0
}

audit() {
  local action="$1" extra="${2:-}"
  printf '{"ts":"%s","action":"%s"%s}\n' "$(date -Is)" "$action" "${extra:+,$extra}" >>"$STATE/deploy.jsonl"
}
read_state() { [ -s "$STATE/$1" ] && tr -d '[:space:]' <"$STATE/$1" || true; }
write_state() { printf '%s\n' "$2" >"$STATE/$1.tmp" && mv "$STATE/$1.tmp" "$STATE/$1"; }

cd "$LIVE" || { log "live dir missing: $LIVE"; exit 1; }

last_good=$(read_state last-good)
if [ -z "$last_good" ]; then
  last_good=$(git -C "$LIVE" rev-parse HEAD 2>/dev/null || true)
  [ -n "$last_good" ] && write_state last-good "$last_good"
fi
log "live=$LIVE last-good=${last_good:-none} soak=${SOAK_SEC}s"

child=""
cleanup() {
  trap - TERM INT
  log "stopping"
  stop_child
  exit 0
}
trap cleanup TERM INT

consecutive_failures=0
while true; do
  desired=$(read_state desired-commit)
  [ -z "$desired" ] && desired=$last_good
  rm -f "$STATE/restart-request"

  if ! git -C "$LIVE" checkout -q --detach "$desired" 2>/dev/null; then
    log "cannot check out $desired; falling back to last-good $last_good"
    audit "auto-revert" "\"from\":\"$desired\",\"to\":\"$last_good\",\"reason\":\"checkout\""
    [ "$desired" = "$last_good" ] && sleep 10
    write_state desired-commit "$last_good"
    continue
  fi
  log "checked out $desired"

  # Warm the module graph up front: an import/lock error is a deploy failure we can
  # attribute to this commit before it ever binds the port.
  if ! timeout "$BOOT_TIMEOUT_SEC" deno cache src/server.ts >/dev/null 2>&1; then
    log "deno cache failed for $desired"
    audit "auto-revert" "\"from\":\"$desired\",\"to\":\"$last_good\",\"reason\":\"deno-cache\""
    if [ "$desired" != "$last_good" ]; then
      write_state desired-commit "$last_good"
    else
      sleep 10
    fi
    continue
  fi

  # expose the running commit to the server (denops.about) and to any child
  DENOPS_COMMIT="$desired" setsid deno task start &
  child=$!

  healthy=0
  for _ in $(seq 1 $((STARTUP_TIMEOUT_SEC * 2))); do
    if curl -fsS -m 1 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
    kill -0 "$child" 2>/dev/null || break
    sleep 0.5
  done

  if [ "$healthy" -ne 1 ]; then
    log "startup failed for $desired"
    audit "auto-revert" "\"from\":\"$desired\",\"to\":\"$last_good\",\"reason\":\"startup\""
    stop_child
    wait "$child" 2>/dev/null
    child=""
    consecutive_failures=$((consecutive_failures + 1))
    if [ "$desired" != "$last_good" ]; then
      write_state desired-commit "$last_good"
    fi
    sleep $(( consecutive_failures > 3 ? 20 : 3 ))
    [ "$consecutive_failures" -gt 6 ] && { log "too many consecutive failures; exiting for systemd"; exit 1; }
    continue
  fi

  # Soak. Until this elapses the commit is not trusted, so a death here reverts.
  soak_end=$(( $(date +%s) + SOAK_SEC ))
  while [ "$(date +%s)" -lt "$soak_end" ]; do
    kill -0 "$child" 2>/dev/null || break
    [ -e "$STATE/restart-request" ] && break
    sleep 1
  done

  if kill -0 "$child" 2>/dev/null && [ "$desired" != "$last_good" ]; then
    last_good=$desired
    write_state last-good "$last_good"
    audit "soak-ok" "\"commit\":\"$desired\",\"soakSec\":$SOAK_SEC"
    log "commit $desired passed the ${SOAK_SEC}s soak and is now last-good"
    # Only a proven commit advances main: a failed promotion never lands there, so a
    # later fast-forward starts from something known to run.
    if git -C "$LIVE" merge-base --is-ancestor main "$desired" 2>/dev/null; then
      if git -C "$LIVE" update-ref refs/heads/main "$desired" 2>/dev/null; then
        audit "main-advanced" "\"commit\":\"$desired\""
        log "main advanced to $desired"
      else
        log "could not advance main to $desired"
      fi
    else
      log "not advancing main: $desired is not a descendant of main"
    fi
    consecutive_failures=0
  fi

  # Supervise: restart requests from the deploy connector, or a crash.
  restart_reason=""
  while kill -0 "$child" 2>/dev/null; do
    if [ -e "$STATE/restart-request" ]; then restart_reason="requested"; break; fi
    sleep 1
  done

  if [ "$restart_reason" = "requested" ]; then
    log "restart requested; signalling the server"
    stop_child
  fi
  wait "$child" 2>/dev/null
  rc=$?
  child=""
  [ -n "$restart_reason" ] && continue

  # Unrequested exit.
  log "server exited (code $rc)"
  audit "crash" "\"commit\":\"$desired\",\"code\":$rc"
  consecutive_failures=$((consecutive_failures + 1))
  if [ "$desired" != "$last_good" ] && [ "$consecutive_failures" -lt 2 ]; then
    log "reverting to last-good $last_good"
    audit "auto-revert" "\"from\":\"$desired\",\"to\":\"$last_good\",\"reason\":\"crash\""
    write_state desired-commit "$last_good"
    sleep 2
  else
    sleep $(( consecutive_failures > 3 ? 20 : 3 ))
  fi
  [ "$consecutive_failures" -gt 6 ] && { log "too many consecutive failures; exiting for systemd"; exit 1; }
done
