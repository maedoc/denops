import { compose, optNum, rejectUnknown, str } from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
import { htmlToText } from "../../text.ts";

// `web` fetches an http(s) document into a run, so an agent can read a paper, a
// GitLab raw file or a docs page without a round trip through a human's tools.
//
// The guard that matters is SSRF: this server sits on a homelab LAN, and a plain
// fetch op would happily read http://192.168.1.1/ or the metadata service. Three
// layers, all fail-closed:
//   1. the host must be in `connectors.web.allowedHosts` (config, operator-owned) —
//      this is also what narrows --allow-net, so the runtime enforces it too;
//   2. the hostname is resolved and every address must be public (no loopback,
//      private, link-local, CGNAT, multicast…);
//   3. redirects are followed manually (max 3), re-validating each hop.
// Bodies are capped and must be text-ish; there is no cookie jar and no auth header.
export interface WebConnectorOptions {
  /** Allowed hosts: `example.org`, `*.example.org`, optionally `host:port`. */
  allowedHosts: string[];
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** DNS resolver, injectable so the guard is testable without a network. */
  resolve?: (host: string) => Promise<string[]>;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const TEXTUAL = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/ld+json",
];

/** Loopback, private, link-local, CGNAT, multicast, documentation, reserved. */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (addr.includes(":")) {
    // IPv6, including IPv4-mapped (::ffff:10.0.0.1) and zone ids (fe80::1%eth0)
    const bare = addr.split("%")[0];
    if (bare === "::" || bare === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(bare)) return true; // fe80::/10 link local
    if (/^ff[0-9a-f]{2}:/.test(bare)) return true; // multicast
    if (bare.startsWith("2001:db8:")) return true; // documentation
    return false;
  }
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // not an address: refuse rather than guess
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0/24, 192.0.2/24 (doc)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // doc
  if (a === 203 && b === 0) return true; // doc
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Split an allowlist entry into host and optional port (IPv6 in brackets). */
export function splitHostPort(entry: string): { host: string; port: string } {
  const wanted = entry.trim().toLowerCase();
  if (wanted.startsWith("[")) {
    const close = wanted.indexOf("]");
    const host = wanted.slice(1, close < 0 ? undefined : close);
    const rest = close < 0 ? "" : wanted.slice(close + 1);
    return { host, port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const idx = wanted.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(wanted.slice(idx + 1))) {
    return { host: wanted.slice(0, idx), port: wanted.slice(idx + 1) };
  }
  return { host: wanted, port: "" };
}

function hostMatches(pattern: string, host: string, port: string): boolean {
  const { host: patHost, port: patPort } = splitHostPort(pattern);
  if (patHost === "") return false;
  if (patPort && patPort !== port) return false;
  if (!patPort && port !== "80" && port !== "443") return false;
  if (patHost.startsWith("*.")) {
    const suffix = patHost.slice(1); // ".example.org"
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === patHost;
}

export interface UrlCheck {
  url: URL;
  addresses: string[];
}

/**
 * Validate a URL against the allowlist and the network guard. Throws with a message
 * naming the reason; never returns a URL that resolved into private space.
 */
export async function assertFetchable(
  raw: string,
  allowedHosts: string[],
  resolve: (host: string) => Promise<string[]>,
): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(String(raw).slice(0, 200))}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`refusing ${url.protocol} — only http and https`);
  }
  if (url.username || url.password) {
    throw new Error("refusing a URL with embedded credentials");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new Error("web.fetch is not configured: set connectors.web.allowedHosts");
  }
  if (!allowedHosts.some((p) => hostMatches(p, host, port))) {
    throw new Error(
      `host ${host}${port === "443" || port === "80" ? "" : `:${port}`} is not in ` +
        `connectors.web.allowedHosts (${allowedHosts.join(", ")})`,
    );
  }
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
  const addresses = literal ? [host] : await resolve(host);
  if (addresses.length === 0) {
    throw new Error(`cannot resolve ${host}`);
  }
  for (const ip of addresses) {
    if (isPrivateAddress(ip)) {
      throw new Error(
        `refusing ${host}: resolves to ${ip}, which is loopback/private/link-local (SSRF guard)`,
      );
    }
  }
  return { url, addresses };
}

async function resolveAll(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      const records = await Deno.resolveDns(host, type);
      out.push(...records.map((r) => String(r)));
    } catch {
      // a host with no AAAA record is normal
    }
  }
  return out;
}

async function readCapped(
  res: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (text.length + value.length > limit) {
      text += decoder.decode(value.slice(0, Math.max(0, limit - text.length)));
      truncated = true;
      try {
        await reader.cancel();
      } catch { /* already closed */ }
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, truncated };
}

export function webConnector(opts: WebConnectorOptions): Connector {
  const allowed = opts.allowedHosts ?? [];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const resolve = opts.resolve ?? resolveAll;
  const userAgent = opts.userAgent ?? "denops/0.2 (+https://wdmn.hd.free.fr)";

  const fetchOne = async (raw: string, format: "text" | "html", cap: number) => {
    let target = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { url } = await assertFetchable(target, allowed, resolve);
      const res = await fetch(url, {
        redirect: "manual",
        headers: {
          "user-agent": userAgent,
          "accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.1",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        try {
          await res.body?.cancel();
        } catch { /* ignore */ }
        if (!location) throw new Error(`redirect ${res.status} without a Location header`);
        target = new URL(location, url).toString();
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!TEXTUAL.some((t) => contentType.startsWith(t))) {
        try {
          await res.body?.cancel();
        } catch { /* ignore */ }
        throw new Error(
          `${
            contentType.split(";")[0] || "unknown content-type"
          } is not text — web.fetch only returns textual documents`,
        );
      }
      const { text, truncated } = await readCapped(res, cap);
      const isHtml = contentType.includes("html");
      return {
        url: url.toString(),
        status: res.status,
        contentType: contentType.split(";")[0],
        bytes: new TextEncoder().encode(text).length,
        truncated,
        format,
        text: format === "html" || !isHtml ? text : htmlToText(text),
      } as JsonValue;
    }
    throw new Error(`too many redirects (> ${MAX_REDIRECTS})`);
  };

  return {
    id: "web",
    ops: [
      {
        name: "web.fetch",
        tier: "open",
        doc:
          "Fetch an http(s) document and return its text. args: { url, format?: 'text'|'html', maxBytes? }. " +
          "Only hosts in connectors.web.allowedHosts are reachable, private/link-local addresses are refused (SSRF guard), " +
          "redirects are re-validated, and only textual content-types are returned. " +
          "format 'text' (default) converts HTML to readable text (best effort, no JS, no links list); 'html' returns the raw markup. " +
          "Returns { url, status, contentType, bytes, truncated, format, text }.",
        argSchema: compose(
          rejectUnknown(),
          str("url"),
          (a) => {
            const f = (a as { format?: unknown }).format;
            if (f === undefined) return null;
            return f === "text" || f === "html" ? null : "format: expected 'text' or 'html'";
          },
          optNum("maxBytes"),
          (a) => {
            const u = (a as { url?: unknown }).url;
            if (typeof u !== "string" || u.length <= 2048) return null;
            return "url: too long (max 2048)";
          },
        ),
      },
    ],
    client: (ctx: HostContext) => ({
      "fetch": async (a) => {
        const r = a as { url: string; format?: "text" | "html"; maxBytes?: number };
        const cap = Math.min(r.maxBytes ?? maxBytes, maxBytes);
        ctx.log({ connector: "web", op: "web.fetch", args: { url: r.url, format: r.format } });
        return await fetchOne(r.url, r.format ?? "text", cap);
      },
    }),
    validateStartup: () => {
      if (allowed.length === 0) throw new Error("connectors.web enabled but allowedHosts is empty");
      return Promise.resolve();
    },
  };
}

export function webOptionsFromConfig(raw: Record<string, unknown>): WebConnectorOptions {
  const allowed = Array.isArray(raw.allowedHosts)
    ? (raw.allowedHosts as unknown[]).map((h) => String(h)).filter((h) => h !== "")
    : [];
  return {
    allowedHosts: allowed,
    ...(raw.maxBytes === undefined ? {} : { maxBytes: Number(raw.maxBytes) }),
    ...(raw.timeoutMs === undefined ? {} : { timeoutMs: Number(raw.timeoutMs) }),
    ...(raw.userAgent === undefined ? {} : { userAgent: String(raw.userAgent) }),
  };
}
