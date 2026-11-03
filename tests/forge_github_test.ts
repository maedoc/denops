import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { ForgeHttp } from "../src/connectors/forge/client.ts";
import { githubPort, nextPageFromLink, toBase64 } from "../src/connectors/forge/flavors/github.ts";
import type { ForgeAccount } from "../src/connectors/forge/port.ts";

// What is structurally different about GitHub, verified against api.github.com:
//  - paging is a `Link` cursor, not "this page was short"
//  - `GET /issues` returns PRs, so issues.list must filter on `pull_request`
//  - `state=merged` does not exist (merged = closed + merged_at)
//  - there is no /raw: file bytes need `Accept: application/vnd.github.raw`
//  - a file update without `sha` is 422 `"sha" wasn't supplied`
//  - search is a different endpoint with a {total_count, items} envelope
//  - 403 means scope *or* rate limit; only the headers separate them

interface Rec {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  accept: string | null;
}

function mockGitHub(routes: (key: string, rec: Rec) => Response | null) {
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
      accept: req.headers.get("accept"),
    };
    recorded.push(rec);
    return routes(`${req.method} ${url.pathname}`, rec) ??
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  });
  base = `http://127.0.0.1:${server.addr.port}`;
  return { base, recorded, stop: () => server.shutdown() };
}

const ACCOUNT = (origin: string): ForgeAccount => ({
  id: "github",
  flavor: "github",
  origin,
  apiPath: "",
  token: "ghp",
  maxLimit: 100,
});

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

Deno.test("github: Link cursor drives nextPage, not a short page", async () => {
  const m = mockGitHub((key) => {
    if (key === "GET /user/repos") {
      return json(
        [{ id: 1, full_name: "o/r", name: "r", owner: { login: "o" }, private: false }],
        200,
        {
          link:
            '<http://x/user/repos?page=2>; rel="next", <http://x/user/repos?page=9>; rel="last"',
        },
      );
    }
    return null;
  });
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.listProjects({ limit: 1 });
    assertEquals(out.items.length, 1);
    // one item and limit 1 — a short-page heuristic would have said "done"
    assertEquals(out.nextPage, 2);
    assertEquals(m.recorded[0].query.per_page, "1");
  } finally {
    m.stop();
  }
});

Deno.test("github: Link parsing ignores non-next relations", () => {
  assertEquals(
    nextPageFromLink('<http://x?page=2>; rel="prev", <http://x?page=4>; rel="next"'),
    4,
  );
  assertEquals(nextPageFromLink('<http://x?page=2>; rel="last"'), null);
  assertEquals(nextPageFromLink(null), null);
  assertEquals(nextPageFromLink(""), null);
});

Deno.test("github: issues.list drops the pull requests that share the number space", async () => {
  const rows = [
    {
      number: 1,
      title: "real issue",
      state: "open",
      user: { login: "maedoc" },
      labels: [],
      pull_request: undefined,
    },
    {
      number: 2,
      title: "a PR",
      state: "closed",
      user: { login: "maedoc" },
      labels: [],
      pull_request: { merged_at: "x" },
    },
  ];
  const m = mockGitHub((key) => (key === "GET /repos/o/r/issues" ? json(rows) : null));
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.listIssues({ owner: "o", name: "r" }, { state: "all" });
    assertEquals(out.items.map((i) => i.number), [1]);
  } finally {
    m.stop();
  }
});

Deno.test("github: issues.get refuses a PR number and names pulls.get", async () => {
  const m = mockGitHub((key) =>
    key === "GET /repos/o/r/issues/2"
      ? json({ number: 2, title: "pr", state: "closed", pull_request: { merged_at: "x" } })
      : null
  );
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const err = await assertRejects(() => port.getIssue({ owner: "o", name: "r" }, 2));
    assertStringIncludes((err as Error).message, "use forge.pulls.get");
  } finally {
    m.stop();
  }
});

Deno.test("github: pulls.list state=merged filters closed rows on merged_at", async () => {
  const m = mockGitHub((key) =>
    key === "GET /repos/o/r/pulls"
      ? json([
        { number: 1, state: "open", merged_at: null, head: { ref: "a" }, base: { ref: "main" } },
        {
          number: 2,
          state: "closed",
          merged_at: "2026-11-03T10:00:00Z",
          head: { ref: "b" },
          base: { ref: "main" },
        },
      ])
      : null
  );
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.listPulls({ owner: "o", name: "r" }, { state: "merged" });
    assertEquals(out.items.map((p) => p.number), [2]);
    assertEquals(out.items[0].state, "merged");
    assertEquals(m.recorded[0].query.state, "closed");
  } finally {
    m.stop();
  }
});

Deno.test("github: file reads send the raw media type and decode exact bytes", async () => {
  const m = mockGitHub((key) =>
    key === "GET /repos/o/r/contents/README.md"
      ? new Response("# hi\n", { headers: { "content-type": "application/vnd.github.raw" } })
      : null
  );
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const f = await port.getFile({ owner: "o", name: "r" }, { path: "README.md" });
    assertEquals(f.text, "# hi\n");
    assertEquals(f.size, 5);
    assertEquals(f.binary, false);
    assertStringIncludes(String(m.recorded[0].accept), "application/vnd.github.raw");
  } finally {
    m.stop();
  }
});

Deno.test("github: writeFile omits sha on create and sends it on update", async () => {
  const m = mockGitHub((key) => {
    if (key === "GET /repos/o/r/contents/new.md") {
      return json({ message: "Not Found" }, 404);
    }
    if (key === "PUT /repos/o/r/contents/new.md") return json({ content: { sha: "newblob" } }, 201);
    if (key === "GET /repos/o/r/contents/old.md") return json({ sha: "oldblob" });
    if (key === "PUT /repos/o/r/contents/old.md") {
      return json({ content: { sha: "nextblob" } }, 200);
    }
    return null;
  });
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const created = await port.writeFile({ owner: "o", name: "r" }, {
      path: "new.md",
      branch: "main",
      content: "hello",
      message: "add",
    });
    assertEquals(created.sha, "newblob");
    const body = JSON.parse(m.recorded[1].body);
    assertEquals(body.sha, undefined, "create must not send a sha");
    assertEquals(body.content, "aGVsbG8=");

    m.recorded.length = 0;
    await port.writeFile({ owner: "o", name: "r" }, {
      path: "old.md",
      branch: "main",
      content: "changed",
      message: "edit",
    });
    assertEquals(JSON.parse(m.recorded[1].body).sha, "oldblob");
  } finally {
    m.stop();
  }
});

Deno.test("github: search uses its own endpoint and envelope", async () => {
  const m = mockGitHub((key) => {
    if (key === "GET /search/repositories") {
      return json({
        total_count: 1,
        incomplete_results: false,
        items: [{ id: 5, full_name: "o/r", name: "r", owner: { login: "o" } }],
      });
    }
    if (key === "GET /search/users") {
      return json({
        total_count: 1,
        incomplete_results: false,
        items: [{ id: 9, login: "maedoc" }],
      });
    }
    return null;
  });
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const repos = await port.listProjects({ search: "r" });
    assertEquals(repos.items[0].fullName, "o/r");
    const users = await port.searchUsers({ search: "maedoc" });
    assertEquals(users.items[0].username, "maedoc");
  } finally {
    m.stop();
  }
});

Deno.test("github: 403 rate-limit and 403 scope are told apart by headers", async () => {
  const limited = mockGitHub((key) =>
    key === "GET /user"
      ? json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" })
      : null
  );
  const scoped = mockGitHub((key) =>
    key === "GET /user" ? json({ message: "Resource not accessible by integration" }, 403) : null
  );
  try {
    const a = await assertRejects(
      () => githubPort(new ForgeHttp(ACCOUNT(limited.base))).currentUser(),
      Error,
    );
    assertStringIncludes((a as { hint?: string }).hint ?? "", "rate limited");

    const b = await assertRejects(
      () => githubPort(new ForgeHttp(ACCOUNT(scoped.base))).currentUser(),
      Error,
    );
    assertStringIncludes((b as { hint?: string }).hint ?? "", "scope");
  } finally {
    limited.stop();
    scoped.stop();
  }
});

Deno.test("github: merge reports merged after reading the PR back", async () => {
  const m = mockGitHub((key) => {
    if (key === "PUT /repos/o/r/pulls/2/merge") {
      return json({ merged: true, message: "Pull Request merged" });
    }
    if (key === "GET /repos/o/r/pulls/2") {
      return json({
        number: 2,
        state: "closed",
        merged: true,
        merged_at: "2026-11-03T11:46:54Z",
        head: { ref: "probe/x" },
        base: { ref: "main" },
        user: { login: "maedoc" },
      });
    }
    return null;
  });
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const out = await port.mergePull({ owner: "o", name: "r" }, 2, "squash me");
    assertEquals(m.recorded.map((r) => r.method), ["PUT", "GET"]);
    assertEquals(JSON.parse(m.recorded[0].body).commit_title, "squash me");
    assertEquals(out.state, "merged");
    assertEquals(out.merged, true);
    assertEquals(out.sourceBranch, "probe/x");
  } finally {
    m.stop();
  }
});

Deno.test("github: changed files carry per-file patches and stop at the cap", async () => {
  const m = mockGitHub((key, rec) => {
    if (key === "GET /repos/o/r/pulls/2/files") {
      const page = rec.query.page ?? "1";
      return json(
        [{
          filename: "a.txt",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@",
        }],
        200,
        // only the first page advertises a successor
        page === "1" ? { link: '<http://x?page=2>; rel="next"' } : {},
      );
    }
    return null;
  });
  try {
    const port = githubPort(new ForgeHttp(ACCOUNT(m.base)));
    const set = await port.getChanges({ owner: "o", name: "r" }, 2);
    assertEquals(set.files[0].patch, "@@ -1 +1 @@");
    // pagination follows the cursor (one more page was advertised)
    assertEquals(m.recorded.length, 2);
  } finally {
    m.stop();
  }
});

Deno.test("github: base64 encoding is UTF-8 safe", () => {
  assertEquals(toBase64("hello"), "aGVsbG8=");
  assertEquals(
    new TextDecoder().decode(Uint8Array.from(atob(toBase64("éàü ✓")), (c) => c.charCodeAt(0))),
    "éàü ✓",
  );
});
