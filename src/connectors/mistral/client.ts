import type { JsonValue } from "../../harness/types.ts";

export interface MistralClientOptions {
  apiKey: string;
  origin: string;
  apiPath: string;
  /** Where `documents.stage` writes downloads (outside the operator's dev tree). */
  stagingRoot?: string;
  maxStagedBytes?: number;
  inlineReadMaxBytes?: number;
}

const MIME_TEXT = /^(text\/|application\/(json|xml|x-yaml|yaml|markdown))/i;

export class MistralClient {
  private base: string;
  private apiKey: string;
  private stagingRoot: string;
  private maxStagedBytes: number;
  private inlineReadMaxBytes: number;

  constructor(opts: MistralClientOptions) {
    this.base = `${opts.origin}${opts.apiPath}`;
    this.apiKey = opts.apiKey;
    this.stagingRoot = opts.stagingRoot ?? "data/staging";
    this.maxStagedBytes = opts.maxStagedBytes ?? 32 * 1024 * 1024;
    this.inlineReadMaxBytes = opts.inlineReadMaxBytes ?? 64 * 1024;
    const allowMock = Deno.env.get("DENOPS_ALLOW_MOCK_ORIGIN") === "1";
    if (!allowMock && !this.base.startsWith("https://api.mistral.ai/")) {
      throw new Error(`refusing non-pinned mistral origin: ${opts.origin}`);
    }
  }

  private async req(path: string, init?: RequestInit): Promise<JsonValue> {
    // Never label a multipart body as JSON: fetch must add
    // `multipart/form-data; boundary=…` itself, and hard-coding application/json
    // made Mistral reject uploads with `422 Field required at loc ['file','file']`
    // (the form part never existed as far as the server could tell).
    const isForm = init?.body instanceof FormData;
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      ...(isForm ? {} : {}),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(isForm ? {} : { "content-type": "application/json" }),
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `mistral ${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return text ? (JSON.parse(text) as JsonValue) : {};
  }

  async listLibraries(): Promise<JsonValue> {
    return await this.req("/libraries");
  }

  async getLibrary(id: string): Promise<JsonValue> {
    return await this.req(`/libraries/${encodeURIComponent(id)}`);
  }

  async createLibrary(name: string, description?: string): Promise<JsonValue> {
    return await this.req("/libraries", {
      method: "POST",
      body: JSON.stringify(description ? { name, description } : { name }),
    });
  }

  async deleteLibrary(id: string): Promise<JsonValue> {
    return await this.req(`/libraries/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listDocuments(libraryId: string): Promise<JsonValue> {
    return await this.req(`/libraries/${encodeURIComponent(libraryId)}/documents`);
  }

  async getDocument(libraryId: string, documentId: string): Promise<JsonValue> {
    return await this.req(
      `/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}`,
    );
  }

  async deleteDocument(libraryId: string, documentId: string): Promise<JsonValue> {
    return await this.req(
      `/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}`,
      { method: "DELETE" },
    );
  }

  /** Raw bytes from an endpoint (files content, signed blob URLs). */
  private async bytes(urlOrPath: string, absolute = false): Promise<Uint8Array> {
    const url = absolute ? urlOrPath : `${this.base}${urlOrPath}`;
    const headers: Record<string, string> = absolute
      ? {}
      : { authorization: `Bearer ${this.apiKey}` };
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `mistral GET ${urlOrPath.slice(0, 80)} -> ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Documents have no /content endpoint; they expose a signed blob URL instead
   * (`GET .../documents/{id}/signed-url`). That URL is time-limited and must be
   * fetched *without* the API key.
   */
  async documentSignedUrl(libraryId: string, documentId: string): Promise<string> {
    const body = await this.req(
      `/libraries/${encodeURIComponent(libraryId)}/documents/${
        encodeURIComponent(documentId)
      }/signed-url`,
    );
    if (typeof body === "string") return body;
    const url = (body as { url?: string }).url;
    if (!url) throw new Error("document signed-url: no url in response");
    return url;
  }

  async documentBytes(libraryId: string, documentId: string): Promise<Uint8Array> {
    const url = await this.documentSignedUrl(libraryId, documentId);
    const bytes = await this.bytes(url, true);
    if (bytes.byteLength > this.maxStagedBytes) {
      throw new Error(
        `document is ${bytes.byteLength} bytes, over the ${this.maxStagedBytes}-byte staging cap`,
      );
    }
    return bytes;
  }

  /** Inline read: text documents up to `maxBytes`, decoded UTF-8. */
  async documentText(
    libraryId: string,
    documentId: string,
    maxBytes = this.inlineReadMaxBytes,
  ): Promise<{ text: string; bytes: number; mime: string; truncated: boolean }> {
    const meta = await this.getDocument(libraryId, documentId) as {
      mime_type?: string;
      size?: number;
    };
    const mime = meta.mime_type ?? "application/octet-stream";
    if (!MIME_TEXT.test(mime)) {
      throw new Error(
        `document ${documentId} is ${mime} (${
          meta.size ?? "?"
        } bytes): binary content cannot be read as text; ` +
          `use mistral.documents.list/get with fields:["summary"] for the extracted summary, or mistral.documents.stage + fs.grep`,
      );
    }
    const bytes = await this.documentBytes(libraryId, documentId);
    const truncated = bytes.byteLength > maxBytes;
    const slice = truncated ? bytes.slice(0, maxBytes) : bytes;
    return { text: new TextDecoder().decode(slice), bytes: bytes.byteLength, mime, truncated };
  }

  /** Stage a document into the staging root; returns the path the fs ops can read. */
  async stageDocument(
    libraryId: string,
    documentId: string,
    name: string,
    destName?: string,
  ): Promise<{ path: string; bytes: number; mime: string; sha256: string }> {
    const meta = await this.getDocument(libraryId, documentId) as { mime_type?: string };
    const data = await this.documentBytes(libraryId, documentId);
    await Deno.mkdir(this.stagingRoot, { recursive: true });
    const safe = (destName ?? `${documentId}-${name}`).replace(/[^A-Za-z0-9._-]+/g, "_").slice(
      0,
      120,
    );
    const path = `${this.stagingRoot}/${safe}`;
    await Deno.writeFile(path, data);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      data.slice() as unknown as ArrayBuffer,
    );
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return {
      path,
      bytes: data.byteLength,
      mime: meta.mime_type ?? "application/octet-stream",
      sha256,
    };
  }

  /**
   * Remove staged downloads. The staging root is read-only to fs writes by design,
   * so the connector that wrote those files owns pruning them.
   */
  async clearStaging(olderThanHours = 0): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    const cutoff = olderThanHours > 0 ? Date.now() - olderThanHours * 3600_000 : Infinity;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(this.stagingRoot)];
    } catch {
      return { removed };
    }
    for (const entry of entries) {
      if (!entry.isFile) continue;
      const path = `${this.stagingRoot}/${entry.name}`;
      try {
        const info = Deno.statSync(path);
        const mtime = info.mtime?.getTime() ?? 0;
        if (mtime > cutoff) continue;
        Deno.removeSync(path);
        removed.push(entry.name);
      } catch { /* raced or unreadable: ignore */ }
    }
    return { removed };
  }

  /** Upload text as a new library document (no base64 in the caller). */
  async putDocument(
    libraryId: string,
    fileName: string,
    text: string,
    contentType = "text/markdown",
  ): Promise<JsonValue> {
    const bytes = new TextEncoder().encode(text);
    return await this.uploadBytes(libraryId, fileName, bytes, contentType);
  }

  /** Replace a document in place by name: delete then re-upload. */
  async replaceDocument(
    libraryId: string,
    documentId: string,
    fileName: string,
    text: string,
    contentType = "text/markdown",
  ): Promise<JsonValue> {
    await this.deleteDocument(libraryId, documentId);
    return await this.putDocument(libraryId, fileName, text, contentType);
  }

  private async uploadBytes(
    libraryId: string,
    fileName: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<JsonValue> {
    // Library documents are uploaded *directly* as multipart on the library
    // endpoint; the filename in the file part becomes the document name. (There is
    // no /files + {file_id} step — the Files API has different purposes and, for a
    // document, expects a multipart `file` part as well.)
    const form = new FormData();
    // BlobPart wants an ArrayBuffer-backed view; a slice gives one.
    form.append(
      "file",
      new Blob([bytes.slice() as unknown as ArrayBuffer], { type: contentType }),
      fileName,
    );
    return await this.req(`/libraries/${encodeURIComponent(libraryId)}/documents`, {
      method: "POST",
      body: form,
    });
  }

  async uploadDocument(
    libraryId: string,
    fileName: string,
    contentBase64: string,
    contentType = "text/plain",
  ): Promise<JsonValue> {
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0));
    } catch {
      throw new Error("contentBase64: not valid base64");
    }
    return await this.uploadBytes(libraryId, fileName, bytes, contentType);
  }

  async shareLibrary(
    libraryId: string,
    shareWithType: string,
    shareWithUuid: string,
    level: string,
  ): Promise<JsonValue> {
    return await this.req(`/libraries/${encodeURIComponent(libraryId)}/share`, {
      method: "PUT",
      body: JSON.stringify({
        level,
        share_with_type: shareWithType,
        share_with_uuid: shareWithUuid,
      }),
    });
  }

  async unshareLibrary(
    libraryId: string,
    shareWithType: string,
    shareWithUuid: string,
  ): Promise<JsonValue> {
    return await this.req(`/libraries/${encodeURIComponent(libraryId)}/share`, {
      method: "DELETE",
      body: JSON.stringify({ share_with_type: shareWithType, share_with_uuid: shareWithUuid }),
    });
  }

  async listShares(libraryId: string): Promise<JsonValue> {
    return await this.req(`/libraries/${encodeURIComponent(libraryId)}/share`);
  }

  async listConnectors(): Promise<JsonValue> {
    return await this.req("/connectors");
  }

  async getConnector(nameOrId: string): Promise<JsonValue> {
    return await this.req(`/connectors/${encodeURIComponent(nameOrId)}`);
  }

  async listModels(): Promise<JsonValue> {
    return await this.req("/models");
  }
}
