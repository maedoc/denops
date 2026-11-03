import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { normalize } from "../src/config.ts";
import { Registry } from "../src/harness/registry.ts";
import type { Connector } from "../src/harness/types.ts";
import { validateConnectors } from "../src/server.ts";

// Regression for 2026-11-03: one unreachable connector took the whole server down.
// Startup validation is a reachability probe, and its rejection escaped buildApp as an
// uncaught rejection, so the child died before binding 127.0.0.1:3100 and Caddy answered
// 502 for every op. A dead local Proton bridge on 127.0.0.1:1143 therefore took out
// gitlab, mistral, fs, dev and deploy too — forever, because the supervisor kept
// restarting the same commit. Reachability must degrade, not refuse.

const boom: Connector = {
  id: "flaky",
  ops: [],
  client: () => ({}),
  validateStartup: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1143")),
};

const fine: Connector = { id: "steady", ops: [], client: () => ({}) };

function config(failFast: boolean) {
  const cfg = normalize({ connectors: { flaky: { enabled: true } } });
  cfg.startup = { validate: "full", failFast };
  return cfg;
}

Deno.test("startup validation: an unreachable connector is reported degraded, not fatal", async () => {
  const registry = new Registry();
  registry.register(fine);
  registry.register(boom);
  const failures = await validateConnectors(registry, {
    config: config(false),
    secrets: {},
    log: () => {},
  });
  assertEquals(failures.map((f) => f.connector), ["flaky"]);
  assert(failures[0].error.includes("ECONNREFUSED 127.0.0.1:1143"));
  // still registered and callable: only flaky.* ops fail, the rest of the surface is up
  assertEquals(registry.list().map((c) => c.id), ["steady", "flaky"]);
});

Deno.test("startup validation: failFast keeps the all-or-nothing contract", async () => {
  const registry = new Registry();
  registry.register(boom);
  await assertRejects(
    () => validateConnectors(registry, { config: config(true), secrets: {}, log: () => {} }),
    Error,
    "connector flaky: startup validation failed",
  );
});

Deno.test("startup validation: validate: none skips probing entirely", async () => {
  const registry = new Registry();
  registry.register(boom);
  const cfg = config(false);
  cfg.startup = { validate: "none", failFast: false };
  assertEquals(await validateConnectors(registry, { config: cfg, secrets: {}, log: () => {} }), []);
});

Deno.test("startup validation: a connector's own startup log lines are collected", async () => {
  const registry = new Registry();
  registry.register({
    id: "chatty",
    ops: [],
    client: () => ({}),
    validateStartup: (ctx) => {
      ctx.log({ connector: "chatty", message: "api key ok" });
      return Promise.resolve();
    },
  });
  const lines: Record<string, unknown>[] = [];
  const failures = await validateConnectors(registry, {
    config: config(false),
    secrets: {},
    log: (e) => lines.push(e),
  });
  assertEquals(failures, []);
  assertEquals(lines.length, 1);
});
