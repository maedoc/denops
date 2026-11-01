import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { deployConfigFrom, deployConnector } from "../src/connectors/deploy/manifest.ts";
import { denopsConnector } from "../src/connectors/denops/manifest.ts";
import { devConnector, devRootsFromConfig } from "../src/connectors/dev/manifest.ts";
import { fsConnector } from "../src/connectors/fs/manifest.ts";
import { gitlabConnector } from "../src/connectors/gitlab/manifest.ts";
import { imapConnector } from "../src/connectors/imap/manifest.ts";
import { mistralConnector } from "../src/connectors/mistral/manifest.ts";
import { webConnector } from "../src/connectors/web/manifest.ts";
import type { Connector } from "../src/harness/types.ts";

// SKILL.md is the prompt-facing contract; it is served by the denops.skill op. This
// test is the anti-drift gate: it fails when the doc and the code disagree, so a
// promotion cannot ship a stale skill sheet.

const skillPath = new URL("../SKILL.md", import.meta.url).pathname;
const skill = await Deno.readTextFile(skillPath);

async function allConnectors(): Promise<Connector[]> {
  const tmp = await Deno.makeTempDir();
  const devRoots = devRootsFromConfig([{
    name: "devroot",
    path: tmp,
    tasks: { test: ["/usr/bin/true"] },
  }]);
  const deploy = deployConfigFrom(
    { enabled: true, liveDir: tmp, devBranch: "main" },
    devRoots,
    tmp,
  );
  return [
    gitlabConnector({ token: "t", origin: "https://gitlab.example", apiPath: "/api/v4" }),
    mistralConnector({ apiKey: "k", origin: "https://api.mistral.ai", apiPath: "/v1" }),
    imapConnector({
      accounts: [{
        id: "a",
        host: "imap.example.org",
        port: 993,
        tls: true,
        user: "u",
        password: "p",
        draftsMailbox: "Drafts",
      }],
    }),
    fsConnector({
      roots: [{ name: "r", path: tmp, write: true, exec: false }],
      maxFileSize: 1024,
      maxOutput: 1024,
      execTimeoutSec: 5,
      maxConcurrentExec: 1,
    }),
    devConnector({ roots: devRoots }),
    webConnector({ allowedHosts: ["example.org"] }),
    ...(deploy ? [deployConnector(deploy)] : []),
    denopsConnector({ skillPath, version: "0.2.1", connectors: () => [] }),
  ];
}

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
    // "(1 op)" and "(4 ops)" are both fine: only the number has to match
    assert(
      new RegExp(`\\(${count} op(s)?\\)`).test(skill),
      `missing "(${count} ops)" for ${c.id}`,
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
  assert(skill.length < 12_000, `SKILL.md should stay compact, got ${skill.length} chars`);
  assertStringIncludes(skill, "MAINTENANCE");
});

Deno.test("denops.skill serves SKILL.md, optionally filtered by section", async () => {
  const conn = denopsConnector({ skillPath, version: "0.2.1", connectors: () => ["mail", "fs"] });
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
  assertEquals(about.version, "0.2.1");
  assertEquals(about.connectors, ["mail", "fs"]);
});
