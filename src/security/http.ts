// HTTP edge hardening for the /mcp endpoint: constant-time bearer auth,
// ban gate (fail2ban-style), request body cap, security headers, and
// per-connection read/idle timeouts. Ported from ins-mcp's
// internal/server/server.go (withBearerTokenAndBans) and main.go
// (http.ListenAndServe -> server with timeouts).
import { type BanPolicy, BanStore, defaultBanPolicy, subnetOf } from "./ban.ts";
import { isOAuthPath } from "./oauth.ts";

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export interface GateOptions {
  token: string;
  bans: BanStore;
  /** Value for the 401 challenge's resource_metadata parameter (RFC 9728). */
  resourceMetadata?: string;
}

function jsonError(status: number, message: string, extra?: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...extra,
      },
    },
  );
}

export function addSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  if (!headers.has("strict-transport-security")) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export function gateRequest(
  req: Request,
  remoteAddr: string,
  opts: GateOptions,
): Promise<Response | null> {
  const ip = opts.bans.effectiveClientIp(req, remoteAddr);
  const verdict = opts.bans.banned(req, remoteAddr);
  const run = async (): Promise<Response | null> => {
    const v = await verdict;
    if (v.banned) {
      return jsonError(429, "banned", { "retry-after": String(v.retryAfterSec) });
    }
    const auth = req.headers.get("authorization") ?? "";
    const prefix = "Bearer ";
    if (
      opts.token === "" || !auth.startsWith(prefix) ||
      !constantTimeEqual(auth.slice(prefix.length), opts.token)
    ) {
      if (ip) {
        const becameBanned = await opts.bans.recordFailure(ip);
        console.error(
          `[denops] auth failure from ${ip} (${subnetLabel(ip)})${
            becameBanned ? " -> BANNED" : ""
          }`,
        );
      }
      // Point spec-aware MCP clients at the protected-resource metadata so they
      // can start the OAuth flow instead of just failing.
      const challenge = opts.resourceMetadata
        ? `Bearer realm="denops", resource_metadata="${opts.resourceMetadata}"`
        : 'Bearer realm="denops"';
      return jsonError(401, "missing or invalid bearer token", {
        "www-authenticate": challenge,
      });
    }
    if (ip) void opts.bans.recordSuccess(ip);
    return null;
  };
  return run();
}

function subnetLabel(ip: string): string {
  return subnetOf(ip);
}

export interface HandlerOptions {
  token: string;
  bans?: BanStore;
  policy?: BanPolicy;
  banFile?: string;
  blacklistFile?: string;
  whitelistFile?: string;
  trustedProxy?: string;
  skipLoopbackBan?: boolean;
  maxBodyBytes?: number;
  mcpHandler: (req: Request) => Promise<Response>;
  healthHandler?: (req: Request) => Response;
  /**
   * OAuth surface: /.well-known/*, /register, /authorize, /oauth/token.
   * Receives the (already size-checked) body, returns null to fall through to 404.
   */
  oauthHandler?: (req: Request, url: URL, body: string) => Promise<Response | null>;
  resourceMetadata?: (req: Request) => string | undefined;
}

export function createHandler(
  opts: HandlerOptions,
): (req: Request, info: Deno.ServeHandlerInfo) => Promise<Response> {
  const bans = opts.bans ?? new BanStore({
    policy: opts.policy ?? defaultBanPolicy(),
    banFile: opts.banFile,
    blacklistFile: opts.blacklistFile,
    whitelistFile: opts.whitelistFile,
    trustedProxy: opts.trustedProxy,
    skipLoopback: opts.skipLoopbackBan ?? true,
  });
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req, info) => {
    const url = new URL(req.url);
    let res: Response;
    if (url.pathname === "/health") {
      res = opts.healthHandler ? opts.healthHandler(req) : Response.json({ ok: true });
      return addSecurityHeaders(res);
    }
    const addr = info.remoteAddr as { transport?: string; hostname?: string };
    const remoteAddr = addr.transport === "tcp" || addr.hostname !== undefined
      ? (addr.hostname ?? "")
      : "";
    if (isOAuthPath(url.pathname)) {
      if (!opts.oauthHandler) {
        return addSecurityHeaders(new Response("not found", { status: 404 }));
      }
      const verdict = await bans.banned(req, remoteAddr);
      if (verdict.banned) {
        return addSecurityHeaders(
          new Response(
            JSON.stringify({
              error: "temporarily_unavailable",
              error_description: "too many failed attempts from this network; retry later",
            }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "cache-control": "no-store",
                "retry-after": String(verdict.retryAfterSec),
              },
            },
          ),
        );
      }
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > maxBody) return jsonError(413, "request body too large");
      const body = req.method === "POST" ? await req.text() : "";
      if (body.length > maxBody) return jsonError(413, "request body too large");
      const res = await opts.oauthHandler(req, url, body);
      if (!res) return addSecurityHeaders(new Response("not found", { status: 404 }));
      const ip = bans.effectiveClientIp(req, remoteAddr);
      // Only 401 counts toward a ban (bad secret, bad consent token); an
      // unsupported_grant_type or bad redirect_uri is a client bug, not a guess.
      if (res.status === 401 && ip) {
        const becameBanned = await bans.recordFailure(ip);
        console.error(
          `[denops] oauth token failure from ${ip} (${subnetLabel(ip)})${
            becameBanned ? " -> BANNED" : ""
          }`,
        );
      } else if (res.status === 200 && url.pathname === "/oauth/token" && ip) {
        void bans.recordSuccess(ip);
      }
      return addSecurityHeaders(res);
    }
    if (url.pathname !== "/mcp") {
      return addSecurityHeaders(new Response("not found", { status: 404 }));
    }
    const denied = await gateRequest(req, remoteAddr, {
      token: opts.token,
      bans,
      resourceMetadata: opts.resourceMetadata?.(req),
    });
    if (denied) return denied;
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > maxBody) {
        return jsonError(413, "request body too large");
      }
      const wrapped = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: new LimitedStream(req.body, maxBody),
        // @ts-expect-error duplex is required for streaming request bodies
        duplex: "half",
      });
      res = await opts.mcpHandler(wrapped);
    } else {
      res = await opts.mcpHandler(req);
    }
    return addSecurityHeaders(res);
  };
}

class LimitedStream extends ReadableStream<Uint8Array> {
  private received = 0;
  private failed = false;
  constructor(source: ReadableStream<Uint8Array> | null, private limit: number) {
    const reader = source?.getReader();
    super({
      pull: async (controller) => {
        if (!reader) return;
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        this.received += value.byteLength;
        if (this.received > this.limit && !this.failed) {
          this.failed = true;
          controller.error(new Error("request body too large"));
          return;
        }
        controller.enqueue(value);
      },
      cancel: () => reader?.cancel(),
    });
  }
}

export interface ServeOptions {
  hostname: string;
  port: number;
  handler: (req: Request, info: Deno.ServeHandlerInfo) => Promise<Response>;
}

export function serveWithTimeouts(opts: ServeOptions): Deno.HttpServer {
  return Deno.serve({
    hostname: opts.hostname,
    port: opts.port,
    handler: opts.handler,
    onListen: () => {},
  });
}
