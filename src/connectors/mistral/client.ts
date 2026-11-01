import type { JsonValue } from "../../harness/types.ts";

export interface MistralClientOptions {
  apiKey: string;
  origin: string;
  apiPath: string;
}

export class MistralClient {
  private base: string;
  private apiKey: string;

  constructor(opts: MistralClientOptions) {
    this.base = `${opts.origin}${opts.apiPath}`;
    this.apiKey = opts.apiKey;
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

  async uploadDocument(
    libraryId: string,
    fileName: string,
    contentBase64: string,
    contentType = "text/plain",
  ): Promise<JsonValue> {
    const bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: contentType }), fileName);
    const up = await this.req("/files", { method: "POST", body: form });
    const fileId = (up as { id?: string }).id;
    if (!fileId) throw new Error("upload did not return a file id");
    return await this.req(`/libraries/${encodeURIComponent(libraryId)}/documents`, {
      method: "POST",
      body: JSON.stringify({ file_id: fileId, name: fileName }),
    });
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
