# Working on denops (instructions for agents)

This repo is edited both by humans and by LLM agents running through `denops` itself (the `dev`
connector: `fs.*` on a worktree, `dev.run` for tests, `dev.git` for commits, `deploy.promote` to
ship). Read `SKILL.md` before touching anything — it is the contract the served MCP surface is
documented by.

## Keep SKILL.md current (required)

`SKILL.md` is served to models at runtime by the `denops.skill` op. It is the prompt-facing
contract, so it must change in the **same commit** as any of:

- adding/removing/renaming an op, or changing its tier (open/approval), arguments or return shape
- changing capability rules (fs `write`/`exec`, capability prechecks, grant levels)
- changing the approval/replay protocol, error shapes or budgets
- changing the dev/deploy loop, supervisor behaviour or deployment state files
- changing auth (bearer/OAuth), exposure (Caddy, bans) or config keys an agent must know

`tests/skill_test.ts` enforces the mechanical half of this: it fails if `SKILL.md` mentions an op
that does not exist, omits a connector family, or omits a connector's op count. Semantic drift it
cannot catch — review it by hand when you touch behaviour.

House style for `SKILL.md`: keep it under ~120 lines, one crib-sheet entry per connector, concrete
call shapes over prose, and no secrets or host-specific paths.

## Keep CHANGELOG.md current (required)

`CHANGELOG.md` is served by `denops.version` so a run can tell what it is talking to. Append an
entry (newest first, `## <version> — <YYYY-MM-DD>`) in the **same commit** as any change a caller
can observe: an op, an argument, a return shape, a tier, an error contract, the deploy loop. Bump
`version` in `deno.json` when the entry deserves one.

## Before promoting

```bash
deno task check && deno task test    # tests/skill_test.ts is part of this
```

Then `dev.git commit` → `deploy.promote` (a human approves; the supervisor soaks and can
auto-revert). `deploy.status` tells you what is live, what is last-good, and whether a promotion is
pending.

## Conventions

- Ops are declared in `src/connectors/<name>/manifest.ts`; credentials live host-side in
  `client.ts`. Never put a token in an op argument or in a log line.
- New mutating ops default to `tier: "approval"`; add a `summarize(args)` so the approval prompt
  says what will happen in plain words.
- Anything that invalidates an approval (a capability the root lacks, an impossible argument) must
  be rejected by `precheck`/`argSchema`, never after the human clicks approve.
- Payloads are money: project list/get results with the shared `shape.ts` helpers (`fields`/`full`).
- **Permissions are code, not config.** `src/permissions.ts` derives the server's `--allow-*` (for
  `scripts/start.ts`) and dev.try's child envelope. The child executes agent-written code and
  imports the agent's worktree, so its envelope is _pinned_: read = the checkout (+ resolved
  config/secrets), write = the checkout's data dir, net = hosts the **live** config declares, and
  never `--allow-run`, `--allow-all` or a bare `--allow-read`. Never derive it from the dev
  checkout's config.yaml — that file is agent-writable.
- `dev.try` only runs committed code whose tree has a green `checkTask`. Keep the gate on the exit
  code and the tree object (`git rev-parse <state>^{tree}`), never on command output; a cached
  `deno check` prints nothing and is a pass.
