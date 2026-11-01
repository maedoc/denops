import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildApp, createHttpHandler } from "../src/server.ts";

async function writeConfig(dir: string): Promise<{ config: string; secrets: string }> {
  const config = `${dir}/config.yaml`;
  const secrets = `${dir}/secrets.json`;
  await Deno.writeTextFile(
    config,
    [
      "server:",
      "  host: 127.0.0.1",
      "  port: 3123",
      "budgets:",
      "  wallClockMs: 10000",
      "connectors:",
      "  debug:",
      "    enabled: true",
      "  gitlab:",
      "    enabled: false",
      "  mistral:",
      "    enabled: false",
      "startup:",
      "  validate: none",
      `dataDir: ${dir}/data`,
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(secrets, "{}");
  return { config, secrets };
}

// The approval flow end to end over MCP: a run with two gated ops must hand back a
// *new* pendingId after the first approval, and only then complete.
Deno.test("MCP smoke: chained approvals hand back each pendingId", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { config, secrets } = await writeConfig(dir);
    const app = await buildApp(config, secrets);
    const port = 3125;
    app.config.server.token = "test-token";
    const srv = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      (req, info) => createHttpHandler(app)(req, info),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const text = await r.text();
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      assert(line, "expected SSE data line");
      const msg = JSON.parse(line.slice(5)) as {
        result: { content: Array<{ text: string }> };
      };
      return JSON.parse(msg.result.content[0].text) as Record<string, unknown>;
    };

    const first = await call("execute", {
      code:
        `const a = await debug.gated({ step: 1 }); const b = await debug.gated({ step: 2 }); return { a, b };`,
    });
    assertEquals(first.status, "awaiting_approval");
    assertEquals(first.seq, 1);

    const second = await call("approve", { pendingId: first.pendingId, decision: "approve" });
    assertEquals(second.status, "awaiting_approval", "second gated op must still ask");
    assert(typeof second.pendingId === "string" && second.pendingId !== first.pendingId);
    assertEquals((second.args as { step: number }).step, 2);

    const third = await call("approve", { pendingId: second.pendingId, decision: "approve" });
    assertEquals(third.status, "completed");
    const result = third.result as { a: { args: { step: number } }; b: { args: { step: number } } };
    assertEquals(result.a.args, { step: 1 });
    assertEquals(result.b.args, { step: 2 });
    await srv.shutdown();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("MCP smoke: initialize, tools/list, execute echo via streamable HTTP", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { config, secrets } = await writeConfig(dir);
    const app = await buildApp(config, secrets);
    const port = 3123;
    app.config.server.token = "test-token";
    const handler = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      (req, info) => createHttpHandler(app)(req, info),
    );

    const post = (body: unknown, token = "test-token") =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    const parseSse = async (r: Response): Promise<Record<string, unknown>> => {
      const text = await r.text();
      const line = text.split("\n").find((l) => l.startsWith("data:"));
      assert(line, "expected SSE data line");
      return JSON.parse(line.slice(5)) as Record<string, unknown>;
    };

    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    assertEquals(init.status, 200);
    const initRes = await parseSse(init);
    assert(initRes.result, "initialize result");

    const tools = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsRes = await parseSse(tools);
    const names = (toolsRes.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    // `grants` is only advertised when a grant-keyed connector (fs) is enabled; this
    // deployment has debug+gitlab+mail.
    assertEquals(names.sort(), ["approve", "execute", "search"]);

    const call = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "execute",
        arguments: { code: `return await debug.echo({ text: "smoke" });` },
      },
    });
    const callRes = await parseSse(call);
    const content = (callRes.result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(content) as { status: string; result: unknown };
    assertEquals(parsed.status, "completed");
    assertEquals(parsed.result, { echoed: { text: "smoke" } });

    const searchCall = await post({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "search", arguments: { query: "gated", connector: "debug" } },
    });
    const searchRes = await parseSse(searchCall);
    const searchText = (searchRes.result as { content: Array<{ text: string }> }).content[0].text;
    assertStringIncludes(searchText, "debug.gated");

    const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    });
    assertEquals(noAuth.status, 401);

    const badAuth = await post(
      { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
      "wrong",
    );
    assertEquals(badAuth.status, 401);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assertEquals(health.status, 200);
    assertEquals(health.headers.get("x-content-type-options"), "nosniff");

    await handler.shutdown();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
