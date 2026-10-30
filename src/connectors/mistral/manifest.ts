import { compose, optStr, rejectUnknown, str } from "../../harness/args.ts";
import type { Connector, HostContext } from "../../harness/types.ts";
import { MistralClient } from "./client.ts";

export function mistralConnector(
  opts: { apiKey: string; origin: string; apiPath: string },
): Connector {
  const client = new MistralClient(opts);
  return {
    id: "mistral",
    ops: [
      {
        name: "mistral.libraries.list",
        tier: "open",
        doc: "List all Libraries (knowledge bases) in the workspace.",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "mistral.libraries.get",
        tier: "open",
        doc: "Get one Library by id or name. args: { id: string }",
        argSchema: compose(rejectUnknown(), str("id")),
      },
      {
        name: "mistral.libraries.create",
        tier: "open",
        doc:
          "Create a Library. args: { name: string, description?: string }. Returns the new library incl. id.",
        argSchema: compose(rejectUnknown(), str("name"), optStr("description", 4000)),
      },
      {
        name: "mistral.libraries.delete",
        tier: "approval",
        doc: "Delete a Library permanently. args: { id: string }",
        argSchema: compose(rejectUnknown(), str("id")),
      },
      {
        name: "mistral.documents.list",
        tier: "open",
        doc: "List documents in a Library. args: { libraryId: string }",
        argSchema: compose(rejectUnknown(), str("libraryId")),
      },
      {
        name: "mistral.documents.get",
        tier: "open",
        doc: "Get document metadata. args: { libraryId: string, documentId: string }",
        argSchema: compose(rejectUnknown(), str("libraryId"), str("documentId")),
      },
      {
        name: "mistral.documents.upload",
        tier: "open",
        doc:
          "Upload a document into a Library. args: { libraryId: string, fileName: string, contentBase64: string, contentType?: string }. Content is base64; the host performs the HTTP upload so the API key never leaves the host.",
        argSchema: compose(
          rejectUnknown(),
          str("libraryId"),
          str("fileName"),
          str("contentBase64"),
          optStr("contentType", 200),
        ),
      },
      {
        name: "mistral.documents.delete",
        tier: "approval",
        doc:
          "Delete a document from a Library. args: { libraryId: string, documentId: string }. Open (no approval) when the library was created by this same run — handled host-side via the op log.",
        argSchema: compose(rejectUnknown(), str("libraryId"), str("documentId")),
      },
      {
        name: "mistral.connectors.list",
        tier: "open",
        doc:
          "List registered MCP Connectors in the workspace (beta API, used by startup check). args: {}",
        argSchema: compose(rejectUnknown()),
      },
    ],
    client: (_ctx: HostContext) => ({
      "libraries.list": () => client.listLibraries(),
      "libraries.get": (a) => client.getLibrary(String((a as { id: string }).id)),
      "libraries.create": async (a) => {
        const r = a as { name: string; description?: string };
        return await client.createLibrary(r.name, r.description);
      },
      "libraries.delete": (a) => client.deleteLibrary(String((a as { id: string }).id)),
      "documents.list": (a) => client.listDocuments(String((a as { libraryId: string }).libraryId)),
      "documents.get": async (a) => {
        const r = a as { libraryId: string; documentId: string };
        return await client.getDocument(r.libraryId, r.documentId);
      },
      "documents.upload": async (a) => {
        const r = a as {
          libraryId: string;
          fileName: string;
          contentBase64: string;
          contentType?: string;
        };
        return await client.uploadDocument(r.libraryId, r.fileName, r.contentBase64, r.contentType);
      },
      "documents.delete": async (a) => {
        const r = a as { libraryId: string; documentId: string };
        return await client.deleteDocument(r.libraryId, r.documentId);
      },
      "connectors.list": () => client.listConnectors(),
    }),
    validateStartup: async (ctx: HostContext) => {
      await client.listModels();
      ctx.log({ event: "mistral key verified via GET /models" });
      const startup =
        (ctx.config as { mistral?: { startup?: Record<string, unknown> } }).mistral?.startup ?? {};
      const check = startup.checkVibeConnector as
        | { enabled?: boolean; name?: string; expectServerUrl?: string; strict?: boolean }
        | undefined;
      if (check?.enabled && check.name) {
        try {
          const list = (await client.listConnectors()) as
            | { data?: Array<Record<string, unknown>> }
            | Array<Record<string, unknown>>;
          const items = Array.isArray(list) ? list : (list.data ?? []);
          const found = items.find((c) => c.name === check.name || c.id === check.name);
          if (!found) {
            const msg =
              `vibe connector check: no connector named "${check.name}" registered in workspace`;
            ctx.log({ event: "vibe-connector-check", ok: false, detail: msg });
            if (check.strict) throw new Error(msg + " (strict mode)");
          } else {
            const server = String(found.server ?? "");
            const ok = !check.expectServerUrl || server === check.expectServerUrl;
            ctx.log({
              event: "vibe-connector-check",
              ok,
              detail: `connector "${check.name}" server=${server || "(none)"} expected=${
                check.expectServerUrl || "(any)"
              }`,
            });
            if (!ok && check.strict) {
              throw new Error(
                `vibe connector "${check.name}" has server=${server}, expected ${check.expectServerUrl} (strict mode)`,
              );
            }
          }
        } catch (err) {
          const msg = `vibe connector check failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
          ctx.log({ event: "vibe-connector-check", ok: false, detail: msg });
          if (check.strict) throw new Error(msg + " (strict mode)");
        }
      }
    },
  };
}
