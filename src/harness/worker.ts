import { guestSource } from "../guest/bootstrap.ts";
import { serializedSize, validateArgs } from "./boundary.ts";
import { RunLog } from "./log.ts";
import type { Budgets, Connector, JsonValue, OpSpec } from "./types.ts";

export interface PendingApproval {
  pendingId: string;
  runId: string;
  op: string;
  args: JsonValue;
  summary: string;
  /** 1-based call sequence of this op inside the run (matches the op log). */
  seq?: number;
}

export function summarizeOp(op: string, args: JsonValue): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const brief = (v: unknown, max = 120): string => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + "…" : s;
  };
  switch (op) {
    case "mail.messages.move":
      return `Move ${Array.isArray(a.uids) ? a.uids.length : 1} message(s) from ${
        brief(a.account)
      }/${brief(a.mailbox)} to ${brief(a.toAccount ?? a.account)}/${brief(a.toMailbox)}`;
    case "gitlab.issues.create":
      return `Create issue in project ${brief(a.projectId)}: "${brief(a.title, 200)}"`;
    case "gitlab.issues.update":
      return `Update issue #${a.issueIid} in project ${brief(a.projectId)}${
        a.state ? ` → state=${a.state}` : ""
      }${a.title ? ` title="${brief(a.title, 120)}"` : ""}`;
    case "gitlab.issues.notes.create":
      return `Comment on issue #${a.issueIid} in project ${brief(a.projectId)}: "${
        brief(a.body, 200)
      }"`;
    case "gitlab.mergeRequests.create":
      return `Create MR in project ${brief(a.projectId)}: ${brief(a.sourceBranch)} → ${
        brief(a.targetBranch)
      } "${brief(a.title, 200)}"`;
    case "gitlab.mergeRequests.comment":
      return `Comment on MR !${a.mrIid} in project ${brief(a.projectId)}: "${brief(a.body, 200)}"`;
    case "gitlab.repository.files.create":
      return `Commit file ${brief(a.filePath, 200)} on branch ${brief(a.branch)} in project ${
        brief(a.projectId)
      } (${typeof a.content === "string" ? (a.content as string).length : 0} bytes): "${
        brief(a.commitMessage, 200)
      }"`;
    case "gitlab.projects.update":
      return `Update project ${brief(a.id)}: ${
        Object.entries(a).filter(([k]) => k !== "id").map(([k, v]) => `${k}=${brief(v, 100)}`).join(
          ", ",
        )
      }`;
    case "mistral.libraries.delete":
      return `Delete Mistral library ${brief(a.id)}`;
    case "mistral.documents.delete":
      return `Delete document ${brief(a.documentId)} from library ${brief(a.libraryId)}`;
    case "mistral.libraries.share":
      return `Share library ${brief(a.id)} with ${brief(a.shareWithType)} ${
        brief(a.shareWithUuid)
      } as ${brief(a.level)}`;
    case "mistral.libraries.unshare":
      return `Unshare library ${brief(a.id)} from ${brief(a.shareWithType)} ${
        brief(a.shareWithUuid)
      }`;
    case "mail.messages.raw":
      return `Fetch full raw source of message uid ${a.uid} in ${brief(a.mailbox)} (account ${
        brief(a.account)
      })`;
    default:
      return `${op} ${brief(JSON.stringify(args), 300)}`;
  }
}

export interface RunOutcome {
  status: "completed" | "failed" | "awaiting_approval" | "budget_exceeded";
  result?: JsonValue;
  error?: string;
  pending?: PendingApproval;
}

export interface ReplayState {
  /**
   * Recorded results keyed by the op's 1-based call sequence within the run (the
   * same number the op log stores), NOT by op name: a run that calls
   * issues.create three times has three separate calls to replay.
   */
  resultsBySeq: Map<number, { op: string; result: JsonValue }>;
  /** Call sequences the human approved; every other approval op re-suspends. */
  approvedSeqs: Set<number>;
  runState?: RunState;
  // grantKeys are root-grant keys (e.g. "fs:myrepo") approved out-of-band;
  // ops touching them skip the approval tier even in fresh runs.
  grantKeys?: Set<string>;
}

export type TierOverride = (
  op: string,
  args: JsonValue,
  runState: RunState,
) => "open" | "approval" | null;

export interface RunState {
  createdLibraryIds: Set<string>;
}

interface ResolvedOp {
  spec: OpSpec;
  connector: Connector;
  method: (args: JsonValue) => Promise<JsonValue>;
}

export class Harness {
  private connectorIds: string[] = [];
  private grantKeyOf?: (op: string, args: JsonValue) => string | null;
  private isGranted?: (key: string) => boolean;

  constructor(
    private resolveOp: (op: string) => ResolvedOp | undefined,
    private budgets: Budgets,
    private searchFn: (query: string, connector?: string) => string,
    private describeFn: (op: string) => string,
    private tierOverride?: TierOverride,
  ) {}

  private newRunState(): RunState {
    return { createdLibraryIds: new Set<string>() };
  }

  setConnectorIds(ids: string[]): void {
    this.connectorIds = ids;
  }

  setGrantLookup(
    grantKeyOf: (op: string, args: JsonValue) => string | null,
    isGranted: (key: string) => boolean,
  ): void {
    this.grantKeyOf = grantKeyOf;
    this.isGranted = isGranted;
  }

  async run(runId: string, code: string, log: RunLog, replay?: ReplayState): Promise<RunOutcome> {
    const started = Date.now();
    let opCount = 0;
    let opSeq = 0;
    let awaiting: PendingApproval | null = null;
    const runState = replay?.runState ?? this.newRunState();
    if (replay) {
      for (const { op, result } of replay.resultsBySeq.values()) {
        if (op === "mistral.libraries.create") {
          const id = (result as { id?: unknown })?.id;
          if (typeof id === "string") runState.createdLibraryIds.add(id);
        }
      }
    }

    // Pre-flight parse: a guest module that fails to *parse* reports through an
    // unhandled rejection in this isolate ("Unhandled error in child worker"),
    // which is fatal for the whole process — one syntax error from a model would
    // take the server down. Compiling the same wrapper here costs nothing and
    // turns it into a normal failed run.
    try {
      new Function(`return (async () => {\n${code}\n});`);
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await log.recordFinal({ status: "failed", error: msg });
      return { status: "failed", error: msg };
    }

    const guest = guestSource(this.connectorIds, code);

    // blob: rather than data: — a data: URL embeds the whole guest source, so any
    // stack trace the guest reports (or prints back at the caller) carried the
    // percent-encoded prelude. A blob URL shows up as blob:null/<uuid>:LINE.
    const blobUrl = URL.createObjectURL(new Blob([guest], { type: "text/javascript" }));
    const worker = new Worker(blobUrl, {
      type: "module",
      deno: { permissions: "none" },
    });
    const killWorker = () => {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    };

    let outcome: RunOutcome | null = null;
    const finish = (o: RunOutcome) => {
      if (outcome) return;
      outcome = o;
      clearTimeout(timer);
      killWorker();
    };

    const timer = setTimeout(() => {
      void log.recordFinal({ status: "budget_exceeded", error: "wall clock budget exceeded" });
      finish({
        status: "budget_exceeded",
        error: `run exceeded wall clock budget of ${this.budgets.wallClockMs} ms`,
      });
    }, this.budgets.wallClockMs);

    const reply = (callId: string, msg: Record<string, unknown>) =>
      worker.postMessage({ kind: "opResult", callId, ...msg });

    const handleOp = async (m: Record<string, unknown>): Promise<void> => {
      const op = String(m.op);
      const args = (m.args ?? {}) as JsonValue;
      const callId = String(m.callId);

      if (op === "__search") {
        const q = typeof (args as Record<string, unknown>).query === "string"
          ? (args as Record<string, unknown>).query as string
          : "";
        const conn = typeof (args as Record<string, unknown>).connector === "string"
          ? (args as Record<string, unknown>).connector as string
          : undefined;
        reply(callId, { result: this.searchFn(q, conn) });
        return;
      }
      if (op === "__describe") {
        const o = typeof (args as Record<string, unknown>).op === "string"
          ? (args as Record<string, unknown>).op as string
          : "";
        reply(callId, { result: this.describeFn(o) });
        return;
      }

      const resolved = this.resolveOp(op);
      if (!resolved) {
        reply(callId, {
          error: `unknown or unavailable op: ${op}. Use api.search("...") to discover ops.`,
        });
        return;
      }
      const { spec, method } = resolved;

      const argErr = validateArgs(spec, args);
      if (argErr) {
        reply(callId, { error: `invalid args for ${op}: ${argErr}` });
        return;
      }
      const argBytes = serializedSize(args);
      if (argBytes > this.budgets.maxOpArgsBytes) {
        reply(callId, {
          error:
            `args for ${op} are ${argBytes} bytes, exceeding the cap of ${this.budgets.maxOpArgsBytes}`,
        });
        return;
      }
      if (Date.now() - started > this.budgets.wallClockMs) {
        void log.recordFinal({ status: "budget_exceeded", error: "wall clock budget exceeded" });
        finish({ status: "budget_exceeded", error: "wall clock budget exceeded" });
        return;
      }
      if (opCount >= this.budgets.maxOpsPerRun) {
        void log.recordFinal({ status: "budget_exceeded", error: "op count budget exceeded" });
        finish({
          status: "budget_exceeded",
          error: `run exceeded op budget of ${this.budgets.maxOpsPerRun}`,
        });
        return;
      }
      opCount += 1;

      // 1-based call sequence: the identity of *this* op call within the run. Every
      // dispatch logs exactly one op entry, so it matches the log's seq.
      opSeq += 1;

      const effectiveTier = this.tierOverride?.(op, args, runState) ?? spec.tier;
      const grantKey = this.grantKeyOf?.(op, args) ?? null;
      const granted = grantKey !== null &&
        ((replay?.grantKeys?.has(grantKey)) || this.isGranted?.(grantKey));
      // Approval is per call, not per op name: approving one issues.create must not
      // silently approve the next one in the same run.
      const approved = replay?.approvedSeqs.has(opSeq) ?? false;
      if (effectiveTier === "approval" && !approved && !granted) {
        const pendingId = crypto.randomUUID();
        const summary = spec.summarize ? await spec.summarize(args) : summarizeOp(op, args);
        awaiting = { pendingId, runId, op, args, summary, seq: opSeq };
        await log.recordOp({ op, args, status: "pending", call: opSeq });
        await log.recordFinal({ status: "awaiting_approval", pendingId });
        finish({ status: "awaiting_approval", pending: awaiting });
        reply(callId, { pending: true, pendingId, op, args });
        return;
      }

      if (replay) {
        const prior = replay.resultsBySeq.get(opSeq);
        if (prior && prior.op === op) {
          reply(callId, { result: prior.result });
          return;
        }
      }

      try {
        const result = await method(args);
        const bytes = serializedSize(result);
        if (bytes > this.budgets.maxOpResultBytes) {
          await log.recordOp({
            op,
            status: "error",
            error: `result ${bytes}B exceeds cap`,
            call: opSeq,
          });
          reply(callId, {
            error:
              `op ${op} result is ${bytes} bytes, exceeding the per-op cap of ${this.budgets.maxOpResultBytes}. Narrow the query.`,
          });
          return;
        }
        await log.recordOp({ op, args, status: "ok", result, call: opSeq });
        // Keep the replayed map current so a later suspension (a second approval
        // op) replays this call instead of executing it again.
        if (replay) replay.resultsBySeq.set(opSeq, { op, result });
        if (op === "mistral.libraries.create") {
          const id = (result as { id?: unknown })?.id;
          if (typeof id === "string") runState.createdLibraryIds.add(id);
        }
        reply(callId, { result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log.recordOp({ op, status: "error", error: msg, call: opSeq });
        reply(callId, { error: `op ${op} failed: ${msg}` });
      }
    };

    worker.addEventListener("message", (e) => {
      const m = e.data as Record<string, unknown>;
      if (m.kind === "op") void handleOp(m);
      else if (m.kind === "done") {
        if (outcome) return;
        clearTimeout(timer);
        killWorker();
        if (m.error) {
          void log.recordFinal({ status: "failed", error: String(m.error) });
          outcome = { status: "failed", error: String(m.error) };
        } else {
          void log.recordFinal({ status: "completed" });
          outcome = { status: "completed", result: (m.result ?? null) as JsonValue };
        }
      }
    });

    worker.addEventListener("error", (e) => {
      if (outcome) return;
      clearTimeout(timer);
      killWorker();
      void log.recordFinal({ status: "failed", error: e.message });
      outcome = { status: "failed", error: e.message };
    });

    while (!outcome) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return outcome;
  }
}
