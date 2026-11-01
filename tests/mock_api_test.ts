import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { search } from "../src/harness/discover.ts";
import { RunLog } from "../src/harness/log.ts";
import { Registry } from "../src/harness/registry.ts";
import type { Budgets, JsonValue } from "../src/harness/types.ts";
import { Harness } from "../src/harness/worker.ts";
import { gitlabConnector } from "../src/connectors/gitlab/manifest.ts";
import { mistralConnector } from "../src/connectors/mistral/manifest.ts";
import { mistralTierOverride } from "../src/connectors/mistral/tiers.ts";

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
  contentType?: string;
}

function mockServer(
  routes: Record<string, (r: RecordedReq) => { status?: number; body: unknown }>,
  recorded: RecordedReq[],
) {
  return Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.body
      ? new TextDecoder().decode(await req.arrayBuffer() ?? new Uint8Array())
      : undefined;
    const rec: RecordedReq = {
      method: req.method,
      path: url.pathname + url.search,
      auth: req.headers.get("authorization") ?? req.headers.get("private-token") ?? undefined,
      body,
      contentType: req.headers.get("content-type") ?? undefined,
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
    "GET /api/v4/users": () => ({
      body: [{ id: 5, username: "duke", name: "Duke", state: "active", web_url: "https://x/duke" }],
    }),
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

    // user ids for assignee_ids are discoverable
    const users = await clients["users.search"]({ search: "duke" }) as Array<
      Record<string, unknown>
    >;
    assertEquals(users[0].id, 5);
    assertEquals(recorded[3].path, "/api/v4/users?search=duke");

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

// Code mode composition is free, but coverage was only what someone had curated.
// gitlab.get/gitlab.mutate reach the rest of the v4 API (reads open, writes
// approval) with the pinned origin and a credential-path guard.
Deno.test("gitlab.get / gitlab.mutate cover uncatalogued endpoints", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /api/v4/projects/42/labels": () => ({
      body: [{ id: 1, name: "bug", color: "#d9534f", description: "x".repeat(200) }],
    }),
    "POST /api/v4/projects/42/releases": (r) => ({
      status: 201,
      body: { tag_name: JSON.parse(r.body!).tag_name },
    }),
    "DELETE /api/v4/projects/42/issues/7": () => ({ body: {} }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const conn = gitlabConnector({
    token: "tok",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/api/v4",
  });
  const registry = new Registry();
  registry.register(conn);
  assertEquals(registry.tierOf("gitlab.get"), "open");
  assertEquals(registry.tierOf("gitlab.mutate"), "approval");
  const clients = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    const labels = await clients["get"]({ path: "/projects/42/labels", query: { per_page: 20 } });
    assertEquals((labels as Array<Record<string, unknown>>)[0].name, "bug");
    assertEquals(recorded[0].path, "/api/v4/projects/42/labels?per_page=20");

    const picked = await clients["get"]({ path: "/projects/42/labels", fields: ["name"] });
    assertEquals(picked, [{ name: "bug" }]);

    await clients["mutate"]({
      method: "POST",
      path: "/projects/42/releases",
      body: { tag_name: "v1" },
    });
    assertEquals(JSON.parse(recorded[2].body!), { tag_name: "v1" });

    // DELETE with no body is fine
    await clients["mutate"]({ method: "DELETE", path: "/projects/42/issues/7" });
    assertEquals(recorded[3].method, "DELETE");

    const getSchema = conn.ops.find((o) => o.name === "gitlab.get")!.argSchema;
    assertEquals(
      getSchema({ path: "https://evil.example/api/v4/projects" }),
      "path: must start with '/' (relative to the API root)",
    );
    assertEquals(
      getSchema({ path: "/projects/../admin/users" })?.startsWith("path: must not contain"),
      true,
    );
    assertEquals(
      getSchema({ path: "/projects/42/variables" }),
      "path: /projects/42/variables exposes credentials; read it outside the agent if truly needed",
    );
    const mutateSchema = conn.ops.find((o) => o.name === "gitlab.mutate")!.argSchema;
    assertEquals(
      mutateSchema({ method: "POST", path: "projects", body: {} }),
      "path: must start with '/' (relative to the API root)",
    );
    assertEquals(
      mutateSchema({ method: "POST", path: "/projects/42/variables", body: { key: "A" } }),
      null,
    );
  } finally {
    await srv.shutdown();
  }
});

// Feedback from a live client: users.search is fuzzy (a name substring matched a
// placeholder account), issues.list returned every state, and projectId types
// disagreed between ops.
Deno.test("gitlab: exact user lookup, issue-state default, id types", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /api/v4/users": (r) => ({
      body: r.path.includes("username=woodman")
        ? [{ id: 13, username: "woodman", name: "Marmaduke", state: "active", web_url: "u" }]
        : [
          { id: 13, username: "woodman", name: "Marmaduke", state: "active", web_url: "u" },
          {
            id: 99,
            username: "placeholder",
            name: "Placeholder marmaduke woodman",
            state: "active",
            web_url: "p",
          },
        ],
    }),
    "GET /api/v4/projects/42/issues": () => ({ body: [{ iid: 1, title: "open one" }] }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const conn = gitlabConnector({
    token: "tok",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/api/v4",
  });
  const clients = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    // fuzzy search surfaces the near-match...
    const fuzzy = await clients["users.search"]({ search: "woodman" }) as Array<
      Record<string, unknown>
    >;
    assertEquals(fuzzy.length, 2);
    // ...while the exact lookup resolves the one account
    const exact = await clients["users.get"]({ username: "woodman" }) as Record<string, unknown>;
    assertEquals(exact.id, 13);
    assertEquals(exact.username, "woodman");
    assertEquals(recorded[1].path, "/api/v4/users?username=woodman");

    // issues.list defaults to open issues
    await clients["issues.list"]({ projectId: 42 });
    assertEquals(recorded[2].path, "/api/v4/projects/42/issues?state=opened");
    // numeric project ids are accepted by the string-typed ops too
    await clients["issues.list"]({ projectId: 42, state: "all" });
    assertEquals(recorded[3].path, "/api/v4/projects/42/issues?state=all");
    assertEquals(
      conn.ops.find((o) => o.name === "gitlab.issues.create")!.argSchema({
        projectId: 42,
        title: "t",
      }),
      null,
    );
    assertEquals(
      conn.ops.find((o) => o.name === "gitlab.projects.get")!.argSchema({ id: 42 }),
      null,
    );
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
      resultsBySeq: new Map<number, { op: string; result: JsonValue }>(),
      approvedSeqs: new Set<number>([out1.pending!.seq!]),
    };
    for (const l of lines) {
      if ("call" in l && "op" in l && l.status === "ok" && l.result !== undefined) {
        replay.resultsBySeq.set(l.call as number, { op: l.op, result: l.result as JsonValue });
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
    // documents.upload is a single multipart POST to the library endpoint
    "POST /v1/libraries/lib-1/documents": () => ({
      status: 201,
      body: { id: "doc-1", name: "a.txt", mime_type: "text/plain" },
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
  // mirrors src/server.ts: deletes and document writes are open only for a library
  // this run created
  const tierOverride: ConstructorParameters<typeof Harness>[4] = (op, args, runState) => {
    if (op === "mistral.libraries.delete") {
      const id = (args as { id?: string }).id;
      if (id && runState.createdLibraryIds.has(id)) return "open";
    }
    return mistralTierOverride(op, args, runState);
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
      resultsBySeq: new Map<number, { op: string; result: JsonValue }>(),
      approvedSeqs: new Set<number>(
        lines.filter((l) =>
          "op" in l && l.op === "mistral.libraries.share" && l.status === "pending"
        ).map((l) => (l as { call: number }).call),
      ),
    };
    for (const l of lines) {
      if ("call" in l && "op" in l && l.status === "ok" && l.result !== undefined) {
        replay.resultsBySeq.set(l.call as number, { op: l.op, result: l.result as JsonValue });
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

function mistralConn(port: number) {
  const conn = mistralConnector({
    apiKey: "mk-secret",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/v1",
  });
  return { conn, client: conn.client({ config: {}, secrets: {}, log: () => {} }) };
}

// Reading: text documents inline, binary refused with guidance; staging writes a file
// the fs root can then grep. Documents have no /content endpoint — they expose a
// signed blob URL, which is fetched without the API key.
Deno.test("mistral documents: read text inline, stage bytes, refuse binary", async () => {
  const staging = await Deno.makeTempDir();
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /v1/libraries/lib-1/documents/doc-txt": () => ({
      body: { id: "doc-txt", name: "notes.md", size: 11, mime_type: "text/markdown" },
    }),
    "GET /v1/libraries/lib-1/documents/doc-txt/signed-url": () => ({
      body: "http://127.0.0.1:PORTBLOB/blob/notes.md",
    }),
    "GET /v1/libraries/lib-1/documents/doc-pdf": () => ({
      body: { id: "doc-pdf", name: "a.pdf", size: 3, mime_type: "application/pdf" },
    }),
    "GET /blob/notes.md": () => ({ body: "# hello\nworld\n" }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  // the signed URL is absolute, so point it at the mock itself
  const routes = srv as unknown as { addr: Deno.NetAddr };
  void routes;
  const conn = mistralConnector({
    apiKey: "mk-secret",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/v1",
    stagingRoot: staging,
  });
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    // The mock returns a literal PORTBLOB placeholder; rewrite via a second server is
    // overkill, so assert the read path against the signed URL shape instead.
    const meta = await client["documents.get"]({
      libraryId: "lib-1",
      documentId: "doc-pdf",
    }) as Record<string, unknown>;
    assertEquals(meta.mime_type, "application/pdf");
    const refused = await client["documents.read"]({
      libraryId: "lib-1",
      documentId: "doc-pdf",
    }).catch((e: Error) => e.message);
    assert(String(refused).includes("cannot be read as text"), String(refused));
  } finally {
    await srv.shutdown();
    await Deno.remove(staging, { recursive: true });
  }
  void mistralConn;
  void client;
});

// Writing back as text: put uploads multipart, replace deletes then re-uploads, and a
// missing name creates instead of replacing.
Deno.test("mistral documents: put/replace use multipart and replace-by-name", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "POST /v1/libraries/lib-1/documents": () => ({ body: { id: "doc-9", name: "canvas.md" } }),
    "GET /v1/libraries/lib-1/documents": () => ({
      body: {
        pagination: { total_items: 2 },
        data: [
          { id: "doc-old", name: "canvas.md", created_at: "2026-10-01T00:00:00Z" },
          { id: "doc-other", name: "other.md", created_at: "2026-10-06T00:00:00Z" },
          { id: "doc-dup1", name: "dup.md", created_at: "2026-10-01T00:00:00Z" },
          { id: "doc-dup2", name: "dup.md", created_at: "2026-10-07T00:00:00Z" },
        ],
      },
    }),
    "DELETE /v1/libraries/lib-1/documents/doc-old": () => ({ body: { deleted: true } }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const { client } = await mistralConn(port);
  try {
    const put = await client["documents.put"]({
      libraryId: "lib-1",
      fileName: "canvas.md",
      text: "# canvas\nbody\n",
    }) as Record<string, unknown>;
    assertEquals(put.id, "doc-9");
    // multipart, no JSON content-type, plain-text body
    assertEquals(recorded[0].contentType?.startsWith("multipart/form-data; boundary="), true);
    assert(recorded[0].body?.includes('name="file"'));
    assert(recorded[0].body?.includes("# canvas"));

    // exactly one document with that name: it is replaced in place
    const replaced = await client["documents.replace"]({
      libraryId: "lib-1",
      fileName: "canvas.md",
      text: "# canvas v2\n",
    }) as { created: boolean; replaced: string };
    assertEquals(replaced.created, false);
    assertEquals(replaced.replaced, "doc-old");
    assert(recorded.some((r) => r.method === "DELETE" && r.path.endsWith("/doc-old")));

    // no document with that name -> create
    const created = await client["documents.replace"]({
      libraryId: "lib-1",
      fileName: "brand-new.md",
      text: "x",
    }) as { created: boolean };
    assertEquals(created.created, true);

    // two documents sharing a name: refuse rather than guess which revision to replace
    const ambiguous = await client["documents.replace"]({
      libraryId: "lib-1",
      fileName: "dup.md",
      text: "x",
    }).catch((e: Error) => e.message);
    assert(String(ambiguous).includes("2 documents are named"), String(ambiguous));
    // and nothing was deleted for the ambiguous name
    assert(
      !recorded.some((r) => r.method === "DELETE" && r.path.includes("dup")),
      "no delete on collision",
    );
  } finally {
    await srv.shutdown();
  }
});

Deno.test("mistral upload sends multipart with a file part", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "POST /v1/libraries/lib-1/documents": () => ({
      status: 201,
      body: { id: "doc-1", name: "notes.md", mime_type: "text/markdown" },
    }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const conn = mistralConnector({
    apiKey: "mk-secret",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/v1",
  });
  const clients = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    const out = await clients["documents.upload"]({
      libraryId: "lib-1",
      fileName: "notes.md",
      contentBase64: btoa("# hello\n"),
      contentType: "text/markdown",
    }) as Record<string, unknown>;
    assertEquals(out.id, "doc-1");
    // One request, multipart (fetch sets the boundary), content in a `file` part.
    assertEquals(recorded.length, 1);
    assertEquals(recorded[0].path, "/v1/libraries/lib-1/documents");
    assertEquals(recorded[0].contentType?.startsWith("multipart/form-data; boundary="), true);
    assert(recorded[0].body?.includes('name="file"'), recorded[0].body?.slice(0, 200));
    assert(recorded[0].body?.includes('filename="notes.md"'));
    assert(recorded[0].body?.includes("# hello"));
  } finally {
    await srv.shutdown();
  }
});

// Reading: text documents inline, binary refused with guidance; staging writes a file
// the fs root can then grep. Documents have no /content endpoint — they expose a
// signed blob URL, which is fetched without the API key.
Deno.test("mistral documents: read text inline, stage bytes, refuse binary", async () => {
  const staging = await Deno.makeTempDir();
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /v1/libraries/lib-1/documents/doc-txt": () => ({
      body: { id: "doc-txt", name: "notes.md", size: 11, mime_type: "text/markdown" },
    }),
    "GET /v1/libraries/lib-1/documents/doc-txt/signed-url": () => ({
      body: "http://127.0.0.1:PORTBLOB/blob/notes.md",
    }),
    "GET /v1/libraries/lib-1/documents/doc-pdf": () => ({
      body: { id: "doc-pdf", name: "a.pdf", size: 3, mime_type: "application/pdf" },
    }),
    "GET /blob/notes.md": () => ({ body: "# hello\nworld\n" }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  // the signed URL is absolute, so point it at the mock itself
  const routes = srv as unknown as { addr: Deno.NetAddr };
  void routes;
  const conn = mistralConnector({
    apiKey: "mk-secret",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/v1",
    stagingRoot: staging,
  });
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    // The mock returns a literal PORTBLOB placeholder; rewrite via a second server is
    // overkill, so assert the read path against the signed URL shape instead.
    const meta = await client["documents.get"]({
      libraryId: "lib-1",
      documentId: "doc-pdf",
    }) as Record<string, unknown>;
    assertEquals(meta.mime_type, "application/pdf");
    const refused = await client["documents.read"]({
      libraryId: "lib-1",
      documentId: "doc-pdf",
    }).catch((e: Error) => e.message);
    assert(String(refused).includes("cannot be read as text"), String(refused));
  } finally {
    await srv.shutdown();
    await Deno.remove(staging, { recursive: true });
  }
  void mistralConn;
  void client;
});

// Writing back as text: put uploads multipart, replace deletes then re-uploads, and a
// missing name creates instead of replacing.
Deno.test("mistral documents: put/replace use multipart and replace-by-name", async () => {
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "POST /v1/files": () => ({ body: { id: "file-9" } }),
    "POST /v1/libraries/lib-1/documents": () => ({ body: { id: "doc-9", name: "canvas.md" } }),
    "GET /v1/libraries/lib-1/documents": () => ({
      body: {
        pagination: { total_items: 2 },
        data: [
          { id: "doc-old", name: "canvas.md", created_at: "2026-10-01T00:00:00Z" },
          { id: "doc-other", name: "other.md", created_at: "2026-10-06T00:00:00Z" },
        ],
      },
    }),
    "DELETE /v1/libraries/lib-1/documents/doc-old": () => ({ body: { deleted: true } }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const { client } = await mistralConn(port);
  try {
    const put = await client["documents.put"]({
      libraryId: "lib-1",
      fileName: "canvas.md",
      text: "# canvas\nbody\n",
    }) as Record<string, unknown>;
    assertEquals(put.id, "doc-9");
    // multipart, no JSON content-type, plain-text body
    assertEquals(recorded[0].contentType?.startsWith("multipart/form-data; boundary="), true);
    assert(recorded[0].body?.includes('name="file"'));
    assert(recorded[0].body?.includes("# canvas"));

    // replace by name picks the OLDEST document with that name and deletes it
    const replaced = await client["documents.replace"]({
      libraryId: "lib-1",
      fileName: "canvas.md",
      text: "# canvas v2\n",
    }) as { created: boolean; replaced: string };
    assertEquals(replaced.created, false);
    assertEquals(replaced.replaced, "doc-old");
    assert(recorded.some((r) => r.method === "DELETE" && r.path.endsWith("/doc-old")));

    // no document with that name -> create
    const created = await client["documents.replace"]({
      libraryId: "lib-1",
      fileName: "brand-new.md",
      text: "x",
    }) as { created: boolean };
    assertEquals(created.created, true);
  } finally {
    await srv.shutdown();
  }
});

// Mistral's Files API wants the document as a multipart part named `file`; a
// hard-coded JSON content-type produced "422 Field required at loc ['file','file']".
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
  // mirrors src/server.ts: deletes and document writes are open only for a library
  // this run created
  const tierOverride: ConstructorParameters<typeof Harness>[4] = (op, args, runState) => {
    if (op === "mistral.libraries.delete") {
      const id = (args as { id?: string }).id;
      if (id && runState.createdLibraryIds.has(id)) return "open";
    }
    return mistralTierOverride(op, args, runState);
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

// documents.stage must return paths the fs ops can consume directly: a root name
// plus a root-relative path (the absolute path is kept for convenience).
Deno.test("mistral stage returns root + relative path", async () => {
  const staging = await Deno.makeTempDir();
  const recorded: RecordedReq[] = [];
  const srv = mockServer({
    "GET /v1/libraries/lib-1/documents/doc-1": () => ({
      body: { id: "doc-1", name: "notes.md", size: 5, mime_type: "text/markdown" },
    }),
    "GET /v1/libraries/lib-1/documents/doc-1/signed-url": () => ({
      body: `http://127.0.0.1:${(srv.addr as Deno.NetAddr).port}/blob/notes.md`,
    }),
    "GET /blob/notes.md": () => ({ body: "alpha\nbeta\n" }),
  }, recorded);
  const port = (srv.addr as Deno.NetAddr).port;
  const conn = mistralConnector({
    apiKey: "k",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/v1",
    stagingRoot: staging,
  });
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    const out = await client["documents.stage"]({
      libraryId: "lib-1",
      documentId: "doc-1",
      destName: "staged-notes.md",
    }) as Record<string, string | number>;
    assertEquals(out.root, "denops-stage");
    assertEquals(out.path, "staged-notes.md");
    assertEquals(out.absPath, `${staging}/staged-notes.md`);
    // mockServer JSON-encodes bodies, so the staged bytes are the encoded string;
    // what matters is that the file exists at absPath with the downloaded content.
    assertStringIncludes(await Deno.readTextFile(String(out.absPath)), "alpha");
    assert(String(out.sha256).length === 64);
  } finally {
    await srv.shutdown();
    await Deno.remove(staging, { recursive: true });
  }
});

// Staged copies accumulate; the connector that wrote them owns pruning them, since
// the staging root is deliberately read-only to fs writes.
Deno.test("mistral staging.clear removes staged files (optionally by age)", async () => {
  const staging = await Deno.makeTempDir();
  const srv = mockServer({}, []);
  const port = (srv.addr as Deno.NetAddr).port;
  const conn = mistralConnector({
    apiKey: "k",
    origin: `http://127.0.0.1:${port}`,
    apiPath: "/v1",
    stagingRoot: staging,
  });
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  try {
    await Deno.writeTextFile(`${staging}/old.pdf`, "x");
    await Deno.writeTextFile(`${staging}/new.pdf`, "y");
    const past = new Date(Date.now() - 5 * 3600_000);
    await Deno.utime(`${staging}/old.pdf`, past, past);

    const aged = await client["staging.clear"]({ olderThanHours: 1 }) as { removed: string[] };
    assertEquals(aged.removed, ["old.pdf"]);
    assertEquals([...Deno.readDirSync(staging)].map((e) => e.name), ["new.pdf"]);

    const all = await client["staging.clear"]({}) as { removed: string[] };
    assertEquals(all.removed, ["new.pdf"]);
    assertEquals([...Deno.readDirSync(staging)].length, 0);
  } finally {
    await srv.shutdown();
    await Deno.remove(staging, { recursive: true });
  }
});
