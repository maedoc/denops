import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { __test, forgeConnector } from "../src/connectors/forge/manifest.ts";
import type { ForgeAccount } from "../src/connectors/forge/port.ts";
import type { JsonValue } from "../src/harness/types.ts";
import { stubPort } from "./forge_stub.ts";

// The family's contract: reads open, writes approval, and nothing that cannot work
// reaching an approval prompt. No network here — the port is injected.

const ACCOUNTS: ForgeAccount[] = [
  {
    id: "ebrains",
    flavor: "gitlab",
    origin: "https://gitlab.ebrains.eu",
    apiPath: "/api/v4",
    token: "t",
    maxLimit: 100,
  },
  {
    id: "amu",
    flavor: "forgejo",
    origin: "https://git.ins-amu.fr",
    apiPath: "/api/v1",
    token: "t",
    maxLimit: 50,
  },
];

function connector() {
  return forgeConnector({ accounts: ACCOUNTS, buildPort: stubPort });
}

Deno.test("forge: reads are open, writes are approval, and the set is flavour-blind", () => {
  const conn = connector();
  const tiers = new Map(conn.ops.map((op) => [op.name, op.tier]));
  const approval = [...tiers].filter(([, t]) => t === "approval").map(([n]) => n).sort();
  assertEquals(approval, [
    "forge.issues.create",
    "forge.issues.notes.create",
    "forge.issues.update",
    "forge.pulls.comment",
    "forge.pulls.create",
    "forge.pulls.merge",
    "forge.repository.files.create",
  ]);
  // every remaining op is an open read
  for (const [name, tier] of tiers) {
    if (!approval.includes(name)) assertEquals(tier, "open", `${name} should be open`);
  }
  // the family must not leak flavour-specific naming
  for (const name of tiers.keys()) {
    assertEquals(/mergeRequests|groups|iid|projectId|mrIid/.test(name), false, name);
  }
  // 26 ops: parity with gitlab's 27 minus groups/mutate, plus accounts + merge
  assertEquals(conn.ops.length, 26);
});

Deno.test("forge: argument checks reject bad refs before any request", () => {
  const conn = connector();
  const schema = (name: string) => conn.ops.find((op) => op.name === name)!.argSchema;

  assertEquals(
    schema("forge.projects.get")({ account: "ebrains", repo: "mymcp" }),
    "repo: expected 'owner/name'",
  );
  assertEquals(
    schema("forge.projects.get")({ account: "ebrains", repo: "../etc/passwd" }),
    "repo: invalid path segment '..'",
  );
  assertEquals(
    schema("forge.projects.get")({ account: "EBRAINS", repo: "a/b" }),
    "account: expected a configured account id (lowercase letters, digits, - or _)",
  );
  // subgroups are legal: group/sub/project
  assertEquals(
    schema("forge.projects.get")({ account: "ebrains", repo: "group/sub/project" }),
    null,
  );

  assertEquals(
    schema("forge.issues.get")({ account: "amu", repo: "a/b", number: 0 }),
    "number: expected a positive integer (per-repo id, e.g. 42)",
  );
  assertEquals(
    schema("forge.issues.list")({ account: "amu", repo: "a/b", limit: 101 }),
    "limit: expected an integer 1..100 (clamped further to the instance's page cap)",
  );
  assertEquals(
    schema("forge.pulls.list")({ account: "amu", repo: "a/b", state: "opened" }),
    "state: expected one of open, closed, merged, all",
  );
  // shape args are composed onto the family too
  assertStringIncludes(
    String(schema("forge.issues.list")({ account: "amu", repo: "a/b", fields: "title" })),
    "fields",
  );
});

Deno.test("forge: pulls.create refuses an empty pull request in precheck, not after approval", () => {
  const conn = connector();
  const op = conn.ops.find((o) => o.name === "forge.pulls.create")!;
  const err = op.precheck!({
    account: "amu",
    repo: "o/r",
    title: "x",
    sourceBranch: "main",
    targetBranch: "main",
  } as unknown as JsonValue);
  assertStringIncludes(String(err), "empty pull request");
  assertEquals(
    op.precheck!({
      account: "amu",
      repo: "o/r",
      title: "x",
      sourceBranch: "feat",
      targetBranch: "main",
    } as unknown as JsonValue),
    null,
  );
});

Deno.test("forge: approval summaries name the account, flavour, host and repo", async () => {
  const conn = connector();
  const op = conn.ops.find((o) => o.name === "forge.pulls.create")!;
  const text = await op.summarize!({
    account: "amu",
    repo: "marmaduke/forge-probe",
    title: "probe",
    sourceBranch: "feat",
    targetBranch: "main",
  } as unknown as JsonValue);
  assertStringIncludes(text, "amu (forgejo git.ins-amu.fr) marmaduke/forge-probe");
});

Deno.test("forge: api.get stays inside the API root and refuses credential endpoints", () => {
  const op = connector().ops.find((o) => o.name === "forge.api.get")!;
  const bad = (path: string) => op.argSchema({ account: "ebrains", path });
  assertEquals(bad("//evil.example.com/api/v4/x") !== null, true);
  assertEquals(bad("/../../etc/passwd") !== null, true);
  assertStringIncludes(String(bad("/projects/1/variables")), "exposes credentials");
  assertStringIncludes(String(bad("/user/tokens")), "exposes credentials");
  assertEquals(bad("/projects/woodman%2Fmymcp/releases"), null);
});

Deno.test("forge: unknown account ids are rejected at call time with the configured list", async () => {
  const conn = connector();
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  let err: unknown = null;
  try {
    await client["projects.get"]({ account: "nope", repo: "a/b" } as unknown as JsonValue);
  } catch (e) {
    err = e;
  }
  assertStringIncludes(String((err as Error).message), "unknown forge account 'nope'");
  assertStringIncludes(String((err as Error).message), "amu, ebrains");
});

Deno.test("forge: repo refs keep GitLab subgroups intact", () => {
  assertEquals(__test.parseRepoRef("group/sub/project"), { owner: "group/sub", name: "project" });
  assertEquals(__test.repoRefString({ owner: "group/sub", name: "project" }), "group/sub/project");
});

Deno.test("forge: accounts op never exposes credentials", async () => {
  const conn = connector();
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  const out = (await client["accounts"]({} as unknown as JsonValue)) as unknown as Array<
    Record<string, unknown>
  >;
  assertEquals(out.length, 2);
  const text = JSON.stringify(out);
  assertEquals(text.includes("token"), false);
  assertEquals(out[1].maxLimit, 50);
});
