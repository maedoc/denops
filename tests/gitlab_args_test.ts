import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { gitlabConnector } from "../src/connectors/gitlab/manifest.ts";

// Regression: `gitlab.issues.list` hard-failed when `state` was omitted, because its
// argSchema used the *required* enum check while the doc said `state?` and the client
// applied a default of "opened". The client-level mock test still passed — it calls
// the client directly and never crosses the argSchema boundary, which is exactly
// where the call was dying. Boundary tests belong at the boundary.

const conn = gitlabConnector({
  token: "t",
  origin: "https://gitlab.example",
  apiPath: "/api/v4",
});

function schema(op: string) {
  const spec = conn.ops.find((o) => o.name === op);
  if (!spec) throw new Error(`no such op: ${op}`);
  return spec.argSchema;
}

Deno.test("gitlab: documented-optional enums may be omitted", () => {
  assertEquals(schema("gitlab.issues.list")({ projectId: 42 }), null, "issues.list without state");
  assertEquals(
    schema("gitlab.mergeRequests.list")({ projectId: 42 }),
    null,
    "mergeRequests.list without state",
  );
  assertEquals(
    schema("gitlab.issues.update")({ projectId: 42, issueIid: 7, title: "only a title" }),
    null,
    "issues.update without state",
  );
});

Deno.test("gitlab: an invalid enum value is still refused, omission or not", () => {
  for (
    const [op, args] of [
      ["gitlab.issues.list", { projectId: 42, state: "bogus" }],
      ["gitlab.mergeRequests.list", { projectId: 42, state: "bogus" }],
      ["gitlab.issues.update", { projectId: 42, issueIid: 7, state: "merged" }],
    ] as const
  ) {
    const err = schema(op)(args);
    assertStringIncludes(String(err), "expected one of", `${op} should refuse state=bogus`);
  }
});

Deno.test("gitlab: required fields are still required", () => {
  assertStringIncludes(String(schema("gitlab.issues.list")({})), "projectId");
  assertStringIncludes(String(schema("gitlab.issues.update")({ projectId: 1 })), "issueIid");
  // a genuinely required enum stays required
  assertStringIncludes(
    String(schema("gitlab.mutate")({ path: "/projects" })),
    "method",
  );
});
