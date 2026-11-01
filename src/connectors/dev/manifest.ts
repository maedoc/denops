import { parseYaml } from "../../config.ts";
import { compose, optStr, rejectUnknown, str } from "../../harness/args.ts";
import { execSummary, runArgv } from "../../harness/exec.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
import { permissionFlags, tryPermissions } from "../../permissions.ts";

// The dev connector lets an agent work on *code* without a shell: it runs the
// project's declared task table (argv only, never a shell), a small fixed set of
// git commands, and a single op from the project's own registry. Everything the
// agent can invoke is enumerated in config.yaml by the operator.
export interface DevRootConfig {
  name: string;
  path: string;
  /** task name -> argv. No shell: argv[0] is the program. */
  tasks: Record<string, string[]>;
  /** task dev.try requires to have passed for this exact commit (default "check") */
  checkTask?: string;
}

const MAX_TASKS = 20;
const MAX_ARGV = 24;

const GIT_ACTIONS = ["status", "diff", "log", "commit"] as const;
type GitAction = typeof GIT_ACTIONS[number];

/** One dev.run outcome, keyed to the tree it was produced from. */
interface CheckRecord {
  task: string;
  code: number;
  /** commit the check ran at (informational: the tree is what gates dev.try) */
  sha: string;
  /** `git rev-parse <state>^{tree}` — the content the check actually saw */
  tree: string;
  at: string;
  durationMs: number;
}

export interface DevConnectorOptions {
  roots: DevRootConfig[];
  timeoutMs?: number;
  /**
   * Hosts the dev.try child may reach. Comes from the LIVE config (operator-owned),
   * never from the dev checkout's own config.yaml, which the agent can edit.
   */
  tryNet?: string[];
  /** Require a green checkTask for HEAD before dev.try (default true). */
  requireCheck?: boolean;
}

export function devConnector(opts: DevConnectorOptions): Connector {
  const roots = new Map(opts.roots.map((r) => [r.name, r]));
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const tryNet = opts.tryNet ?? [];
  const requireCheck = opts.requireCheck !== false;
  // Check results live in memory: a server restart invalidates them, which is what we
  // want (the envelope, the code and the process all changed).
  const checks = new Map<string, CheckRecord>();
  const rootOf = (name: unknown): DevRootConfig => {
    const r = roots.get(String(name));
    if (!r) {
      throw new Error(
        `unknown dev root ${JSON.stringify(name)}; configured: ${
          [...roots.keys()].join(", ") || "none"
        }`,
      );
    }
    return r;
  };

  return {
    id: "dev",
    ops: [
      {
        name: "dev.roots",
        tier: "open",
        doc: "List configured dev roots with their runnable tasks and paths. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "dev.run",
        tier: "open",
        doc:
          "Run one of a root's declared tasks (e.g. check, test, fmt, lint) and return { code, stdout, stderr, sha, subject, dirty }. args: { root, task }. No shell: the argv comes from config.yaml. The outcome is recorded against the tree it ran on (exit code + git tree object); dev.try requires a green `check` for the current tree.",
        argSchema: compose(rejectUnknown(), str("root"), str("task")),
      },
      {
        name: "dev.git",
        tier: "open",
        summarize: (a) => {
          const { root, action, message } = a as { root: string; action: string; message?: string };
          return action === "commit"
            ? `git commit -am "${message}" in dev root ${root}`
            : `git ${action} in dev root ${root}`;
        },
        doc:
          "Fixed git verbs in a dev root. args: { root, action: 'status'|'diff'|'log'|'commit', message? } (message required for commit). Returns { code, stdout, stderr }.",
        argSchema: compose(
          rejectUnknown(),
          str("root"),
          (a) => {
            const action = (a as { action?: unknown }).action;
            return GIT_ACTIONS.includes(action as GitAction)
              ? null
              : `action: expected one of ${GIT_ACTIONS.join(", ")}`;
          },
          optStr("message", 500),
          (a) => {
            const { action, message } = a as { action?: string; message?: string };
            if (action === "commit" && !message) return "message: required for commit";
            if (message !== undefined && /\n/.test(message)) {
              return "message: must be a single line";
            }
            return null;
          },
        ),
      },
      {
        name: "dev.try",
        tier: "open",
        doc:
          "Execute one open-tier op from this root's own registry against the real API, returning { code, stdout, stderr, commit, subject, dirty, check }. args: { root, op, args }. Committed code only: refuses a dirty tracked tree, and refuses unless the root's check task passed for the current tree (a green check before committing the same content still counts). The child runs with a pinned envelope: read=the dev root (+ its secrets symlink), write=its data dir, net=the live config's hosts, no subprocesses. Approval-tier ops are refused: promote them instead.",
        argSchema: compose(
          rejectUnknown(),
          str("root"),
          str("op"),
          (a) => {
            const op = (a as { op?: unknown }).op;
            if (typeof op === "string" && !/^[a-z][a-z0-9_.]*\.[a-z][a-z0-9_.]*$/i.test(op)) {
              return "op: expected '<connector>.<method>'";
            }
            return null;
          },
        ),
      },
    ],
    client: (ctx: HostContext) => ({
      "roots": () =>
        Promise.resolve({
          roots: [...roots.values()].map((r) => ({
            name: r.name,
            path: r.path,
            tasks: Object.keys(r.tasks),
            checkTask: r.checkTask ?? "check",
          })),
        } as JsonValue),

      "run": async (a) => {
        const { root, task } = a as { root: string; task: string };
        const r = rootOf(root);
        const argv = r.tasks[task];
        if (!argv || argv.length === 0) {
          throw new Error(
            `unknown task ${JSON.stringify(task)} for root ${r.name}; configured: ${
              Object.keys(r.tasks).join(", ") || "none"
            }`,
          );
        }
        if (argv.length > MAX_ARGV) throw new Error(`task ${task}: argv too long`);
        const snap = await snapshot(r);
        ctx.log({ connector: "dev", op: "dev.run", args: { root, task, argv } });
        const res = await runArgv(argv, { cwd: r.path, timeoutMs });
        // Provenance is keyed on the exit code and the tree, never on the output:
        // `deno check` prints nothing when it hits its cache, and that is a pass. The
        // tree is the *content*, so checking before committing the same thing counts.
        checks.set(r.name, {
          task,
          code: res.code,
          sha: snap.sha,
          tree: snap.tree,
          at: new Date().toISOString(),
          durationMs: res.durationMs,
        });
        return { ...(execSummary(res) as Record<string, JsonValue>), ...snap } as JsonValue;
      },

      "git": async (a) => {
        const { root, action, message } = a as {
          root: string;
          action: GitAction;
          message?: string;
        };
        const r = rootOf(root);
        const argv = ["git", "-C", r.path];
        switch (action) {
          case "status":
            argv.push("status", "--short", "--branch");
            break;
          case "diff":
            argv.push("diff", "--stat", "--", ".");
            break;
          case "log":
            argv.push("log", "--oneline", "-n", "15");
            break;
          case "commit":
            // -am is deliberate: staged-then-forgotten files silently drop out of
            // a promotion otherwise. No flags come from the caller.
            argv.push("commit", "-am", String(message));
            break;
          default:
            throw new Error(`unsupported git action ${String(action)}`);
        }
        ctx.log({ connector: "dev", op: "dev.git", args: { root, action } });
        return execSummary(await runArgv(argv, { cwd: r.path, timeoutMs: 60_000 }));
      },

      "try": async (a) => {
        const { root, op } = a as { root: string; op: string; args?: JsonValue };
        const r = rootOf(root);
        const args = ((a as { args?: JsonValue }).args ?? {}) as JsonValue;

        // Committed, checked code only. The child imports the checkout's own modules, so
        // "what ran" has to be content a reviewer can see in the promotion diff — and a
        // green `check` has to describe that same content.
        const snap = await snapshot(r);
        if (!snap.sha) {
          throw new Error(
            `dev.try: ${r.path} is not a usable git checkout (${snap.error ?? "no HEAD"})`,
          );
        }
        if (snap.dirty) {
          throw new Error(
            `dev.try refuses root ${r.name}: tracked files are modified. It runs committed ` +
              `code only, so the result can be attributed to a commit and reviewed in the ` +
              `promotion diff — commit first (dev.git {action:"commit", message}) and retry.`,
          );
        }
        const checkTask = r.checkTask ?? "check";
        const rec = checks.get(r.name);
        if (requireCheck) {
          if (!r.tasks[checkTask]) {
            throw new Error(
              `dev.try needs a "${checkTask}" task in dev root ${r.name}; configured: ${
                Object.keys(r.tasks).join(", ") || "none"
              }`,
            );
          }
          if (!rec || rec.task !== checkTask) {
            throw new Error(
              `dev.try needs a green "${checkTask}" for this code: run ` +
                `dev.run({root:"${r.name}", task:"${checkTask}"}) first, then retry.`,
            );
          }
          if (rec.tree !== snap.tree) {
            throw new Error(
              `dev.try: the last "${checkTask}" ran on different code (tree ${
                rec.tree.slice(0, 12) || "(unknown)"
              }, HEAD is ${snap.sha.slice(0, 12)} / tree ${
                snap.tree.slice(0, 12)
              }) — run the ${checkTask} task again for this commit.`,
            );
          }
          if (rec.code !== 0) {
            throw new Error(
              `dev.try: the last "${checkTask}" for ${snap.sha.slice(0, 12)} exited ${rec.code}` +
                ` — fix it before trying the op.`,
            );
          }
        }

        // The envelope is pinned (src/permissions.ts): the dev config is agent-writable
        // and must not be able to widen it. Only its dataDir is honoured, confined.
        const devCfg = await readDevConfig(r);
        const plan = tryPermissions({
          devRoot: r.path,
          dataDir: devCfg.dataDir,
          readExtra: await realPathsOf(r.path),
          net: tryNet,
        });
        ctx.log({
          connector: "dev",
          op: "dev.try",
          args: { root, op, commit: snap.sha, subject: snap.subject, dirty: snap.dirty },
        });
        const argv = [
          Deno.execPath(),
          "run",
          ...permissionFlags(plan),
          `${r.path}/scripts/dev_try.ts`,
          r.path,
          op,
          JSON.stringify(args),
        ];
        const res = await runArgv(argv, {
          cwd: r.path,
          timeoutMs,
          maxBytes: 96 * 1024,
        });
        return {
          ...(execSummary(res) as Record<string, JsonValue>),
          op,
          commit: snap.sha,
          subject: snap.subject,
          dirty: snap.dirty,
          check: rec
            ? { task: rec.task, code: rec.code, at: rec.at, durationMs: rec.durationMs }
            : null,
        } as JsonValue;
      },
    }),
    validateStartup: () => Promise.resolve(),
  };

  // HEAD sha + subject + whether tracked files differ from it. Tolerates a non-git or
  // unreadable root by reporting it (`sha: ""`, `dirty: true`), never by guessing.
  async function snapshot(r: DevRootConfig): Promise<{
    sha: string;
    subject: string;
    dirty: boolean;
    tree: string;
    error?: string;
  }> {
    const head = await gitAt(r.path, ["log", "-1", "--format=%H%n%s"]);
    if (head.code !== 0) {
      return {
        sha: "",
        subject: "",
        dirty: true,
        tree: "",
        error: head.stderr.trim().slice(0, 200) || `git exited ${head.code}`,
      };
    }
    const [sha = "", subject = ""] = head.stdout.split("\n");
    // Untracked scratch files cannot enter a commit, so they cannot change what the
    // child runs; modified/staged tracked files can, and must block.
    const status = await gitAt(r.path, ["status", "--porcelain", "--untracked-files=no"]);
    const dirty = status.code !== 0 || status.stdout.trim() !== "";
    // The tree is the content, not the commit: a check made before committing that same
    // content still describes it. `git stash create` builds that tree without touching
    // the worktree, the index or any ref (its commit is unreferenced, so gc collects
    // it); `^{tree}` turns it into the content address we compare against HEAD's.
    let tree = "";
    if (dirty) {
      const stash = (await gitAt(r.path, ["stash", "create"])).stdout.trim();
      if (stash) {
        tree = (await gitAt(r.path, ["rev-parse", `${stash}^{tree}`])).stdout.trim();
      }
    } else {
      tree = (await gitAt(r.path, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    }
    return { sha: sha.trim(), subject: subject.trim(), dirty, tree };
  }

  async function gitAt(path: string, args: string[]) {
    return await runArgv(["git", "-C", path, ...args], { timeoutMs: 60_000, maxBytes: 16 * 1024 });
  }

  // The checkout's own config: it names the data dir the child is allowed to write,
  // and its presence is what makes dev.try runnable at all.
  async function readDevConfig(r: DevRootConfig): Promise<{ dataDir?: string }> {
    const path = `${r.path}/config.yaml`;
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      throw new Error(
        `dev.try needs ${path} (the dev checkout's own config, with dataDir and the ` +
          `connectors under test); see the README's "Develop without a shell" section.`,
      );
    }
    const cfg = parseYaml(text);
    const dataDir = cfg.dataDir === undefined ? undefined : String(cfg.dataDir);
    return { dataDir };
  }

  // config.yaml / secrets.json may be symlinks (the dev secrets usually are, pointing
  // at the live file outside the checkout). Deno resolves symlinks before checking
  // permissions, so the real targets have to be in the read allowlist.
  async function realPathsOf(root: string): Promise<string[]> {
    const out: string[] = [];
    for (const name of ["config.yaml", "secrets.json"]) {
      try {
        out.push(await Deno.realPath(`${root}/${name}`));
      } catch { /* absent: the child reports that itself */ }
    }
    return out;
  }
}

export function devRootsFromConfig(raw: unknown): DevRootConfig[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: DevRootConfig[] = [];
  for (const entry of arr.slice(0, 10)) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const name = String(r.name ?? "");
    const path = String(r.path ?? "");
    if (!name || !path) throw new Error("dev.roots[]: name and path are required");
    if (out.some((x) => x.name === name)) throw new Error(`dev.roots: duplicate name ${name}`);
    const tasksRaw = (r.tasks ?? {}) as Record<string, unknown>;
    const tasks: Record<string, string[]> = {};
    const names = Object.keys(tasksRaw);
    if (names.length > MAX_TASKS) {
      throw new Error(`dev.roots[${name}].tasks: too many (${names.length})`);
    }
    for (const t of names) {
      const argv = tasksRaw[t];
      if (!Array.isArray(argv) || argv.length === 0 || argv.some((x) => typeof x !== "string")) {
        throw new Error(
          `dev.roots[${name}].tasks.${t}: expected a non-empty argv array of strings`,
        );
      }
      tasks[t] = argv as string[];
    }
    const checkTask = r.checkTask === undefined ? undefined : String(r.checkTask);
    if (checkTask !== undefined && !tasks[checkTask]) {
      throw new Error(
        `dev.roots[${name}].checkTask: ${JSON.stringify(checkTask)} is not a configured task`,
      );
    }
    out.push({ name, path, tasks, ...(checkTask === undefined ? {} : { checkTask }) });
  }
  return out;
}
