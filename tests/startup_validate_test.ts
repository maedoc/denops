import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
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

// Regression for 2026-11-18: the hang variant of the same bug. gitlab.ebrains.eu accepted
// TCP and never finished the TLS handshake, so the forge startup probe never settled,
// buildApp never returned, and the supervisor restart-looped a healthy commit for hours.
// A probe that never settles must degrade like a refused one, within a deadline.

const hung: Connector = {
  id: "hung",
  ops: [],
  client: () => ({}),
  validateStartup: () => new Promise(() => {}),
};

Deno.test("startup validation: a probe that never settles degrades within its deadline", async () => {
  const registry = new Registry();
  registry.register(fine);
  registry.register(hung);
  const failures = await validateConnectors(registry, {
    config: config(false),
    secrets: {},
    log: () => {},
    probeTimeoutMs: 25,
  });
  assertEquals(failures.map((f) => f.connector), ["hung"]);
  assertStringIncludes(failures[0].error, "hung startup probe timed out after 25ms");
});

Deno.test("startup validation: hung probes settle concurrently, within one deadline", async () => {
  const registry = new Registry();
  registry.register({ ...hung, id: "hung-a" });
  registry.register({ ...hung, id: "hung-b" });
  const started = Date.now();
  const failures = await validateConnectors(registry, {
    config: config(false),
    secrets: {},
    log: () => {},
    probeTimeoutMs: 200,
  });
  // sequentially awaited probes would take 2 x 200ms; concurrent ones one deadline
  assert(Date.now() - started < 400);
  assertEquals(failures.map((f) => f.connector), ["hung-a", "hung-b"]);
});

Deno.test("startup validation: failFast treats a hang as a validation failure", async () => {
  const registry = new Registry();
  registry.register(hung);
  await assertRejects(
    () =>
      validateConnectors(registry, {
        config: config(true),
        secrets: {},
        log: () => {},
        probeTimeoutMs: 25,
      }),
    Error,
    "connector hung: startup validation failed",
  );
});
