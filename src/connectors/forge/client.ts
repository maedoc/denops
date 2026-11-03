import type { JsonValue } from "../../harness/types.ts";
import { type ForgeAccount, ForgeError, type ForgeFlavor, type QueryObject } from "./port.ts";

// One pinned HTTP client per account. Pinning is the point: the origin and the API
// root come from configuration, never from an op argument, so `forge.api.get` cannot
// be talked into fetching another host (the same rule the gitlab connector applies).

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const DEFAULT_MAX_LIMIT: Record<ForgeFlavor, number> = {
  // GitLab caps per_page at 100; Forgejo's max_response_items is instance config
  // (50 on git.ins-amu.fr) and the server clamps anyway; GitHub caps at 100.
  gitlab: 100,
  forgejo: 50,
  github: 100,
};

export function defaultMaxLimit(flavor: ForgeFlavor): number {
  return DEFAULT_MAX_LIMIT[flavor] ?? 50;
}

/** Auth headers per flavor. GitLab uses its own header; Forgejo needs the `token` prefix. */
export function authHeaders(acct: ForgeAccount): Record<string, string> {
  switch (acct.flavor) {
    case "gitlab":
      return { "PRIVATE-TOKEN": acct.token };
    case "forgejo":
      return { Authorization: `token ${acct.token}` };
    case "github":
      return {
        Authorization: `Bearer ${acct.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
  }
}

export class ForgeHttp {
  private readonly base: URL;

  constructor(private readonly acct: ForgeAccount) {
    this.base = new URL(`${acct.origin.replace(/\/+$/, "")}${acct.apiPath}`);
  }

  get flavor(): ForgeFlavor {
    return this.acct.flavor;
  }

  get accountId(): string {
    return this.acct.id;
  }

  /** Requested page size, clamped to what this flavor accepts. */
  clampLimit(requested: number | undefined): number {
    const max = Math.max(1, Math.min(this.acct.maxLimit || defaultMaxLimit(this.acct.flavor), 100));
    if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
      return Math.min(30, max);
    }
    return Math.min(Math.floor(requested), max);
  }

  async get(path: string, query?: QueryObject): Promise<JsonValue> {
    return await this.request("GET", path, { query });
  }

  async post(path: string, body?: JsonValue): Promise<JsonValue> {
    return await this.request("POST", path, { body });
  }

  async put(path: string, body?: JsonValue): Promise<JsonValue> {
    return await this.request("PUT", path, { body });
  }

  async patch(path: string, body?: JsonValue): Promise<JsonValue> {
    return await this.request("PATCH", path, { body });
  }

  async del(path: string): Promise<JsonValue> {
    return await this.request("DELETE", path);
  }

  async request(
    method: HttpMethod,
    path: string,
    opts: { query?: QueryObject; body?: JsonValue } = {},
  ): Promise<JsonValue> {
    const url = this.resolve(path, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...authHeaders(this.acct),
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) throw this.toError(method, path, res, text);
    return text.trim() === "" ? {} : (JSON.parse(text) as JsonValue);
  }

  /** Raw byte read (used for file content where base64 JSON would inflate it). */
  async raw(path: string, query?: QueryObject): Promise<{ text: string; bytes: number }> {
    const url = this.resolve(path, query);
    const res = await fetch(url, { headers: authHeaders(this.acct) });
    if (!res.ok) throw this.toError("GET", path, res, await res.text());
    const buf = new Uint8Array(await res.arrayBuffer());
    return { text: new TextDecoder().decode(buf), bytes: buf.byteLength };
  }

  private resolve(path: string, query?: QueryObject): URL {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error(`forge path must start with '/': ${String(path)}`);
    }
    if (
      path.includes("://") || path.includes("//") || path.includes("..") || /[\s\\?#]/.test(path)
    ) {
      throw new Error(`forge path must be relative to the API root: ${path}`);
    }
    const url = new URL(`${this.base.href.replace(/\/+$/, "")}${path}`);
    // Two independent checks: an absolute URL pasted into `path` would keep the
    // origin only if the host matched, and a `//` would re-root the path.
    if (url.origin !== this.base.origin) {
      throw new Error(`forge path escapes the account origin: ${path}`);
    }
    if (!url.pathname.startsWith(this.base.pathname)) {
      throw new Error(`forge path escapes the API root (${this.base.pathname}): ${path}`);
    }
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) { for (const item of v) url.searchParams.append(k, String(item)); }
        else url.searchParams.set(k, String(v));
      }
    }
    return url;
  }

  private toError(method: HttpMethod, path: string, res: Response, text: string): ForgeError {
    const message = extractMessage(text) ?? res.statusText ?? "request failed";
    const hint = hintFor(res.status, res.headers);
    return new ForgeError(
      this.acct.flavor,
      res.status,
      `${this.acct.id} (${this.acct.flavor}) ${method} ${path} -> ${res.status}: ${message}`,
      hint ? `${hint}${scopeHint(res.status)}` : scopeHint(res.status) || null,
    );
  }
}



function scopeHint(status: number): string {
  if (status === 401) return "the token was rejected (check secrets.forge.<account>.token)";
  if (status === 403) return "the token lacks a required scope for this call";
  return "";
}

function hintFor(status: number, headers: Headers): string {
  if (status === 404) return "not found, or not visible to this token";
  if (status === 405) return "the upstream does not support that (Forgejo: already merged)";
  if (status === 429) {
    const retry = headers.get("retry-after");
    return retry ? `rate limited; retry after ${retry}s` : "rate limited; retry later";
  }
  return "";
}

// Error bodies differ per flavor: GitLab {"message": "404 Project Not Found"},
// Forgejo {"message": "…", "url": "…", "errors": ["[SHA]: Required"]} where `message`
// can be empty or an internal function name, GitHub {"message": …, "documentation_url": …}.
// Prefer the most specific string available, and never surface the swagger URL.
export function extractMessage(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    const errors = body.errors;
    if (Array.isArray(errors)) {
      const first = errors.find((e) => typeof e === "string" && e.trim() !== "");
      if (typeof first === "string") return first;
    }
    for (const key of ["message", "error", "errors"]) {
      const v = body[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return trimmed.slice(0, 200);
  } catch {
    return trimmed.slice(0, 200);
  }
}
