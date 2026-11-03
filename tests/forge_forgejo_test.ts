import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { ForgeHttp } from "../src/connectors/forge/client.ts";
import {
  branchOf,
  forgejoPort,
  splitDiff,
  toBase64,
  unwrapData,
} from "../src/connectors/forge/flavors/forgejo.ts";
import type { ForgeAccount } from "../src/connectors/forge/port.ts";

// The Forgejo quirks these pin were all observed on git.ins-amu.fr, not inferred:
//  - search wraps results in {ok,data}; other endpoints do not
//  - PATCH answers 201
//  - POST /pulls/{n}/merge answers 200 with an EMPTY body (so the PR must be re-read)
//  - a file PUT without `sha` fails 422 "[SHA]: Required"
//  - issue comments ignore page/limit entirely
//  - the PR detail endpoint reports head.ref as "refs/pull/N/head"

interface Rec {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
}

function mockForgejo(routes: (key: string, rec: Rec) => Response | null) {
  const recorded: Rec[] = [];
  let base = "";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.body ? new TextDecoder().decode(await req.arrayBuffer()) : "";
    const rec: Rec = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
    };
    recorded.push(rec);
    return routes(`${req.method} ${url.pathname}`, rec) ??
      new Response(JSON.stringify({ message: "The target couldn't be found." }), { status: 404 });
  });
  base = `http://127.0.0.1:${server.addr.port}`;
  return { base, recorded, stop: () => server.shutdown() };
}

const ACCOUNT = (origin: string): ForgeAccount => ({
  id: "amu",
  flavor: "forgejo",
  origin,
  apiPath: "/api/v1",
  token: "pat",
  maxLimit: 50,
});

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

Deno.test("forgejo: search results are unwrapped from {ok, data}", async () => {
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/search") {
      return json({
        ok: true,
        data: [{
          id: 18,
          name: "forge-probe",
          full_name: "marmaduke/forge-probe",
          owner: { login: "marmaduke" },
          private: true,
        }],
      });
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.listProjects({ limit: 2 });
    assertEquals(out.items.length, 1);
    assertEquals(out.items[0].fullName, "marmaduke/forge-probe");
    assertEquals(out.items[0].owner, "marmaduke");
    assertEquals(out.items[0].visibility, "private");
    // limit is forwarded as `limit` (not per_page) and clamped to the account's cap
    assertEquals(m.recorded[0].query.limit, "2");
    assertEquals(unwrapData([] as never).length, 0);
    assertEquals(unwrapData({ ok: false } as never).length, 0);
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: issue update uses PATCH and accepts its 201 answer", async () => {
  const m = mockForgejo((key) => {
    if (key === "PATCH /api/v1/repos/o/r/issues/5") {
      return json(
        { number: 5, title: "t", state: "closed", user: { login: "duke" }, labels: [] },
        201,
      );
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.updateIssue({ owner: "o", name: "r" }, 5, { state: "closed" });
    assertEquals(m.recorded[0].method, "PATCH");
    assertEquals(JSON.parse(m.recorded[0].body).state, "closed");
    assertEquals(out.state, "closed");
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: comments are sliced client-side because the route ignores paging", async () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    id: i + 1,
    body: `c${i}`,
    user: { login: "duke" },
    created_at: "2026-11-03T10:00:00Z",
  }));
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/o/r/issues/9/comments") return json(rows);
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const first = await port.listNotes({ owner: "o", name: "r" }, 9, { limit: 3, page: 1 });
    assertEquals(first.items.length, 3);
    assertEquals(first.items[0].id, "1");
    assertEquals(first.nextPage, 2);
    const last = await port.listNotes({ owner: "o", name: "r" }, 9, { limit: 3, page: 3 });
    assertEquals(last.items.length, 1);
    assertEquals(last.nextPage, null);
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: merging re-reads the PR because the merge answer has no body", async () => {
  const m = mockForgejo((key) => {
    if (key === "POST /api/v1/repos/o/r/pulls/2/merge") return new Response("", { status: 200 });
    if (key === "GET /api/v1/repos/o/r/pulls/2") {
      return json({
        number: 2,
        state: "closed",
        merged: true,
        merged_at: "2026-11-03T12:17:29+01:00",
        head: { ref: "refs/pull/2/head", label: "probe/branch" },
        base: { ref: "main", label: "main" },
        user: { login: "duke" },
      });
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.mergePull({ owner: "o", name: "r" }, 2, "probe merge");
    assertEquals(m.recorded.map((r) => `${r.method} ${r.path}`), [
      "POST /api/v1/repos/o/r/pulls/2/merge",
      "GET /api/v1/repos/o/r/pulls/2",
    ]);
    assertEquals(JSON.parse(m.recorded[0].body).Do, "merge");
    assertEquals(out.merged, true);
    assertEquals(out.state, "merged");
    // the synthetic ref must never leak out as a branch name
    assertEquals(out.sourceBranch, "probe/branch");
    assertEquals(out.targetBranch, "main");
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: writeFile creates with POST, updates with PUT + sha", async () => {
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/o/r/contents/new.md") {
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    if (key === "POST /api/v1/repos/o/r/contents/new.md") return json({}, 201);
    if (key === "GET /api/v1/repos/o/r/contents/old.md") return json({ sha: "blob123" });
    if (key === "PUT /api/v1/repos/o/r/contents/old.md") return json({}, 200);
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    await port.writeFile({ owner: "o", name: "r" }, {
      path: "new.md",
      branch: "main",
      content: "hello",
      message: "add",
    });
    assertEquals(m.recorded.map((r) => r.method), ["GET", "POST"]);
    // content goes up base64-encoded
    assertEquals(JSON.parse(m.recorded[1].body).content, "aGVsbG8=");

    m.recorded.length = 0;
    await port.writeFile({ owner: "o", name: "r" }, {
      path: "old.md",
      branch: "main",
      content: "changed",
      message: "edit",
    });
    assertEquals(m.recorded.map((r) => r.method), ["GET", "PUT"]);
    assertEquals(JSON.parse(m.recorded[1].body).sha, "blob123");
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: issues.get refuses a number that is really a pull request", async () => {
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/o/r/issues/2") {
      return json({ number: 2, title: "pr", state: "closed", pull_request: { merged: true } });
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const err = await assertRejects(() => port.getIssue({ owner: "o", name: "r" }, 2));
    assertStringIncludes((err as Error).message, "is a pull request; use forge.pulls.get");
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: pulls.list filters state=merged on the flag (no upstream filter)", async () => {
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/o/r/pulls") {
      return json([
        { number: 1, title: "open", state: "open", head: { ref: "a" }, base: { ref: "main" } },
        {
          number: 2,
          title: "merged",
          state: "closed",
          merged_at: "2026-11-03T10:00:00Z",
          head: { ref: "b" },
          base: { ref: "main" },
        },
      ]);
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.listPulls({ owner: "o", name: "r" }, { state: "merged" });
    assertEquals(out.items.map((p) => p.number), [2]);
    assertEquals(out.items[0].state, "merged");
    assertEquals(m.recorded[0].query.state, "closed");
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: labels are resolved from names to ids before writing", async () => {
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/o/r/labels") {
      return json([{ id: 3, name: "bug" }, { id: 4, name: "mail" }]);
    }
    if (key === "POST /api/v1/repos/o/r/issues") {
      return json({ number: 7, title: "t", state: "open", labels: [{ name: "mail" }] }, 201);
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.createIssue({ owner: "o", name: "r" }, { title: "t", labels: ["mail"] });
    assertEquals(JSON.parse(m.recorded[1].body).labels, [4]);
    assertEquals(out.labels, ["mail"]);

    m.recorded.length = 0;
    const err = await assertRejects(() =>
      port.createIssue({ owner: "o", name: "r" }, { title: "t", labels: ["nope"] })
    );
    assertStringIncludes((err as Error).message, "unknown label(s) on o/r: nope");
    assertStringIncludes((err as Error).message, "known: bug, mail");
    // nothing was written
    assertEquals(m.recorded.filter((r) => r.method === "POST").length, 0);
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: file reads use /raw (exact bytes), not base64 JSON", async () => {
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/o/r/raw/README.md") {
      return new Response("# hi\n", { headers: { "content-type": "text/plain" } });
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const f = await port.getFile({ owner: "o", name: "r" }, { path: "README.md" });
    assertEquals(f.text, "# hi\n");
    assertEquals(f.size, 5);
    assertEquals(f.binary, false);
    assertEquals(f.truncated, false);
    assertEquals(f.sha, null); // only needed for writes, which fetch it themselves
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: changes merge the file list with per-file patches from the .diff", async () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/repos/o/r/pulls/3/files") {
      return json([
        { filename: "a.txt", status: "modified", additions: 1, deletions: 1 },
        { filename: "b.txt", status: "modified", additions: 1, deletions: 1 },
      ]);
    }
    if (key === "GET /api/v1/repos/o/r/pulls/3.diff") {
      return new Response(diff, { headers: { "content-type": "text/plain" } });
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const set = await port.getChanges({ owner: "o", name: "r" }, 3);
    assertEquals(set.truncated, false);
    assertEquals(set.files.map((f) => f.path), ["a.txt", "b.txt"]);
    assertStringIncludes(set.files[0].patch ?? "", "-old");
    assertStringIncludes(set.files[1].patch ?? "", "+y");
    // the split keeps each file's own hunk
    assertEquals((set.files[0].patch ?? "").includes("b.txt"), false);
    assertEquals(splitDiff(diff).size, 2);
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: the startup check compares maxLimit with the instance cap", async () => {
  const m = mockForgejo((key) => {
    if (key === "GET /api/v1/settings/api") {
      return json({
        max_response_items: 50,
        default_paging_num: 30,
        default_git_trees_per_page: 1000,
      });
    }
    return null;
  });
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    await port.validate?.();
    // clampLimit(50) === 50, so the configured cap agrees with the instance
    assertEquals(new ForgeHttp(ACCOUNT(m.base)).clampLimit(500), 50);
  } finally {
    m.stop();
  }
});

Deno.test("forgejo: base64 encoding is UTF-8 safe", () => {
  assertEquals(toBase64("hello"), "aGVsbG8=");
  assertEquals(
    new TextDecoder().decode(
      Uint8Array.from(atob(toBase64("éàü ✓")), (c) => c.charCodeAt(0)),
    ),
    "éàü ✓",
  );
});

Deno.test("forgejo: branchOf prefers a real ref over the synthetic refs/pull/N/head", () => {
  assertEquals(branchOf({ ref: "feature", label: "feature" }), "feature");
  assertEquals(branchOf({ ref: "refs/pull/2/head", label: "probe/x" }), "probe/x");
  assertEquals(branchOf({}), null);
});

Deno.test("forgejo: tree.list pages by slicing, because /contents has no paging", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    name: `f${i}.txt`,
    path: `f${i}.txt`,
    type: "file",
    size: 10,
  }));
  const m = mockForgejo((key, rec) => key === "GET /api/v1/repos/o/r/contents" ? json(rows) : null);
  try {
    const port = forgejoPort(new ForgeHttp(ACCOUNT(m.base)));
    const p1 = await port.listTree({ owner: "o", name: "r" }, { limit: 2, page: 1 });
    const p2 = await port.listTree({ owner: "o", name: "r" }, { limit: 2, page: 2 });
    const p3 = await port.listTree({ owner: "o", name: "r" }, { limit: 2, page: 3 });
    assertEquals(p1.items.map((e) => e.name), ["f0.txt", "f1.txt"]);
    assertEquals(p1.nextPage, 2);
    assertEquals(p2.items.map((e) => e.name), ["f2.txt", "f3.txt"]);
    assertEquals(p2.nextPage, 3);
    assertEquals(p3.items.map((e) => e.name), ["f4.txt"]);
    assertEquals(p3.nextPage, null);
  } finally {
    m.stop();
  }
});
