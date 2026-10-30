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
