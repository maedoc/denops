import type { Budgets } from "./harness/types.ts";

export interface ServerConfig {
  host: string;
  port: number;
  token?: string;
  requireToken?: boolean;
  tokenFile?: string;
  maxBodyBytes?: number;
  trustedProxy?: string;
  skipLoopbackBan?: boolean;
  oauth?: {
    enabled?: boolean;
    clientId?: string;
    publicUrl?: string;
    ttlSec?: number;
    /** Redirect hosts accepted for the pre-registered client id. */
    redirectHosts?: string[];
  };
  ban?: {
    file?: string;
    blacklistFile?: string;
    whitelistFile?: string;
    maxFailures?: number;
    windowMs?: number;
    durationMs?: number;
  };
}

export interface MistralStartupCheck {
  enabled: boolean;
  name: string;
  expectServerUrl?: string;
  strict: boolean;
}

export interface Config {
  server: ServerConfig;
  budgets: Budgets;
  connectors: Record<string, Record<string, unknown> & { enabled: boolean }>;
  startup: { validate: "full" | "none" };
  dataDir: string;
  mistralStartupCheck?: MistralStartupCheck;
}

export async function loadConfig(path: string): Promise<Config> {
  const text = await Deno.readTextFile(path);
  const parsed = parseYaml(text) as Record<string, unknown>;
  return normalize(parsed);
}

export function normalize(parsed: Record<string, unknown>): Config {
  const server = (parsed.server ?? {}) as Record<string, unknown>;
  const positive = (v: unknown, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${name} must be a positive number, got ${JSON.stringify(v)}`);
    }
    return n;
  };
  const budgets = (parsed.budgets ?? {}) as Record<string, unknown>;
  const connectors = (parsed.connectors ?? {}) as Record<
    string,
    Record<string, unknown> & { enabled: boolean }
  >;
  const startup = (parsed.startup ?? {}) as Record<string, unknown>;
  const mistral = connectors.mistral as
    | { enabled: boolean; origin?: string; apiPath?: string; startup?: Record<string, unknown> }
    | undefined;
  const check = mistral?.startup?.checkVibeConnector as Record<string, unknown> | undefined;
  return {
    server: {
      host: String(server.host ?? "127.0.0.1"),
      port: Number(server.port ?? 3100),
      token: server.token ? String(server.token) : undefined,
      requireToken: server.requireToken === undefined ? undefined : server.requireToken === true,
      tokenFile: server.tokenFile ? String(server.tokenFile) : undefined,
      maxBodyBytes: positive(server.maxBodyBytes, "server.maxBodyBytes"),
      trustedProxy: server.trustedProxy ? String(server.trustedProxy) : undefined,
      skipLoopbackBan: server.skipLoopbackBan === false ? false : true,
      oauth: (() => {
        const o = (server.oauth ?? {}) as Record<string, unknown>;
        if (Object.keys(o).length === 0 || o.enabled === false) return undefined;
        return {
          enabled: true,
          clientId: o.clientId ? String(o.clientId) : "mistral",
          publicUrl: o.publicUrl ? String(o.publicUrl).replace(/\/+$/, "") : undefined,
          ttlSec: positive(o.ttlSec, "server.oauth.ttlSec"),
          redirectHosts: Array.isArray(o.redirectHosts)
            ? (o.redirectHosts as unknown[]).map((h) => String(h))
            : undefined,
        };
      })(),
      ban: (() => {
        const b = (server.ban ?? {}) as Record<string, unknown>;
        return {
          file: b.file ? String(b.file) : undefined,
          blacklistFile: b.blacklistFile ? String(b.blacklistFile) : undefined,
          whitelistFile: b.whitelistFile ? String(b.whitelistFile) : undefined,
          maxFailures: positive(b.maxFailures, "server.ban.maxFailures"),
          windowMs: positive(b.windowMs, "server.ban.windowMs"),
          durationMs: positive(b.durationMs, "server.ban.durationMs"),
        };
      })(),
    },
    budgets: {
      wallClockMs: Number(budgets.wallClockMs ?? 120_000),
      maxOpsPerRun: Number(budgets.maxOpsPerRun ?? 200),
      maxOpResultBytes: Number(budgets.maxOpResultBytes ?? 1_048_576),
      maxOpArgsBytes: Number(budgets.maxOpArgsBytes ?? 26_214_400),
      maxLogBytes: Number(budgets.maxLogBytes ?? 10_485_760),
    },
    connectors,
    startup: { validate: startup.validate === "none" ? "none" : "full" },
    dataDir: String(parsed.dataDir ?? "data"),
    mistralStartupCheck: check
      ? {
        enabled: check.enabled === true,
        name: String(check.name ?? ""),
        expectServerUrl: check.expectServerUrl ? String(check.expectServerUrl) : undefined,
        strict: check.strict === true,
      }
      : undefined,
  };
}

export async function loadSecrets(path: string): Promise<Record<string, unknown>> {
  const text = await Deno.readTextFile(path);
  return JSON.parse(text) as Record<string, unknown>;
}

// The one YAML reader in the tree: config loading and permission derivation (which
// must agree about `enabled: true` vs "true") both come through here.
export function parseYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: {
    indent: number;
    obj: Record<string, unknown> | unknown[];
    parent?: Record<string, unknown>;
    key?: string;
  }[] = [{ indent: -1, obj: root }];
  const scalar = (rest: string): unknown => {
    if (rest === "[]") return [];
    if (rest === "true" || rest === "false") return rest === "true";
    if (/^-?\d+(\.\d+)?$/.test(rest)) return Number(rest);
    return rest.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  };
  const lines = text.split("\n");
  for (const raw of lines) {
    const noComment = raw.replace(/\s+#.*$/, "");
    if (!noComment.trim() || noComment.trim() === "---") continue;
    const indent = noComment.length - noComment.trimStart().length;
    const line = noComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];
    if (line.startsWith("- ")) {
      if (!Array.isArray(top.obj)) {
        if (top.parent === undefined || Object.keys(top.obj).length > 0) continue;
        const arr: unknown[] = [];
        top.parent[top.key as string] = arr;
        top.obj = arr;
      }
      const rest = line.slice(2);
      const m = rest.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (!m) {
        // scalar list item (e.g. an argv entry under tasks.check)
        (top.obj as unknown[]).push(scalar(rest));
        continue;
      }
      const item: Record<string, unknown> = {};
      (top.obj as unknown[]).push(item);
      item[m[1]] = m[2] === "" ? {} : scalar(m[2]);
      stack.push({ indent: indent + 1, obj: item });
      continue;
    }
    const parent = top.obj as Record<string, unknown>;
    const m = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = m[2];
    if (rest === "") {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child, parent, key });
    } else {
      parent[key] = scalar(rest);
    }
  }
  return root;
}
