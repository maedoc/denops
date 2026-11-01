// dev_try runner: execute ONE op from a checkout's own registry, against the real
// APIs, and print the result as JSON. Spawned by the dev connector so the agent can
// validate a freshly written op before promoting it.
//
// Usage: deno run --allow-* scripts/dev_try.ts <root> <op> <argsJson>
import { buildApp } from "../src/server.ts";

const [root, op, argsJson] = Deno.args;
if (!root || !op) {
  console.error("usage: dev_try.ts <root> <op> <argsJson>");
  Deno.exit(2);
}

const configPath = `${root}/config.yaml`;
const secretsPath = `${root}/secrets.json`;
let args: unknown = {};
try {
  args = JSON.parse(argsJson ?? "{}");
} catch {
  console.error(`dev_try: args is not valid JSON: ${argsJson?.slice(0, 100)}`);
  Deno.exit(2);
}

// The dev config is the agent's own tree, so buildApp may fail on code it just
// edited — that failure *is* the answer, reported as JSON rather than a stack.
try {
  const app = await buildApp(configPath, secretsPath);
  const resolved = app.registry.resolve(op);
  if (!resolved) {
    const known = app.registry.index().map((e) => e.name);
    const near = known.filter((n) => n.includes(op.split(".")[1] ?? "#")).slice(0, 10);
    console.log(JSON.stringify({
      error: `unknown op ${op} in this checkout`,
      hint: near.length ? `similar: ${near.join(", ")}` : `use api.search("", "${op.split(".")[0]}")`,
    }));
    Deno.exit(0);
  }
  if (resolved.spec.tier === "approval") {
    console.log(JSON.stringify({
      error: `${op} is approval-tier; dev.try only runs open-tier ops — promote it and approve instead`,
    }));
    Deno.exit(0);
  }
  const schemaError = resolved.spec.argSchema(args);
  if (schemaError) {
    console.log(JSON.stringify({ error: `invalid args: ${schemaError}` }));
    Deno.exit(0);
  }
  const client = resolved.connector.client({ config: {}, secrets: {}, log: () => {} });
  const method = client[op.slice(resolved.connector.id.length + 1)];
  if (!method) {
    console.log(JSON.stringify({ error: `${op} has no client method in this checkout` }));
    Deno.exit(0);
  }
  const started = Date.now();
  const result = await method(args as never);
  console.log(JSON.stringify({ ok: true, durationMs: Date.now() - started, result }));
  Deno.exit(0);
} catch (e) {
  console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  Deno.exit(0);
}
