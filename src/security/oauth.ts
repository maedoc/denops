// OAuth 2.0 for /mcp.
//
// Two ways in, both ending at the same static bearer token:
//
// 1. client_credentials (machine clients: Mistral, curl). The pre-registered
//    client's secret IS the server bearer token from secrets.json; the token
//    endpoint hands it back as the access token.
//
// 2. authorization_code + PKCE with dynamic client registration and an explicit
//    consent page (interactive clients: Gemini and friends, which discover
//    /.well-known/openid-configuration and insist on the browser flow).
//    Registration issues a public client (no secret), and /authorize only mints
//    a code after the operator pastes the denops access token into the consent
//    form — the possession proof that keeps this from being open token issuance.
//
// Deliberate limits: one identity, no refresh tokens, no id_tokens (hence an
// empty JWKS), expires_in advisory. Access token == client secret throughout.
import { constantTimeEqual } from "./http.ts";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public origin of this server, e.g. https://mcp.example.com (no trailing /). */
  publicUrl: string;
  ttlSec?: number;
}

const DEFAULT_TTL_SEC = 3600;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 200;
const MAX_CODES = 1000;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_LEN = 500;

interface RegisteredClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  expiresAt: number;
}

export interface OAuthState {
  clients: Map<string, RegisteredClient>;
  codes: Map<string, AuthCode>;
  now: () => number;
}

export function newOAuthState(now: () => number = () => Date.now()): OAuthState {
  return { clients: new Map(), codes: new Map(), now };
}

// ---------------------------------------------------------------- metadata

export function protectedResourceMetadata(cfg: OAuthConfig): Record<string, unknown> {
  return {
    resource: `${cfg.publicUrl}/mcp`,
    authorization_servers: [cfg.publicUrl],
    bearer_methods_supported: ["header"],
    resource_name: "denops",
  };
}

export function authorizationServerMetadata(cfg: OAuthConfig): Record<string, unknown> {
  return {
    issuer: cfg.publicUrl,
    authorization_endpoint: `${cfg.publicUrl}/authorize`,
    token_endpoint: `${cfg.publicUrl}/oauth/token`,
    registration_endpoint: `${cfg.publicUrl}/register`,
    grant_types_supported: ["authorization_code", "client_credentials"],
    response_types_supported: ["code"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
  };
}

// Some clients ignore RFC 8414 metadata and only look for OIDC discovery.
// We are not an identity provider (no id_token), so no signup/claims endpoints
// are advertised and the JWKS is empty.
export function openidConfiguration(cfg: OAuthConfig): Record<string, unknown> {
  return {
    ...authorizationServerMetadata(cfg),
    jwks_uri: `${cfg.publicUrl}/.well-known/jwks.json`,
    subject_types_supported: ["public"],
    claims_supported: [],
  };
}

export function jwksDocument(): Record<string, unknown> {
  return { keys: [] };
}

// ----------------------------------------------------------------- errors

export function oauthError(
  status: number,
  error: string,
  description: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

// ------------------------------------------------------------ credentials

export interface TokenRequestInput {
  authorization: string | null;
  contentType: string | null;
  body: string;
}

export interface ParsedCredentials {
  clientId: string;
  clientSecret: string;
  clientIdDecoded?: string;
  clientSecretDecoded?: string;
  grantType: string;
}

export function parseCredentials(input: TokenRequestInput): ParsedCredentials | string {
  const form = new URLSearchParams();
  if (input.body) { for (const [k, v] of new URLSearchParams(input.body)) form.set(k, v); }
  let clientId = form.get("client_id") ?? "";
  let clientSecret = form.get("client_secret") ?? "";
  const grantType = form.get("grant_type") ?? "";
  const decoded: { clientIdDecoded?: string; clientSecretDecoded?: string } = {};

  const auth = input.authorization ?? "";
  if (auth.startsWith("Basic ")) {
    let raw: string;
    try {
      raw = atob(auth.slice("Basic ".length).trim());
    } catch {
      return "malformed Basic authorization header";
    }
    const sep = raw.indexOf(":");
    if (sep < 0) return "malformed Basic credentials (expected client_id:client_secret)";
    clientId = raw.slice(0, sep);
    clientSecret = raw.slice(sep + 1);
    // RFC 6749 has clients form-encode these before base64, but plenty (curl -u
    // among them) send raw values; a literal '%' must not be a parse error.
    try {
      const idDecoded = decodeURIComponent(clientId);
      const secretDecoded = decodeURIComponent(clientSecret);
      if (idDecoded !== clientId) decoded.clientIdDecoded = idDecoded;
      if (secretDecoded !== clientSecret) decoded.clientSecretDecoded = secretDecoded;
    } catch { /* raw values, keep as-is */ }
  }
  return { clientId, clientSecret, ...decoded, grantType };
}

// --------------------------------------------------------------- register

export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > MAX_REDIRECT_LEN) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

function randomId(prefix: string, bytes = 16): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function registerClient(
  body: string,
  cfg: OAuthConfig,
  state: OAuthState,
): Response {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(body || "{}") as Record<string, unknown>;
  } catch {
    return oauthError(400, "invalid_client_metadata", "body must be JSON");
  }
  const uris = req.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris is required");
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return oauthError(400, "invalid_redirect_uri", `at most ${MAX_REDIRECT_URIS} redirect_uris`);
  }
  for (const u of uris) {
    if (typeof u !== "string" || !isAllowedRedirectUri(u)) {
      return oauthError(
        400,
        "invalid_redirect_uri",
        `redirect_uri must be https, or http on localhost/127.0.0.1: ${JSON.stringify(u)}`,
      );
    }
  }
  if (state.clients.size >= MAX_CLIENTS) {
    return oauthError(
      429,
      "temporarily_unavailable",
      "too many registered clients; restart to reset",
    );
  }
  const clientId = randomId("dcr_");
  const name = typeof req.client_name === "string" ? req.client_name.slice(0, 100) : "mcp client";
  state.clients.set(clientId, {
    clientId,
    name,
    redirectUris: uris as string[],
    createdAt: state.now(),
  });
  return new Response(
    JSON.stringify({
      client_id: clientId,
      client_id_issued_at: Math.floor(state.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      // Public client: the consent page is what gates issuance, not a secret.
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "mcp",
    }),
    { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

// -------------------------------------------------------------- authorize

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
  ));

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope: string;
}

function parseAuthorizeParams(url: URL): AuthorizeParams | string {
  const p = url.searchParams;
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const responseType = p.get("response_type") ?? "";
  const challenge = p.get("code_challenge") ?? "";
  const method = p.get("code_challenge_method") ?? "S256";
  if (responseType !== "code") return "response_type must be 'code'";
  if (clientId === "") return "client_id is required";
  if (redirectUri === "") return "redirect_uri is required";
  if (challenge === "") return "PKCE code_challenge is required";
  if (method !== "S256") return "code_challenge_method must be S256";
  return {
    clientId,
    redirectUri,
    state: p.get("state") ?? "",
    challenge,
    scope: p.get("scope") || "mcp",
  };
}

function consentPage(
  cfg: OAuthConfig,
  params: AuthorizeParams,
  clientName: string,
  error?: string,
): Response {
  const hidden = [
    ["client_id", params.clientId],
    ["redirect_uri", params.redirectUri],
    ["state", params.state],
    ["code_challenge", params.challenge],
    ["scope", params.scope],
  ].map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("\n    ");
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>denops — authorize ${esc(clientName)}</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
 input[type=password]{width:100%;padding:.5rem;font:inherit;box-sizing:border-box}
 button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;cursor:pointer}
 .err{background:#fee;border:1px solid #c00;padding:.6rem;border-radius:4px}
 code{background:#f3f3f3;padding:.1rem .3rem;border-radius:3px}
</style></head>
<body>
<h1>Authorize <code>${esc(clientName)}</code></h1>
<p><strong>${esc(clientName)}</strong> is asking for access to this denops server as
<code>${esc(cfg.clientId)}</code>. It will be able to run every op you have configured
(GitLab, mail, …) with your credentials.</p>
<p>To approve, paste the denops access token (the <code>serverToken</code> in
<code>secrets.json</code>, same value as the bearer token).</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">
    ${hidden}
  <label for="token">Access token</label>
  <input id="token" name="token" type="password" autocomplete="off" autofocus required>
  <button type="submit">Authorize ${esc(clientName)}</button>
</form>
<p style="color:#555;font-size:13px">No token at hand? Deny by closing this tab; nothing is
granted until the form is submitted.</p>
</body></html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export function authorizeGet(url: URL, cfg: OAuthConfig, state: OAuthState): Response {
  const parsed = parseAuthorizeParams(url);
  if (typeof parsed === "string") {
    return new Response(`invalid authorization request: ${esc(parsed)}`, {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const client = state.clients.get(parsed.clientId);
  if (!client) {
    return new Response("unknown client_id; register first or use client_credentials", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  // Never redirect to an unregistered URI: that would be an open redirect.
  if (!client.redirectUris.includes(parsed.redirectUri)) {
    return new Response("redirect_uri is not registered for this client", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return consentPage(cfg, parsed, client.name);
}

export function authorizePost(
  url: URL,
  body: string,
  cfg: OAuthConfig,
  state: OAuthState,
): Response {
  const form = new URLSearchParams(body);
  const parsed = parseAuthorizeParams(url);
  const params: AuthorizeParams = typeof parsed === "string"
    ? {
      clientId: form.get("client_id") ?? "",
      redirectUri: form.get("redirect_uri") ?? "",
      state: form.get("state") ?? "",
      challenge: form.get("code_challenge") ?? "",
      scope: form.get("scope") || "mcp",
    }
    : {
      ...parsed,
      clientId: form.get("client_id") ?? parsed.clientId,
      redirectUri: form.get("redirect_uri") ?? parsed.redirectUri,
      state: form.get("state") ?? parsed.state,
      challenge: form.get("code_challenge") ?? parsed.challenge,
    };
  const client = state.clients.get(params.clientId);
  if (!client || !client.redirectUris.includes(params.redirectUri) || params.challenge === "") {
    return new Response("invalid authorization request", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const token = form.get("token") ?? "";
  if (token === "" || !constantTimeEqual(token, cfg.clientSecret)) {
    return consentPage(cfg, params, client.name, "That token does not match. Nothing was granted.");
  }
  // Possession of the access token proved; mint a single-use, short-lived code
  // bound to the client, redirect URI and PKCE challenge.
  const code = randomId("code_", 32);
  if (state.codes.size >= MAX_CODES) {
    const oldest = state.codes.keys().next().value;
    if (oldest !== undefined) state.codes.delete(oldest);
  }
  state.codes.set(code, {
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    challenge: params.challenge,
    scope: params.scope,
    expiresAt: state.now() + CODE_TTL_MS,
  });
  const location = new URL(params.redirectUri);
  location.searchParams.set("code", code);
  if (params.state !== "") location.searchParams.set("state", params.state);
  return new Response(null, {
    status: 302,
    headers: { location: location.toString(), "cache-control": "no-store" },
  });
}

// ------------------------------------------------------------------ token

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function handleTokenRequest(
  req: Request,
  cfg: OAuthConfig,
  body: string,
  state?: OAuthState,
): Promise<Response> {
  if (req.method !== "POST") {
    return oauthError(400, "invalid_request", "token endpoint requires POST");
  }
  const parsed = parseCredentials({
    authorization: req.headers.get("authorization"),
    contentType: req.headers.get("content-type"),
    body,
  });
  if (typeof parsed === "string") return oauthError(400, "invalid_request", parsed);
  if (parsed.grantType === "") {
    return oauthError(400, "invalid_request", "grant_type is required");
  }

  if (parsed.grantType === "authorization_code") {
    return await exchangeCode(new URLSearchParams(body), cfg, state);
  }
  if (parsed.grantType !== "client_credentials") {
    return oauthError(
      400,
      "unsupported_grant_type",
      "supported: client_credentials, authorization_code",
    );
  }

  const idOk = parsed.clientId === cfg.clientId || parsed.clientIdDecoded === cfg.clientId;
  const secretOk = constantTimeEqual(parsed.clientSecret, cfg.clientSecret) ||
    (parsed.clientSecretDecoded !== undefined &&
      constantTimeEqual(parsed.clientSecretDecoded, cfg.clientSecret));
  if (!idOk || !secretOk) {
    return oauthError(401, "invalid_client", "unknown client or bad secret", {
      "www-authenticate": 'Basic realm="denops"',
    });
  }
  return accessTokenResponse(cfg, "mcp");
}

function accessTokenResponse(cfg: OAuthConfig, scope: string): Response {
  return new Response(
    JSON.stringify({
      access_token: cfg.clientSecret,
      token_type: "Bearer",
      expires_in: cfg.ttlSec ?? DEFAULT_TTL_SEC,
      scope,
    }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

async function exchangeCode(
  form: URLSearchParams,
  cfg: OAuthConfig,
  state?: OAuthState,
): Promise<Response> {
  if (!state) return oauthError(400, "unsupported_grant_type", "authorization_code is not enabled");
  const code = form.get("code") ?? "";
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const entry = state.codes.get(code);
  if (!entry) return oauthError(400, "invalid_grant", "unknown or already used code");
  // Single use, whatever the outcome.
  state.codes.delete(code);
  if (state.now() > entry.expiresAt) return oauthError(400, "invalid_grant", "code expired");
  if (entry.clientId !== clientId) {
    return oauthError(400, "invalid_grant", "code was issued to another client");
  }
  if (entry.redirectUri !== redirectUri) {
    return oauthError(400, "invalid_grant", "redirect_uri mismatch");
  }
  if (verifier === "") return oauthError(400, "invalid_grant", "code_verifier is required");
  if (await s256(verifier) !== entry.challenge) {
    return oauthError(400, "invalid_grant", "PKCE verification failed");
  }
  return accessTokenResponse(cfg, entry.scope);
}

// ---------------------------------------------------------------- routing

export async function handleOAuthRoute(
  req: Request,
  url: URL,
  body: string,
  cfg: OAuthConfig,
  state: OAuthState,
): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/.well-known/oauth-protected-resource") {
    return Response.json(protectedResourceMetadata(cfg));
  }
  if (p === "/.well-known/oauth-authorization-server") {
    return Response.json(authorizationServerMetadata(cfg));
  }
  if (p === "/.well-known/openid-configuration") {
    return Response.json(openidConfiguration(cfg));
  }
  if (p === "/.well-known/jwks.json") {
    return Response.json(jwksDocument());
  }
  if (p === "/register") {
    if (req.method !== "POST") return oauthError(400, "invalid_request", "register requires POST");
    return registerClient(body, cfg, state);
  }
  if (p === "/authorize") {
    return req.method === "POST"
      ? authorizePost(url, body, cfg, state)
      : authorizeGet(url, cfg, state);
  }
  if (p === "/oauth/token") {
    return await handleTokenRequest(req, cfg, body, state);
  }
  return null;
}

export function isOAuthPath(path: string): boolean {
  return path.startsWith("/.well-known/") || path === "/register" || path === "/authorize" ||
    path === "/oauth/token";
}
