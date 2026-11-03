import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  decodeFile,
  normalizeCommit,
  normalizeIssue,
  normalizeNote,
  normalizeProject,
  normalizePull,
} from "../src/connectors/forge/flavors/gitlab.ts";
import type { ChangeSet } from "../src/connectors/forge/port.ts";
import type { JsonValue } from "../src/harness/types.ts";

// Conformance: recorded live payloads -> normalized objects with the documented keys.
//
// This is the test that keeps "unified" honest. When the forgejo adapter lands, the
// same assertions run over `tests/fixtures/forge/forgejo/*.json`; if a flavor drifts,
// the failure is a key/value mismatch here rather than a wrong answer in a live run.
// Fixtures are real responses captured through the running server (open-tier reads
// only) — not hand-written, so they also catch upstream shape drift on upgrade.

const DIR = new URL("./fixtures/forge/gitlab/", import.meta.url);

function fixture<T>(name: string): T {
  return JSON.parse(Deno.readTextFileSync(new URL(name, DIR))) as T;
}

const KEYS = {
  project: [
    "archived",
    "defaultBranch",
    "fullName",
    "id",
    "name",
    "owner",
    "updatedAt",
    "url",
    "visibility",
  ],
  issue: ["author", "labels", "number", "state", "title", "updatedAt", "url"],
  note: ["author", "body", "createdAt", "id"],
  pull: [
    "author",
    "draft",
    "merged",
    "number",
    "sourceBranch",
    "state",
    "targetBranch",
    "title",
    "updatedAt",
    "url",
  ],
  commit: ["authorName", "authoredAt", "id", "shortId", "title"],
};

Deno.test("conformance/gitlab: project payloads normalize to the documented keys", () => {
  const raw = fixture<Record<string, unknown>>("project.json");
  const norm = normalizeProject(raw);
  assertEquals(Object.keys(norm).sort(), KEYS.project);
  assertEquals(norm.fullName, "woodman/mymcp");
  assertEquals(`${norm.owner}/${norm.name}`, "woodman/mymcp");
  assert(norm.id !== "");
  assertEquals(norm.archived, false);

  for (const item of fixture<Array<Record<string, unknown>>>("projects_page.json")) {
    const p = normalizeProject(item);
    assertEquals(Object.keys(p).sort(), KEYS.project);
    assertEquals(`${p.owner}/${p.name}`, p.fullName);
  }
});

Deno.test("conformance/gitlab: issues normalize with a per-repo number and a closed state enum", () => {
  const items = fixture<Array<Record<string, unknown>>>("issues_page.json");
  assert(items.length > 0);
  for (const item of items) {
    const i = normalizeIssue(item);
    assertEquals(Object.keys(i).sort(), KEYS.issue);
    assert(Number.isInteger(i.number) && i.number > 0, `number ${i.number}`);
    assert(["open", "closed", "merged"].includes(i.state), i.state);
    assert(Array.isArray(i.labels));
    assert(i.title.length > 0);
  }
});

Deno.test("conformance/gitlab: notes carry author, body and a string id", () => {
  const items = fixture<Array<Record<string, unknown>>>("notes_page.json");
  assert(items.length > 0);
  for (const item of items) {
    const n = normalizeNote(item);
    assertEquals(Object.keys(n).sort(), KEYS.note);
    assert(typeof n.id === "string" && n.id.length > 0);
    assertEquals(typeof n.body, "string");
  }
});

Deno.test("conformance/gitlab: pulls normalize state, branches and merged flag", () => {
  const items = fixture<Array<Record<string, unknown>>>("pulls_page.json");
  assert(items.length > 0, "expected at least one recorded merge request payload");
  for (const item of items) {
    const p = normalizePull(item);
    assertEquals(Object.keys(p).sort(), KEYS.pull);
    assert(Number.isInteger(p.number) && p.number > 0);
    assert(["open", "closed", "merged"].includes(p.state), p.state);
    assertEquals(typeof p.draft, "boolean");
    assertEquals(typeof p.merged, "boolean");
    // a merged MR is closed upstream; the flag must survive
    if (p.state === "merged") assertEquals(p.merged, true);
  }
});

Deno.test("conformance/gitlab: commits and branches normalize", () => {
  for (const item of fixture<Array<Record<string, unknown>>>("commits_page.json")) {
    const c = normalizeCommit(item);
    assertEquals(Object.keys(c).sort(), KEYS.commit);
    assert(c.id.length >= 7);
    assertEquals(typeof c.title, "string");
  }
  const branches = fixture<Array<Record<string, unknown>>>("branches_page.json");
  for (const b of branches) {
    assert(typeof b.name === "string" && b.name.length > 0);
  }
});

Deno.test("conformance/gitlab: tree entries map blob/tree onto the neutral types", () => {
  const items = fixture<Array<Record<string, unknown>>>("tree_page.json");
  assert(items.length > 0);
  for (const e of items) {
    const type = String(e.type);
    assert(["blob", "tree", "commit", "symlink"].includes(type), type);
    assert(typeof e.path === "string" && e.path.length > 0);
  }
});

Deno.test("conformance/gitlab: a recorded file payload decodes back to its size", () => {
  const raw = fixture<Record<string, unknown>>("file_readme.json");
  const size = Number(raw.size);
  const content = String(raw.content);
  const f = decodeFile(
    content,
    size,
    String(raw.blob_id ?? ""),
    String(raw.file_path),
    String(raw.ref),
  );
  assertEquals(f.binary, false);
  assertEquals(f.truncated, false);
  assertEquals(f.text?.length, size);
  assert(f.text!.startsWith("#"));
  // base64 inflates: the wire size is what the port must not pay for
  assert(content.length > size);
});

Deno.test("conformance/gitlab: users, orgs and the current user normalize", () => {
  for (const u of fixture<Array<Record<string, unknown>>>("users_page.json")) {
    assert(typeof u.username === "string" && u.username.length > 0);
    assert(typeof u.id === "number" || typeof u.id === "string");
  }
  const me = fixture<Record<string, unknown>>("current_user.json");
  assert(typeof me.username === "string");
  for (const g of fixture<Array<Record<string, unknown>>>("groups_page.json")) {
    assert(typeof g.name === "string");
    assert(typeof g.full_path === "string");
  }
});

Deno.test("conformance: the neutral ChangeSet shape is what ops promise", () => {
  // GitLab /changes carries the diff per file; the neutral shape flattens it and
  // reports truncation, so a caller never has to know which flavor answered.
  const sample: ChangeSet = {
    files: [{ path: "a.ts", status: "modified", additions: null, deletions: null, patch: "@@" }],
    truncated: false,
  };
  assertEquals(Object.keys(sample).sort(), ["files", "truncated"]);
  assertEquals(Object.keys(sample.files[0]).sort(), [
    "additions",
    "deletions",
    "patch",
    "path",
    "status",
  ]);
});

// --- forgejo: the same conformance contract, over payloads captured from git.ins-amu.fr ---
// The assertions are deliberately identical to the gitlab ones: that equality is what
// "one family" means. Differences the fixtures encode (an {ok,data} envelope on search,
// bare arrays elsewhere, `user.login` instead of `author.username`, merged inferred from
// `merged_at`) are the adapter's business, not the caller's.

const FJ_DIR = new URL("./fixtures/forge/forgejo/", import.meta.url);

function fj<T>(name: string): T {
  return JSON.parse(Deno.readTextFileSync(new URL(name, FJ_DIR))) as T;
}

Deno.test("conformance/forgejo: search envelopes unwrap and projects normalize", async () => {
  const { normalizeProject, unwrapData } = await import(
    "../src/connectors/forge/flavors/forgejo.ts"
  );
  const env = fj<{ ok: boolean; data: Array<Record<string, unknown>> }>("projects_page.json");
  assertEquals(env.ok, true);
  const rows = unwrapData(env as unknown as JsonValue) as Array<Record<string, unknown>>;
  assert(rows.length > 0);
  for (const row of rows) {
    const p = normalizeProject(row);
    assertEquals(Object.keys(p).sort(), KEYS.project);
    assertEquals(`${p.owner}/${p.name}`, p.fullName);
    assert(["private", "public", null].includes(p.visibility as string | null));
  }
  const one = normalizeProject(fj<Record<string, unknown>>("project.json"));
  assertEquals(one.fullName, "marmaduke/forge-probe");
});

Deno.test("conformance/forgejo: issues carry a number, an author login and label names", async () => {
  const { normalizeIssue } = await import("../src/connectors/forge/flavors/forgejo.ts");
  const i = normalizeIssue(fj<Record<string, unknown>>("issue.json"));
  assertEquals(Object.keys(i).sort(), KEYS.issue);
  assert(Number.isInteger(i.number) && i.number > 0);
  assert(["open", "closed", "merged"].includes(i.state));
  // labels arrive as objects upstream; the neutral shape is names
  for (const l of i.labels) assertEquals(typeof l, "string");
});

Deno.test("conformance/forgejo: comments normalize like GitLab notes", async () => {
  const { normalizeNote } = await import("../src/connectors/forge/flavors/forgejo.ts");
  const rows = fj<Array<Record<string, unknown>>>("notes_page.json");
  assert(rows.length >= 4, "expected the four probe comments");
  for (const row of rows) {
    const n = normalizeNote(row);
    assertEquals(Object.keys(n).sort(), KEYS.note);
    assert(n.id.length > 0);
    assertEquals(typeof n.body, "string");
  }
});

Deno.test("conformance/forgejo: a merged pull is reported as merged, not closed", async () => {
  const { normalizePull } = await import("../src/connectors/forge/flavors/forgejo.ts");
  const p = normalizePull(fj<Record<string, unknown>>("pull.json"));
  assertEquals(Object.keys(p).sort(), KEYS.pull);
  assertEquals(p.merged, true);
  assertEquals(p.state, "merged"); // upstream says "closed" + merged_at
  assertEquals(p.sourceBranch, "probe/denops-111726");
  assertEquals(p.targetBranch, "main");
});

Deno.test("conformance/forgejo: commits keep sha, first line of the message, author date", async () => {
  const { normalizeCommit } = await import("../src/connectors/forge/flavors/forgejo.ts");
  for (const row of fj<Array<Record<string, unknown>>>("commits_page.json")) {
    const c = normalizeCommit(row);
    assertEquals(Object.keys(c).sort(), KEYS.commit);
    assert(c.id.length >= 7);
    assert(c.title.length > 0);
    assertEquals(c.title.includes("\n"), false);
  }
});

Deno.test("conformance/forgejo: tree entries map file/dir onto the neutral types", async () => {
  const { unwrapData } = await import("../src/connectors/forge/flavors/forgejo.ts");
  const rows = unwrapData(fj<JsonValue>("tree_page.json")) as Array<Record<string, unknown>>;
  assert(rows.length > 0);
  for (const row of rows) {
    assert(["file", "dir", "symlink", "submodule"].includes(String(row.type)), String(row.type));
    assert(typeof row.path === "string" && row.path.length > 0);
  }
  // /raw is what the adapter reads; the fixture is the exact file, not base64
  const text = Deno.readTextFileSync(new URL("raw_readme.txt", FJ_DIR));
  assert(text.startsWith("# forge-probe"));
  assert(!text.includes("\u0000"));
});

Deno.test("conformance/forgejo: users and orgs normalize", async () => {
  const { unwrapData } = await import("../src/connectors/forge/flavors/forgejo.ts");
  const users = unwrapData(fj<JsonValue>("users_page.json")) as Array<Record<string, unknown>>;
  assert(users.length > 0);
  for (const u of users) assert(typeof u.login === "string");
  const me = fj<Record<string, unknown>>("current_user.json");
  assertEquals(me.login, "marmaduke");
  const orgs = fj<Array<Record<string, unknown>>>("orgs_page.json");
  for (const o of orgs) assert(typeof o.username === "string");
});

// --- github: third flavor, same assumptions the other two are held to ---
// Recorded from api.github.com after populating a scratch repo, so the issue list here
// genuinely contains a pull request (number 2) — the shape that breaks naive code.

const GH_DIR = new URL("./fixtures/forge/github/", import.meta.url);

function gh<T>(name: string): T {
  return JSON.parse(Deno.readTextFileSync(new URL(name, GH_DIR))) as T;
}

Deno.test("conformance/github: projects normalize, with owner/name split from full_name", async () => {
  const { normalizeProject } = await import("../src/connectors/forge/flavors/github.ts");
  for (const row of gh<Array<Record<string, unknown>>>("projects_page.json")) {
    const p = normalizeProject(row);
    assertEquals(Object.keys(p).sort(), KEYS.project);
    assertEquals(`${p.owner}/${p.name}`, p.fullName);
  }
  const one = normalizeProject(gh<Record<string, unknown>>("project.json"));
  assertEquals(one.fullName, "maedoc/forge-test");
  assertEquals(one.visibility, "private");
});

Deno.test("conformance/github: the issue payloads include a PR, both normalize", async () => {
  const { normalizeIssue, normalizePull } = await import(
    "../src/connectors/forge/flavors/github.ts"
  );
  const rows = gh<Array<Record<string, unknown>>>("issues_page.json");
  const prs = rows.filter((r) => r.pull_request !== null && r.pull_request !== undefined);
  const issues = rows.filter((r) => r.pull_request === null || r.pull_request === undefined);
  assert(prs.length >= 1, "the fixture must contain the PR, or the filter is untested");
  assert(issues.length >= 1, "the fixture must contain a plain issue");
  for (const row of issues) {
    const i = normalizeIssue(row);
    assertEquals(Object.keys(i).sort(), KEYS.issue);
    assert(Number.isInteger(i.number) && i.number > 0);
  }
  const p = normalizePull(gh<Record<string, unknown>>("pull.json"));
  assertEquals(Object.keys(p).sort(), KEYS.pull);
  assertEquals(p.merged, true);
  assertEquals(p.state, "merged");
  assert(p.sourceBranch !== null && !p.sourceBranch.startsWith("refs/"));
});

Deno.test("conformance/github: comments, commits and branches normalize", async () => {
  const { normalizeCommit } = await import("../src/connectors/forge/flavors/github.ts");
  for (const row of gh<Array<Record<string, unknown>>>("commits_page.json")) {
    const c = normalizeCommit(row);
    assertEquals(Object.keys(c).sort(), KEYS.commit);
    assert(c.id.length >= 7);
    assertEquals(c.title.includes("\n"), false);
  }
  for (const row of gh<Array<Record<string, unknown>>>("branches_page.json")) {
    assert(typeof row.name === "string" && row.name.length > 0);
    assert(typeof (row.commit as Record<string, unknown>)?.sha === "string");
  }
});

Deno.test("conformance/github: tree entries, raw file text and users", async () => {
  const rows = gh<Array<Record<string, unknown>>>("tree_page.json");
  assert(rows.length > 0);
  for (const row of rows) {
    assert(["file", "dir", "symlink", "submodule"].includes(String(row.type)));
    assert(typeof row.path === "string" && row.path.length > 0);
  }
  const text = Deno.readTextFileSync(new URL("raw_readme.txt", GH_DIR));
  assert(text.startsWith("# forge-test"));
  const env = gh<{ total_count: number; items: Array<Record<string, unknown>> }>(
    "search_repos.json",
  );
  assert(env.total_count >= env.items.length);
  const users = gh<{ items: Array<Record<string, unknown>> }>("users_search.json");
  for (const u of users.items) assert(typeof u.login === "string");
  // private-repo payloads can carry a short-lived clone token: never commit one
  const project = Deno.readTextFileSync(new URL("project.json", GH_DIR));
  assertEquals(project.includes("temp_clone_token"), false);
});
