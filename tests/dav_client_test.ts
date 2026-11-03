import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { davConnector } from "../src/connectors/dav/manifest.ts";
import type { Connector, JsonValue } from "../src/harness/types.ts";

// What these pin is the contract a caller actually experiences: one address form, no
// XML in results, create-only by default, etag-gated writes, refusals before approval,
// and bytes that reach disk instead of the context window.

const SHARE = "/remote.php/dav/files/alice";

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

interface Node {
  kind: "file" | "dir";
  bytes: Uint8Array;
  mtime: string;
  etag: string;
}

function multistatus(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" ` +
    `xmlns:oc="http://owncloud.org/ns">${body}</d:multistatus>`;
}

function response(href: string, props: string, status = "HTTP/1.1 200 OK"): string {
  return props === ""
    ? `<d:response><d:href>${href}</d:href><d:status>${status}</d:status></d:response>`
    : `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop>` +
      `<d:status>${status}</d:status></d:propstat></d:response>`;
}

/**
 * A small in-memory Nextcloud-ish DAV server. It is deliberately strict about the
 * request shapes the client is supposed to send (Depth, If-Match, If-None-Match,
 * Overwrite), because those are the safety properties under test.
 */
function mockDav(recorded: Recorded[], opts: { quota?: boolean; unlimited?: boolean } = {}) {
  const nodes = new Map<string, Node>();
  const enc = new TextEncoder();
  const add = (path: string, content: string | Uint8Array, kind: "file" | "dir" = "file") => {
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    nodes.set(`${SHARE}/${path}`.replace(/\/$/, ""), {
      kind,
      bytes,
      mtime: "Mon, 02 Nov 2026 10:00:00 GMT",
      etag: `"etag-${nodes.size}"`,
    });
  };
  add("", "", "dir");
  add("docs", "", "dir");
  add("docs/intro.md", "# Intro\nhello\n");
  add("docs/data.csv", "a,b\n1,2\n");
  add("docs/sub", "", "dir");
  add("docs/sub/deep.md", "deep\n");
  add("notes.json", '{"a":1}');
  add("logo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  let base = "";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const bytes = new Uint8Array(await req.arrayBuffer());
    recorded.push({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body: new TextDecoder().decode(bytes),
    });
    const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
    const node = nodes.get(path);
    const href = `${SHARE}${path.slice(SHARE.length)}`;
    const depth = req.headers.get("depth") ?? "1";

    if (req.method === "PROPFIND") {
      if (!node) {
        // what Nextcloud/Sabre actually answers, body and all
        return new Response(
          `<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" ` +
            `xmlns:s="http://sabredav.org/ns">` +
            `<s:exception>Sabre\DAV\Exception\NotFound</s:exception>` +
            `<s:message>File with name ${href} could not be located</s:message></d:error>`,
          { status: 404, headers: { "content-type": "application/xml; charset=utf-8" } },
        );
      }
      const propsOf = (p: string, n: Node) => {
        const isDir = n.kind === "dir";
        const base = `<d:resourcetype>${isDir ? "<d:collection/>" : ""}</d:resourcetype>` +
          `<d:displayname>${p.split("/").pop() ?? ""}</d:displayname>` +
          `<d:getlastmodified>${n.mtime}</d:getlastmodified><d:getetag>${n.etag}</d:getetag>` +
          (isDir ? "" : `<d:getcontentlength>${n.bytes.byteLength}</d:getcontentlength>`) +
          (isDir
            ? ""
            : `<d:getcontenttype>${
              p.endsWith(".png")
                ? "image/png"
                : p.endsWith(".json")
                ? "application/json"
                : "text/plain"
            }</d:getcontenttype>`);
        if (p === SHARE && opts.quota) {
          // Nextcloud 33+ answers RFC 4331 names in the DAV: namespace; the oc: ones
          // 404. Serving exactly that is the point of this branch.
          return base +
            `<d:quota-used-bytes>1000</d:quota-used-bytes>` +
            (opts.unlimited
              ? `<d:quota-available-bytes>-1</d:quota-available-bytes>`
              : `<d:quota-available-bytes>3000</d:quota-available-bytes>`);
        }
        if (p === SHARE && opts.quota === false) return base;
        return base;
      };
      const self = response(href + (node.kind === "dir" ? "/" : ""), propsOf(path, node));
      if (depth === "0" || node.kind === "file") {
        return new Response(multistatus(self), { status: 207 });
      }
      const kids = [...nodes.entries()]
        .filter(([p]) =>
          p !== path && p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")
        )
        .map(([p, n]) =>
          response(`${SHARE}${p.slice(SHARE.length)}${n.kind === "dir" ? "/" : ""}`, propsOf(p, n))
        );
      return new Response(multistatus(self + kids.join("")), { status: 207 });
    }

    if (req.method === "GET") {
      if (!node || node.kind === "dir") return new Response("nope", { status: 404 });
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      if (range) {
        const from = Number(range[1]);
        const to = Math.min(Number(range[2]), node.bytes.byteLength - 1);
        const slice = node.bytes.subarray(from, to + 1);
        return new Response(slice as unknown as BodyInit, {
          status: 206,
          headers: {
            "content-type": "text/plain",
            "content-range": `bytes ${from}-${to}/${node.bytes.byteLength}`,
            etag: `${node.etag}-gzip`,
          },
        });
      }
      return new Response(node.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": path.endsWith(".png") ? "image/png" : "text/plain",
          // Nextcloud appends -gzip to the response ETag; the DAV getetag is the one
          // If-Match is compared against, so `get` must not report this one.
          etag: `${node.etag}-gzip`,
          "content-length": String(node.bytes.byteLength),
        },
      });
    }

    if (req.method === "PUT") {
      const ifNone = req.headers.get("if-none-match");
      const ifMatch = req.headers.get("if-match");
      if (ifNone === "*" && node) return new Response("exists", { status: 412 });
      if (ifMatch !== null && node && ifMatch !== node.etag) {
        return new Response("stale", { status: 412 });
      }
      const created = !node;
      nodes.set(path, {
        kind: "file",
        bytes,
        mtime: new Date().toUTCString(),
        etag: `"etag-new-${nodes.size + 1}"`,
      });
      return new Response(null, {
        status: created ? 201 : 204,
        headers: { etag: `"etag-new-${nodes.size}"` },
      });
    }

    if (req.method === "MKCOL") {
      if (node) return new Response("exists", { status: 405 });
      const parent = nodes.get(path.slice(0, path.lastIndexOf("/")));
      if (!parent) return new Response("no parent", { status: 409 });
      nodes.set(path, {
        kind: "dir",
        bytes: new Uint8Array(),
        mtime: new Date().toUTCString(),
        etag: `"d${nodes.size}"`,
      });
      return new Response(null, { status: 201 });
    }

    if (req.method === "MOVE" || req.method === "COPY") {
      const dest = new URL(req.headers.get("destination") ?? "", base);
      const destPath = decodeURIComponent(dest.pathname).replace(/\/$/, "");
      if (!node) return new Response("nope", { status: 404 });
      const exists = nodes.has(destPath);
      if (exists && req.headers.get("overwrite") === "F") {
        return new Response("exists", { status: 412 });
      }
      nodes.set(destPath, { ...node });
      if (req.method === "MOVE") nodes.delete(path);
      return new Response(null, { status: exists ? 204 : 201 });
    }

    if (req.method === "DELETE") {
      if (!node) return new Response("nope", { status: 404 });
      for (const p of [...nodes.keys()]) {
        if (p === path || p.startsWith(`${path}/`)) nodes.delete(p);
      }
      return new Response(null, { status: 204 });
    }

    return new Response("unhandled", { status: 500 });
  });
  base = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
  return { server, base, nodes };
}

interface Harness {
  conn: Connector;
  recorded: Recorded[];
  nodes: Map<string, Node>;
  staging: string;
  call: (op: string, args?: Record<string, unknown>) => Promise<JsonValue>;
  schema: (op: string, args: Record<string, unknown>) => string | null;
  close: () => Promise<void>;
}

async function harness(
  opts: {
    writable?: boolean;
    quota?: boolean;
    unlimited?: boolean;
    stagingFsRoot?: { name: string; path: string };
  } = {},
): Promise<Harness> {
  const recorded: Recorded[] = [];
  const { server, base, nodes } = mockDav(recorded, {
    quota: opts.quota,
    unlimited: opts.unlimited,
  });
  const staging = await Deno.makeTempDir({ prefix: "dav-stage-" });
  const root = await Deno.makeTempDir({ prefix: "dav-fs-" });
  const conn = davConnector({
    accounts: [{
      id: "alice",
      origin: base,
      shareRoot: SHARE,
      user: "alice",
      auth: "basic",
      password: "app-password",
      writable: opts.writable !== false,
    }],
    stagingRoot: `${root}/dav`,
    stagingFsRoot: opts.stagingFsRoot ?? { name: "stage", path: root },
    timeoutMs: 5000,
  });
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  return {
    conn,
    recorded,
    nodes,
    staging,
    call: (op, args = {}) => client[op]({ account: "alice", ...args } as JsonValue),
    schema: (op, args) => {
      const spec = conn.ops.find((o) => o.name === `dav.${op}`);
      if (!spec) throw new Error(`no such op: dav.${op}`);
      return spec.argSchema({ account: "alice", ...args });
    },
    close: async () => {
      await server.shutdown();
      await Deno.remove(root, { recursive: true }).catch(() => {});
      await Deno.remove(staging, { recursive: true }).catch(() => {});
    },
  };
}

// --- reads -------------------------------------------------------------------

Deno.test("dav: accounts reports where paths start, never a credential", async () => {
  const h = await harness();
  try {
    const out = await h.call("accounts") as {
      accounts: Array<Record<string, JsonValue>>;
    };
    assertEquals(out.accounts.length, 1);
    assertEquals(out.accounts[0].account, "alice");
    assertEquals(out.accounts[0].shareRoot, SHARE);
    assertEquals(out.accounts[0].writable, true);
    assert(!JSON.stringify(out).includes("app-password"), "no password in the result");
  } finally {
    await h.close();
  }
});

Deno.test("dav: list pages a depth-1 listing and drops the collection itself", async () => {
  const h = await harness();
  try {
    const out = await h.call("list", { path: "docs" }) as {
      count: number;
      total: number;
      more: number;
      entries: Array<{ name: string; path: string; kind: string; size?: number }>;
    };
    const names = out.entries.map((e) => e.name);
    assertEquals(names, ["data.csv", "intro.md", "sub"]);
    assertEquals(out.total, 3);
    assertEquals(out.more, 0);
    const sub = out.entries.find((e) => e.name === "sub")!;
    assertEquals(sub.kind, "dir");
    assertEquals(sub.size, undefined, "no bogus size on a collection");
    const md = out.entries.find((e) => e.name === "intro.md")!;
    assertEquals(md.path, "docs/intro.md", "paths round-trip, relative to the share root");
    assertEquals(md.size, 14);

    const paged = await h.call("list", { path: "docs", limit: 2 }) as { more: number };
    assertEquals(paged.more, 1, "more counts what the limit sliced off");

    const dirs = await h.call("list", { path: "docs", kind: "dir" }) as { entries: unknown[] };
    assertEquals(dirs.entries.length, 1);

    const bySize = await h.call("list", { path: "docs", sort: "size" }) as {
      entries: Array<{ name: string }>;
    };
    assertEquals(bySize.entries[0].name, "intro.md", "size sorts largest first");
  } finally {
    await h.close();
  }
});

Deno.test("dav: stat gives the etag the writes need", async () => {
  const h = await harness();
  try {
    const out = await h.call("stat", { path: "docs/intro.md" }) as {
      kind: string;
      size: number;
      etag: string;
      contentType: string;
    };
    assertEquals(out.kind, "file");
    assertEquals(out.size, 14);
    assert(/^"etag-/.test(out.etag));
    assertEquals(out.contentType, "text/plain");
  } finally {
    await h.close();
  }
});

Deno.test("dav: get inlines text, caps it honestly, and refuses binary", async () => {
  const h = await harness();
  try {
    const out = await h.call("get", { path: "docs/intro.md" }) as {
      text: string;
      bytes: number;
      truncated: boolean;
      etag: string;
    };
    assertEquals(out.text, "# Intro\nhello\n");
    assertEquals(out.truncated, false);
    const stat = await h.call("stat", { path: "docs/intro.md" }) as { etag: string };
    assertEquals(out.etag, stat.etag, "get reports the DAV getetag, not the -gzip one");
    assert(!String(out.etag).endsWith("-gzip"));

    const cut = await h.call("get", { path: "docs/intro.md", maxBytes: 4 }) as {
      text: string;
      truncated: boolean;
      bytes: number;
      size?: number;
      nextOffset?: number;
    };
    assertEquals(cut.text, "# In");
    assertEquals(cut.truncated, true);
    assertEquals(cut.bytes, 4, "bytes is the length of the text that came back");
    assertEquals(cut.size, 14, "size is the file's size, from content-length");
    assertEquals(cut.nextOffset, 4, "and the caller is told where to resume");

    // a window: Nextcloud answers Range with 206 + content-range, so a big file is walkable
    const tail = await h.call("get", { path: "docs/intro.md", offset: 8, maxBytes: 100 }) as {
      text: string;
      offset: number;
      totalBytes?: number;
      size?: number;
      truncated: boolean;
    };
    assertEquals(tail.text, "hello\n");
    assertEquals(tail.offset, 8);
    assertEquals(tail.totalBytes, 14, "the real size comes from content-range");
    assertEquals(tail.size, 14);
    assertEquals(tail.truncated, false, "the window covers the rest of the file");

    const dirErr = await assertRejects(() => h.call("get", { path: "docs" })) as Error;
    assertStringIncludes(dirErr.message, "that is a directory");
    const stageErr = await assertRejects(() => h.call("stage", { path: "docs" })) as Error;
    assertStringIncludes(stageErr.message, "that is a directory");
    assertEquals(
      h.recorded.filter((r) => r.method === "GET").length,
      3,
      "a directory is refused before any GET is made (only the 3 real reads went out)",
    );

    const err = await assertRejects(() => h.call("get", { path: "logo.png" })) as Error;
    assertStringIncludes(err.message, "not text");
    assertStringIncludes(err.message, "dav.stage", "the error says what to do instead");
  } finally {
    await h.close();
  }
});

Deno.test("dav: find walks bounded and says which cap stopped it", async () => {
  const h = await harness();
  try {
    const hit = await h.call("find", { pattern: "deep" }) as {
      matched: number;
      truncated: boolean;
      entries: Array<{ path: string }>;
    };
    assertEquals(hit.entries.map((e) => e.path), ["docs/sub/deep.md"]);
    assertEquals(hit.truncated, false);

    const glob = await h.call("find", { pattern: "*.csv" }) as { entries: Array<{ path: string }> };
    assertEquals(glob.entries.map((e) => e.path), ["docs/data.csv"]);

    const shallow = await h.call("find", { pattern: "deep", maxDepth: 1 }) as {
      truncated: boolean;
      stoppedBy?: string;
    };
    assertEquals(shallow.truncated, true);
    assertEquals(shallow.stoppedBy, "depth");
  } finally {
    await h.close();
  }
});

Deno.test("dav: quota is reported when the server has it, absent when it does not", async () => {
  const withQuota = await harness({ quota: true });
  try {
    const out = await withQuota.call("quota") as {
      reported: boolean;
      usedBytes: number;
      availableBytes: number;
      totalBytes: number;
      usedPercent: number;
    };
    assertEquals(out.reported, true);
    assertEquals(out.usedBytes, 1000);
    assertEquals(out.availableBytes, 3000);
    assertEquals(out.totalBytes, 4000);
    assertEquals(out.usedPercent, 25);
  } finally {
    await withQuota.close();
  }
  // -1 means "no limit" on Nextcloud: no derived total, no invented percentage
  const unlimited = await harness({ quota: true, unlimited: true });
  try {
    const out = await unlimited.call("quota") as Record<string, unknown>;
    assertEquals(out.reported, true);
    assertEquals(out.usedBytes, 1000);
    assertEquals(out.unlimited, true);
    assertEquals(out.totalBytes, undefined);
    assertEquals(out.usedPercent, undefined);
    assertEquals(out.availableBytes, undefined);
  } finally {
    await unlimited.close();
  }
  const without = await harness({ quota: false });
  try {
    const out = await without.call("quota") as { reported: boolean; note: string };
    assertEquals(out.reported, false);
    assertStringIncludes(out.note, "Nextcloud");
  } finally {
    await without.close();
  }
});

// --- writes ------------------------------------------------------------------

Deno.test("dav: put creates only, unless told otherwise", async () => {
  const h = await harness();
  try {
    const created = await h.call("put", { path: "docs/new.md", text: "hi" }) as {
      created: boolean;
      etag: string;
      bytes: number;
    };
    assertEquals(created.created, true);
    assertEquals(created.bytes, 2);
    assert(created.etag.startsWith('"'), "the new etag comes back so writes can chain");
    const put = h.recorded.filter((r) => r.method === "PUT")[0];
    assertEquals(put.headers.get("if-none-match"), "*", "create-only by default");

    const clash = await assertRejects(() =>
      h.call("put", { path: "docs/new.md", text: "again" })
    ) as Error;
    assertStringIncludes(clash.message, "412");
    assertStringIncludes(clash.message, "overwrite: true", "the fix is named in the error");

    const overwritten = await h.call("put", {
      path: "docs/new.md",
      text: "again",
      overwrite: true,
    }) as { created: boolean };
    assertEquals(overwritten.created, false);

    // etag-gated: the right etag wins, the stale one is a 412 and nothing is written
    const stat = await h.call("stat", { path: "docs/new.md" }) as { etag: string };
    await h.call("put", { path: "docs/new.md", text: "v2", ifMatch: stat.etag });
    const last = h.recorded.filter((r) => r.method === "PUT").at(-1)!;
    assertEquals(last.headers.get("if-match"), stat.etag);
    const stale = await assertRejects(() =>
      h.call("put", { path: "docs/new.md", text: "v3", ifMatch: '"etag-1"' })
    ) as Error;
    assertStringIncludes(stale.message, "Re-read");
  } finally {
    await h.close();
  }
});

Deno.test("dav: mkdir creates the missing parents and is idempotent", async () => {
  const h = await harness();
  try {
    const out = await h.call("mkdir", { path: "a/b/c" }) as {
      created: boolean;
      createdPaths: string[];
    };
    assertEquals(out.created, true);
    assertEquals(out.createdPaths, ["a", "a/b", "a/b/c"]);
    const mkcols = h.recorded.filter((r) => r.method === "MKCOL").map((r) => r.path);
    // collections are addressed with a trailing slash, which is what the href form is
    assertEquals(mkcols, [`${SHARE}/a/`, `${SHARE}/a/b/`, `${SHARE}/a/b/c/`]);

    const again = await h.call("mkdir", { path: "a/b/c" }) as { created: boolean; note?: string };
    assertEquals(again.created, false);
    assertStringIncludes(String(again.note), "already existed");
  } finally {
    await h.close();
  }
});

Deno.test("dav: move and copy refuse a silent overwrite", async () => {
  const h = await harness();
  try {
    await h.call("move", { from: "notes.json", to: "notes-old.json" });
    const move = h.recorded.filter((r) => r.method === "MOVE").at(-1)!;
    assertEquals(move.headers.get("overwrite"), "F");
    assertEquals(new URL(move.headers.get("destination")!).pathname, `${SHARE}/notes-old.json`);
    assert(!h.nodes.has(`${SHARE}/notes.json`));

    await h.call("copy", { from: "docs/intro.md", to: "docs/intro.bak" });
    const copy = h.recorded.filter((r) => r.method === "COPY").at(-1)!;
    assertEquals(copy.headers.get("overwrite"), "F");
    assert(h.nodes.has(`${SHARE}/docs/intro.bak`));

    const clash = await assertRejects(() =>
      h.call("copy", { from: "docs/intro.md", to: "docs/intro.bak" })
    ) as Error;
    assertStringIncludes(clash.message, "412");

    await h.call("copy", { from: "docs/intro.md", to: "docs/intro.bak", overwrite: true });
    assertEquals(
      h.recorded.filter((r) => r.method === "COPY").at(-1)!.headers.get("overwrite"),
      "T",
    );
  } finally {
    await h.close();
  }
});

Deno.test("dav: delete needs a second, explicit yes for a directory", async () => {
  const h = await harness();
  try {
    const err = await assertRejects(() => h.call("delete", { path: "docs" })) as Error;
    assertStringIncludes(err.message, "recursive: true");
    assertEquals(h.recorded.filter((r) => r.method === "DELETE").length, 0, "nothing was sent");

    const out = await h.call("delete", { path: "docs", recursive: true }) as {
      deleted: string;
      kind: string;
    };
    assertEquals(out.kind, "dir");
    assert(!h.nodes.has(`${SHARE}/docs/intro.md`), "the tree went with it");

    const root = await assertRejects(() => h.call("delete", { path: "" })) as Error;
    assertStringIncludes(root.message, "share root");
  } finally {
    await h.close();
  }
});

Deno.test("dav: read-only accounts are refused before any approval", async () => {
  const h = await harness({ writable: false });
  try {
    const spec = h.conn.ops.find((o) => o.name === "dav.put")!;
    assertEquals(spec.tier, "approval");
    for (const op of ["put", "putStaged", "mkdir", "move", "copy", "delete"]) {
      const err = h.schema(op, { path: "x", from: "a", to: "b", text: "t", staged: "s" });
      assertStringIncludes(String(err), "read-only", `${op} must be refused pre-approval`);
    }
    // reads are unaffected
    assertEquals(h.schema("list", { path: "docs" }), null);
  } finally {
    await h.close();
  }
});

Deno.test("dav: traversal is refused in argSchema, before approval", async () => {
  const h = await harness();
  try {
    for (
      const [op, args] of [
        ["get", { path: "../../etc/passwd" }],
        ["list", { path: "/etc" }],
        ["put", { path: "a/../../b", text: "x" }],
        ["move", { from: "a", to: "../b" }],
        ["delete", { path: ".." }],
      ] as const
    ) {
      const err = h.schema(op, args as Record<string, unknown>);
      assert(err !== null, `${op} must refuse ${JSON.stringify(args)}`);
    }
    assertEquals(h.recorded.length, 0, "no request was made for a refused path");
  } finally {
    await h.close();
  }
});

// --- staging -----------------------------------------------------------------

Deno.test("dav: stage lands bytes on disk and putStaged sends them back", async () => {
  const h = await harness();
  try {
    const staged = await h.call("stage", { path: "logo.png" }) as {
      staged: string;
      fsRoot: string;
      path: string;
      absPath: string;
      bytes: number;
      contentType: string;
      sha256: string;
    };
    assertEquals(staged.fsRoot, "stage", "the fs root name is resolved, not guessed by the caller");
    assert(staged.path.startsWith("dav/alice/"), "staged inside the account subdirectory");
    assertEquals(staged.bytes, 6);
    assertEquals(staged.contentType, "image/png");
    const onDisk = await Deno.readFile(staged.absPath);
    assertEquals(onDisk.byteLength, 6);
    // sha256 of the 6 bytes we served
    const digest = await crypto.subtle.digest("SHA-256", onDisk.slice() as unknown as ArrayBuffer);
    const expected = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    assertEquals(staged.sha256, expected);

    assertEquals(staged.staged, "alice/logo.png", "putStaged takes this value verbatim");
    const up = await h.call("putStaged", {
      path: "docs/copy.png",
      staged: staged.staged,
    }) as { created: boolean; bytes: number; contentType: string };
    assertEquals(up.created, true);
    assertEquals(up.bytes, 6);
    assertEquals(up.contentType, "image/png");
    assertEquals(h.nodes.get(`${SHARE}/docs/copy.png`)!.bytes.byteLength, 6);

    // the staging root is a boundary: a staged name that resolves outside it is refused
    const escape = await assertRejects(() =>
      h.call("putStaged", { path: "docs/x.png", staged: "../../../etc/passwd" })
    ) as Error;
    assertStringIncludes(escape.message, "staged");

    const missing = await assertRejects(() =>
      h.call("putStaged", { path: "docs/x.png", staged: "nope.png" })
    ) as Error;
    assertStringIncludes(missing.message, "dav.stage");
  } finally {
    await h.close();
  }
});

Deno.test("dav: staging.clear removes only this account's staged copies", async () => {
  const h = await harness();
  try {
    await h.call("stage", { path: "docs/intro.md" });
    const cleared = await h.call("staging.clear") as { removed: string[] };
    assertEquals(cleared.removed.length, 1);
    const again = await h.call("staging.clear") as { removed: string[] };
    assertEquals(again.removed.length, 0);
  } finally {
    await h.close();
  }
});

// --- plumbing ----------------------------------------------------------------

Deno.test("dav: credentials stay on the pinned host", async () => {
  const h = await harness();
  try {
    await h.call("list", { path: "docs" });
    const first = h.recorded[0];
    assertEquals(first.headers.get("authorization"), `Basic ${btoa("alice:app-password")}`);
    // every request in this test went to the pinned origin by construction; what the
    // client must never do is adopt a foreign href, which paths_test covers.
  } finally {
    await h.close();
  }
});

Deno.test("dav: the op surface is the documented one", async () => {
  const h = await harness();
  try {
    const names = h.conn.ops.map((o) => o.name).sort();
    assertEquals(names, [
      "dav.accounts",
      "dav.copy",
      "dav.delete",
      "dav.edit",
      "dav.find",
      "dav.get",
      "dav.grep",
      "dav.list",
      "dav.mkdir",
      "dav.move",
      "dav.put",
      "dav.putStaged",
      "dav.quota",
      "dav.stage",
      "dav.staging.clear",
      "dav.stat",
    ]);
    const approval = h.conn.ops.filter((o) => o.tier === "approval").map((o) => o.name).sort();
    assertEquals(approval, [
      "dav.copy",
      "dav.delete",
      "dav.edit",
      "dav.mkdir",
      "dav.move",
      "dav.put",
      "dav.putStaged",
    ]);
    // every approval op says where the write lands, in plain words
    for (const op of h.conn.ops.filter((o) => o.tier === "approval")) {
      assert(op.summarize, `${op.name} has no summarize`);
      const text = await op.summarize!(
        { account: "alice", path: "x", from: "a", to: "b" } as JsonValue,
      );
      assertStringIncludes(text, "alice", `${op.name} summary names the account`);
    }
  } finally {
    await h.close();
  }
});

Deno.test("dav: edit is one approval, one conditional write, no body round trip", async () => {
  const h = await harness();
  try {
    // append to an existing file: the write carries the etag of the read
    const out = await h.call("edit", { path: "docs/intro.md", append: "tail\n" }) as {
      created: boolean;
      unchanged: boolean;
      bytes: number;
      previousBytes: number;
      etag: string;
      precondition: string;
    };
    assertEquals(out.created, false);
    assertEquals(out.previousBytes, 14);
    assertEquals(out.bytes, 19);
    assertEquals(out.precondition, "if-match");
    const put = h.recorded.filter((r) => r.method === "PUT").at(-1)!;
    assert(put.headers.get("if-match") !== null, "edit always sends the etag it read");
    assertEquals(h.nodes.get(`${SHARE}/docs/intro.md`)!.bytes.byteLength, 19);

    // a transform that changes nothing must not write at all
    const before = h.recorded.filter((r) => r.method === "PUT").length;
    const noop = await h.call("edit", { path: "docs/intro.md", append: "" }) as {
      unchanged: boolean;
    };
    assertEquals(noop.unchanged, true);
    assertEquals(h.recorded.filter((r) => r.method === "PUT").length, before);

    // literal replace, first occurrence only by default, with a count
    const rep = await h.call("edit", {
      path: "docs/intro.md",
      replace: [{ find: "l", replace: "L" }],
    }) as { replacements: Array<{ find: string; replaced: number }> };
    assertEquals(rep.replacements[0].replaced, 1);
    const text = new TextDecoder().decode(h.nodes.get(`${SHARE}/docs/intro.md`)!.bytes);
    assertEquals(text, "# Intro\nheLlo\ntail\n", "first l only, everything else untouched");

    // a find that matches nothing is an error, not a silent no-op
    const miss = await assertRejects(() =>
      h.call("edit", { path: "docs/intro.md", replace: [{ find: "absent", replace: "x" }] })
    ) as Error;
    assertStringIncludes(miss.message, "matched nothing");
    const optional = await h.call("edit", {
      path: "docs/intro.md",
      replace: [{ find: "absent", replace: "x", optional: true }],
    }) as { unchanged: boolean };
    assertEquals(optional.unchanged, true, "an optional miss is not a change");

    // createIfMissing creates; without it, a missing file is an error
    const created = await h.call("edit", {
      path: "docs/new-journal.md",
      append: "# day one\n",
      createIfMissing: true,
    }) as { created: boolean; precondition: string };
    assertEquals(created.created, true);
    assertEquals(created.precondition, "if-none-match");
    const missing = await assertRejects(() =>
      h.call("edit", { path: "docs/nope.md", append: "x" })
    ) as Error;
    assertStringIncludes(missing.message, "createIfMissing");

    // stale knowledge is refused before anything is written
    const stat = await h.call("stat", { path: "docs/intro.md" }) as { etag: string };
    const stale = await assertRejects(() =>
      h.call("edit", { path: "docs/intro.md", append: "x", ifMatch: '"etag-1"' })
    ) as Error;
    assertStringIncludes(stale.message, "412");
    assertEquals(
      new TextDecoder().decode(h.nodes.get(`${SHARE}/docs/intro.md`)!.bytes).endsWith("x"),
      false,
    );
    // ...and the current etag is accepted
    await h.call("edit", { path: "docs/intro.md", append: "!", ifMatch: stat.etag });

    // a directory, a binary file and an empty transform list are all refused
    assertStringIncludes(
      String(await assertRejects(() => h.call("edit", { path: "docs", append: "x" }))),
      "directory",
    );
    assertStringIncludes(
      String(await assertRejects(() => h.call("edit", { path: "logo.png", append: "x" }))),
      "not text",
    );
    assertEquals(
      h.schema("edit", { path: "docs/intro.md" }),
      "pass at least one of append, prepend or replace",
    );
  } finally {
    await h.close();
  }
});

Deno.test("dav: list continues with nextOffset, and overlap semantics are exact", async () => {
  const h = await harness();
  try {
    const first = await h.call("list", { path: "docs", limit: 2 }) as {
      count: number;
      total: number;
      offset: number;
      more: number;
      nextOffset: number | null;
      entries: Array<{ name: string }>;
    };
    assertEquals(first.count, 2);
    assertEquals(first.offset, 0);
    assertEquals(first.nextOffset, 2);
    assertEquals(first.more, 1);

    const second = await h.call("list", { path: "docs", limit: 2, offset: 2 }) as {
      count: number;
      nextOffset: number | null;
      entries: Array<{ name: string }>;
    };
    assertEquals(second.count, 1);
    assertEquals(second.nextOffset, null, "end of the directory");
    assertEquals(
      [...first.entries, ...second.entries].map((e) => e.name),
      ["data.csv", "intro.md", "sub"],
      "paging in order is the whole directory, once",
    );

    const past = await h.call("list", { path: "docs", offset: 99 }) as { count: number };
    assertEquals(past.count, 0);
  } finally {
    await h.close();
  }
});

Deno.test("dav: put with overwrite reports what it replaced", async () => {
  const h = await harness();
  try {
    const out = await h.call("put", {
      path: "docs/intro.md",
      text: "replaced\n",
      overwrite: true,
    }) as { created: boolean; replaced?: { size?: number; etag?: string; modified?: string } };
    assertEquals(out.created, false);
    assertEquals(out.replaced?.size, 14, "the destroyed file's size comes back");
    assert(String(out.replaced?.etag).startsWith('"'), "and its etag, for version lookup");

    // create-only and etag-gated writes report nothing replaced: they cannot clobber
    const fresh = await h.call("put", { path: "docs/fresh.md", text: "x" }) as {
      replaced?: unknown;
    };
    assertEquals(fresh.replaced, undefined);
    const gated = await h.call("put", {
      path: "docs/intro.md",
      text: "gated\n",
      ifMatch: (await h.call("stat", { path: "docs/intro.md" }) as { etag: string }).etag,
    }) as { replaced?: unknown };
    assertEquals(gated.replaced, undefined);
  } finally {
    await h.close();
  }
});

Deno.test("dav: accounts explains a read-only account instead of leaving it a mystery", async () => {
  const h = await harness({ writable: false });
  try {
    const out = await h.call("accounts") as {
      accounts: Array<{ writable: boolean; note?: string }>;
    };
    assertEquals(out.accounts[0].writable, false);
    assertStringIncludes(String(out.accounts[0].note), "writable: false in config.yaml");
  } finally {
    await h.close();
  }
});

Deno.test("dav: a server error body is reduced to the sentence that matters", async () => {
  const h = await harness();
  try {
    const err = await assertRejects(() => h.call("stat", { path: "docs/nope.md" })) as Error;
    assert(!err.message.includes("<d:"), "no raw XML in the message");
    assertStringIncludes(err.message, "no such path");
  } finally {
    await h.close();
  }
});

Deno.test("dav: grep finds which files mention a string, and counts what it skipped", async () => {
  const h = await harness();
  try {
    const out = await h.call("grep", { pattern: "deep" }) as {
      filesScanned: number;
      filesMatched: number;
      matchCount: number;
      truncated: boolean;
      skipped: { binary: number };
      hits: Array<{ path: string; line: number; text: string }>;
    };
    assertEquals(out.filesMatched, 1, "only deep.md says 'deep'");
    assertEquals(out.hits[0].path, "docs/sub/deep.md");
    assertEquals(out.hits[0].line, 1);
    assertEquals(out.hits[0].text, "deep", "the matching line comes back, trimmed");
    assertEquals(out.skipped.binary, 1, "logo.png is counted, not silently dropped");

    // namePattern narrows what gets read at all
    const narrowed = await h.call("grep", { pattern: "INTRO", namePattern: "*.csv" }) as {
      matchCount: number;
      filesScanned: number;
    };
    assertEquals(narrowed.filesScanned, 1);
    assertEquals(narrowed.matchCount, 0, "case-insensitive, but csv has no 'intro'");

    // maxMatches stops early and says so
    await h.call("put", { path: "docs/two.md", text: "hit\nhit\nhit\n" });
    const capped = await h.call("grep", { pattern: "hit", maxMatches: 2 }) as {
      matchCount: number;
      truncated: boolean;
      stoppedBy?: string;
    };
    assertEquals(capped.matchCount, 2);
    assertEquals(capped.truncated, true);
    assertEquals(capped.stoppedBy, "matches");

    // a one-character needle is refused: it matches everything and costs everything
    assertStringIncludes(String(h.schema("grep", { pattern: "a" })), "2..200");
  } finally {
    await h.close();
  }
});

Deno.test("dav: a big file is readable in windows, and size is never a bogus zero", async () => {
  const h = await harness();
  try {
    const long = `${"x".repeat(999)}\nEND\n`;
    await h.call("put", { path: "docs/long.txt", text: long });
    const head = await h.call("get", { path: "docs/long.txt", maxBytes: 100 }) as {
      truncated: boolean;
      nextOffset?: number;
      totalBytes?: number;
    };
    assertEquals(head.truncated, true);
    assertEquals(head.nextOffset, 100);

    const tail = await h.call("get", {
      path: "docs/long.txt",
      offset: head.nextOffset,
      maxBytes: 2000,
    }) as { text: string; offset: number; truncated: boolean; totalBytes?: number };
    assertEquals(tail.text, `${"x".repeat(899)}\nEND\n`, "the window is byte-exact");
    assertEquals(tail.offset, 100);
    assertEquals(tail.truncated, false);
    assertEquals(tail.totalBytes, 1004);

    // a response with no content-length must not report size: 0
    const noLength = await h.call("stat", { path: "docs/long.txt" }) as { size?: number };
    assertEquals(noLength.size, 1004);
  } finally {
    await h.close();
  }
});

Deno.test("dav: non-UTF-8 text is flagged, and edit refuses to corrupt it", async () => {
  const h = await harness();
  try {
    // Latin-1 bytes (0xE9 = é in Windows-1252) are not valid UTF-8
    h.nodes.set(`${SHARE}/docs/latin.csv`, {
      kind: "file",
      bytes: new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xe9, 0x0a]),
      mtime: "Mon, 02 Nov 2026 10:00:00 GMT",
      etag: '"latin-1"',
    });
    const got = await h.call("get", { path: "docs/latin.csv" }) as {
      encodingIssue?: boolean;
      note?: string;
      text: string;
    };
    assertEquals(got.encodingIssue, true);
    assertStringIncludes(String(got.note), "not valid UTF-8");

    const err = await assertRejects(() =>
      h.call("edit", { path: "docs/latin.csv", append: "x" })
    ) as Error;
    assertStringIncludes(err.message, "would corrupt it");
  } finally {
    await h.close();
  }
});

Deno.test("dav: exclude keeps junk out of listings without hiding anything by default", async () => {
  const h = await harness();
  try {
    h.nodes.set(`${SHARE}/docs/._intro.md`, {
      kind: "file",
      bytes: new Uint8Array(4),
      mtime: "Mon, 02 Nov 2026 10:00:00 GMT",
      etag: '"junk"',
    });
    const all = await h.call("list", { path: "docs" }) as { entries: Array<{ name: string }> };
    assert(all.entries.some((e) => e.name === "._intro.md"), "visible unless asked otherwise");

    const filtered = await h.call("list", {
      path: "docs",
      exclude: ["._*", ".DS_Store"],
    }) as { entries: Array<{ name: string }>; total: number };
    assertEquals(filtered.entries.some((e) => e.name.startsWith("._")), false);
    assertEquals(filtered.total, 3, "the filtered set is what total counts");

    const found = await h.call("find", { pattern: "*.md", exclude: ["._*"] }) as {
      entries: Array<{ name: string }>;
    };
    assertEquals(found.entries.every((e) => !e.name.startsWith("._")), true);
  } finally {
    await h.close();
  }
});

Deno.test("dav: stage refuses to clobber a different file at the same name", async () => {
  const h = await harness();
  try {
    const first = await h.call("stage", { path: "docs/intro.md" }) as { staged: string };
    const again = await h.call("stage", { path: "docs/intro.md" }) as {
      reused?: boolean;
      sha256: string;
    };
    assertEquals(again.reused, true, "identical bytes are reused, not rewritten");

    // same name, different content: refuse and name the way out
    const conflict = await assertRejects(async () => {
      await h.call("stage", { path: "docs/data.csv", destName: "intro.md" });
    }) as Error;
    assertStringIncludes(conflict.message, "Pass destName");
    assertEquals(first.staged, "alice/intro.md");
  } finally {
    await h.close();
  }
});

Deno.test("dav: delete and move honour an etag when one is given", async () => {
  const h = await harness();
  try {
    const stat = await h.call("stat", { path: "docs/intro.md" }) as { etag: string };
    // stale etag: refused before anything is sent
    const stale = await assertRejects(() =>
      h.call("delete", { path: "docs/intro.md", ifMatch: '"etag-stale"' })
    ) as Error;
    assertStringIncludes(stale.message, "412");
    assertEquals(h.recorded.filter((r) => r.method === "DELETE").length, 0);

    await h.call("delete", { path: "docs/intro.md", ifMatch: stat.etag });
    const del = h.recorded.filter((r) => r.method === "DELETE").at(-1)!;
    assertEquals(del.headers.get("if-match"), stat.etag, "the precondition went on the wire");

    const mv = await h.call("move", {
      from: "docs/data.csv",
      to: "docs/data2.csv",
      ifMatch: '"etag-2"',
    }) as { moved: { to: string } };
    assertEquals(mv.moved.to, "docs/data2.csv");
    assertEquals(
      h.recorded.filter((r) => r.method === "MOVE").at(-1)!.headers.get("if-match"),
      '"etag-2"',
    );
  } finally {
    await h.close();
  }
});
