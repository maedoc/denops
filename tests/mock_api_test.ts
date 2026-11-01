import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { search } from "../src/harness/discover.ts";
import { RunLog } from "../src/harness/log.ts";
import { Registry } from "../src/harness/registry.ts";
import type { Budgets, JsonValue } from "../src/harness/types.ts";
import { Harness } from "../src/harness/worker.ts";
import { gitlabConnector } from "../src/connectors/gitlab/manifest.ts";
import { mistralConnector } from "../src/connectors/mistral/manifest.ts";

const budgets: Budgets = {
  wallClockMs: 15_000,
  maxOpsPerRun: 50,
  maxOpResultBytes: 1_048_576,
  maxOpArgsBytes: 1_048_576,
  maxLogBytes: 10_485_760,
};

interface RecordedReq {
  method: string;
  path: string;
  auth?: string;
  body?: string;
}

function mockServer(
  routes: Record<string, (r: RecordedReq) => { status?: number; body: unknown }>,
  recorded: RecordedReq[],
) {
  return Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.body ? await req.text() : undefined;
    const rec: RecordedReq = {
      method: req.method,
      path: url.pathname + url.search,
      auth: req.headers.get("authorization") ?? req.headers.get("private-token") ?? undefined,
      body,
    };
    recorded.push(rec);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key] ?? routes[`* ${url.pathname}`] ?? routes["*"];
    if (!handler) {
      return new Response(JSON.stringify({ error: "no mock route" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const out = handler(rec);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function harnessFor(
  registry: Registry,
  clients: Map<string, Record<string, (args: JsonValue) => Promise<JsonValue>>>,
  ids: string[],
  tierOverride?: ConstructorParameters<typeof Harness>[4],
) {
  const h = new Harness(
    (op) => {
      const r = registry.resolve(op);
      if (!r) return undefined;
      const m = clients.get(r.connector.id)?.[op.slice(`${r.connector.id}.`.length)];
      return m ? { spec: r.spec, connector: r.connector, method: m } : undefined;
    },
    budgets,
    (q, c) => search(registry, q, c),
    () => "",
    tierOverride,
  );
  h.setConnectorIds(ids);
  return h;
}

Deno.test("gitlab client against mock API: read op, path encoding, auth header", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /api/v4/projects": () => ({
      body: { data: [{ id: 1, path_with_namespace: "grp/proj" }] },
    }),
    "GET /api/v4/user": () => ({ body: { id: 7, username: "tester" } }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const registry = new Registry();
  const conn = gitlabConnector({
    token: "secret-token",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/api/v4",
  });
  registry.register(conn);
  const clients = new Map([["gitlab", conn.client({ config: {}, secrets: {}, log: () => {} })]]);
  const harness = harnessFor(registry, clients, ["gitlab"]);
  const dir = await Deno.makeTempDir();
  try {
    const log = new RunLog(dir, "g1", budgets.maxLogBytes);
    await log.init({ runId: "g1", code: "", connectors: ["gitlab"] });
    const out = await harness.run(
      "g1",
      `const p = await gitlab.projects.list({}); const u = await gitlab.users.current(); return { p, u };`,
      log,
    );
    assertEquals(out.status, "completed");
    const res = out.result as { p: unknown; u: unknown };
    assertEquals(res.u, { id: 7, username: "tester" });
    assertEquals(recorded[0].auth, "secret-token");
    assertEquals(recorded[0].path, "/api/v4/projects");
  } finally {
    await srv.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// Upstream GitLab objects are ~4KB each; returning them wholesale is context
// abuse for an LLM caller. Lists project onto a small default field set, with
// `fields` to choose and `full: true` to opt into the raw object.
Deno.test("gitlab list ops return summaries by default, full objects on request", async () => {
  const fatProject = {
    id: 42,
    name: "proj",
    path_with_namespace: "grp/proj",
    default_branch: "main",
    visibility: "private",
    archived: false,
    web_url: "https://gitlab.example/grp/proj",
    last_activity_at: "2026-10-30T18:13:36.806+01:00",
    description: "x".repeat(4000),
    avatar_url: "https://gitlab.example/avatar.png",
    _links: { self: "https://gitlab.example/api/v4/projects/42", issues: "..." },
    namespace: { id: 3, name: "grp", path: "grp", kind: "group", full_path: "grp" },
    permissions: { project_access: { access_level: 40 }, group_access: null },
  };
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /api/v4/projects": () => ({ body: [fatProject] }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const conn = gitlabConnector({
    token: "tok",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/api/v4",
  });
  const clients = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    const summary = await clients["projects.list"]({}) as Array<Record<string, unknown>>;
    assertEquals(summary.length, 1);
    assertEquals(summary[0].id, 42);
    assertEquals(summary[0].path_with_namespace, "grp/proj");
    assertEquals(summary[0].default_branch, "main");
    for (const heavy of ["description", "avatar_url", "_links", "namespace", "permissions"]) {
      assert(!(heavy in summary[0]), `summary must omit ${heavy}`);
    }
    assert(
      JSON.stringify(summary).length < 400,
      `summary should be small, got ${JSON.stringify(summary).length}B`,
    );

    const picked = await clients["projects.list"]({
      fields: ["id", "namespace.full_path"],
    }) as Array<Record<string, unknown>>;
    assertEquals(picked[0], { id: 42, namespace: { full_path: "grp" } });

    const full = await clients["projects.list"]({ full: true }) as Array<Record<string, unknown>>;
    assertEquals(full[0].description, "x".repeat(4000));
    assert("_links" in full[0]);

    // fields/full are projections, never forwarded upstream as query params
    assertEquals(recorded.map((r) => r.path), [
      "/api/v4/projects",
      "/api/v4/projects",
      "/api/v4/projects",
    ]);
  } finally {
    await srv.shutdown();
  }
});

// Project creation and the issue write attributes had no op surface at all:
// callers could create issues/MRs/files but not projects, and issues.create
// silently dropped assignee_ids/due_date/labels/milestone_id.
Deno.test("gitlab projects.create and issue write attributes reach the API", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "POST /api/v4/projects": (r) => ({ status: 201, body: { id: 99, ...JSON.parse(r.body!) } }),
    "POST /api/v4/projects/99/issues": (r) => ({
      status: 201,
      body: { iid: 1, ...JSON.parse(r.body!) },
    }),
    "PUT /api/v4/projects/99/issues/1": (r) => ({ body: { iid: 1, ...JSON.parse(r.body!) } }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const conn = gitlabConnector({
    token: "tok",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/api/v4",
  });
  const registry = new Registry();
  registry.register(conn);
  assertEquals(registry.tierOf("gitlab.projects.create"), "approval");
  const clients = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    const created = await clients["projects.create"]({
      name: "smoke",
      visibility: "private",
      namespaceId: 7,
      initializeWithReadme: true,
    }) as Record<string, unknown>;
    assertEquals(created.id, 99);
    assertEquals(JSON.parse(recorded[0].body!), {
      name: "smoke",
      visibility: "private",
      namespace_id: 7,
      initialize_with_readme: true,
    });

    await clients["issues.create"]({
      projectId: "99",
      title: "t",
      assignee_ids: [5, 6],
      due_date: "2026-12-01",
      labels: ["a", "b"],
      milestone_id: 3,
    });
    assertEquals(JSON.parse(recorded[1].body!), {
      title: "t",
      assignee_ids: [5, 6],
      due_date: "2026-12-01",
      labels: "a,b",
      milestone_id: 3,
    });

    await clients["issues.update"]({
      projectId: "99",
      issueIid: 1,
      assignee_ids: [7],
      due_date: "2027-01-15",
    });
    assertEquals(JSON.parse(recorded[2].body!), {
      assignee_ids: [7],
      due_date: "2027-01-15",
    });

    // invalid due_date is rejected at the boundary, before any HTTP call
    const err = (conn.ops.find((o) => o.name === "gitlab.issues.create")!.argSchema)({
      projectId: "99",
      title: "t",
      due_date: "01/12/2026",
    });
    assertEquals(err, "due_date: expected YYYY-MM-DD");
  } finally {
    await srv.shutdown();
  }
});

Deno.test("gitlab approval op suspends, approve replays and issues POST live", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /api/v4/projects": () => ({ body: [] }),
    "POST /api/v4/projects/42/issues": (r) => ({
      status: 201,
      body: { iid: 5, title: JSON.parse(r.body!).title },
    }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const registry = new Registry();
  const conn = gitlabConnector({
    token: "tok",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/api/v4",
  });
  registry.register(conn);
  const clients = new Map([["gitlab", conn.client({ config: {}, secrets: {}, log: () => {} })]]);
  const harness = harnessFor(registry, clients, ["gitlab"]);
  const dir = await Deno.makeTempDir();
  try {
    const runId = "g2";
    const code =
      `const p = await gitlab.projects.list({}); const i = await gitlab.issues.create({ projectId: "42", title: "hello" }); return { p, i };`;
    const log1 = new RunLog(dir, runId, budgets.maxLogBytes);
    await log1.init({ runId, code, connectors: ["gitlab"] });
    const out1 = await harness.run(runId, code, log1);
    assertEquals(out1.status, "awaiting_approval");
    assertEquals(out1.pending?.op, "gitlab.issues.create");
    assertEquals(recorded.filter((r) => r.method === "POST").length, 0, "no POST before approval");

    const lines = await RunLog.read(dir, runId);
    const replay = {
      resultsByOpSeq: new Map<string, JsonValue>(),
      approvedOps: new Set(["gitlab.issues.create"]),
    };
    for (const l of lines) {
      if ("seq" in l && "op" in l && l.status === "ok" && l.result !== undefined) {
        replay.resultsByOpSeq.set(String(l.op), l.result as JsonValue);
      }
    }
    const log2 = new RunLog(dir, runId, budgets.maxLogBytes);
    const out2 = await harness.run(runId, code, log2, replay);
    assertEquals(out2.status, "completed");
    const res = out2.result as { i: { iid: number; title: string } };
    assertEquals(res.i, { iid: 5, title: "hello" });
    const posts = recorded.filter((r) => r.method === "POST");
    assertEquals(
      posts.length,
      1,
      "exactly one POST after approval (replay did not re-execute open ops live beyond log)",
    );
    assertEquals(posts[0].path, "/api/v4/projects/42/issues");
    assertEquals(JSON.parse(posts[0].body!).title, "hello");
  } finally {
    await srv.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mistral client against mock API: create library, upload document, share (approval)", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "POST /v1/libraries": (r) => ({
      status: 201,
      body: { id: "lib-1", name: JSON.parse(r.body!).name },
    }),
    "GET /v1/libraries": () => ({ body: { data: [{ id: "lib-1" }] } }),
    "POST /v1/files": () => ({ status: 200, body: { id: "file-9" } }),
    "POST /v1/libraries/lib-1/documents": (r) => ({
      status: 201,
      body: { id: "doc-1", ...JSON.parse(r.body!) },
    }),
    "PUT /v1/libraries/lib-1/share": (r) => ({
      status: 200,
      body: { ok: true, req: JSON.parse(r.body!) },
    }),
    "DELETE /v1/libraries/lib-1": () => ({ status: 200, body: { deleted: true } }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const origin = `http://127.0.0.1:${port}`;
  const registry = new Registry();
  const conn = mistralConnector({ apiKey: "mk-secret", origin, apiPath: "/v1" });
  registry.register(conn);
  const clients = new Map([["mistral", conn.client({ config: {}, secrets: {}, log: () => {} })]]);
  const tierOverride: ConstructorParameters<typeof Harness>[4] = (op, args, runState) => {
    if (op === "mistral.libraries.delete") {
      const id = (args as { id?: string }).id;
      if (id && runState.createdLibraryIds.has(id)) return "open";
    }
    return null;
  };
  const harness = harnessFor(registry, clients, ["mistral"], tierOverride);
  const dir = await Deno.makeTempDir();
  try {
    const runId = "m1";
    const code = `
      const lib = await mistral.libraries.create({ name: "test-lib" });
      const b64 = btoa("hello document");
      const doc = await mistral.documents.upload({ libraryId: lib.id, fileName: "a.txt", contentBase64: b64 });
      const share = await mistral.libraries.share({ id: lib.id, shareWithType: "Org", shareWithUuid: "org-1", level: "Viewer" });
      const del = await mistral.libraries.delete({ id: lib.id });
      return { lib, doc, share, del };
    `;
    const log1 = new RunLog(dir, runId, budgets.maxLogBytes);
    await log1.init({ runId, code, connectors: ["mistral"] });
    const out1 = await harness.run(runId, code, log1);
    assertEquals(out1.status, "awaiting_approval");
    assertEquals(out1.pending?.op, "mistral.libraries.share");
    assertStringIncludes(JSON.stringify(out1.pending?.args), "org-1");
    const shares = recorded.filter((r) => r.method === "PUT" && r.path.includes("/share"));
    assertEquals(shares.length, 0, "share not executed before approval");
    const deletes = recorded.filter((r) => r.method === "DELETE");
    assertEquals(deletes.length, 0, "delete not executed before share approval");
    assertEquals(recorded[0].auth, "Bearer mk-secret");

    const lines = await RunLog.read(dir, runId);
    const replay = {
      resultsByOpSeq: new Map<string, JsonValue>(),
      approvedOps: new Set(["mistral.libraries.share"]),
    };
    for (const l of lines) {
      if ("seq" in l && "op" in l && l.status === "ok" && l.result !== undefined) {
        replay.resultsByOpSeq.set(String(l.op), l.result as JsonValue);
      }
    }
    const log2 = new RunLog(dir, runId, budgets.maxLogBytes);
    const out2 = await harness.run(runId, code, log2, replay);
    assertEquals(out2.status, "completed");
    const res = out2.result as {
      lib: { id: string };
      doc: { id: string };
      share: { ok: boolean };
      del: unknown;
    };
    assertEquals(res.lib.id, "lib-1");
    assertEquals(res.doc.id, "doc-1");
    assertEquals(res.share.ok, true);
    const shares2 = recorded.filter((r) => r.method === "PUT" && r.path.includes("/share"));
    assertEquals(shares2.length, 1);
    assertEquals(JSON.parse(shares2[0].body!).share_with_type, "Org");
    const deletes2 = recorded.filter((r) =>
      r.method === "DELETE" && r.path === "/v1/libraries/lib-1"
    );
    assertEquals(deletes2.length, 1, "run-created library delete executed open (same-run cleanup)");
  } finally {
    await srv.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mistral run-scoped delete is approval when library was NOT created this run", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer(
    { "DELETE /v1/libraries/other": () => ({ status: 204, body: {} }) },
    recorded,
  );
  const port = (srv.addr as Deno.NetAddr).port;
  const registry = new Registry();
  const conn = mistralConnector({
    apiKey: "k",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/v1",
  });
  registry.register(conn);
  const clients = new Map([["mistral", conn.client({ config: {}, secrets: {}, log: () => {} })]]);
  const tierOverride: ConstructorParameters<typeof Harness>[4] = (op, args, runState) => {
    if (op === "mistral.libraries.delete") {
      const id = (args as { id?: string }).id;
      if (id && runState.createdLibraryIds.has(id)) return "open";
    }
    return null;
  };
  const harness = harnessFor(registry, clients, ["mistral"], tierOverride);
  const dir = await Deno.makeTempDir();
  try {
    const log = new RunLog(dir, "m2", budgets.maxLogBytes);
    await log.init({ runId: "m2", code: "", connectors: ["mistral"] });
    const out = await harness.run(
      "m2",
      `return await mistral.libraries.delete({ id: "other" });`,
      log,
    );
    assertEquals(out.status, "awaiting_approval", "foreign library delete must gate");
    assertEquals(recorded.length, 0);
  } finally {
    await srv.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("boundary: invalid args rejected without hitting the API", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({ "*": () => ({ body: {} }) }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const registry = new Registry();
  const conn = gitlabConnector({
    token: "t",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/api/v4",
  });
  registry.register(conn);
  const clients = new Map([["gitlab", conn.client({ config: {}, secrets: {}, log: () => {} })]]);
  const harness = harnessFor(registry, clients, ["gitlab"]);
  const dir = await Deno.makeTempDir();
  try {
    const log = new RunLog(dir, "g3", budgets.maxLogBytes);
    await log.init({ runId: "g3", code: "", connectors: ["gitlab"] });
    const out = await harness.run(
      "g3",
      `try { await gitlab.issues.get({ projectId: 42 }); return "NO ERROR (BAD)"; } catch (e) { return e.message; }`,
      log,
    );
    assertEquals(out.status, "completed");
    assertStringIncludes(String(out.result), "invalid args for gitlab.issues.get");
    assertEquals(recorded.length, 0, "validation happens before any network call");
  } finally {
    await srv.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});
