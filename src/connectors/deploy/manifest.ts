import { compose, optStr, rejectUnknown } from "../../harness/args.ts";
import { execSummary, runArgv } from "../../harness/exec.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
import { type DevRootConfig } from "../dev/manifest.ts";

// Deploy works with the supervisor (scripts/live-supervisor.sh), never instead of
// it: this connector records intent ("run commit X") and asks the supervisor to
// restart. The supervisor decides what actually runs, checks /health, soaks, and
// auto-reverts; that is the part that still works when the new code does not.
export interface DeployConfig {
  /** Live checkout (detached at the commit named by data/desired-commit). */
  liveDir: string;
  /** Branch the agent works on, merged fast-forward into main on promote. */
  devBranch: string;
  /** Dev root used for the promotion gate. */
  devRoot: DevRootConfig;
  /** Directory holding desired-commit / last-good / deploy.jsonl (the live data dir). */
  stateDir: string;
  /** Git identity used for the merge commit-free ff merge (none needed) / audits. */
  timeoutMs?: number;
}

const AUDIT = "deploy.jsonl";

export function deployConnector(cfg: DeployConfig): Connector {
  const timeoutMs = cfg.timeoutMs ?? 180_000;
  const state = (name: string) => `${cfg.stateDir}/${name}`;

  const readState = async (name: string): Promise<string> => {
    try {
      return (await Deno.readTextFile(state(name))).trim();
    } catch {
      return "";
    }
  };
  const writeState = async (name: string, value: string): Promise<void> => {
    await Deno.mkdir(cfg.stateDir, { recursive: true });
    const tmp = `${state(name)}.tmp`;
    await Deno.writeTextFile(tmp, `${value}\n`);
    await Deno.rename(tmp, state(name));
  };
  const audit = async (entry: Record<string, unknown>): Promise<void> => {
    await Deno.mkdir(cfg.stateDir, { recursive: true });
    await Deno.writeTextFile(
      state(AUDIT),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      { append: true },
    );
  };

  const git = async (args: string[], cwd = cfg.liveDir) =>
    await runArgv(["git", ...args], { cwd, timeoutMs: 60_000, maxBytes: 16 * 1024 });

  const liveSha = async (): Promise<string> => (await git(["rev-parse", "HEAD"])).stdout.trim();
  const devSha = async (): Promise<string> =>
    (await git(["rev-parse", cfg.devBranch])).stdout.trim();
  // Untracked files cannot enter a commit, so they must not block a promotion —
  // scratch files in the dev worktree are normal. Modified/staged tracked files do.
  const isDirty = async (cwd: string): Promise<boolean> =>
    (await git(["status", "--porcelain", "--untracked-files=no"], cwd)).stdout.trim() !== "";
  const untrackedCount = async (cwd: string): Promise<number> =>
    (await git(["ls-files", "--others", "--exclude-standard"], cwd)).stdout.trim().split("\n")
      .filter(Boolean).length;

  const recentDeploys = async (n: number): Promise<JsonValue[]> => {
    let text = "";
    try {
      text = await Deno.readTextFile(state(AUDIT));
    } catch {
      return [];
    }
    return text.trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l) as JsonValue);
  };

  return {
    id: "deploy",
    ops: [
      {
        name: "deploy.status",
        tier: "open",
        doc:
          "Deployment state: live commit (running), desired commit (next start), last-good (last soak-verified), dev branch sha, ahead/behind, dirty trees, recent deploys, and whether a restart is pending. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "deploy.promote",
        tier: "approval",
        summarize: async () => {
          const dev = await devSha();
          const subject = (await git(["log", "-1", "--format=%s", dev])).stdout.trim();
          const stat = (await git(["diff", "--stat", `main..${dev}`])).stdout.trim();
          const changed = (await git(["diff", "--name-only", `main..${dev}`])).stdout
            .trim().split("\n").filter(Boolean);
          const testsTouched = changed.filter((f) => f.startsWith("tests/"));
          return [
            `Ship ${dev.slice(0, 12)} to live: "${subject}"`,
            stat.split("\n").slice(-1)[0] ?? "",
            changed.length
              ? `files: ${changed.slice(0, 12).join(", ")}${
                changed.length > 12 ? `, +${changed.length - 12} more` : ""
              }`
              : "",
            testsTouched.length ? `NOTE: touches ${testsTouched.length} test file(s)` : "",
            "Runs the dev root's `test` task first; the supervisor reverts if it fails to stay up.",
          ].filter(Boolean).join("\n");
        },
        doc:
          "Ship the dev branch: runs the dev root's `test` task, fast-forwards main to it, records the new commit as desired, and asks the supervisor to restart. The human approval summary names the commit, its message and the test result. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "deploy.rollback",
        tier: "approval",
        summarize: async (a) => {
          const requested = String((a as { commit?: string }).commit ?? "").trim();
          const target = requested || (await readState("last-good")) || "(no last-good recorded)";
          const subject = /^[0-9a-f]{7,40}$/.test(target)
            ? (await git(["log", "-1", "--format=%s", target])).stdout.trim()
            : "";
          return `Restart live on ${target.slice(0, 12)}${subject ? ` ("${subject}")` : ""}${
            requested ? " (explicit sha)" : " (last known good)"
          }.`;
        },
        doc:
          "Roll back: set the desired commit to last-good (or an explicit sha from the deploy log) and ask the supervisor to restart. args: { commit? }",
        argSchema: compose(rejectUnknown(), optStr("commit", 64)),
      },
    ],
    client: (_ctx: HostContext) => ({
      "status": async () => {
        const live = await liveSha();
        const dev = await devSha();
        const desired = await readState("desired-commit");
        const lastGood = await readState("last-good");
        const ahead = await git(["rev-list", "--count", `HEAD..${cfg.devBranch}`]);
        const behind = await git(["rev-list", "--count", `${cfg.devBranch}..HEAD`]);
        const shortlog = await git(["log", "--oneline", "-n", "5", `HEAD..${cfg.devBranch}`]);
        let restartPending = true;
        try {
          await Deno.stat(state("restart-request"));
        } catch {
          restartPending = false;
        }
        return {
          liveCommit: live,
          desiredCommit: desired === "" ? live : desired,
          lastGood: lastGood === "" ? null : lastGood,
          devBranch: cfg.devBranch,
          devCommit: dev,
          devAhead: Number(ahead.stdout.trim() || 0),
          devBehind: Number(behind.stdout.trim() || 0),
          pendingCommits: shortlog.stdout.trim().split("\n").filter(Boolean),
          liveDirty: await isDirty(cfg.liveDir),
          mainCommit: (await git(["rev-parse", "main"])).stdout.trim(),
          devDirty: await isDirty(cfg.devRoot.path),
          devUntracked: await untrackedCount(cfg.devRoot.path),
          restartPending,
          recentDeploys: await recentDeploys(5),
        } as JsonValue;
      },

      "promote": async () => {
        if (await isDirty(cfg.devRoot.path)) {
          throw new Error(
            `refusing to promote: ${cfg.devRoot.path} has uncommitted changes to tracked files ` +
              `(commit or revert them; untracked scratch files are fine)`,
          );
        }
        const target = await devSha();
        const live = await liveSha();
        if (target === live) throw new Error("nothing to promote: dev branch is already live");

        // Gate: the project's own test task, run by us rather than trusted from the
        // caller. A red suite never reaches the tree that runs in production.
        const testArgv = cfg.devRoot.tasks["test"];
        if (!testArgv) throw new Error("dev root declares no `test` task; cannot gate promotion");
        const tests = await runArgv(testArgv, {
          cwd: cfg.devRoot.path,
          timeoutMs,
          maxBytes: 32 * 1024,
        });
        await audit({
          action: "promote-test",
          commit: target,
          code: tests.code,
          timedOut: tests.timedOut,
        });
        if (tests.code !== 0) {
          throw new Error(
            `refusing to promote: \`${testArgv.join(" ")}\` failed (code ${tests.code})\n${
              tests.stdout.slice(-1500)
            }\n${tests.stderr.slice(-1500)}`,
          );
        }

        // main is NOT touched here: the supervisor advances it only after the new
        // commit passes its soak, so a broken commit never lands on the branch that
        // a later promotion fast-forwards from.
        const now = target;
        await writeState("desired-commit", now);
        await writeState("restart-request", now);
        await audit({ action: "promote", commit: now, previous: live, tests: tests.code });
        return {
          status: "restart_requested",
          from: live,
          to: now,
          tests: { code: tests.code, stdout: tests.stdout.slice(-800) },
          note:
            "The supervisor restarts into this commit, probes /health, and soaks it. On success it advances main to this commit and records it as last-good; on failure it reverts to last-good and main is untouched.",
        } as JsonValue;
      },

      "rollback": async (a) => {
        const requested = String((a as { commit?: string }).commit ?? "").trim();
        const lastGood = await readState("last-good");
        const target = requested === "" ? lastGood : requested;
        if (target === "") {
          throw new Error("no last-good commit recorded yet and no commit given");
        }
        if (!/^[0-9a-f]{7,40}$/.test(target)) throw new Error("commit: expected a git sha");
        const exists = await git(["cat-file", "-e", `${target}^{commit}`]);
        if (exists.code !== 0) throw new Error(`unknown commit ${target}`);
        const live = await liveSha();
        await writeState("desired-commit", target);
        await writeState("restart-request", target);
        await audit({
          action: "rollback",
          commit: target,
          previous: live,
          requested: requested || "last-good",
        });
        return {
          status: "restart_requested",
          from: live,
          to: target,
          note: "The supervisor restarts into this commit and re-verifies /health.",
        } as JsonValue;
      },
    }),
    validateStartup: async () => {
      const r = await git(["rev-parse", "--git-dir"]);
      if (r.code !== 0) throw new Error(`deploy.liveDir is not a git checkout: ${cfg.liveDir}`);
    },
  };
}

export function deployConfigFrom(
  raw: Record<string, unknown>,
  devRoots: DevRootConfig[],
  stateDir: string,
): DeployConfig | null {
  if (raw.enabled !== true && raw.enabled !== "true") return null;
  const liveDir = String(raw.liveDir ?? "");
  if (!liveDir) throw new Error("connectors.deploy.liveDir is required");
  const devRootName = raw.devRoot ? String(raw.devRoot) : "";
  const devRoot = devRootName ? devRoots.find((r) => r.name === devRootName) : devRoots[0];
  if (!devRoot) throw new Error("connectors.deploy requires a dev root (see connectors.dev.roots)");
  return {
    liveDir,
    devBranch: String(raw.devBranch ?? "agent/dev"),
    devRoot,
    stateDir,
    timeoutMs: raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs),
  };
}

export { execSummary };
