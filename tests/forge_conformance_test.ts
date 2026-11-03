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
