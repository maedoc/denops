import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BanStore, defaultBanPolicy } from "../src/security/ban.ts";
import {
  addSecurityHeaders,
  constantTimeEqual,
  createHandler,
  gateRequest,
} from "../src/security/http.ts";

function makeHandler(overrides: Partial<Parameters<typeof createHandler>[0]> = {}) {
  const bans = new BanStore({ policy: defaultBanPolicy() });
  const handler = createHandler({
    token: "s3cret",
    bans,
    mcpHandler: () =>
      Promise.resolve(
        new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        }),
      ),
    healthHandler: () => Response.json({ ok: true }),
    ...overrides,
  });
  const info = {
    remoteAddr: { hostname: "203.0.113.7", port: 5000, transport: "tcp" },
  } as unknown as Deno.ServeHandlerInfo;
  return { handler, info, bans };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3100${path}`, init);
}

Deno.test("constantTimeEqual: equal, different length, same length different content", () => {
  assert(constantTimeEqual("abc", "abc"));
  assert(!constantTimeEqual("abc", "abd"));
  assert(!constantTimeEqual("abc", "abcd"));
  assert(!constantTimeEqual("", "a"));
  assert(constantTimeEqual("", ""));
});

Deno.test("gate: missing/wrong token -> 401 with WWW-Authenticate; empty configured token rejects all", async () => {
  const { handler, info } = makeHandler();
  let res = await handler(req("/mcp"), info);
  assertEquals(res.status, 401);
  assertStringIncludes(res.headers.get("www-authenticate") ?? "", "Bearer");
  res = await handler(req("/mcp", { headers: { authorization: "Bearer wrong" } }), info);
  assertEquals(res.status, 401);
  res = await handler(req("/mcp", { headers: { authorization: "Bearer s3cret" } }), info);
  assertEquals(res.status, 200);

  const open = makeHandler({ token: "" });
  res = await open.handler(
    req("/mcp", { headers: { authorization: "Bearer anything" } }),
    open.info,
  );
  assertEquals(res.status, 401, "empty token must reject everything");
});

Deno.test("gate: repeated auth failures ban the source subnet with 429 + Retry-After", async () => {
  const bans = new BanStore({
    policy: { maxFailures: 3, windowMs: 60_000, durationMs: 3_600_000, maxEntries: 1000 },
  });
  const handler = createHandler({
    token: "s3cret",
    bans,
    mcpHandler: () => Promise.resolve(new Response("ok")),
  });
  const info = {
    remoteAddr: { hostname: "203.0.113.7", port: 5000, transport: "tcp" },
  } as Deno.ServeHandlerInfo;
  for (let i = 0; i < 3; i++) {
    const res = await handler(req("/mcp", { headers: { authorization: "Bearer wrong" } }), info);
    assertEquals(res.status, 401);
  }
  const res = await handler(req("/mcp", { headers: { authorization: "Bearer s3cret" } }), info);
  assertEquals(res.status, 429, "banned even with correct token");
  assert(Number(res.headers.get("retry-after")) > 0);
});

Deno.test("gateRequest honors trusted proxy XFF for banning", async () => {
  const bans = new BanStore({
    policy: { maxFailures: 2, windowMs: 60_000, durationMs: 3_600_000, maxEntries: 1000 },
    trustedProxy: "127.0.0.1",
  });
  const r = (xff: string) =>
    new Request("http://x/mcp", {
      headers: { authorization: "Bearer wrong", "x-forwarded-for": xff },
    });
  await gateRequest(r("203.0.113.5"), "127.0.0.1:9", { token: "s3cret", bans });
  await gateRequest(r("203.0.113.9"), "127.0.0.1:9", { token: "s3cret", bans });
  const denied = await gateRequest(r("203.0.113.9"), "127.0.0.1:9", { token: "s3cret", bans });
  assert(denied !== null, "banned subnet must be denied");
  assertEquals(denied.status, 429);
  const other = await gateRequest(
    new Request("http://x/mcp", {
      headers: { authorization: "Bearer s3cret", "x-forwarded-for": "198.51.100.1" },
    }),
    "127.0.0.1:9",
    { token: "s3cret", bans },
  );
  assertEquals(other, null, "different subnet not banned; valid token passes");
});

Deno.test("handler: /health open with security headers, unknown path 404, oversized body 413", async () => {
  const { handler, info } = makeHandler({ maxBodyBytes: 64 });
  const health = await handler(req("/health"), info);
  assertEquals(health.status, 200);
  assertEquals(health.headers.get("x-content-type-options"), "nosniff");
  assertEquals(health.headers.get("cache-control"), "no-store");
  assert((await health.json()).ok);

  const nf = await handler(req("/nope"), info);
  assertEquals(nf.status, 404);

  const big = await handler(
    req("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer s3cret", "content-length": "1000" },
      body: "x".repeat(1000),
    }),
    info,
  );
  assertEquals(big.status, 413);

  const ok = await handler(
    req("/mcp", {
      method: "POST",
      headers: { authorization: "Bearer s3cret", "content-length": "10" },
      body: "0123456789",
    }),
    info,
  );
  assertEquals(ok.status, 200);
  assertEquals(
    ok.headers.get("x-content-type-options"),
    "nosniff",
    "security headers on proxied responses too",
  );
});

Deno.test("addSecurityHeaders does not clobber an existing HSTS header", () => {
  const res = new Response("x", { headers: { "strict-transport-security": "max-age=1" } });
  const out = addSecurityHeaders(res);
  assertEquals(out.headers.get("strict-transport-security"), "max-age=1");
});

// The app owns the edge headers so a TLS-terminating proxy can stay thin: Caddy
// appends rather than replaces on proxied responses, which duplicated whatever
// both sides set.
Deno.test("addSecurityHeaders sets the full edge header set", () => {
  const out = addSecurityHeaders(new Response("x"));
  assertEquals(out.headers.get("x-content-type-options"), "nosniff");
  assertEquals(out.headers.get("cache-control"), "no-store");
  assertEquals(out.headers.get("referrer-policy"), "no-referrer");
  assertEquals(out.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
});
