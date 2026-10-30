import type { Budgets } from "./harness/types.ts";

export interface ServerConfig {
  host: string;
  port: number;
  token?: string;
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

function parseYaml(text: string): unknown {
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
      const item: Record<string, unknown> = {};
      (top.obj as unknown[]).push(item);
      const m = line.slice(2).match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (m) item[m[1]] = m[2] === "" ? {} : scalar(m[2]);
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
