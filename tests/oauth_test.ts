import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BanStore, defaultBanPolicy } from "../src/security/ban.ts";
import { createHandler, type HandlerOptions } from "../src/security/http.ts";
import {
  authorizationServerMetadata,
  handleTokenRequest,
  type OAuthConfig,
  parseCredentials,
  protectedResourceMetadata,
} from "../src/security/oauth.ts";

const cfg: OAuthConfig = {
  clientId: "mistral",
  clientSecret: "s3cret-token",
  publicUrl: "https://mcp.example.com",
  ttlSec: 900,
};

function basic(id: string, secret: string): string {
  return `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;
}

function tokenReq(init: RequestInit = {}): Request {
  return new Request("https://mcp.example.com/oauth/token", { method: "POST", ...init });
}

Deno.test("oauth: client_secret_basic returns the server token as the access token", async () => {
  // grant_type may arrive in the body
  const res2 = handleTokenRequest(
    tokenReq({
      headers: {
        authorization: basic("mistral", "s3cret-token"),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }),
    cfg,
    "grant_type=client_credentials",
  );
  assertEquals(res2.status, 200);
  const body = await res2.json() as Record<string, unknown>;
  assertEquals(body.access_token, "s3cret-token");
  assertEquals(body.token_type, "Bearer");
  assertEquals(body.expires_in, 900);
  assertEquals((res2.headers.get("cache-control") ?? "").includes("no-store"), true);
});

Deno.test("oauth: client_secret_post is accepted too", async () => {
  const res = handleTokenRequest(
    tokenReq({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials&client_id=mistral&client_secret=s3cret-token",
    }),
    cfg,
    "grant_type=client_credentials&client_id=mistral&client_secret=s3cret-token",
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json() as Record<string, unknown>).access_token, "s3cret-token");
});

Deno.test("oauth: failures use the RFC 6749 error shape", async () => {
  const cases: Array<[Request, string]> = [
    [
      tokenReq({
        headers: { authorization: basic("mistral", "wrong") },
        body: "grant_type=client_credentials",
      }),
      "invalid_client",
    ],
    [
      tokenReq({
        headers: { authorization: basic("other", "s3cret-token") },
        body: "grant_type=client_credentials",
      }),
      "invalid_client",
    ],
    [
      tokenReq({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      }),
      "invalid_client",
    ],
    [
      tokenReq({
        headers: {
          authorization: basic("mistral", "s3cret-token"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=password&username=x&password=y",
      }),
      "unsupported_grant_type",
    ],
    [new Request("https://mcp.example.com/oauth/token"), "invalid_request"],
  ];
  for (const [req, expected] of cases) {
    const body = req.method === "POST" ? await req.clone().text() : "";
    const res = handleTokenRequest(req, cfg, body);
    const json = await res.json() as Record<string, unknown>;
    assertEquals(json.error, expected);
    assert(res.status === 400 || res.status === 401);
    assert(!JSON.stringify(json).includes("s3cret-token"), "never echo the secret");
  }
});

Deno.test("oauth: Basic parsing is form-urlencoded per RFC 6749", () => {
  const parsed = parseCredentials({
    authorization: basic("cli ent", "sec ret+/="),
    contentType: null,
    body: "",
  });
  assertEquals(parsed, { clientId: "cli ent", clientSecret: "sec ret+/=", grantType: "" });
  assert(
    typeof parseCredentials({ authorization: "Basic !!!", contentType: null, body: "" }) ===
      "string",
  );
  assert(
    typeof parseCredentials({
      authorization: "Basic bm9jb2xvbg==",
      contentType: null,
      body: "",
    }) ===
      "string",
  );
});

Deno.test("oauth: discovery documents point at this server", () => {
  const pr = protectedResourceMetadata(cfg);
  assertEquals(pr.resource, "https://mcp.example.com/mcp");
  assertEquals(pr.authorization_servers, ["https://mcp.example.com"]);
  const as = authorizationServerMetadata(cfg);
  assertEquals(as.issuer, "https://mcp.example.com");
  assertEquals(as.token_endpoint, "https://mcp.example.com/oauth/token");
  assertEquals(as.grant_types_supported, ["client_credentials"]);
  assertEquals(as.token_endpoint_auth_methods_supported, [
    "client_secret_basic",
    "client_secret_post",
  ]);
});

function makeHandler(overrides: Partial<HandlerOptions> = {}) {
  const bans = new BanStore({
    policy: { ...defaultBanPolicy(), maxFailures: 3, windowMs: 60_000, durationMs: 3_600_000 },
  });
  const handler = createHandler({
    token: cfg.clientSecret,
    bans,
    mcpHandler: () => Promise.resolve(Response.json({ ok: true })),
    healthHandler: () => Response.json({ ok: true }),
    oauthTokenHandler: (req, body) => Promise.resolve(handleTokenRequest(req, cfg, body)),
    wellKnownHandler: (_req, path) => {
      if (path === "/.well-known/oauth-protected-resource") {
        return Promise.resolve(Response.json(protectedResourceMetadata(cfg)));
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Promise.resolve(Response.json(authorizationServerMetadata(cfg)));
      }
      return Promise.resolve(null);
    },
    resourceMetadata: () => "https://mcp.example.com/.well-known/oauth-protected-resource",
    ...overrides,
  });
  const info = {
    remoteAddr: { hostname: "203.0.113.7", port: 5000, transport: "tcp" },
  } as unknown as Deno.ServeHandlerInfo;
  return { handler, info, bans };
}

Deno.test("oauth: end to end — token endpoint result authenticates /mcp", async () => {
  const { handler, info } = makeHandler();
  const tokenRes = await handler(
    new Request("https://mcp.example.com/oauth/token", {
      method: "POST",
      headers: {
        authorization: basic("mistral", cfg.clientSecret),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    }),
    info,
  );
  assertEquals(tokenRes.status, 200);
  const { access_token } = await tokenRes.json() as { access_token: string };

  const ok = await handler(
    new Request("https://mcp.example.com/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: "{}",
    }),
    info,
  );
  assertEquals(ok.status, 200, "the OAuth access token works on /mcp");

  const discovery = await handler(
    new Request("https://mcp.example.com/.well-known/oauth-protected-resource"),
    info,
  );
  assertEquals(discovery.status, 200);
  assertEquals(
    (await discovery.json() as Record<string, unknown>).resource,
    "https://mcp.example.com/mcp",
  );
});

Deno.test("oauth: 401 challenge advertises resource metadata", async () => {
  const { handler, info } = makeHandler();
  const res = await handler(
    new Request("https://mcp.example.com/mcp", { method: "POST", body: "{}" }),
    info,
  );
  assertEquals(res.status, 401);
  assertStringIncludes(
    res.headers.get("www-authenticate") ?? "",
    'resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
  );
});

Deno.test("oauth: bad secrets count toward the subnet ban; the endpoint then 429s", async () => {
  const { handler, info } = makeHandler();
  const attempt = () =>
    handler(
      new Request("https://mcp.example.com/oauth/token", {
        method: "POST",
        headers: {
          authorization: basic("mistral", "wrong"),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      }),
      info,
    );
  for (let i = 0; i < 3; i++) assertEquals((await attempt()).status, 401);
  const banned = await attempt();
  assertEquals(banned.status, 429, "banned after maxFailures");
  assert(Number(banned.headers.get("retry-after")) > 0);
  assertEquals((await banned.json() as Record<string, unknown>).error, "temporarily_unavailable");
});

Deno.test("oauth: disabled means the endpoints 404", async () => {
  const { handler, info } = makeHandler({
    oauthTokenHandler: undefined,
    wellKnownHandler: undefined,
    resourceMetadata: undefined,
  });
  assertEquals(
    (await handler(new Request("https://mcp.example.com/oauth/token", { method: "POST" }), info))
      .status,
    404,
  );
  assertEquals(
    (await handler(
      new Request("https://mcp.example.com/.well-known/oauth-protected-resource"),
      info,
    )).status,
    404,
  );
  const res = await handler(
    new Request("https://mcp.example.com/mcp", { method: "POST", body: "{}" }),
    info,
  );
  assertEquals(res.headers.get("www-authenticate"), 'Bearer realm="denops"');
});

Deno.test("oauth: token endpoint rejects oversized bodies", async () => {
  const { handler, info } = makeHandler({ maxBodyBytes: 64 });
  const res = await handler(
    new Request("https://mcp.example.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&pad=${"x".repeat(200)}`,
    }),
    info,
  );
  assertEquals(res.status, 413);
});
