import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { agentGuide } from "../src/guide.ts";

Deno.test("agent guide states the calling contract, discovery and limits", () => {
  const guide = agentGuide({
    connectors: [{ id: "gitlab", ops: 25 }, { id: "mail", ops: 10 }],
    totalOps: 35,
    budgets: { wallClockMs: 120_000, maxOpsPerRun: 200, maxOpResultBytes: 1_048_576 },
  });
  for (
    const needle of [
      "35 ops — gitlab 25, mail 10",
      "return p.map",
      "api.search",
      "api.describe",
      "Object.keys(tools)",
      "gitlab.get",
      "gitlab.mutate",
      "fields:",
      "full: true",
      "awaiting_approval",
      "approve(",
      "120s wall clock",
      "200 ops",
      "1024 KB",
      "approve(pendingId",
    ]
  ) {
    assertStringIncludes(guide, needle);
  }
  assert(guide.length < 4000, `guide should stay compact, got ${guide.length} chars`);
});
