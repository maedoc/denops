import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { ApprovalQueue } from "./harness/approvals.ts";
import { PendingStore } from "./harness/pendingStore.ts";
import { describe, search } from "./harness/discover.ts";
import { isManifest, isOpEntry, RunLog } from "./harness/log.ts";
import { Registry } from "./harness/registry.ts";
import type { Budgets, Connector, JsonValue } from "./harness/types.ts";
import { Harness, summarizeOp } from "./harness/worker.ts";
import { type Config, loadConfig, loadSecrets } from "./config.ts";
import { createHandler, DEFAULT_MAX_BODY_BYTES, serveWithTimeouts } from "./security/http.ts";
import { agentGuide } from "./guide.ts";
import { handleOAuthRoute, newOAuthState, type OAuthConfig } from "./security/oauth.ts";
import { defaultBanPolicy } from "./security/ban.ts";
import { RootGrants } from "./harness/grants.ts";
import { fsConnector, fsGrantKey } from "./connectors/fs/manifest.ts";
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
  grants: RootGrants;
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
  if (config.server.token === undefined && config.server.tokenFile) {
    const text = await Deno.readTextFile(config.server.tokenFile);
    const token = text.trim();
    if (!token) {
      throw new Error(`server.tokenFile ${config.server.tokenFile} is empty`);
    }
    config.server.token = token;
  }
  if (!config.server.token) {
    const host = config.server.host;
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (config.server.requireToken === true) {
      throw new Error(
        "server.requireToken=true but no token configured; set server.token, secrets.serverToken, or server.tokenFile",
      );
    }
    if (!loopback) {
      throw new Error(
        `refusing to serve on non-loopback ${host} without a bearer token. ` +
          "Set server.token (or secrets.serverToken / server.tokenFile), or explicitly set server.requireToken=false (not recommended).",
      );
    }
    console.error(
      "[denops] warning: no server.token configured; /mcp is unauthenticated but bound to loopback only. " +
        "Set a token before exposing this server.",
    );
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

  if (enabled("fs")) {
    const f = config.connectors.fs;
    const roots = ((f.roots ?? []) as Array<Record<string, unknown>>).map((r) => ({
      name: String(r.name),
      path: String(r.path),
      write: r.write === true,
      exec: r.exec === true,
    }));
    registry.register(
      fsConnector({
        roots,
        maxFileSize: Number(f.maxFileSize ?? config.budgets.maxOpResultBytes),
        maxOutput: Number(f.maxOutput ?? config.budgets.maxOpResultBytes),
        execTimeoutSec: Number(f.execTimeoutSec ?? 120),
        maxConcurrentExec: Number(f.maxConcurrentExec ?? 2),
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
      allowSelfSigned: a.allowSelfSigned === true,
      user: String(a.user ?? ""),
      password: String(
        ((mailSecrets[String(a.id)] ?? {}) as Record<string, unknown>).password ?? "",
      ),
      draftsMailbox: String(a.draftsMailbox ?? "Drafts"),
      ...(a.socketTimeoutMs === undefined ? {} : { socketTimeoutMs: Number(a.socketTimeoutMs) }),
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
  const hostCtx = {
    config: config.connectors as unknown as Record<string, unknown>,
    secrets,
    log: (entry: Record<string, unknown>) => console.error("[connector]", JSON.stringify(entry)),
  };
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

  const grants = new RootGrants({ dataDir: config.dataDir, isGrantOp: fsGrantKey });
  await grants.init();
  harness.setGrantLookup(fsGrantKey, (key) => grants.isGranted(key));

  return {
    config,
    secrets,
    registry,
    harness,
    approvals: new ApprovalQueue(),
    pendingStore: new PendingStore(config.dataDir),
    grants,
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
      description: (() => {
        // Advertise the handle families this deployment actually has: naming
        // connectors that are not enabled sends the model chasing 404s.
        const families = app.registry.list().map((c) => `${c.id}.*`).join(", ");
        return `Run one JavaScript async function body in a fresh sandboxed worker (no network/fs/env; connector handles ${
          families || "none"
        } call authenticated host-side clients; api.search/api.describe list the ops). Return a JSON-serializable value. Approval-tier ops suspend the run and return { status: 'awaiting_approval', pendingId, op, summary, args } — summary says in plain words what will be executed; resume with the approve tool, which re-suspends on any further approval op.`;
      })(),
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
              seq: outcome.pending.seq,
              summary: outcome.pending.summary,
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
            summary: stored.summary ?? summarizeOp(stored.op, stored.args),
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
      if (decision === "approve") {
        const grantKey = fsGrantKey(pending.op, pending.args);
        if (grantKey) {
          await app.grants.grant(grantKey);
          await new RunLog(app.dataDir, pending.runId, app.budgets.maxLogBytes).recordOp({
            op: pending.op,
            status: "approved",
            call: pending.seq,
          });
          console.error(`[denops] granted root ${grantKey} (approved ${pending.op})`);
        }
      }
      if (decision === "reject") {
        const log = new RunLog(app.dataDir, pending.runId, app.budgets.maxLogBytes);
        await log.recordOp({ op: pending.op, status: "rejected", call: pending.seq });
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
      // Replay is keyed by call sequence (log seq), so each op call is distinct:
      // three issues.create calls are three entries, not one shared result.
      const replay = {
        resultsBySeq: new Map<number, { op: string; result: JsonValue }>(),
        // Every call approved so far in this run (marker entries carry the call
        // index), plus the one being approved now.
        approvedSeqs: new Set<number>(
          lines
            .filter((l) => isOpEntry(l) && l.status === "approved" && l.call !== undefined)
            .map((l) => (l as { call: number }).call),
        ),
      };
      if (pending.seq !== undefined) replay.approvedSeqs.add(pending.seq);
      for (const l of lines) {
        if (!isOpEntry(l) || l.status !== "ok" || l.call === undefined) continue;
        const result = l.result ??
          (l.resultSummary?.storedAt
            ? await RunLog.readOpResult(app.dataDir, pending.runId, l.seq)
            : undefined);
        if (result === undefined) continue;
        replay.resultsBySeq.set(l.call, { op: l.op, result });
      }
      const log = new RunLog(app.dataDir, pending.runId, app.budgets.maxLogBytes);
      const outcome = await app.harness.run(pending.runId, manifest.code, log, replay);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: outcome.status,
            runId: pending.runId,
            approvedOp: pending.op,
            approvedSummary: pending.summary,
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
  // `instructions` is delivered in the initialize result: one agent-oriented
  // usage guide per session, instead of the model discovering the contract by
  // failing calls.
  const server = new McpServer({ name: "denops", version: "0.1.0" }, {
    instructions: agentGuide({
      connectors: app.registry.list().map((c) => ({
        id: c.id,
        ops: c.ops.filter((o) => o.tier !== "absent").length,
      })),
      totalOps: app.registry
        .list()
        .reduce((n, c) => n + c.ops.filter((o) => o.tier !== "absent").length, 0),
      budgets: {
        wallClockMs: app.budgets.wallClockMs,
        maxOpsPerRun: app.budgets.maxOpsPerRun,
        maxOpResultBytes: app.budgets.maxOpResultBytes,
      },
    }),
  });
  registerTools(app, server);
  // `grants` only means anything when a grant-keyed connector (fs) is enabled;
  // advertising it otherwise invites calls that can only return "[]".
  const hasGrantKeyedConnector = app.registry.list().some((c) => c.id === "fs");
  if (hasGrantKeyedConnector) {
    server.registerTool(
      "grants",
      {
        description:
          "List or revoke root grants. Approving an fs.* op on a root grants it; later fs.* ops on that root run without further approval. args: { action: 'list' | 'revoke', key? } (key like 'fs:myrepo', required for revoke)",
        inputSchema: {
          action: z.enum(["list", "revoke"]),
          key: z.string().optional(),
        },
      },
      async ({ action, key }: { action: "list" | "revoke"; key?: string }) => {
        if (action === "list") {
          return {
            content: [{ type: "text", text: JSON.stringify({ grants: app.grants.list() }) }],
          };
        }
        if (!key) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "key required for revoke" }) }],
          };
        }
        const revoked = await app.grants.revoke(key);
        console.error(`[denops] ${revoked ? "revoked" : "no such"} root grant ${key}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ revoked, key, grants: app.grants.list() }),
          }],
        };
      },
    );
  }
  return server;
}

export function createHttpHandler(
  app: AppContext,
): (req: Request, info: Deno.ServeHandlerInfo) => Promise<Response> {
  const s = app.config.server;
  // Static-client OAuth: the pre-registered client's secret IS the server bearer
  // token, and /oauth/token hands it back as the access token. /mcp keeps
  // validating exactly the same value.
  const oauth = ((): OAuthConfig | null => {
    if (!s.oauth?.enabled) return null;
    if (!s.token) {
      throw new Error(
        "server.oauth requires a bearer token (server.token / tokenFile / secrets.json serverToken) to use as the client secret",
      );
    }
    return {
      clientId: s.oauth.clientId ?? "mistral",
      clientSecret: s.token,
      publicUrl: s.oauth.publicUrl ?? "",
      ttlSec: s.oauth.ttlSec,
      redirectHosts: s.oauth.redirectHosts,
    };
  })();
  // Metadata needs absolute URLs: prefer the configured public URL, else the
  // Host the request arrived with (Caddy passes it through).
  const publicUrlFor = (req: Request): string =>
    oauth?.publicUrl || `https://${req.headers.get("host") ?? new URL(req.url).host}`;
  const oauthFor = (req: Request): OAuthConfig => ({ ...oauth!, publicUrl: publicUrlFor(req) });
  // Registered clients and one-time authorization codes live in memory: a
  // restart just means clients re-register (DCR) or re-run client_credentials.
  const oauthState = newOAuthState();
  console.error(
    oauth
      ? `[denops] oauth: client_credentials enabled (client_id=${oauth.clientId}, secret=bearer token)`
      : "[denops] oauth: disabled",
  );
  return createHandler({
    token: s.token ?? "",
    policy: {
      ...defaultBanPolicy(),
      maxFailures: s.ban?.maxFailures ?? defaultBanPolicy().maxFailures,
      windowMs: s.ban?.windowMs ?? defaultBanPolicy().windowMs,
      durationMs: s.ban?.durationMs ?? defaultBanPolicy().durationMs,
    },
    banFile: s.ban?.file,
    blacklistFile: s.ban?.blacklistFile,
    whitelistFile: s.ban?.whitelistFile,
    trustedProxy: s.trustedProxy,
    skipLoopbackBan: s.skipLoopbackBan ?? true,
    maxBodyBytes: s.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    healthHandler: () => Response.json({ ok: true }),
    ...(oauth
      ? {
        oauthHandler: (req: Request, url: URL, body: string) =>
          handleOAuthRoute(req, url, body, oauthFor(req), oauthState),
        resourceMetadata: (req: Request) =>
          `${publicUrlFor(req)}/.well-known/oauth-protected-resource`,
      }
      : {}),
    mcpHandler: async (req) => {
      const transport = new WebStandardStreamableHTTPServerTransport();
      const server = createMcpServer(app);
      await server.connect(transport);
      return await transport.handleRequest(req);
    },
  });
}

async function main(): Promise<void> {
  const app = await buildApp(configPath, secretsPath);
  const { host, port } = app.config.server;
  const banDesc = app.config.server.ban
    ? `ban file=${app.config.server.ban.file ?? "(memory)"} blacklist=${
      app.config.server.ban.blacklistFile ?? "-"
    } whitelist=${app.config.server.ban.whitelistFile ?? "-"} trustedProxy=${
      app.config.server.trustedProxy ?? "-"
    }`
    : "brute-force banning enabled (in-memory)";
  console.error(
    `[denops] listening on http://${host}:${port}/mcp (connectors: ${
      app.registry.list().map((c) => c.id).join(", ")
    }; auth: required; ${banDesc})`,
  );
  const server = serveWithTimeouts({ hostname: host, port, handler: createHttpHandler(app) });
  await server.finished;
}

// A worker whose module fails to load reports through an unhandled rejection in
// this isolate, which would otherwise be fatal — the run itself is already
// failed by the harness (its 'error' listener), so log it and carry on. Anything
// else stays fatal so real bugs are not hidden.
globalThis.addEventListener("unhandledrejection", (e) => {
  const reason = String((e as PromiseRejectionEvent).reason);
  if (reason.includes("Unhandled error in child worker")) {
    console.error(`[denops] worker failed: ${reason.slice(0, 200)}`);
    e.preventDefault();
  }
});

if (import.meta.main) {
  await main();
}
