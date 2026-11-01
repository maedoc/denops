import { compose, oneOf, optNum, optStr, rejectUnknown, str } from "../../harness/args.ts";
import { checkShapeArgs, wrapClient } from "../shape.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
import { MistralClient } from "./client.ts";

// Default projections: library/document objects carry summaries, tokens counts and
// sharing metadata an agent rarely needs up front. `fields`/`full` opt out.
const MISTRAL_SHAPE: Record<string, string[]> = {
  // list endpoints wrap their rows: keep the envelope keys, project each row
  "libraries.list": [
    "pagination",
    "data.id",
    "data.name",
    "data.total_size",
    "data.nb_documents",
    "data.updated_at",
  ],
  "libraries.get": ["id", "name", "total_size", "nb_documents", "updated_at", "description"],
  "documents.list": [
    "pagination",
    "data.id",
    "data.name",
    "data.size",
    "data.mime_type",
    "data.extension",
    "data.created_at",
    "data.process_status",
  ],
  "documents.get": [
    "id",
    "name",
    "size",
    "mime_type",
    "extension",
    "created_at",
    "process_status",
    "summary",
    "url",
  ],
  "documents.put": ["id", "name", "size", "mime_type"],
  // replace() returns a wrapper { created, replaced, document } — keep the wrapper
  // keys and project the nested document.
  "documents.replace": [
    "created",
    "replaced",
    "document.id",
    "document.name",
    "document.size",
    "document.mime_type",
  ],
};

export function mistralConnector(
  opts: {
    apiKey: string;
    origin: string;
    apiPath: string;
    stagingRoot?: string;
    maxStagedBytes?: number;
    inlineReadMaxBytes?: number;
  },
): Connector {
  const client = new MistralClient({ stagingRoot: "data/staging", ...opts });
  const conn: Connector = {
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
        doc:
          "List documents in a Library. args: { libraryId: string }. Returns document summaries; `size` and `mime_type` " +
          "decide whether to read inline (documents.read) or stage+grep (documents.stage), and `summary` is the " +
          'extracted text summary — ask for it with fields: ["name","size","summary"].',
        argSchema: compose(rejectUnknown(), str("libraryId")),
      },
      {
        name: "mistral.documents.get",
        tier: "open",
        doc:
          "Get document metadata (id, name, size, mime_type, extension, process_status, summary). " +
          'args: { libraryId: string, documentId: string }. Add "summary" via fields for the extracted text.',
        argSchema: compose(rejectUnknown(), str("libraryId"), str("documentId")),
      },
      {
        name: "mistral.documents.read",
        tier: "open",
        doc:
          "Read a text document's content inline. args: { libraryId, documentId, maxBytes? } (default 64 KiB). " +
          "Returns { text, bytes, mime, truncated }. Binary documents (application/pdf, …) are refused: read the " +
          'extracted `summary` via documents.get({fields:["summary"]}) — that is the text Mistral\'s pipeline produced. ' +
          "documents.stage gives you the bytes, but fs.grep cannot search binary files (it skips them).",
        argSchema: compose(
          rejectUnknown(),
          str("libraryId"),
          str("documentId"),
          optNum("maxBytes"),
        ),
      },
      {
        name: "mistral.documents.stage",
        tier: "open",
        doc:
          "Download a document into the staging root so fs.read / fs.grep can work through it (any size, any type). " +
          "args: { libraryId, documentId, destName? }. Returns { root, path, absPath, bytes, mime, sha256 }; pass " +
          "`root` and `path` straight to fs.read/fs.grep (files stay staged; nothing prunes them yet).",
        argSchema: compose(
          rejectUnknown(),
          str("libraryId"),
          str("documentId"),
          optStr("destName", 120),
        ),
      },
      {
        name: "mistral.staging.clear",
        tier: "open",
        doc:
          "Delete staged document copies (the files documents.stage wrote). args: { olderThanHours? } " +
          "(0 = all, the default). Returns { removed: [names] }. Only the staging root is touched.",
        argSchema: compose(rejectUnknown(), optNum("olderThanHours")),
      },
      {
        name: "mistral.documents.put",
        tier: "approval",
        doc:
          "Create a library document from text (no base64 needed). args: { libraryId, fileName, text, contentType? }. " +
          "contentType labels the multipart part only — Mistral assigns the stored mime_type itself (text uploads " +
          "become text/plain). Approval-tier unless the library was created in this same run.",
        argSchema: compose(
          rejectUnknown(),
          str("libraryId"),
          str("fileName"),
          str("text"),
          optStr("contentType", 200),
        ),
      },
      {
        name: "mistral.documents.replace",
        tier: "approval",
        doc:
          "Overwrite a document in place (delete + re-upload) so a canvas keeps its name and gains a new revision. " +
          "args: { libraryId, documentId?, fileName, text, contentType? }. Without documentId it replaces the only " +
          "document with that name, creates one if none exists, and REFUSES if several share the name (pass documentId).",
        argSchema: compose(
          rejectUnknown(),
          str("libraryId"),
          optStr("documentId", 64),
          str("fileName"),
          str("text"),
          optStr("contentType", 200),
        ),
      },
      {
        name: "mistral.documents.upload",
        tier: "approval",
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
        name: "mistral.libraries.share",
        tier: "approval",
        doc:
          "Share a Library with a User/Workspace/Org. args: { id, shareWithType: 'User'|'Workspace'|'Org', shareWithUuid, level: 'Viewer'|'Editor' }",
        argSchema: compose(
          rejectUnknown(),
          str("id"),
          oneOf("shareWithType", ["User", "Workspace", "Org"]),
          str("shareWithUuid"),
          oneOf("level", ["Viewer", "Editor"]),
        ),
      },
      {
        name: "mistral.libraries.unshare",
        tier: "approval",
        doc: "Remove a share from a Library. args: { id, shareWithType, shareWithUuid }",
        argSchema: compose(
          rejectUnknown(),
          str("id"),
          oneOf("shareWithType", ["User", "Workspace", "Org"]),
          str("shareWithUuid"),
        ),
      },
      {
        name: "mistral.libraries.shares.list",
        tier: "open",
        doc: "List access entries of a Library. args: { id }",
        argSchema: compose(rejectUnknown(), str("id")),
      },
      {
        name: "mistral.connectors.list",
        tier: "open",
        doc:
          "List registered MCP Connectors in the workspace (beta API, used by startup check). args: {}",
        argSchema: compose(rejectUnknown()),
      },
    ],
    client: (_ctx: HostContext) =>
      wrapClient({
        "libraries.list": () => client.listLibraries(),
        "libraries.get": (a) => client.getLibrary(String((a as { id: string }).id)),
        "libraries.create": async (a) => {
          const r = a as { name: string; description?: string };
          return await client.createLibrary(r.name, r.description);
        },
        "libraries.delete": (a) => client.deleteLibrary(String((a as { id: string }).id)),
        "documents.list": (a) =>
          client.listDocuments(String((a as { libraryId: string }).libraryId)),
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
          return await client.uploadDocument(
            r.libraryId,
            r.fileName,
            r.contentBase64,
            r.contentType,
          );
        },
        "documents.read": async (a) => {
          const r = a as { libraryId: string; documentId: string; maxBytes?: number };
          return await client.documentText(r.libraryId, r.documentId, r.maxBytes) as JsonValue;
        },
        "documents.stage": async (a) => {
          const r = a as { libraryId: string; documentId: string; destName?: string };
          const meta = await client.getDocument(r.libraryId, r.documentId) as { name?: string };
          const out = await client.stageDocument(
            r.libraryId,
            r.documentId,
            meta.name ?? r.documentId,
            r.destName,
          );
          // root + relative path, so fs.read/fs.grep take these straight from the
          // result (no absolute-path → root surgery in the caller)
          const rel = out.path.slice(out.path.lastIndexOf("/") + 1);
          return { ...out, root: "denops-stage", absPath: out.path, path: rel } as JsonValue;
        },
        "staging.clear": async (a) => {
          const hours = Number((a as { olderThanHours?: number }).olderThanHours ?? 0);
          return await client.clearStaging(hours) as JsonValue;
        },
        "documents.put": async (a) => {
          const r = a as {
            libraryId: string;
            fileName: string;
            text: string;
            contentType?: string;
          };
          return await client.putDocument(r.libraryId, r.fileName, r.text, r.contentType);
        },
        "documents.replace": async (a) => {
          const r = a as {
            libraryId: string;
            documentId?: string;
            fileName: string;
            text: string;
            contentType?: string;
          };
          let documentId = r.documentId;
          if (!documentId) {
            const listed = await client.listDocuments(r.libraryId) as {
              data?: Array<{ id: string; name: string; created_at?: string }>;
            };
            const sameName = (listed.data ?? []).filter((d) => d.name === r.fileName);
            // Refuse ambiguity instead of guessing: "the oldest canvas.md" would
            // silently overwrite the wrong revision.
            if (sameName.length > 1) {
              throw new Error(
                `${sameName.length} documents are named ${
                  JSON.stringify(r.fileName)
                } in this library (` +
                  sameName.map((d) => `${d.id}@${d.created_at ?? "?"}`).join(", ") +
                  `); pass documentId`,
              );
            }
            documentId = sameName[0]?.id;
          }
          if (!documentId) {
            return {
              created: true,
              document: await client.putDocument(r.libraryId, r.fileName, r.text, r.contentType),
            } as JsonValue;
          }
          return {
            created: false,
            replaced: documentId,
            document: await client.replaceDocument(
              r.libraryId,
              documentId,
              r.fileName,
              r.text,
              r.contentType,
            ),
          } as JsonValue;
        },
        "documents.delete": async (a) => {
          const r = a as { libraryId: string; documentId: string };
          return await client.deleteDocument(r.libraryId, r.documentId);
        },
        "connectors.list": () => client.listConnectors(),
        "libraries.share": (a) => {
          const r = a as {
            id: string;
            shareWithType: string;
            shareWithUuid: string;
            level: string;
          };
          return client.shareLibrary(r.id, r.shareWithType, r.shareWithUuid, r.level);
        },
        "libraries.unshare": (a) => {
          const r = a as { id: string; shareWithType: string; shareWithUuid: string };
          return client.unshareLibrary(r.id, r.shareWithType, r.shareWithUuid);
        },
        "libraries.shares.list": (a) => client.listShares(String((a as { id: string }).id)),
      }, MISTRAL_SHAPE),
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

  conn.ops = conn.ops.map((op) => {
    const short = op.name.slice("mistral.".length);
    return {
      ...op,
      argSchema: compose(op.argSchema, checkShapeArgs),
      doc: MISTRAL_SHAPE[short] && !op.doc.includes("Returns")
        ? op.doc +
          (/\.[a-z]*list$/.test(short) || short === "documents.list"
            ? ' Returns { pagination, data: [summary] }; pass fields: ["..."] or full: true for raw objects.'
            : ' Returns a summary object; pass fields: ["..."] or full: true for the raw object.')
        : op.doc,
    };
  });
  return conn;
}
