// Static-client OAuth 2.0 for /mcp.
//
// This is deliberately not an authorization server: there is exactly one
// pre-registered client, its secret IS the server bearer token from
// secrets.json, and the token endpoint hands that same value back as the access
// token. That makes spec-aware MCP clients (which discover the authorization
// server from /.well-known/oauth-protected-resource and then POST
// /oauth/token) work without changing how /mcp authenticates.
//
// Consequences, all intentional:
// - the access token equals the client secret, so leaking one leaks the other
//   (same exposure as pasting the bearer token into a client config);
// - there is no expiry enforcement and no refresh token; expires_in is advisory
//   and clients simply re-run client_credentials;
// - there is a single identity, so logs record the client id, not a subject.
import { constantTimeEqual } from "./http.ts";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public origin of this server, e.g. https://mcp.example.com (no trailing /). */
  publicUrl: string;
  ttlSec?: number;
}

const DEFAULT_TTL_SEC = 3600;

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
    token_endpoint: `${cfg.publicUrl}/oauth/token`,
    grant_types_supported: ["client_credentials"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: ["mcp"],
    response_types_supported: ["token"],
  };
}

// oauthError uses the RFC 6749 error shape ({"error": "..."}), not JSON-RPC:
// the token endpoint is an OAuth endpoint, not an MCP one.
export function oauthError(
  status: number,
  error: string,
  description: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

export interface TokenRequestInput {
  authorization: string | null;
  contentType: string | null;
  body: string;
}

interface ParsedCredentials {
  clientId: string;
  clientSecret: string;
  /** Form-decoded variants, when the client encoded them (RFC 6749 §2.3.1). */
  clientIdDecoded?: string;
  clientSecretDecoded?: string;
  grantType: string;
}

// parseCredentials accepts both client_secret_basic (RFC 6749 §2.3.1, where the
// values are form-urlencoded before base64) and client_secret_post.
export function parseCredentials(input: TokenRequestInput): ParsedCredentials | string {
  // RFC 6749 has the client send these form-encoded. Parse the body regardless of
  // the declared content type: a missing/wrong header is a common client quirk and
  // the body is capped before it reaches us.
  const form = new URLSearchParams();
  if (input.body) {
    for (const [k, v] of new URLSearchParams(input.body)) form.set(k, v);
  }
  let clientId = form.get("client_id") ?? "";
  let clientSecret = form.get("client_secret") ?? "";
  const grantType = form.get("grant_type") ?? "";
  const parsedDecoded: { clientIdDecoded?: string; clientSecretDecoded?: string } = {};

  const auth = input.authorization ?? "";
  if (auth.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(auth.slice("Basic ".length).trim());
    } catch {
      return "malformed Basic authorization header";
    }
    const sep = decoded.indexOf(":");
    if (sep < 0) return "malformed Basic credentials (expected client_id:client_secret)";
    clientId = decoded.slice(0, sep);
    clientSecret = decoded.slice(sep + 1);
    // RFC 6749 has clients form-encode these before base64, but plenty (curl -u
    // among them) send the raw values. Decode when possible and accept either
    // form; a literal '%' in a secret must not be a parse error.
    try {
      const idDecoded = decodeURIComponent(clientId);
      const secretDecoded = decodeURIComponent(clientSecret);
      if (idDecoded !== clientId) parsedDecoded.clientIdDecoded = idDecoded;
      if (secretDecoded !== clientSecret) parsedDecoded.clientSecretDecoded = secretDecoded;
    } catch { /* raw values, keep as-is */ }
  }
  return { clientId, clientSecret, ...parsedDecoded, grantType };
}

export function handleTokenRequest(req: Request, cfg: OAuthConfig, body: string): Response {
  if (req.method !== "POST") {
    return oauthError(400, "invalid_request", "token endpoint requires POST");
  }
  const parsed = parseCredentials({
    authorization: req.headers.get("authorization"),
    contentType: req.headers.get("content-type"),
    body,
  });
  if (typeof parsed === "string") {
    return oauthError(400, "invalid_request", parsed);
  }
  if (parsed.grantType === "") {
    return oauthError(400, "invalid_request", "grant_type is required");
  }
  if (parsed.grantType !== "client_credentials") {
    return oauthError(
      400,
      "unsupported_grant_type",
      "this server only supports grant_type=client_credentials",
    );
  }
  if (parsed.clientId === "" || parsed.clientSecret === "") {
    return oauthError(
      401,
      "invalid_client",
      "client credentials required (Basic auth or client_id/client_secret form fields)",
      { "www-authenticate": 'Basic realm="denops"' },
    );
  }
  // Client id is an identifier, the secret is compared in constant time.
  const idOk = parsed.clientId === cfg.clientId || parsed.clientIdDecoded === cfg.clientId;
  const secretOk = constantTimeEqual(parsed.clientSecret, cfg.clientSecret) ||
    (parsed.clientSecretDecoded !== undefined &&
      constantTimeEqual(parsed.clientSecretDecoded, cfg.clientSecret));
  if (!idOk || !secretOk) {
    return oauthError(401, "invalid_client", "unknown client or bad secret", {
      "www-authenticate": 'Basic realm="denops"',
    });
  }
  return new Response(
    JSON.stringify({
      access_token: cfg.clientSecret,
      token_type: "Bearer",
      expires_in: cfg.ttlSec ?? DEFAULT_TTL_SEC,
      scope: "mcp",
    }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}
