import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { denopsConnector } from "../src/connectors/denops/manifest.ts";
import { allConnectors } from "./connector_set.ts";

// SKILL.md is the prompt-facing contract; it is served by the denops.skill op. This
// test is the anti-drift gate: it fails when the doc and the code disagree, so a
// promotion cannot ship a stale skill sheet.

const skillPath = new URL("../SKILL.md", import.meta.url).pathname;
const skill = await Deno.readTextFile(skillPath);

Deno.test("SKILL.md names only ops that exist", async () => {
  const connectors = await allConnectors();
  const known = new Set(connectors.flatMap((c) => c.ops.map((o) => o.name)));
  // prose legitimately refers to families/prefixes ("projects.*", "gitlab.projects")
  const prefixes = new Set(
    [...known].flatMap((n) => {
      const parts = n.split(".");
      return [parts.slice(0, 2).join("."), parts.slice(0, 3).join(".")];
    }),
  );
  const ids = new Set(connectors.map((c) => c.id));
  const spans = [...skill.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  const unknown: string[] = [];
  for (const span of spans) {
    // take the leading dotted identifier of a code span ("op({...})" -> "op")
    const m = /^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)/.exec(span);
    if (!m) continue;
    const name = m[1];
    if (name.includes("*")) continue;
    const [connector] = name.split(".");
    if (!ids.has(connector)) continue; // e.g. api.search / fs:<root>:read
    if (known.has(name) || prefixes.has(name)) continue;
    unknown.push(name);
  }
  assertEquals([...new Set(unknown)], [], `SKILL.md references ops that do not exist`);
});

Deno.test("SKILL.md covers every connector family and its op count", async () => {
  const connectors = await allConnectors();
  for (const c of connectors) {
    assertStringIncludes(skill, `**${c.id}**`, `missing crib-sheet section for ${c.id}`);
    const count = c.ops.filter((o) => o.tier !== "absent").length;
    // The count has to sit next to the family name, not just exist somewhere in the
    // file: the old "anywhere" check let `denops` drift from 5 to 6 ops unnoticed.
    assert(
      new RegExp(`\\*\\*${c.id}\\*\\*[^*\\n]{0,40}\\(${count} op(s)?\\)`).test(skill),
      `missing "(${count} ops)" right after **${c.id}**`,
    );
  }
});

Deno.test("SKILL.md states the invariants the server enforces", () => {
  for (
    const needle of [
      "capability_denied",
      "fs:<root>:read",
      "fs:<root>:write",
      "awaiting_approval",
      "api.search",
      "api.describe",
      "denops.skill",
      "dev.try",
      "deploy.promote",
      "staging.clear",
      "fields:",
      "full: true",
    ]
  ) {
    assertStringIncludes(skill, needle);
  }
  // Budget: one crib entry per connector family, ~1.2k each, ten families. It was 12k
  // when there were seven, which is how it ended up being trimmed to fit by single
  // digits — the wrong way to keep a contract sheet honest. Raise this deliberately
  // when a family is added; compress only when an entry restates an op's own docs.
  assert(skill.length < 12_800, `SKILL.md should stay compact, got ${skill.length} chars`);
  assertStringIncludes(skill, "MAINTENANCE");
});

Deno.test("denops.skill serves SKILL.md, optionally filtered by section", async () => {
  const conn = denopsConnector({ skillPath, version: "0.3.0", connectors: () => ["mail", "fs"] });
  const client = conn.client({ config: {}, secrets: {}, log: () => {} });
  const full = await client["skill"]({}) as { content: string; bytes: number; updatedAt: string };
  assertEquals(full.content, skill);
  assertEquals(full.bytes, new TextEncoder().encode(skill).length);
  assert(full.updatedAt.length > 0);

  const section = await client["skill"]({ section: "gitlab" }) as {
    found: boolean;
    content: string;
  };
  assertEquals(section.found, true);
  assertStringIncludes(section.content, "gitlab");
  assert(!section.content.includes("## 6."), "filtered output keeps only matching sections");

  const about = await client["about"]({}) as { version: string; connectors: string[] };
  assertEquals(about.version, "0.3.0");
  assertEquals(about.connectors, ["mail", "fs"]);
});
