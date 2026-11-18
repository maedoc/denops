import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { forgeConnector } from "../src/connectors/forge/manifest.ts";
import type { ForgeAccount } from "../src/connectors/forge/port.ts";

// Regression for 2026-11-18: gitlab.ebrains.eu accepted TCP and never completed the TLS
// handshake, so the real gitlab port's startup probe (GET /user) never settled, and the
// server never bound — the supervisor restart-looped a healthy commit for hours. One
// flaky forge must cost a warn line, not the boot. The black hole below is a local
// server that accepts the request and never answers, which is the same failure shape
// with none of the internet's nondeterminism.

function gitlabAccount(origin: string, over: Partial<ForgeAccount> = {}): ForgeAccount {
  return {
    id: "ebrains",
    flavor: "gitlab",
    origin,
    apiPath: "/api/v4",
    token: "test-token",
    maxLimit: 100,
    ...over,
  };
}

Deno.test("forge validateStartup: one hung account costs a warn, not the boot", async () => {
  // The gate answers only after the probe is over: Deno.serve.shutdown() waits for
  // in-flight requests, so a server that never answers would hang the test on the
  // very property it is asserting.
  let release!: () => void;
  const gate = new Promise<Response>((r) => {
    release = () => r(new Response("late", { status: 500 }));
  });
  const blackHole = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, () => gate);
  const fine = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/api/v4/user") {
      return Response.json({ id: 1, username: "duke", name: null });
    }
    return Response.json({ message: "404" }, { status: 404 });
  });
  try {
    const conn = forgeConnector({
      accounts: [
        gitlabAccount(`http://127.0.0.1:${blackHole.addr.port}`, { id: "hung" }),
        gitlabAccount(`http://127.0.0.1:${fine.addr.port}`, { id: "alive" }),
      ],
      probeTimeoutMs: 100,
    });
    const logs: Record<string, unknown>[] = [];
    // resolves: a hung probe is per-account, and one live account keeps the connector up
    await conn.validateStartup!({ config: {}, secrets: {}, log: (e) => logs.push(e) });
    assertEquals(logs.length, 1);
    const msg = String(logs[0].msg);
    assertStringIncludes(msg, "forge account hung (gitlab) failed its startup probe");
    assertStringIncludes(msg, "hung startup probe timed out after 100ms");
  } finally {
    release();
    await blackHole.shutdown();
    await fine.shutdown();
  }
});
