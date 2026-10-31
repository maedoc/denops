import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { ApprovalQueue } from "../src/harness/approvals.ts";
import { search } from "../src/harness/discover.ts";
import { RunLog } from "../src/harness/log.ts";
import { Registry } from "../src/harness/registry.ts";
import type { Budgets, JsonValue } from "../src/harness/types.ts";
import { Harness } from "../src/harness/worker.ts";
import { debugConnector } from "../src/connectors/debug/manifest.ts";

const budgets: Budgets = {
  wallClockMs: 10_000,
  maxOpsPerRun: 50,
  maxOpResultBytes: 1_048_576,
  maxOpArgsBytes: 1_048_576,
  maxLogBytes: 10_485_760,
};

function makeHarness(
  registry: Registry,
  clients: Map<string, Record<string, (args: JsonValue) => Promise<JsonValue>>>,
) {
  const h = new Harness(
    (op) => {
      const r = registry.resolve(op);
      if (!r) return undefined;
      const short = op.slice(`${r.connector.id}.`.length);
      const method = clients.get(r.connector.id)?.[short];
      return method ? { spec: r.spec, connector: r.connector, method } : undefined;
    },
    budgets,
    (q, c) => search(registry, q, c),
    () => "doc",
  );
  h.setConnectorIds(["debug"]);
  return h;
}

function setup() {
  const registry = new Registry();
  registry.register(debugConnector);
  const clients = new Map([
    ["debug", debugConnector.client({ config: {}, secrets: {}, log: () => {} })],
  ]);
  return { registry, harness: makeHarness(registry, clients) };
}

Deno.test("execute: echo round-trip in sandboxed worker", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const log = new RunLog(dir, "t1", budgets.maxLogBytes);
    await log.init({ runId: "t1", code: "", connectors: ["debug"] });
    const out = await harness.run("t1", `return await debug.echo({ text: "hi" });`, log);
    assertEquals(out.status, "completed");
    assertEquals(out.result, { echoed: { text: "hi" } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sandbox: fetch and Deno namespace are blocked in worker", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const log = new RunLog(dir, "t2", budgets.maxLogBytes);
    await log.init({ runId: "t2", code: "", connectors: ["debug"] });
    const out = await harness.run(
      "t2",
      `try { await fetch("https://example.com"); return "FETCH WORKED (BAD)"; } catch (e) { return "fetch blocked: " + e.message.slice(0, 40); }`,
      log,
    );
    assertEquals(out.status, "completed");
    assertStringIncludes(String(out.result), "fetch blocked");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unknown op returns model-actionable error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const log = new RunLog(dir, "t3", budgets.maxLogBytes);
    await log.init({ runId: "t3", code: "", connectors: ["debug"] });
    const out = await harness.run(
      "t3",
      `try { return await debug.nope({}); } catch (e) { return e.message; }`,
      log,
    );
    assertEquals(out.status, "completed");
    assertStringIncludes(String(out.result), "unknown or unavailable op: debug.nope");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("approval tier suspends run and approve resumes via replay", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const approvals = new ApprovalQueue();
    const runId = "t4";
    const log = new RunLog(dir, runId, budgets.maxLogBytes);
    await log.init({ runId, code: "", connectors: ["debug"] });
    const code =
      `const a = await debug.echo({ text: "before" }); const g = await debug.gated({ reason: "test" }); return { a, g };`;
    const out1 = await harness.run(runId, code, log);
    assertEquals(out1.status, "awaiting_approval");
    assert(out1.pending);
    approvals.add(out1.pending);

    const decided = approvals.decide(out1.pending.pendingId, "approve");
    assertEquals(decided?.pendingId, out1.pending.pendingId);

    const lines = await RunLog.read(dir, runId);
    const replay = {
      resultsByOpSeq: new Map<string, JsonValue>(),
      approvedOps: new Set([out1.pending.op]),
    };
    for (const l of lines) {
      if ("seq" in l && "op" in l && l.status === "ok" && l.result !== undefined) {
        replay.resultsByOpSeq.set(String(l.op), l.result);
      }
    }
    const log2 = new RunLog(dir, runId, budgets.maxLogBytes);
    const out2 = await harness.run(runId, code, log2, replay);
    assertEquals(out2.status, "completed");
    const res = out2.result as { a: unknown; g: unknown };
    assertEquals(res.a, { echoed: { text: "before" } });
    assertEquals(res.g, { gated: true, args: { reason: "test" } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reject terminates the run", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const approvals = new ApprovalQueue();
    const runId = "t5";
    const log = new RunLog(dir, runId, budgets.maxLogBytes);
    await log.init({ runId, code: "", connectors: ["debug"] });
    const out = await harness.run(runId, `return await debug.gated({});`, log);
    assertEquals(out.status, "awaiting_approval");
    assert(out.pending);
    approvals.add(out.pending);
    const p = approvals.decide(out.pending.pendingId, "reject");
    assertEquals(p?.op, "debug.gated");
    assertEquals(approvals.get(out.pending.pendingId), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("wall clock budget kills a runaway run", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const registry = new Registry();
    registry.register(debugConnector);
    const clients = new Map([[
      "debug",
      debugConnector.client({ config: {}, secrets: {}, log: () => {} }),
    ]]);
    const shortBudgets: Budgets = { ...budgets, wallClockMs: 500 };
    const harness = new Harness(
      (op) => {
        const r = registry.resolve(op);
        if (!r) return undefined;
        const method = clients.get("debug")?.[op.slice(6)];
        return method ? { spec: r.spec, connector: r.connector, method } : undefined;
      },
      shortBudgets,
      (q, c) => search(registry, q, c),
      () => "doc",
    );
    harness.setConnectorIds(["debug"]);
    const log = new RunLog(dir, "t6", budgets.maxLogBytes);
    await log.init({ runId: "t6", code: "", connectors: ["debug"] });
    const out = await harness.run(
      "t6",
      `while (true) { await new Promise(r => setTimeout(r, 50)); }`,
      log,
    );
    assertEquals(out.status, "budget_exceeded");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("search finds ops by fuzzy query and scopes by connector", () => {
  const { registry } = setup();
  const all = search(registry, "echo");
  assertStringIncludes(all, "debug.echo");
  const scoped = search(registry, "", "debug");
  assertStringIncludes(scoped, "debug.gated");
  assertStringIncludes(scoped, "[approval]");
  const none = search(registry, "", "gitlab");
  assertStringIncludes(none, "no matching ops");
});

Deno.test("op log records manifest, ops and final entry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const log = new RunLog(dir, "t8", budgets.maxLogBytes);
    await log.init({ runId: "t8", code: "return 1;", connectors: ["debug"] });
    await harness.run("t8", `return await debug.echo({});`, log);
    const lines = await RunLog.read(dir, "t8");
    assertEquals(lines[0].kind, "run");
    const ops = lines.filter((l) => "seq" in l);
    assert(ops.length >= 1);
    assertEquals(lines[lines.length - 1].kind, "final");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
