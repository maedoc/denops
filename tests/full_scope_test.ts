import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { search } from "../src/harness/discover.ts";
import { isManifest, isOpEntry, RunLog } from "../src/harness/log.ts";
import { PendingStore } from "../src/harness/pendingStore.ts";
import { Registry } from "../src/harness/registry.ts";
import type { Budgets, JsonValue } from "../src/harness/types.ts";
import { Harness } from "../src/harness/worker.ts";
import { gitlabConnector } from "../src/connectors/gitlab/manifest.ts";
import { imapConnector } from "../src/connectors/imap/manifest.ts";
import { mistralConnector } from "../src/connectors/mistral/manifest.ts";

const budgets: Budgets = {
  wallClockMs: 10_000,
  maxOpsPerRun: 50,
  maxOpResultBytes: 1_048_576,
  maxOpArgsBytes: 1_048_576,
  maxLogBytes: 10_485_760,
};

Deno.test("gitlab manifest: approval-tier write ops present, deletes/merge absent from index", () => {
  const registry = new Registry();
  registry.register(
    gitlabConnector({ token: "t", origin: "https://gitlab.example", apiPath: "/api/v4" }),
  );
  const idx = registry.index().map((e) => e.name);
  for (
    const op of [
      "gitlab.issues.create",
      "gitlab.issues.update",
      "gitlab.issues.notes.create",
      "gitlab.mergeRequests.create",
      "gitlab.mergeRequests.comment",
      "gitlab.repository.files.create",
      "gitlab.projects.update",
    ]
  ) {
    assert(idx.includes(op), `missing ${op}`);
  }
  for (const op of idx) {
    assert(!op.includes("delete") && !op.includes("merge.merge"), `forbidden op exposed: ${op}`);
  }
  const gated = search(registry, "create issue");
  assertStringIncludes(gated, "[approval]");
  const reads = search(registry, "list issues");
  assertStringIncludes(reads, "gitlab.issues.list");
});

Deno.test("imap manifest: read ops + drafts open, raw approval, no send op", () => {
  const registry = new Registry();
  registry.register(imapConnector({
    accounts: [{
      id: "work",
      host: "127.0.0.1",
      port: 1,
      tls: false,
      user: "u",
      password: "p",
      draftsMailbox: "Drafts",
    }],
  }));
  const idx = registry.index().map((e) => e.name);
  for (
    const op of [
      "mail.accounts",
      "mail.mailboxes.list",
      "mail.messages.list",
      "mail.messages.search",
      "mail.messages.get",
      "mail.messages.getPart",
      "mail.messages.flags.get",
      "mail.drafts.save",
      "mail.messages.raw",
    ]
  ) {
    assert(idx.includes(op), `missing ${op}`);
  }
  assert(!idx.some((n) => n.includes("send")), "send op must not exist");
  assertEquals(registry.tierOf("mail.messages.raw"), "approval");
  assertEquals(registry.tierOf("mail.drafts.save"), "open");
  assertEquals(registry.tierOf("mail.send"), "absent");
});

Deno.test("imap: unknown account id produces actionable error through the boundary", async () => {
  const registry = new Registry();
  const conn = imapConnector({
    accounts: [{
      id: "work",
      host: "127.0.0.1",
      port: 1,
      tls: false,
      user: "u",
      password: "p",
      draftsMailbox: "Drafts",
    }],
  });
  registry.register(conn);
  const clients = new Map([["mail", conn.client({ config: {}, secrets: {}, log: () => {} })]]);
  const harness = new Harness(
    (op) => {
      const r = registry.resolve(op);
      if (!r) return undefined;
      const m = clients.get("mail")?.[op.slice("mail.".length)] as
        | ((args: JsonValue) => Promise<JsonValue>)
        | undefined;
      return m ? { spec: r.spec, connector: r.connector, method: m } : undefined;
    },
    budgets,
    (q, c) => search(registry, q, c),
    () => "",
  );
  harness.setConnectorIds(["mail"]);
  const dir = await Deno.makeTempDir();
  try {
    const log = new RunLog(dir, "im1", budgets.maxLogBytes);
    await log.init({ runId: "im1", code: "", connectors: ["mail"] });
    const out = await harness.run(
      "im1",
      `try { return await mail.mailboxes.list({ account: "nope" }); } catch (e) { return e.message; }`,
      log,
    );
    assertEquals(out.status, "completed");
    assertStringIncludes(String(out.result), "unknown mail account: nope");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mistral manifest: tiers correct, share ops present at approval tier", () => {
  const registry = new Registry();
  registry.register(
    mistralConnector({ apiKey: "k", origin: "https://api.mistral.ai", apiPath: "/v1" }),
  );
  const idx = registry.index().map((e) => e.name);
  for (
    const op of [
      "mistral.libraries.list",
      "mistral.libraries.get",
      "mistral.libraries.create",
      "mistral.documents.list",
      "mistral.documents.get",
      "mistral.documents.upload",
      "mistral.connectors.list",
    ]
  ) {
    assert(idx.includes(op), `missing ${op}`);
  }
  assertEquals(registry.tierOf("mistral.libraries.delete"), "approval");
  assertEquals(registry.tierOf("mistral.documents.delete"), "approval");
  assertEquals(registry.tierOf("mistral.libraries.share"), "approval");
  assertEquals(registry.tierOf("mistral.libraries.unshare"), "approval");
  assertEquals(registry.tierOf("mistral.libraries.shares.list"), "open");
});

Deno.test("pending store: survives reload, add/remove/list round-trip", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const s1 = new PendingStore(dir);
    await s1.add({ pendingId: "p1", runId: "r1", op: "debug.gated", args: { reason: "x" } });
    const s2 = new PendingStore(dir);
    const list = await s2.list();
    assertEquals(list.length, 1);
    assertEquals(list[0].pendingId, "p1");
    assertEquals(list[0].op, "debug.gated");
    const got = await s2.get("p1");
    assert(got?.createdAt, "createdAt set");
    await s2.remove("p1");
    assertEquals((await s2.list()).length, 0);
    assertEquals(await s2.get("p1"), undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("replay after restart: log-driven resume serves prior ops and runs approved op live", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const registry = new Registry();
    const { debugConnector } = await import("../src/connectors/debug/manifest.ts");
    registry.register(debugConnector);
    const clients = new Map([[
      "debug",
      debugConnector.client({ config: {}, secrets: {}, log: () => {} }),
    ]]);
    const mk = () => {
      const h = new Harness(
        (op) => {
          const r = registry.resolve(op);
          if (!r) return undefined;
          const m = clients.get("debug")?.[op.slice(6)];
          return m ? { spec: r.spec, connector: r.connector, method: m } : undefined;
        },
        budgets,
        (q, c) => search(registry, q, c),
        () => "",
      );
      h.setConnectorIds(["debug"]);
      return h;
    };
    const runId = "rr1";
    const code =
      `const a = await debug.echo({ n: 1 }); return { a, g: await debug.gated({ ok: true }) };`;
    const log1 = new RunLog(dir, runId, budgets.maxLogBytes);
    await log1.init({ runId, code, connectors: ["debug"] });
    const out1 = await mk().run(runId, code, log1);
    assertEquals(out1.status, "awaiting_approval");

    const store = new PendingStore(dir);
    await store.add(out1.pending!);

    const lines = await RunLog.read(dir, runId);
    const manifest = lines.find(isManifest);
    assert(manifest?.code);
    const replay = {
      resultsByOpSeq: new Map<string, JsonValue>(),
      approvedOps: new Set([out1.pending!.op]),
    };
    for (const l of lines) {
      if (isOpEntry(l) && l.status === "ok" && l.result !== undefined) {
        replay.resultsByOpSeq.set(l.op, l.result);
      }
    }
    const log2 = new RunLog(dir, runId, budgets.maxLogBytes);
    const out2 = await mk().run(runId, manifest.code!, log2, replay);
    assertEquals(out2.status, "completed");
    const res = out2.result as { a: unknown; g: unknown };
    assertEquals(res.a, { echoed: { n: 1 } });
    assertEquals(res.g, { gated: true, args: { ok: true } });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
