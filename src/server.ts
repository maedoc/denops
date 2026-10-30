import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ApprovalQueue } from "./harness/approvals.ts";
import { PendingStore } from "./harness/pendingStore.ts";
import { describe, search } from "./harness/discover.ts";
import { isManifest, isOpEntry, RunLog } from "./harness/log.ts";
import { Registry } from "./harness/registry.ts";
import type { Budgets, Connector, JsonValue } from "./harness/types.ts";
import { Harness } from "./harness/worker.ts";
import { type Config, loadConfig, loadSecrets } from "./config.ts";
import { debugConnector } from "./connectors/debug/manifest.ts";
import { gitlabConnector } from "./connectors/gitlab/manifest.ts";
import { mistralConnector } from "./connectors/mistral/manifest.ts";

const configPath = Deno.args[0] ?? "config.yaml";
const secretsPath = Deno.args[1] ?? "secrets.json";

export interface AppContext {
  config: Config;
  secrets: Record<string, unknown>;
  registry: Registry;
  harness: Harness;
  approvals: ApprovalQueue;
  pendingStore: PendingStore;
  dataDir: string;
  budgets: Budgets;
}

export async function buildApp(configPath: string, secretsPath: string): Promise<AppContext> {
  const config = await loadConfig(configPath);
  const secrets = await loadSecrets(secretsPath);
  try {
    const info = await Deno.stat(secretsPath);
    if (Deno.build.os !== "windows" && (info.mode ?? 0) & 0o077) {
      console.error(
        `[denops] warning: ${secretsPath} is group/other-accessible (mode ${
          info.mode?.toString(8)
        }); run: chmod 600 ${secretsPath}`,
      );
    }
  } catch { /* stat failure surfaces at read */ }
  if (
    config.server.token === undefined && typeof secrets.serverToken === "string" &&
    secrets.serverToken
  ) {
    config.server.token = secrets.serverToken;
  }
  const registry = new Registry();
  const startupLogs: string[] = [];
  const log = (entry: Record<string, unknown>) => startupLogs.push(JSON.stringify(entry));

  const enabled = (name: string) => config.connectors[name]?.enabled === true;

  if (enabled("debug")) registry.register(debugConnector);

  if (enabled("gitlab")) {
    const g = config.connectors.gitlab;
    const token = ((secrets.gitlab as Record<string, unknown> | undefined)?.token ?? "") as string;
    if (!token) throw new Error("gitlab enabled but secrets.gitlab.token missing");
    registry.register(
      gitlabConnector({
        token,
        origin: String(g.origin ?? "https://gitlab.ebrains.eu"),
        apiPath: String(g.apiPath ?? "/api/v4"),
      }),
    );
  }

  if (enabled("mistral")) {
    const m = config.connectors.mistral;
    const apiKey =
      ((secrets.mistral as Record<string, unknown> | undefined)?.apiKey ?? "") as string;
    if (!apiKey) throw new Error("mistral enabled but secrets.mistral.apiKey missing");
    registry.register(
      mistralConnector({
        apiKey,
        origin: String(m.origin ?? "https://api.mistral.ai"),
        apiPath: String(m.apiPath ?? "/v1"),
      }),
    );
  }

  if (enabled("imap")) {
    const im = config.connectors.imap;
    const mailSecrets = (secrets.mail ?? {}) as Record<string, unknown>;
    const accounts = ((im.accounts ?? []) as Array<Record<string, unknown>>).map((a) => ({
      id: String(a.id),
      host: String(a.host),
      port: Number(a.port ?? 993),
      tls: a.tls !== false,
      user: String(a.user ?? ""),
      password: String(
        ((mailSecrets[String(a.id)] ?? {}) as Record<string, unknown>).password ?? "",
      ),
      draftsMailbox: String(a.draftsMailbox ?? "Drafts"),
    }));
    if (accounts.length === 0) throw new Error("imap enabled but no accounts configured");
    for (const a of accounts) {
      if (!a.password) {
        throw new Error(`imap account ${a.id}: missing secrets.mail.${a.id}.password`);
      }
    }
    const { imapConnector } = await import("./connectors/imap/manifest.ts");
    registry.register(imapConnector({ accounts }));
  }

  if (config.startup.validate === "full") {
    for (const c of registry.list()) {
      if (c.validateStartup) {
        await c.validateStartup({
          config: config.connectors[c.id] as unknown as Record<string, unknown>,
          secrets,
          log,
        });
      }
    }
  }
  for (const l of startupLogs) console.error(`[startup] ${l}`);

  const clients = new Map<string, Record<string, (args: JsonValue) => Promise<JsonValue>>>();
  const hostCtx = { config: config.connectors as unknown as Record<string, unknown>, secrets, log };
  for (const c of registry.list()) {
    clients.set(c.id, c.client(hostCtx));
  }

  const resolveOp = (op: string) => {
    const r = registry.resolve(op);
    if (!r) return undefined;
    const prefix = `${r.connector.id}.`;
    const short = op.startsWith(prefix) ? op.slice(prefix.length) : op;
    const method = clients.get(r.connector.id)?.[short];
    if (!method) return undefined;
    return { spec: r.spec, connector: r.connector, method };
  };

  const harness = new Harness(
    resolveOp,
    config.budgets,
    (q, c) => search(registry, q, c),
    (op) => describe(registry, op),
    (op, args, runState) => {
      if (op === "mistral.libraries.delete" || op === "mistral.documents.delete") {
        const id = (args as { id?: string; libraryId?: string }).id ??
          (args as { libraryId?: string }).libraryId;
        if (id && runState.createdLibraryIds.has(id)) return "open";
      }
      return null;
    },
  );
  harness.setConnectorIds(registry.list().map((c: Connector) => c.id));

  return {
    config,
    secrets,
    registry,
    harness,
    approvals: new ApprovalQueue(),
    pendingStore: new PendingStore(config.dataDir),
    dataDir: config.dataDir,
    budgets: config.budgets,
  };
}

export function registerTools(app: AppContext, server: McpServer): void {
  server.registerTool(
    "search",
    {
      description:
        "Search available connector ops (e.g. 'gitlab issues', 'mistral library'). Returns op names with tier badges ([approval] = needs human approval) and one-line docs.",
      inputSchema: { query: z.string(), connector: z.string().optional() },
    },
    ({ query, connector }: { query: string; connector?: string }) => ({
      content: [{ type: "text", text: search(app.registry, query, connector) }],
    }),
  );

  server.registerTool(
    "execute",
    {
      description:
        "Run one JavaScript async function body in a fresh sandboxed worker (no network/fs/env; connector handles like gitlab.*, mistral.*, mail.* call authenticated host-side clients). Return a JSON-serializable value. Approval-tier ops suspend the run and return { status: 'awaiting_approval', pendingId, op, args }; resume with the approve tool.",
      inputSchema: { code: z.string(), description: z.string().optional() },
    },
    async ({ code }: { code: string; description?: string }) => {
      const runId = crypto.randomUUID();
      const log = new RunLog(app.dataDir, runId, app.budgets.maxLogBytes);
      await log.init({ runId, code, connectors: app.registry.list().map((c) => c.id) });
      const outcome = await app.harness.run(runId, code, log);
      if (outcome.status === "awaiting_approval" && outcome.pending) {
        app.approvals.add(outcome.pending);
        await app.pendingStore.add(outcome.pending);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "awaiting_approval",
              pendingId: outcome.pending.pendingId,
              runId,
              op: outcome.pending.op,
              args: outcome.pending.args,
              note:
                "Call approve(pendingId, 'approve'|'reject'). On approve the run is replayed deterministically and the approved op executes live.",
            }),
          }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: outcome.status,
            runId,
            result: outcome.result ?? null,
            error: outcome.error ?? null,
          }),
        }],
      };
    },
  );

  server.registerTool(
    "approve",
    {
      description:
        "Resolve a pending approval. 'approve': replay the run from its log and execute the approved op live, then continue. 'reject': terminate the run (already-executed ops are NOT auto-undone; the log records the rejection).",
      inputSchema: { pendingId: z.string(), decision: z.enum(["approve", "reject"]) },
    },
    async ({ pendingId, decision }: { pendingId: string; decision: "approve" | "reject" }) => {
      let pending = app.approvals.decide(pendingId, decision);
      if (!pending) {
        const stored = await app.pendingStore.get(pendingId);
        if (stored) {
          pending = {
            pendingId: stored.pendingId,
            runId: stored.runId,
            op: stored.op,
            args: stored.args,
          };
          app.approvals.add(pending);
          app.approvals.decide(pendingId, decision);
        }
      }
      if (!pending) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "unknown_pendingId", pendingId }),
          }],
        };
      }
      await app.pendingStore.remove(pendingId);
      if (decision === "reject") {
        const log = new RunLog(app.dataDir, pending.runId, app.budgets.maxLogBytes);
        await log.recordOp({ op: pending.op, status: "rejected" });
        await log.recordFinal({ status: "rejected" });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "rejected", pendingId, runId: pending.runId }),
          }],
        };
      }
      const lines = await RunLog.read(app.dataDir, pending.runId);
      const manifest = lines.find(isManifest);
      if (!manifest?.code) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "cannot_replay", reason: "run code not found in log" }),
          }],
        };
      }
      const replay = {
        resultsByOpSeq: new Map<string, JsonValue>(),
        approvedOps: new Set([pending.op]),
      };
      for (const l of lines) {
        if (isOpEntry(l) && l.status === "ok" && l.result !== undefined) {
          replay.resultsByOpSeq.set(l.op, l.result);
        }
      }
      const log = new RunLog(app.dataDir, pending.runId, app.budgets.maxLogBytes);
      const outcome = await app.harness.run(pending.runId, manifest.code, log, replay);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: outcome.status,
            runId: pending.runId,
            result: outcome.result ?? null,
            error: outcome.error ?? null,
            resumedFrom: pendingId,
          }),
        }],
      };
    },
  );
}

export function createMcpServer(app: AppContext): McpServer {
  const server = new McpServer({ name: "denops", version: "0.1.0" });
  registerTools(app, server);
  return server;
}

async function main(): Promise<void> {
  const app = await buildApp(configPath, secretsPath);
  const { host, port } = app.config.server;
  console.error(
    `[denops] listening on http://${host}:${port}/mcp (connectors: ${
      app.registry.list().map((c) => c.id).join(", ")
    })`,
  );
  const handler = Deno.serve({ hostname: host, port, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (app.config.server.token) {
      const auth = req.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${app.config.server.token}`) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "unauthorized" },
            id: null,
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      }
    }
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createMcpServer(app);
    await server.connect(transport);
    return await transport.handleRequest(req);
  });
  void handler;
}

if (import.meta.main) {
  await main();
}
