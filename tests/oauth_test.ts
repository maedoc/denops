import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { BanStore, defaultBanPolicy } from "../src/security/ban.ts";
import { createHandler, type HandlerOptions } from "../src/security/http.ts";
import {
  authorizationServerMetadata,
  handleOAuthRoute,
  handleTokenRequest,
  isAllowedRedirectUri,
  newOAuthState,
  type OAuthConfig,
  openidConfiguration,
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

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

// ------------------------------------------------------------------ client_credentials

Deno.test("oauth: client_secret_basic returns the server token as the access token", async () => {
  const res = await handleTokenRequest(
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
  assertEquals(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assertEquals(body.access_token, "s3cret-token");
  assertEquals(body.token_type, "Bearer");
  assertEquals(body.expires_in, 900);
  assertEquals((res.headers.get("cache-control") ?? "").includes("no-store"), true);
});

Deno.test("oauth: client_secret_post is accepted too", async () => {
  const res = await handleTokenRequest(
    tokenReq({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "client_credentials",
        client_id: "mistral",
        client_secret: "s3cret-token",
      }),
    }),
    cfg,
    formBody({
      grant_type: "client_credentials",
      client_id: "mistral",
      client_secret: "s3cret-token",
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json() as Record<string, unknown>).access_token, "s3cret-token");
});

// The live bearer token contains a literal '%'; a client sending it raw (curl -u,
// most SDKs) must not be rejected for "malformed percent-encoding".
Deno.test("oauth: secrets with '%'/'+' work raw and form-encoded", async () => {
  const pctCfg: OAuthConfig = { ...cfg, clientSecret: "a%b+c$d#e&f^g" };
  const raw = await handleTokenRequest(
    tokenReq({
      headers: { authorization: `Basic ${btoa("mistral:a%b+c$d#e&f^g")}` },
      body: "grant_type=client_credentials",
    }),
    pctCfg,
    "grant_type=client_credentials",
  );
  assertEquals(raw.status, 200);
  const encoded = await handleTokenRequest(
    tokenReq({
      headers: { authorization: basic("mistral", "a%b+c$d#e&f^g") },
      body: "grant_type=client_credentials",
    }),
    pctCfg,
    "grant_type=client_credentials",
  );
  assertEquals(encoded.status, 200);
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
    const res = await handleTokenRequest(req, cfg, body);
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
  assert(typeof parsed !== "string");
  if (typeof parsed !== "string") {
    assertEquals(parsed.clientIdDecoded, "cli ent");
    assertEquals(parsed.clientSecretDecoded, "sec ret+/=");
    assertEquals(parsed.grantType, "");
  }
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

// -------------------------------------------------------------------- discovery

Deno.test("oauth: discovery documents point at this server", () => {
  const pr = protectedResourceMetadata(cfg);
  assertEquals(pr.resource, "https://mcp.example.com/mcp");
  assertEquals(pr.authorization_servers, ["https://mcp.example.com"]);
  const as = authorizationServerMetadata(cfg);
  assertEquals(as.issuer, "https://mcp.example.com");
  assertEquals(as.token_endpoint, "https://mcp.example.com/oauth/token");
  assertEquals(as.registration_endpoint, "https://mcp.example.com/register");
  assertEquals(as.grant_types_supported, ["authorization_code", "client_credentials"]);
  assertEquals(as.code_challenge_methods_supported, ["S256"]);
  // Clients that only speak OIDC discovery must find the same endpoints.
  const oidc = openidConfiguration(cfg);
  assertEquals(oidc.authorization_endpoint, "https://mcp.example.com/authorize");
  assertEquals(oidc.jwks_uri, "https://mcp.example.com/.well-known/jwks.json");
  assertEquals(oidc.token_endpoint, "https://mcp.example.com/oauth/token");
});

// --------------------------------------------------- authorization code + PKCE

const VERIFIER = "abc123-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerAndAuthorize(opts: { consentToken?: string } = {}) {
  const state = newOAuthState();
  const registered = await handleOAuthRoute(
    new Request("https://mcp.example.com/register", { method: "POST" }),
    new URL("https://mcp.example.com/register"),
    JSON.stringify({ client_name: "Gemini", redirect_uris: ["http://localhost:7777/cb"] }),
    cfg,
    state,
  );
  assertEquals(registered!.status, 201);
  const client = await registered!.json() as { client_id: string };

  const challenge = await challengeFor(VERIFIER);
  const authUrl = new URL("https://mcp.example.com/authorize");
  for (
    const [k, v] of Object.entries({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://localhost:7777/cb",
      state: "xyz",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
    })
  ) authUrl.searchParams.set(k, v);

  const consent = await handleOAuthRoute(
    new Request(authUrl, { method: "POST" }),
    authUrl,
    formBody({
      client_id: client.client_id,
      redirect_uri: "http://localhost:7777/cb",
      state: "xyz",
      code_challenge: challenge,
      scope: "mcp",
      token: opts.consentToken ?? cfg.clientSecret,
    }),
    cfg,
    state,
  );
  return { state, client, authUrl, challenge, consent: consent! };
}

Deno.test("oauth: DCR validates redirect URIs", async () => {
  const state = newOAuthState();
  const route = (body: unknown) =>
    handleOAuthRoute(
      new Request("https://mcp.example.com/register", { method: "POST" }),
      new URL("https://mcp.example.com/register"),
      JSON.stringify(body),
      cfg,
      state,
    );
  assertEquals((await route({ redirect_uris: ["https://evil.example/cb"] }))!.status, 201);
  assertEquals((await route({ redirect_uris: ["http://evil.example/cb"] }))!.status, 400);
  assertEquals((await route({ redirect_uris: ["/relative/cb"] }))!.status, 400);
  assertEquals((await route({ redirect_uris: [] }))!.status, 400);
  assertEquals((await route({}))!.status, 400);
  assert(isAllowedRedirectUri("http://127.0.0.1:8080/cb"));
  assert(!isAllowedRedirectUri("http://localhost:8080/cb#frag"));
});

Deno.test("oauth: consent page is served, and a wrong token grants nothing", async () => {
  const get = await handleOAuthRoute(
    new Request(
      "https://mcp.example.com/authorize?response_type=code&client_id=dcr_nope&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=x&code_challenge_method=S256",
    ),
    new URL(
      "https://mcp.example.com/authorize?response_type=code&client_id=dcr_nope&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&code_challenge=x&code_challenge_method=S256",
    ),
    "",
    cfg,
    newOAuthState(),
  );
  assertEquals(get!.status, 400, "unknown client cannot reach a redirect");

  const { consent, state } = await registerAndAuthorize({ consentToken: "wrong" });
  assertEquals(consent.status, 401);
  assertStringIncludes(await consent.text(), "That token does not match");
  assertEquals(state.codes.size, 0, "no code issued for a bad consent token");
});

// Gemini's connector uses the pre-registered client id (no DCR) and redirects to
// Google's hosted redirector; that must reach the consent page, not "unknown
// client_id", while arbitrary hosts stay refused.
Deno.test("oauth: pre-registered client id works with an allowlisted redirector", async () => {
  const state = newOAuthState();
  const googleCfg: OAuthConfig = { ...cfg, publicUrl: "https://wdmn.example.org" };
  const challenger = await challengeFor(VERIFIER);
  const uri =
    "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-108742248246697572952-x";
  const url = new URL("https://wdmn.example.org/authorize");
  for (
    const [k, v] of Object.entries({
      response_type: "code",
      client_id: "mistral",
      redirect_uri: uri,
      scope: "mcp",
      resource: "https://wdmn.example.org/mcp",
      code_challenge: challenger,
      code_challenge_method: "S256",
      state: "gemini-state",
    })
  ) url.searchParams.set(k, v);

  const page = await handleOAuthRoute(new Request(url), url, "", googleCfg, state);
  assertEquals(page!.status, 200, "consent page, not 'unknown client_id'");
  assertStringIncludes(await page!.text(), "pre-registered");

  const consent = await handleOAuthRoute(
    new Request(url, { method: "POST" }),
    url,
    formBody({
      client_id: "mistral",
      redirect_uri: uri,
      state: "gemini-state",
      code_challenge: challenger,
      scope: "mcp",
      token: cfg.clientSecret,
    }),
    googleCfg,
    state,
  );
  assertEquals(consent!.status, 302);
  const location = new URL(consent!.headers.get("location")!);
  assertEquals(location.hostname, "oauth-redirect.googleusercontent.com");
  assertEquals(location.searchParams.get("state"), "gemini-state");
  const code = location.searchParams.get("code")!;

  const exchanged = await handleTokenRequest(
    tokenReq({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }),
    googleCfg,
    formBody({
      grant_type: "authorization_code",
      code,
      client_id: "mistral",
      redirect_uri: uri,
      code_verifier: VERIFIER,
    }),
    state,
  );
  assertEquals(exchanged.status, 200);

  // Unlisted host is refused even for the static client (no open redirect).
  const evil = new URL(url);
  evil.searchParams.set("redirect_uri", "https://evil.example/cb");
  assertEquals(
    (await handleOAuthRoute(new Request(evil), evil, "", googleCfg, state))!.status,
    400,
  );
});

Deno.test("oauth: full authorization_code + PKCE flow issues a working token", async () => {
  const { state, client, consent } = await registerAndAuthorize();
  assertEquals(consent.status, 302);
  const location = new URL(consent.headers.get("location")!);
  assertEquals(location.origin + location.pathname, "http://localhost:7777/cb");
  assertEquals(location.searchParams.get("state"), "xyz");
  const code = location.searchParams.get("code")!;

  const exchange = (verifier: string) =>
    handleTokenRequest(
      tokenReq({
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: formBody({
          grant_type: "authorization_code",
          code,
          client_id: client.client_id,
          redirect_uri: "http://localhost:7777/cb",
          code_verifier: verifier,
        }),
      }),
      cfg,
      formBody({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "http://localhost:7777/cb",
        code_verifier: verifier,
      }),
      state,
    );

  const wrongVerifier = await exchange("not-the-verifier");
  assertEquals(wrongVerifier.status, 400);
  assertEquals((await wrongVerifier.json() as Record<string, unknown>).error, "invalid_grant");

  // The failed attempt consumed the code: single use, even on error.
  const replay = await exchange(VERIFIER);
  assertEquals(replay.status, 400);

  // Fresh flow for the success path.
  const second = await registerAndAuthorize();
  const code2 = new URL(second.consent.headers.get("location")!).searchParams.get("code")!;
  const ok = await handleTokenRequest(
    tokenReq({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        code: code2,
        client_id: second.client.client_id,
        redirect_uri: "http://localhost:7777/cb",
        code_verifier: VERIFIER,
      }),
    }),
    cfg,
    formBody({
      grant_type: "authorization_code",
      code: code2,
      client_id: second.client.client_id,
      redirect_uri: "http://localhost:7777/cb",
      code_verifier: VERIFIER,
    }),
    second.state,
  );
  assertEquals(ok.status, 200);
  assertEquals((await ok.json() as Record<string, unknown>).access_token, cfg.clientSecret);
});

Deno.test("oauth: an expired code is rejected", async () => {
  let clock = 1_000_000;
  const state = newOAuthState(() => clock);
  const registered = await handleOAuthRoute(
    new Request("https://mcp.example.com/register", { method: "POST" }),
    new URL("https://mcp.example.com/register"),
    JSON.stringify({ redirect_uris: ["http://localhost:7777/cb"] }),
    cfg,
    state,
  );
  const client = await registered!.json() as { client_id: string };
  const challenge = await challengeFor(VERIFIER);
  const url = new URL("https://mcp.example.com/authorize");
  const fields = {
    client_id: client.client_id,
    redirect_uri: "http://localhost:7777/cb",
    state: "",
    code_challenge: challenge,
    scope: "mcp",
    token: cfg.clientSecret,
  };
  for (const [k, v] of Object.entries(fields)) if (k !== "token") url.searchParams.set(k, v);
  const consent = await handleOAuthRoute(
    new Request(url, { method: "POST" }),
    url,
    formBody(fields),
    cfg,
    state,
  );
  const code = new URL(consent!.headers.get("location")!).searchParams.get("code")!;
  clock += 6 * 60 * 1000;
  const res = await handleTokenRequest(
    tokenReq({ headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }),
    cfg,
    formBody({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: "http://localhost:7777/cb",
      code_verifier: VERIFIER,
    }),
    state,
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json() as Record<string, unknown>).error, "invalid_grant");
});

// -------------------------------------------------------------- integration

function makeHandler(overrides: Partial<HandlerOptions> = {}) {
  const bans = new BanStore({
    policy: { ...defaultBanPolicy(), maxFailures: 3, windowMs: 60_000, durationMs: 3_600_000 },
  });
  const state = newOAuthState();
  const handler = createHandler({
    token: cfg.clientSecret,
    bans,
    mcpHandler: () => Promise.resolve(Response.json({ ok: true })),
    healthHandler: () => Response.json({ ok: true }),
    oauthHandler: (req, url, body) => handleOAuthRoute(req, url, body, cfg, state),
    resourceMetadata: () => "https://mcp.example.com/.well-known/oauth-protected-resource",
    ...overrides,
  });
  const info = {
    remoteAddr: { hostname: "203.0.113.7", port: 5000, transport: "tcp" },
  } as unknown as Deno.ServeHandlerInfo;
  return { handler, info, bans, state };
}

Deno.test("oauth: end to end — discovery, token, then /mcp", async () => {
  const { handler, info } = makeHandler();
  for (
    const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/jwks.json",
    ]
  ) {
    assertEquals(
      (await handler(new Request(`https://mcp.example.com${path}`), info)).status,
      200,
      path,
    );
  }
  const tokenRes = await handler(
    new Request("https://mcp.example.com/oauth/token", {
      method: "POST",
      headers: { authorization: basic("mistral", cfg.clientSecret) },
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
        headers: { authorization: basic("mistral", "wrong") },
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
  const { handler, info } = makeHandler({ oauthHandler: undefined, resourceMetadata: undefined });
  assertEquals(
    (await handler(new Request("https://mcp.example.com/oauth/token", { method: "POST" }), info))
      .status,
    404,
  );
  assertEquals(
    (await handler(new Request("https://mcp.example.com/.well-known/openid-configuration"), info))
      .status,
    404,
  );
  assertEquals(
    (await handler(new Request("https://mcp.example.com/register", { method: "POST" }), info))
      .status,
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
