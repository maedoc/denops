import { compose, optStr, rejectUnknown, str } from "../../harness/args.ts";
import { execSummary, runArgv } from "../../harness/exec.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";

// The dev connector lets an agent work on *code* without a shell: it runs the
// project's declared task table (argv only, never a shell), a small fixed set of
// git commands, and a single op from the project's own registry. Everything the
// agent can invoke is enumerated in config.yaml by the operator.
export interface DevRootConfig {
  name: string;
  path: string;
  /** task name -> argv. No shell: argv[0] is the program. */
  tasks: Record<string, string[]>;
}

const MAX_TASKS = 20;
const MAX_ARGV = 24;

const GIT_ACTIONS = ["status", "diff", "log", "commit"] as const;
type GitAction = typeof GIT_ACTIONS[number];

export function devConnector(opts: { roots: DevRootConfig[]; timeoutMs?: number }): Connector {
  const roots = new Map(opts.roots.map((r) => [r.name, r]));
  const timeoutMs = opts.timeoutMs ?? 180_000;

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
          "Run one of a root's declared tasks (e.g. check, test, fmt, lint) and return { code, stdout, stderr }. args: { root, task }. No shell: the argv comes from config.yaml.",
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
          "Execute one open-tier op from this root's own registry (the code you just edited) against the real API, returning its result. args: { root, op, args }. Approval-tier ops are refused: promote them instead.",
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
        ctx.log({ connector: "dev", op: "dev.run", args: { root, task, argv } });
        return execSummary(await runArgv(argv, { cwd: r.path, timeoutMs }));
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
        ctx.log({ connector: "dev", op: "dev.try", args: { root, op } });
        const argv = [
          "deno",
          "run",
          "--allow-all",
          `${r.path}/scripts/dev_try.ts`,
          r.path,
          op,
          JSON.stringify(args),
        ];
        return execSummary(
          await runArgv(argv, {
            cwd: r.path,
            timeoutMs,
            maxBytes: 96 * 1024,
          }),
        );
      },
    }),
    validateStartup: () => Promise.resolve(),
  };
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
    out.push({ name, path, tasks });
  }
  return out;
}
