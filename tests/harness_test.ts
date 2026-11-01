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

// A failure used to arrive as a stack whose frames point into the injected
// prelude's data: URL — i.e. the whole sandbox source, percent-encoded, plus
// wrapper line numbers the caller never wrote.
Deno.test("sandbox: failed runs report name+message, never a stack", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const log = new RunLog(dir, "t-stack", budgets.maxLogBytes);
    await log.init({ runId: "t-stack", code: "", connectors: ["debug"] });
    const out = await harness.run("t-stack", `throw new TypeError("boom");`, log);
    assertEquals(out.status, "failed");
    assertEquals(out.error, "TypeError: boom");
    for (const leak of ["data:text/javascript", "Injected", ".ts:", " at "]) {
      assert(!String(out.error).includes(leak), `error must not leak ${leak}: ${out.error}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Deno's own error/inspect helpers read Deno.noColor; blocking that data
// property surfaced "Deno.noColor is disabled in the sandbox" for code that
// merely touched globalThis.
Deno.test("sandbox: inert Deno data is readable, Deno APIs stay blocked", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const log = new RunLog(dir, "t-inert", budgets.maxLogBytes);
    await log.init({ runId: "t-inert", code: "", connectors: ["debug"] });
    const ok = await harness.run(
      "t-inert",
      `return { noColor: Deno.noColor, os: Deno.build.os, keys: Object.keys(globalThis).length };`,
      log,
    );
    assertEquals(ok.status, "completed", String(ok.error));
    const r = ok.result as { noColor: boolean; os: string; keys: number };
    assertEquals(r.noColor, true);
    assertEquals(typeof r.os, "string");
    assert(r.keys > 0);

    const blocked = await harness.run(
      "t-inert",
      `return Deno.env.get("HOME");`,
      log,
    );
    assertEquals(blocked.status, "failed");
    assertStringIncludes(String(blocked.error), "Deno.env is disabled");
    assert(!String(blocked.error).includes("data:text/javascript"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A model can emit invalid JS. That must be a failed run, not a dead server: a
// guest module that fails to parse used to surface as
// "Uncaught (in promise) Error: Unhandled error in child worker".
Deno.test("sandbox: unparsable guest code fails the run without killing the host", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { harness } = setup();
    const log = new RunLog(dir, "t-syntax", budgets.maxLogBytes);
    await log.init({ runId: "t-syntax", code: "", connectors: ["debug"] });
    for (const bad of ["return (;", "const x = ;", "await await"]) {
      const out = await harness.run("t-syntax", bad, log);
      assertEquals(out.status, "failed", `expected failure for ${JSON.stringify(bad)}`);
      assertStringIncludes(String(out.error), "SyntaxError");
      assert(!String(out.error).includes("blob:"), "no worker/internals in the error");
    }
    // the harness is still usable afterwards
    const ok = await harness.run("t-syntax", `return await debug.echo({ n: 1 });`, log);
    assertEquals(ok.status, "completed");
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

// A caller that only ever saw "20 op(s)" concluded the server had two ops. Always
// report the true registry size, and say when results were truncated.
Deno.test("search reports registry size and truncation, never implies a small registry", () => {
  const registry = new Registry();
  for (const id of ["alpha", "beta"]) {
    const ops = Array.from({ length: 15 }, (_, i) => ({
      name: `${id}.op${i}`,
      tier: "open" as const,
      doc: `thing ${i} of ${id}`,
      argSchema: () => null,
    }));
    registry.register({ id, ops, client: () => ({}) });
  }

  const empty = search(registry, "");
  assertStringIncludes(empty, "30 op(s) registered");
  assertStringIncludes(empty, "(alpha:15, beta:15)");
  assertStringIncludes(empty, "showing 20 of 30");
  assertStringIncludes(empty, "+10 more");

  // "all available ops" is a listing request, not a literal search: those words
  // are stopwords, so they must fall back to the full listing.
  const phrasing = search(registry, "all available ops");
  assertStringIncludes(phrasing, "30 op(s) registered");
  assertStringIncludes(phrasing, "showing 20 of 30");

  const broad = search(registry, "thing");
  assertStringIncludes(broad, "30 op(s) matched, showing the best 20");
  assertStringIncludes(broad, "+10 more");

  const narrow = search(registry, "beta.op7");
  assertStringIncludes(narrow, "1 op(s) matched");
  assert(!narrow.includes("more —"), "a short result must not claim truncation");

  const scoped = search(registry, "", "alpha");
  assertStringIncludes(scoped, "15 op(s) in alpha");

  const none = search(registry, "zzz");
  assertStringIncludes(none, "no matching ops");
  assertStringIncludes(none, "30 op(s) registered");
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
