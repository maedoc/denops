import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { loadConfig, normalize, parseYaml } from "../src/config.ts";
import { derivePermissions } from "../src/permissions.ts";
import { webOptionsFromConfig } from "../src/connectors/web/manifest.ts";

// The config reader is a minimal YAML subset, which is fine — until it hands a list
// back as a scalar and something iterates it character by character. That happened
// live: `dnsServers: ["1.1.1.1:53", "9.9.9.9:53"]` became --allow-net "[:53,1:53,…"
// and the server refused to start. These guard the reader and its consumers.

Deno.test("parseYaml reads flow sequences and nested lists", () => {
  const cfg = parseYaml(`server:
  host: 127.0.0.1
  port: 3100
connectors:
  web:
    allowedHosts: [arxiv.org, "*.githubusercontent.com", docs.deno.com:443]
    dnsServers: ["1.1.1.1:53", "9.9.9.9:53"]
    empty: []
  fs:
    roots:
      - name: dev
        path: /srv/dev
        write: true
`);
  const web = (cfg.connectors as Record<string, Record<string, unknown>>).web;
  assertEquals(web.allowedHosts, ["arxiv.org", "*.githubusercontent.com", "docs.deno.com:443"]);
  assertEquals(web.dnsServers, ["1.1.1.1:53", "9.9.9.9:53"]);
  assertEquals(web.empty, []);
  const roots = (cfg.connectors as Record<string, Record<string, unknown>>).fs.roots as Array<
    Record<string, unknown>
  >;
  assertEquals(roots[0].name, "dev");
  assertEquals(roots[0].write, true);
});

Deno.test("derivePermissions turns web lists into net entries, never characters", () => {
  const cfg = parseYaml(`connectors:
  web:
    enabled: true
    allowedHosts: [arxiv.org, "*.githubusercontent.com"]
    dnsServers: ["1.1.1.1:53", 9.9.9.9]
`);
  const plan = derivePermissions(cfg);
  for (const want of ["arxiv.org", "*.githubusercontent.com", "1.1.1.1:53", "9.9.9.9:53"]) {
    assert(plan.net.includes(want), `expected ${want} in ${plan.net.join(", ")}`);
  }
  for (const entry of plan.net) {
    assert(!entry.startsWith("["), `bogus net entry: ${JSON.stringify(entry)}`);
    assert(entry.length > 3, `bogus net entry: ${JSON.stringify(entry)}`);
  }
  // a scalar (one-line) list is tolerated, not split per character
  const scalar = derivePermissions({
    connectors: { web: { enabled: true, allowedHosts: "arxiv.org, docs.deno.com" } },
  });
  assertEquals(scalar.net.includes("arxiv.org"), true);
  assert(
    scalar.net.some((e) => e.trim() === "docs.deno.com"),
    `expected docs.deno.com in ${scalar.net.join(", ")}`,
  );
  assert(!scalar.net.some((e) => e.startsWith(":53")), "no per-character entries");
});

Deno.test("webOptionsFromConfig normalises lists and refuses to iterate strings", () => {
  const opts = webOptionsFromConfig({ allowedHosts: ["a.example"], dnsServers: "1.1.1.1:53" });
  assertEquals(opts.allowedHosts, ["a.example"]);
  assertEquals(opts.dnsServers, ["1.1.1.1:53"]);
  const empty = webOptionsFromConfig({});
  assertEquals(empty.allowedHosts, []);
  assertEquals(empty.dnsServers, []);
});

Deno.test("normalize keeps dataDir and validates budgets", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/config.yaml`;
    await Deno.writeTextFile(path, "dataDir: data-dev\nbudgets:\n  wallClockMs: 1000\n");
    const cfg = await loadConfig(path);
    assertEquals(cfg.dataDir, "data-dev");
    assertEquals(cfg.budgets.wallClockMs, 1000);
    let msg = "";
    try {
      normalize({ server: { ban: { maxFailures: -5 } } });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "positive number");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
