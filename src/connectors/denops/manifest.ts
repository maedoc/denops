import { compose, optNum, optStr, rejectUnknown } from "../../harness/args.ts";
import { isManifest, isOpEntry, type LogLine, RunLog } from "../../harness/log.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";

// After `about` and `skill`, this connector is the server's self-report: what is
// running (version + changelog), what it has been doing (the op log, redacted), and
// how much budget is left in the current run. All read-only.
export interface DenopsConnectorOptions {
  skillPath: string;
  version: string;
  commit?: string;
  /** Connector families this deployment exposes, for denops.about. */
  connectors: () => string[];
  /** Runtime state dir (holds runs/<id>.jsonl) for denops.oplog. */
  dataDir?: string;
  /** CHANGELOG.md path, relative to the live checkout. */
  changelogPath?: string;
  /** Live budget of the run in flight, if a harness is attached. */
  budget?: () => Record<string, JsonValue>;
}

const MAX_ERROR_CHARS = 240;

function redact(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_ERROR_CHARS ? `${flat.slice(0, MAX_ERROR_CHARS)}…` : flat;
}

/** One run, as an auditor needs it: what ran, in order, and how it ended. */
export function summarizeRun(runId: string, lines: LogLine[]): JsonValue {
  const manifest = lines.find(isManifest);
  const ops = lines.filter(isOpEntry).map((e) => ({
    seq: e.seq,
    op: e.op,
    status: e.status,
    ...(e.argsSummary ? { argsBytes: e.argsSummary.bytes } : {}),
    ...(e.resultSummary ? { resultBytes: e.resultSummary.bytes } : {}),
    ...(e.error ? { error: redact(e.error) } : {}),
  }));
  const final = lines.find((l) => !isManifest(l) && !isOpEntry(l)) as
    | { ts?: string; status?: string; error?: string }
    | undefined;
  return {
    runId,
    started: manifest?.started ?? null,
    ops,
    finalStatus: final?.status ?? null,
    ...(final?.error ? { finalError: redact(final.error) } : {}),
    approvals: ops.filter((o) => o.status === "approved").length,
    errors: ops.filter((o) => o.status === "error").length,
  } as JsonValue;
}

async function recentRunIds(dataDir: string, limit: number): Promise<string[]> {
  const dir = `${dataDir}/runs`;
  const entries: { id: string; mtime: number }[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".jsonl")) continue;
      const info = await Deno.stat(`${dir}/${e.name}`);
      entries.push({ id: e.name.slice(0, -".jsonl".length), mtime: info.mtime?.getTime() ?? 0 });
    }
  } catch {
    return [];
  }
  return entries.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((e) => e.id);
}

export function denopsConnector(opts: DenopsConnectorOptions): Connector {
  const cache = { mtime: -1, text: "", updatedAt: "" };

  const readSkill = async (): Promise<{ text: string; updatedAt: string }> => {
    try {
      const info = await Deno.stat(opts.skillPath);
      const mtime = info.mtime?.getTime() ?? 0;
      if (mtime !== cache.mtime) {
        cache.text = await Deno.readTextFile(opts.skillPath);
        cache.mtime = mtime;
        cache.updatedAt = new Date(mtime).toISOString();
      }
      return { text: cache.text, updatedAt: cache.updatedAt };
    } catch (e) {
      throw new Error(
        `SKILL.md is missing or unreadable at ${opts.skillPath}: ${(e as Error).message}`,
      );
    }
  };

  const readChangelog = async (): Promise<JsonValue> => {
    if (!opts.changelogPath) return { available: false };
    try {
      const text = await Deno.readTextFile(opts.changelogPath);
      const entries: JsonValue[] = [];
      for (const line of text.split(/\r?\n/)) {
        const m = /^##\s+(.+?)\s*$/.exec(line);
        if (!m) continue;
        const heading = m[1];
        const dash = heading.indexOf("—");
        entries.push({
          version: (dash >= 0 ? heading.slice(0, dash) : heading).trim(),
          date: dash >= 0 ? heading.slice(dash + 1).trim() : null,
        } as JsonValue);
      }
      return { available: true, latest: entries[0] ?? null, entries: entries.slice(0, 10) };
    } catch {
      return { available: false };
    }
  };

  return {
    id: "denops",
    ops: [
      {
        name: "denops.skill",
        tier: "open",
        doc:
          "This server's agent skill sheet (SKILL.md): conventions, discovery, approval/capability semantics, connector crib sheet, dev/deploy loop. args: { section? } filters to matching '## ' sections. Call it first when orienting.",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "denops.about",
        tier: "open",
        doc:
          "Server version, SKILL.md freshness/length, and the connector families this deployment exposes. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "denops.version",
        tier: "open",
        doc:
          "What is running: version, commit (exported by the supervisor), and the top entries of CHANGELOG.md. Use it to confirm a change actually deployed instead of probing behaviour. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "denops.budget",
        tier: "open",
        doc:
          "Budget left in THIS run: { runId, wallClockMs, elapsedMs, remainingMs, opLimit, opsUsed, opsRemaining, maxOpResultBytes }. Call it before a long loop or a multi-step write so the run can degrade (stage early, narrow reads) instead of dying mid-way. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "denops.oplog",
        tier: "open",
        doc:
          "Read-only, redacted view of the run log: recent runs with their ops, statuses, approval and error counts. No op arguments and no result bodies are returned (only their byte sizes); errors are truncated. args: { limit? (runs, default 5, max 50), runId? (one run), ops? (max op rows per run, default 50) }. Use it to answer 'what did the agent actually do?' after something went wrong.",
        argSchema: compose(
          rejectUnknown(),
          optNum("limit"),
          optStr("runId", 100),
          optNum("ops"),
          (a) => {
            const n = (a as { limit?: unknown }).limit;
            if (n === undefined) return null;
            const v = Number(n);
            return Number.isInteger(v) && v > 0 && v <= 50 ? null : "limit: expected 1..50";
          },
          (a) => {
            const n = (a as { ops?: unknown }).ops;
            if (n === undefined) return null;
            const v = Number(n);
            return Number.isInteger(v) && v > 0 && v <= 500 ? null : "ops: expected 1..500";
          },
        ),
      },
    ],
    client: (ctx: HostContext) => ({
      "skill": async (a) => {
        const { text, updatedAt } = await readSkill();
        const section = String((a as { section?: unknown }).section ?? "").trim();
        const bytes = new TextEncoder().encode(text).length;
        if (section === "") return { updatedAt, bytes, content: text } as JsonValue;
        const parts = text.split(/\n(?=## )/);
        const picked = parts.filter((p) => p.toLowerCase().includes(section.toLowerCase()));
        return {
          updatedAt,
          section,
          found: picked.length > 0,
          content: (picked.length ? picked : parts.slice(0, 1)).join("\n"),
        } as JsonValue;
      },
      "about": async () => {
        const { text, updatedAt } = await readSkill();
        return {
          version: opts.version,
          commit: opts.commit ?? null,
          skillUpdatedAt: updatedAt,
          skillBytes: new TextEncoder().encode(text).length,
          connectors: opts.connectors(),
        } as JsonValue;
      },
      "version": async () => {
        const changelog = await readChangelog();
        return {
          version: opts.version,
          commit: opts.commit ?? null,
          changelog,
        } as JsonValue;
      },
      "budget": () => {
        if (!opts.budget) return Promise.resolve({ available: false } as JsonValue);
        return Promise.resolve({ available: true, ...opts.budget() } as JsonValue);
      },
      "oplog": async (a) => {
        const r = a as { limit?: number; runId?: string; ops?: number };
        const dataDir = opts.dataDir;
        if (!dataDir) return { available: false, runs: [] } as JsonValue;
        const perRunOps = Math.min(Number(r.ops ?? 50), 500);
        const ids = r.runId ? [String(r.runId)] : await recentRunIds(dataDir, Number(r.limit ?? 5));
        // a runId from the caller must be a plain id, never a path
        const runs: JsonValue[] = [];
        for (const id of ids) {
          if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
            throw new Error("runId: expected the id printed by execute(), not a path");
          }
          let lines: LogLine[];
          try {
            lines = await RunLog.read(dataDir, id);
          } catch {
            continue;
          }
          const summary = summarizeRun(id, lines) as Record<string, unknown>;
          const ops = summary.ops as unknown[];
          if (ops.length > perRunOps) summary.ops = ops.slice(0, perRunOps);
          runs.push(summary as JsonValue);
        }
        ctx.log({ connector: "denops", op: "denops.oplog", args: { runs: runs.length } });
        return { available: true, runs } as JsonValue;
      },
    }),
    validateStartup: async () => {
      await readSkill();
    },
  };
}
