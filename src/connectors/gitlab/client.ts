import type { JsonValue } from "../../harness/types.ts";

export interface GitLabClientOptions {
  token: string;
  origin: string;
  apiPath: string;
}

export class GitLabClient {
  private base: string;
  private token: string;

  constructor(opts: GitLabClientOptions) {
    this.base = `${opts.origin}${opts.apiPath}`;
    this.token = opts.token;
  }

  async post(path: string, body?: JsonValue): Promise<JsonValue> {
    return await this.req(path, "POST", body);
  }

  async put(path: string, body?: JsonValue): Promise<JsonValue> {
    return await this.req(path, "PUT", body);
  }

  async req(path: string, method: "GET" | "POST" | "PUT", body?: JsonValue): Promise<JsonValue> {
    const url = new URL(`${this.base}${path}`);
    const res = await fetch(url, {
      method,
      headers: { "PRIVATE-TOKEN": this.token, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`gitlab ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? (JSON.parse(text) as JsonValue) : {};
  }

  // request is the generic escape hatch used by gitlab.get / gitlab.mutate: the
  // path is resolved against the pinned origin+apiPath and must stay inside it.
  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Record<string, unknown>; body?: JsonValue } = {},
  ): Promise<JsonValue> {
    const url = new URL(`${this.base}${path}`);
    if (!url.pathname.startsWith(new URL(this.base).pathname)) {
      throw new Error(`path escapes the GitLab API root: ${path}`);
    }
    if (url.origin !== new URL(this.base).origin) {
      throw new Error(`path escapes the GitLab origin: ${path}`);
    }
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) { for (const item of v) url.searchParams.append(k, String(item)); }
      else url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: { "PRIVATE-TOKEN": this.token, "content-type": "application/json" },
      body: method === "GET" || opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`gitlab ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? (JSON.parse(text) as JsonValue) : {};
  }

  async get(path: string, query?: Record<string, string | number | boolean>): Promise<JsonValue> {
    const url = new URL(`${this.base}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": this.token } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`gitlab GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? (JSON.parse(text) as JsonValue) : {};
  }
}
