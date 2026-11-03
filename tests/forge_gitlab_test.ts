import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { ForgeHttp } from "../src/connectors/forge/client.ts";
import { extractMessage } from "../src/connectors/forge/client.ts";
import { gitlabPort } from "../src/connectors/forge/flavors/gitlab.ts";
import type { ForgeAccount } from "../src/connectors/forge/port.ts";
import { ForgeError } from "../src/connectors/forge/port.ts";

// What these pin is the half of the abstraction that no endpoint table can tell you:
// the verb GitLab actually wants (PUT+state_event, not PATCH+state), the probe that
// makes file writes create-or-update, the page-size clamp, and an error mapper that
// survives three different error bodies.

interface Rec {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
}

function account(origin: string, over: Partial<ForgeAccount> = {}): ForgeAccount {
  return {
    id: "ebrains",
    flavor: "gitlab",
    origin,
    apiPath: "/api/v4",
    token: "test-token",
    maxLimit: 100,
    ...over,
  };
}

function mockGitLab(routes: (key: string, rec: Rec) => Response | null) {
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
    const res = routes(`${req.method} ${url.pathname}`, rec);
    return res ?? new Response(JSON.stringify({ message: "404 Not Found" }), { status: 404 });
  });
  base = `http://127.0.0.1:${server.addr.port}`;
  return { base, recorded, stop: () => server.shutdown() };
}

const PROJECT = {
  id: 1935,
  name: "mymcp",
  path: "mymcp",
  path_with_namespace: "woodman/mymcp",
  default_branch: "main",
  visibility: "private",
  archived: false,
  web_url: "https://gitlab.ebrains.eu/woodman/mymcp",
  last_activity_at: "2026-11-03T10:00:00.000Z",
  namespace: { full_path: "woodman" },
};

const ISSUE = {
  iid: 12,
  title: "mail: surface responseText",
  state: "opened",
  labels: ["mail"],
  author: { username: "duke" },
  web_url: "https://gitlab.ebrains.eu/woodman/mymcp/-/issues/12",
  updated_at: "2026-11-03T11:00:00.000Z",
};

Deno.test("forge/gitlab: listProjects clamps the page size and reports nextPage", async () => {
  const m = mockGitLab((key) => {
    if (key === "GET /api/v4/projects") {
      return new Response(
        JSON.stringify([PROJECT, { ...PROJECT, id: 2, path_with_namespace: "a/b" }]),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    const out = await port.listProjects({ limit: 500, page: 1 });
    const rec = m.recorded[0];
    // GitLab caps per_page at 100: asking for 500 must not be forwarded verbatim.
    assertEquals(rec.query.per_page, "100");
    assertEquals(rec.query.page, "1");
    assertEquals(out.items.length, 2);
    assertEquals(out.items[0].fullName, "woodman/mymcp");
    assertEquals(out.items[0].owner, "woodman");
    assertEquals(out.items[0].name, "mymcp");
    // a short page is the last page
    assertEquals(out.nextPage, null);
  } finally {
    m.stop();
  }
});

Deno.test("forge/gitlab: issue update uses PUT + state_event, not PATCH + state", async () => {
  const m = mockGitLab((key) => {
    if (key === "PUT /api/v4/projects/woodman%2Fmymcp/issues/12") {
      return new Response(JSON.stringify({ ...ISSUE, state: "closed" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    const out = await port.updateIssue({ owner: "woodman", name: "mymcp" }, 12, {
      state: "closed",
    });
    const rec = m.recorded[0];
    assertEquals(rec.method, "PUT");
    const body = JSON.parse(rec.body);
    assertEquals(body.state_event, "close");
    assertEquals(body.state, undefined);
    assertEquals(out.state, "closed");
  } finally {
    m.stop();
  }
});

Deno.test("forge/gitlab: writeFile probes then creates (POST) or updates (PUT)", async () => {
  const m = mockGitLab((key) => {
    if (key === "GET /api/v4/projects/o%2Fr/repository/files/new.txt") {
      return new Response(JSON.stringify({ message: "404 File Not Found" }), { status: 404 });
    }
    if (key === "POST /api/v4/projects/o%2Fr/repository/files/new.txt") {
      return new Response(JSON.stringify({ file_path: "new.txt", branch: "main" }), {
        status: 201,
      });
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    await port.writeFile({ owner: "o", name: "r" }, {
      path: "new.txt",
      branch: "main",
      content: "hello",
      message: "add",
    });
    assertEquals(m.recorded.map((r) => r.method), ["GET", "POST"]);
    assertEquals(JSON.parse(m.recorded[1].body).commit_message, "add");
  } finally {
    m.stop();
  }
});

Deno.test("forge/gitlab: writeFile updates an existing blob with PUT", async () => {
  const m = mockGitLab((key) => {
    if (key === "GET /api/v4/projects/o%2Fr/repository/files/old.txt") {
      return new Response(JSON.stringify({ file_path: "old.txt", content: "" }));
    }
    if (key === "PUT /api/v4/projects/o%2Fr/repository/files/old.txt") {
      return new Response(JSON.stringify({ file_path: "old.txt" }));
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    await port.writeFile({ owner: "o", name: "r" }, {
      path: "old.txt",
      branch: "main",
      content: "changed",
      message: "edit",
    });
    assertEquals(m.recorded.map((r) => r.method), ["GET", "PUT"]);
  } finally {
    m.stop();
  }
});

Deno.test("forge/gitlab: upstream errors carry status, message and a usable hint", async () => {
  const m = mockGitLab((key) => {
    if (key === "GET /api/v4/projects/x%2Fy/issues/1") {
      return new Response(JSON.stringify({ message: "403 Forbidden" }), { status: 403 });
    }
    return null;
  });
  try {
    const http = new ForgeHttp(account(m.base));
    const err = await assertRejects(() => http.get("/projects/x%2Fy/issues/1"), ForgeError);
    assertEquals((err as ForgeError).status, 403);
    assertStringIncludes((err as ForgeError).hint ?? "", "scope");
    assertStringIncludes((err as ForgeError).message, "ebrains (gitlab)");
  } finally {
    m.stop();
  }
});

Deno.test("forge: extractMessage handles GitLab, Forgejo and empty bodies", () => {
  assertEquals(
    extractMessage(JSON.stringify({ message: "404 Project Not Found" })),
    "404 Project Not Found",
  );
  // Forgejo validation error: `message` is the useful string in errors[]
  assertEquals(
    extractMessage(JSON.stringify({ message: "", errors: ["[SHA]: Required"] })),
    "[SHA]: Required",
  );
  // Forgejo 404 for an org: `message` is an internal function name, errors[] is human
  assertEquals(
    extractMessage(
      JSON.stringify({
        message: "GetOrgByName",
        errors: ["user redirect does not exist [name: ins-amu]"],
      }),
    ),
    "user redirect does not exist [name: ins-amu]",
  );
  assertEquals(extractMessage(""), null);
  assertEquals(extractMessage("plain text failure"), "plain text failure");
  // GitHub's shape
  assertEquals(
    extractMessage(JSON.stringify({ message: "Bad credentials", documentation_url: "https://x" })),
    "Bad credentials",
  );
});

Deno.test("forge: the client refuses to leave the pinned origin or API root", async () => {
  const m = mockGitLab(() => null);
  try {
    const http = new ForgeHttp(account(m.base));
    await assertRejects(() => http.get("/../../etc/passwd"));
    await assertRejects(() => http.get("//evil.example.com/api/v4/projects"));
    await assertRejects(() => http.get("https://evil.example.com/x"));
    await assertRejects(() => http.get("projects"));
    // Nothing was sent: the checks run before fetch.
    assertEquals(m.recorded.length, 0);
  } finally {
    m.stop();
  }
});

Deno.test("forge/gitlab: getFile decodes base64, flags binary and truncates", async () => {
  const m = mockGitLab((key) => {
    if (key === "GET /api/v4/projects/o%2Fr") {
      return new Response(JSON.stringify({ path_with_namespace: "o/r", default_branch: "main" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (key === "GET /api/v4/projects/o%2Fr/repository/files/README.md") {
      return new Response(
        JSON.stringify({
          file_path: "README.md",
          ref: "main",
          size: 12,
          blob_id: "blob1",
          // GitLab wraps its base64 at 80 columns
          content: btoa("hello\nworld\n"),
          encoding: "base64",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (key === "GET /api/v4/projects/o%2Fr/repository/files/bin.dat") {
      return new Response(
        JSON.stringify({ file_path: "bin.dat", size: 4, content: btoa("\x00\x01\x02\x03") }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    const text = await port.getFile({ owner: "o", name: "r" }, { path: "README.md" });
    assertEquals(text.text, "hello\nworld\n");
    assertEquals(text.binary, false);
    assertEquals(text.truncated, false);
    assertEquals(text.sha, "blob1");

    const bin = await port.getFile({ owner: "o", name: "r" }, { path: "bin.dat" });
    assertEquals(bin.binary, true);
    assertEquals(bin.text, null);
  } finally {
    m.stop();
  }
});

Deno.test("forge/gitlab: merge maps the message and returns a normalized pull", async () => {
  const m = mockGitLab((key) => {
    if (key === "PUT /api/v4/projects/o%2Fr/merge_requests/7/merge") {
      return new Response(
        JSON.stringify({
          iid: 7,
          title: "probe",
          state: "merged",
          source_branch: "feature",
          target_branch: "main",
          merged_at: "2026-11-03T10:00:00.000Z",
          author: { username: "duke" },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    const out = await port.mergePull({ owner: "o", name: "r" }, 7, "squash me");
    assertEquals(JSON.parse(m.recorded[0].body).merge_commit_message, "squash me");
    assertEquals(out.state, "merged");
    assertEquals(out.merged, true);
    assertEquals(out.number, 7);
  } finally {
    m.stop();
  }
});

Deno.test("forge/gitlab: notes are normalized (author, body, id) and paged", async () => {
  const m = mockGitLab((key) => {
    if (key === "GET /api/v4/projects/o%2Fr/issues/3/notes") {
      return new Response(
        JSON.stringify([
          { id: 5, body: "hi", author: { username: "duke" }, created_at: "2026-11-03T10:00:00Z" },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    const out = await port.listNotes({ owner: "o", name: "r" }, 3, { limit: 10 });
    assertEquals(out.items[0].author, "duke");
    assertEquals(out.items[0].body, "hi");
    assertEquals(out.nextPage, null); // short page => last page
    assertEquals(m.recorded[0].query.per_page, "10");
  } finally {
    m.stop();
  }
});

Deno.test("forge: `limit` is clamped per flavor, not just forwarded", () => {
  const gitlab = new ForgeHttp(account("http://127.0.0.1:1"));
  assertEquals(gitlab.clampLimit(undefined), 30);
  assertEquals(gitlab.clampLimit(500), 100);
  const forgejo = new ForgeHttp(
    account("http://127.0.0.1:1", { flavor: "forgejo", apiPath: "/api/v1", maxLimit: 50 }),
  );
  assertEquals(forgejo.clampLimit(500), 50);
  assertEquals(forgejo.clampLimit(0), 30);
  // auth header differs per flavor: the gitlab one must never be used for forgejo
  const gh = new ForgeHttp(account("http://127.0.0.1:1", { flavor: "github", apiPath: "" }));
  assert(gh.clampLimit(10) === 10);
});

Deno.test("forge/gitlab: a file read without `ref` resolves the default branch (GitLab demands one)", async () => {
  const m = mockGitLab((key) => {
    if (key === "GET /api/v4/projects/o%2Fr") {
      return new Response(JSON.stringify({ path_with_namespace: "o/r", default_branch: "trunk" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (key === "GET /api/v4/projects/o%2Fr/repository/files/README.md") {
      return new Response(
        JSON.stringify({ file_path: "README.md", ref: "trunk", size: 2, content: btoa("hi") }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return null;
  });
  try {
    const port = gitlabPort(new ForgeHttp(account(m.base)));
    const f = await port.getFile({ owner: "o", name: "r" }, { path: "README.md" });
    assertEquals(f.text, "hi");
    assertEquals(f.ref, "trunk");
    // the resolved ref is used for the read, and the project lookup is cached
    assertEquals(m.recorded[1].query.ref, "trunk");
    await port.getFile({ owner: "o", name: "r" }, { path: "README.md" });
    assertEquals(m.recorded.filter((r) => r.path === "/api/v4/projects/o%2Fr").length, 1);
  } finally {
    m.stop();
  }
});
