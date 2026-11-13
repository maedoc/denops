import { compose, optStr, rejectUnknown } from "../../harness/args.ts";
import { runArgv } from "../../harness/exec.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";

// Deploy works with the supervisor (scripts/live-supervisor.sh), never instead of
// it: this connector records intent ("run commit X") and asks the supervisor to
// restart. The supervisor decides what actually runs, checks /health, soaks, and
// auto-reverts; that is the part that still works when the new code does not.
//
// Development happens on the laptop and ships through origin: push origin main
// (after the local gate), then deploy.promote fetches, tests in a throwaway
// worktree under the data dir, and hands the commit to the supervisor. There is
// no agent-writable checkout on this host: the code that runs is whatever main
// on origin says, gated here, soaked by the supervisor.
export interface DeployConfig {
  /** Live checkout (detached at the commit named by data/desired-commit). */
  liveDir: string;
  /** The promotion gate: argv run against a fresh worktree of origin/main. */
  testArgv: string[];
  /** Directory holding desired-commit / last-good / deploy.jsonl (the live data dir). */
  stateDir: string;
  timeoutMs?: number;
}

const AUDIT = "deploy.jsonl";
const TEST_WORKTREE = "promote-test";

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

  /** Fetch origin/main; throw with the git stderr if the remote is unreachable. */
  const fetchOrigin = async (): Promise<string> => {
    const r = await git(["fetch", "origin", "main"]);
    if (r.code !== 0) {
      throw new Error(`git fetch origin main failed: ${r.stderr.trim().slice(-500)}`);
    }
    const sha = await git(["rev-parse", "origin/main"]);
    if (sha.code !== 0) throw new Error("origin/main has no commits after fetch");
    return sha.stdout.trim();
  };

  // The promotion gate runs the test suite in a throwaway worktree of the exact
  // commit under a human-approved promote op: not a served fs root, recreated from
  // refs each time, never the live tree.
  const withTestWorktree = async (
    target: string,
    fn: (dir: string) => Promise<void>,
  ): Promise<void> => {
    const dir = state(TEST_WORKTREE);
    // A previous run that crashed mid-cleanup must not wedge the next one.
    await git(["worktree", "remove", "--force", dir]);
    const add = await git(["worktree", "add", "-q", "--detach", dir, target]);
    if (add.code !== 0) {
      throw new Error(
        `could not create the test worktree for ${target}: ${add.stderr.slice(-400)}`,
      );
    }
    try {
      await fn(dir);
    } finally {
      await git(["worktree", "remove", "--force", dir]);
    }
  };

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
          "Deployment state: live commit (running), desired commit (next start), last-good (last soak-verified), origin/main after a best-effort fetch, pending commits, and whether a restart is pending. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "deploy.promote",
        tier: "approval",
        summarize: async () => {
          const live = await liveSha();
          const target = await fetchOrigin();
          const subject = (await git(["log", "-1", "--format=%s", target])).stdout.trim();
          const stat = (await git(["diff", "--stat", `${live}..${target}`])).stdout.trim();
          const changed = (await git(["diff", "--name-only", `${live}..${target}`])).stdout
            .trim().split("\n").filter(Boolean);
          const testsTouched = changed.filter((f) => f.startsWith("tests/"));
          return [
            `Ship origin/main ${target.slice(0, 12)} to live: "${subject}"`,
            stat.split("\n").slice(-1)[0] ?? "",
            changed.length
              ? `files: ${changed.slice(0, 12).join(", ")}${
                changed.length > 12 ? `, +${changed.length - 12} more` : ""
              }`
              : "",
            testsTouched.length ? `NOTE: touches ${testsTouched.length} test file(s)` : "",
            "Runs the test suite in a throwaway worktree first; the supervisor reverts if it fails to stay up.",
          ].filter(Boolean).join("\n");
        },
        doc:
          "Ship origin/main: fetches, refuses a non-fast-forward, runs the test suite in a throwaway worktree, records the commit as desired, and asks the supervisor to restart. The human approval summary names the commit, its message and the files. args: {}",
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
        const originMain = await fetchOrigin().catch(() => "");
        const desired = await readState("desired-commit");
        const lastGood = await readState("last-good");
        const pendingCommits = originMain === ""
          ? []
          : (await git(["log", "--oneline", "-n", "10", `HEAD..${originMain}`])).stdout.trim()
            .split("\n").filter(Boolean);
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
          mainCommit: (await git(["rev-parse", "main"])).stdout.trim(),
          originMain: originMain === "" ? null : originMain,
          pendingCommits,
          restartPending,
          recentDeploys: await recentDeploys(5),
        } as JsonValue;
      },

      "promote": async () => {
        const live = await liveSha();
        const target = await fetchOrigin();
        if (target === live) throw new Error("nothing to promote: origin/main is already live");

        const ff = await git(["merge-base", "--is-ancestor", "main", target]);
        if (ff.code !== 0) {
          throw new Error(
            `refusing to promote: origin/main ${target.slice(0, 12)} is not a descendant of main ` +
              `(a non-fast-forward needs a human looking at the history first)`,
          );
        }

        // Gate: the project's own test task, run by us against the exact commit in
        // a throwaway worktree. A red suite never reaches the tree that runs in
        // production.
        let tests = { code: 0, stdout: "", stderr: "", timedOut: false };
        try {
          await withTestWorktree(target, async (dir) => {
            tests = await runArgv(cfg.testArgv, {
              cwd: dir,
              timeoutMs,
              maxBytes: 32 * 1024,
            });
          });
        } catch (e) {
          throw new Error(`test worktree setup failed: ${e instanceof Error ? e.message : e}`);
        }
        await audit({
          action: "promote-test",
          commit: target,
          code: tests.code,
          timedOut: tests.timedOut,
        });
        if (tests.code !== 0) {
          throw new Error(
            `refusing to promote: \`${cfg.testArgv.join(" ")}\` failed (code ${tests.code})\n${
              tests.stdout.slice(-1500)
            }\n${tests.stderr.slice(-1500)}`,
          );
        }

        // main is NOT touched here: the supervisor advances it only after the new
        // commit passes its soak, so a broken commit never lands on the branch that
        // a later promotion fast-forwards from.
        await writeState("desired-commit", target);
        await writeState("restart-request", target);
        await audit({ action: "promote", commit: target, previous: live, tests: tests.code });
        return {
          status: "restart_requested",
          from: live,
          to: target,
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
  stateDir: string,
): DeployConfig | null {
  if (raw.enabled !== true && raw.enabled !== "true") return null;
  const liveDir = String(raw.liveDir ?? "");
  if (!liveDir) throw new Error("connectors.deploy.liveDir is required");
  const testArgv = Array.isArray(raw.testArgv) && raw.testArgv.every((a) => typeof a === "string")
    ? (raw.testArgv as string[])
    : ["deno", "task", "test"];
  return {
    liveDir,
    testArgv,
    stateDir,
    timeoutMs: raw.timeoutMs === undefined ? undefined : Number(raw.timeoutMs),
  };
}
