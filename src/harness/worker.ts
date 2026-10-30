import { guestSource } from "../guest/bootstrap.ts";
import { serializedSize, validateArgs } from "./boundary.ts";
import { RunLog } from "./log.ts";
import type { Budgets, Connector, JsonValue, OpSpec } from "./types.ts";

export interface PendingApproval {
  pendingId: string;
  runId: string;
  op: string;
  args: JsonValue;
}

export interface RunOutcome {
  status: "completed" | "failed" | "awaiting_approval" | "budget_exceeded";
  result?: JsonValue;
  error?: string;
  pending?: PendingApproval;
}

export interface ReplayState {
  resultsByOpSeq: Map<string, JsonValue>;
  approvedOps: Set<string>;
}

interface ResolvedOp {
  spec: OpSpec;
  connector: Connector;
  method: (args: JsonValue) => Promise<JsonValue>;
}

export class Harness {
  private connectorIds: string[] = [];

  constructor(
    private resolveOp: (op: string) => ResolvedOp | undefined,
    private budgets: Budgets,
    private searchFn: (query: string, connector?: string) => string,
    private describeFn: (op: string) => string,
  ) {}

  setConnectorIds(ids: string[]): void {
    this.connectorIds = ids;
  }

  async run(runId: string, code: string, log: RunLog, replay?: ReplayState): Promise<RunOutcome> {
    const started = Date.now();
    let opCount = 0;
    let awaiting: PendingApproval | null = null;

    const guest = guestSource(this.connectorIds, code);

    const worker = new Worker("data:text/javascript," + encodeURIComponent(guest), {
      type: "module",
      deno: { permissions: "none" },
    });

    let outcome: RunOutcome | null = null;
    const finish = (o: RunOutcome) => {
      if (outcome) return;
      outcome = o;
      clearTimeout(timer);
      worker.terminate();
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

      if (spec.tier === "approval" && !(replay && replay.approvedOps.has(op))) {
        const pendingId = crypto.randomUUID();
        awaiting = { pendingId, runId, op, args };
        await log.recordOp({ op, args, status: "pending" });
        await log.recordFinal({ status: "awaiting_approval", pendingId });
        finish({ status: "awaiting_approval", pending: awaiting });
        reply(callId, { pending: true, pendingId, op, args });
        return;
      }

      if (replay) {
        const prior = replay.resultsByOpSeq.get(op);
        if (prior !== undefined) {
          reply(callId, { result: prior });
          return;
        }
      }

      try {
        const result = await method(args);
        const bytes = serializedSize(result);
        if (bytes > this.budgets.maxOpResultBytes) {
          await log.recordOp({ op, status: "error", error: `result ${bytes}B exceeds cap` });
          reply(callId, {
            error:
              `op ${op} result is ${bytes} bytes, exceeding the per-op cap of ${this.budgets.maxOpResultBytes}. Narrow the query.`,
          });
          return;
        }
        await log.recordOp({ op, args, status: "ok", result });
        if (replay) replay.resultsByOpSeq.set(op, result);
        reply(callId, { result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await log.recordOp({ op, status: "error", error: msg });
        reply(callId, { error: `op ${op} failed: ${msg}` });
      }
    };

    worker.addEventListener("message", (e) => {
      const m = e.data as Record<string, unknown>;
      if (m.kind === "op") void handleOp(m);
      else if (m.kind === "done") {
        if (outcome) return;
        clearTimeout(timer);
        worker.terminate();
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
      worker.terminate();
      void log.recordFinal({ status: "failed", error: e.message });
      outcome = { status: "failed", error: e.message };
    });

    while (!outcome) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return outcome;
  }
}
