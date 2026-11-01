import { isManifest, isOpEntry, RunLog } from "../src/harness/log.ts";
import { PendingStore } from "../src/harness/pendingStore.ts";
import type { JsonValue } from "../src/harness/types.ts";

const dataDir = Deno.args[0] ?? "data";
const cmd = Deno.args[1] ?? "list";
const store = new PendingStore(dataDir);

async function resume(
  pendingId: string,
  configPath = "config.yaml",
  secretsPath = "secrets.json",
): Promise<void> {
  const pending = await store.get(pendingId);
  if (!pending) {
    console.error(`unknown pendingId: ${pendingId}`);
    Deno.exit(1);
  }
  const lines = await RunLog.read(dataDir, pending.runId);
  const manifest = lines.find(isManifest);
  if (!manifest?.code) {
    console.error(`run ${pending.runId}: code not found in log, cannot replay`);
    Deno.exit(1);
  }
  const { Harness } = await import("../src/harness/worker.ts");
  const { Registry } = await import("../src/harness/registry.ts");
  const { search, describe } = await import("../src/harness/discover.ts");
  const { loadConfig, loadSecrets } = await import("../src/config.ts");
  const { debugConnector } = await import("../src/connectors/debug/manifest.ts");
  const { gitlabConnector } = await import("../src/connectors/gitlab/manifest.ts");
  const { mistralConnector } = await import("../src/connectors/mistral/manifest.ts");
  const { imapConnector } = await import("../src/connectors/imap/manifest.ts");
  const { fsConnector, fsGrantKey } = await import("../src/connectors/fs/manifest.ts");
  const { RootGrants } = await import("../src/harness/grants.ts");

  const config = await loadConfig(configPath);
  const secrets = await loadSecrets(secretsPath);
  const registry = new Registry();
  const clients = new Map<string, Record<string, (args: JsonValue) => Promise<JsonValue>>>();
  const enabled = (n: string) => config.connectors[n]?.enabled === true;
  const hostCtx = {
    config: config.connectors as unknown as Record<string, unknown>,
    secrets,
    log: () => {},
  };
  const reg = (c: import("../src/harness/types.ts").Connector) => {
    registry.register(c);
    clients.set(c.id, c.client(hostCtx));
  };
  if (enabled("debug")) reg(debugConnector);
  if (enabled("gitlab")) {
    const g = config.connectors.gitlab;
    reg(gitlabConnector({
      token: String((secrets.gitlab as Record<string, unknown> | undefined)?.token ?? ""),
      origin: String(g.origin ?? "https://gitlab.ebrains.eu"),
      apiPath: String(g.apiPath ?? "/api/v4"),
    }));
  }
  if (enabled("mistral")) {
    const m = config.connectors.mistral;
    reg(mistralConnector({
      apiKey: String((secrets.mistral as Record<string, unknown> | undefined)?.apiKey ?? ""),
      origin: String(m.origin ?? "https://api.mistral.ai"),
      apiPath: String(m.apiPath ?? "/v1"),
    }));
  }
  if (enabled("imap")) {
    const accounts = ((config.connectors.imap.accounts ?? []) as Array<Record<string, unknown>>)
      .map((a) => ({
        id: String(a.id),
        host: String(a.host),
        port: Number(a.port ?? 993),
        tls: a.tls !== false,
        user: String(a.user ?? ""),
        password: String(
          ((secrets.mail as Record<string, unknown> | undefined)?.[String(a.id)] as
            | Record<string, unknown>
            | undefined)?.password ?? "",
        ),
        draftsMailbox: String(a.draftsMailbox ?? "Drafts"),
      }));
    reg(imapConnector({ accounts }));
  }

  const resolveOp = (op: string) => {
    const r = registry.resolve(op);
    if (!r) return undefined;
    const method = clients.get(r.connector.id)?.[op.slice(`${r.connector.id}.`.length)];
    return method ? { spec: r.spec, connector: r.connector, method } : undefined;
  };
  if (enabled("fs")) {
    const f = config.connectors.fs;
    reg(fsConnector({
      roots: ((f.roots ?? []) as Array<Record<string, unknown>>).map((r) => ({
        name: String(r.name),
        path: String(r.path),
        write: r.write === true,
        exec: r.exec === true,
      })),
      maxFileSize: Number(f.maxFileSize ?? config.budgets.maxOpResultBytes),
      maxOutput: Number(f.maxOutput ?? config.budgets.maxOpResultBytes),
      execTimeoutSec: Number(f.execTimeoutSec ?? 120),
      maxConcurrentExec: Number(f.maxConcurrentExec ?? 2),
    }));
  }

  const grants = new RootGrants({ dataDir, isGrantOp: fsGrantKey });
  await grants.init();
  const harness = new Harness(
    resolveOp,
    config.budgets,
    (q, c) => search(registry, q, c),
    (op) => describe(registry, op),
  );
  harness.setConnectorIds(registry.list().map((c) => c.id));
  harness.setGrantLookup(fsGrantKey, (key) => grants.isGranted(key));

  const replay = {
    resultsBySeq: new Map<number, { op: string; result: JsonValue }>(),
    approvedSeqs: new Set<number>([pending.seq ?? 0]),
  };
  for (const l of lines) {
    if (!isOpEntry(l) || l.status !== "ok" || l.call === undefined) continue;
    const result = l.result ??
      (l.resultSummary?.storedAt
        ? await RunLog.readOpResult(config.dataDir ?? "data", pending.runId, l.seq)
        : undefined);
    if (result === undefined) continue;
    replay.resultsBySeq.set(l.call, { op: l.op, result });
  }
  replay.approvedSeqs.delete(0);
  await store.remove(pendingId);
  const grantKey = fsGrantKey(pending.op, pending.args);
  if (grantKey) {
    await grants.grant(grantKey);
    console.error(`[denops] granted root ${grantKey} (approved ${pending.op})`);
  }
  const log = new RunLog(dataDir, pending.runId, config.budgets.maxLogBytes);
  await log.recordOp({ op: pending.op, status: "approved" });
  const outcome = await harness.run(pending.runId, manifest.code, log, {
    ...replay,
    grantKeys: grantKey ? new Set([grantKey]) : undefined,
  });
  console.log(
    JSON.stringify({
      status: outcome.status,
      runId: pending.runId,
      result: outcome.result ?? null,
      error: outcome.error ?? null,
    }),
  );
}

if (cmd === "list") {
  const items = await store.list();
  console.log(JSON.stringify(items, null, 2));
} else if (cmd === "approve") {
  await resume(Deno.args[2], Deno.args[3] ?? "config.yaml", Deno.args[4] ?? "secrets.json");
} else if (cmd === "reject") {
  const pendingId = Deno.args[2];
  const removed = await store.remove(pendingId);
  if (!removed) {
    console.error(`unknown pendingId: ${pendingId}`);
    Deno.exit(1);
  }
  const log = new RunLog(dataDir, removed.runId, 10 * 1024 * 1024);
  await log.recordOp({ op: removed.op, status: "rejected" });
  await log.recordFinal({ status: "rejected" });
  console.log(JSON.stringify({ status: "rejected", pendingId, runId: removed.runId }));
} else {
  console.error(
    "usage: deno task pending <dataDir> list | approve <pendingId> [config.yaml secrets.json] | reject <pendingId>",
  );
  Deno.exit(2);
}
