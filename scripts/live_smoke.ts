import { loadConfig, loadSecrets } from "../src/config.ts";

const configPath = Deno.args[0] ?? "config.yaml";
const secretsPath = Deno.args[1] ?? "secrets.json";

async function main(): Promise<void> {
  const config = await loadConfig(configPath);
  const secrets = await loadSecrets(secretsPath);
  const enabled = (n: string) => config.connectors[n]?.enabled === true;
  const results: Record<string, string> = {};

  if (enabled("forge")) {
    const { ForgeHttp, defaultMaxLimit } = await import("../src/connectors/forge/client.ts");
    const f = config.connectors.forge;
    const forgeSecrets = (secrets.forge ?? {}) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    const legacy = String((secrets.gitlab as Record<string, unknown> | undefined)?.token ?? "");
    for (const a of ((f.accounts ?? []) as Array<Record<string, unknown>>)) {
      const id = String(a.id);
      const flavor = String(a.flavor ?? "gitlab") as "gitlab" | "forgejo" | "github";
      const c = new ForgeHttp({
        id,
        flavor,
        origin: String(a.origin),
        apiPath: String(a.apiPath ?? (flavor === "gitlab" ? "/api/v4" : "/api/v1")),
        token: String((forgeSecrets[id] ?? {}).token ?? (flavor === "gitlab" ? legacy : "")),
        maxLimit: Number(a.maxLimit ?? defaultMaxLimit(flavor)),
      });
      const me = await c.get("/user") as { username?: string; login?: string };
      results[`forge:${id}`] = `ok: ${flavor} user=${me.username ?? me.login ?? "?"}`;
    }
  }

  if (enabled("mistral")) {
    const { MistralClient } = await import("../src/connectors/mistral/client.ts");
    const m = config.connectors.mistral;
    const c = new MistralClient({
      apiKey: String((secrets.mistral as Record<string, unknown> | undefined)?.apiKey ?? ""),
      origin: String(m.origin ?? "https://api.mistral.ai"),
      apiPath: String(m.apiPath ?? "/v1"),
    });
    const models = await c.listModels() as { data?: unknown[] };
    results.mistral = `ok: models=${models.data?.length ?? "?"}`;
  }

  if (enabled("imap")) {
    const { imapConnector } = await import("../src/connectors/imap/manifest.ts");
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
    const conn = imapConnector({ accounts });
    await conn.validateStartup?.({ config: {}, secrets, log: () => {} });
    results.imap = `ok: ${accounts.map((a) => a.id).join(",")} connected`;
  }

  console.log(JSON.stringify(results, null, 2));
}

await main();
