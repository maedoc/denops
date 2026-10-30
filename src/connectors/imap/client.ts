import { ImapFlow } from "npm:imapflow@2.10.0";
import type { JsonValue } from "../../harness/types.ts";

export interface ImapAccountConfig {
  id: string;
  host: string;
  port: number;
  tls: boolean;
  user: string;
  password: string;
  draftsMailbox: string;
}

interface Queue {
  tail: Promise<unknown>;
}

export class ImapAccountClient {
  private client: ImapFlow;
  private queue: Queue = { tail: Promise.resolve() };
  private connected = false;

  constructor(private cfg: ImapAccountConfig) {
    this.client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.tls,
      auth: { user: cfg.user, pass: cfg.password },
      logger: false,
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.tail.then(fn, fn);
    this.queue.tail = run.catch(() => {});
    return run;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  async listMailboxes(): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const boxes = await this.client.list();
      const out: JsonValue[] = [];
      for (const b of boxes) {
        out.push({
          name: String(b.name),
          path: String(b.path),
          flags: [...(b.flags ?? [])],
          specialUse: b.specialUse ? String(b.specialUse) : null,
        });
      }
      return out;
    });
  }

  async listMessages(mailbox: string, limit = 50, page = 1): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const mb = this.client.mailbox;
        const total = typeof mb === "object" && mb !== null ? Number(mb.exists) : 0;
        const from = Math.max(1, total - (page - 1) * limit);
        const to = Math.max(0, from - limit + 1);
        const messages: JsonValue[] = [];
        if (total > 0 && from >= 1) {
          for await (
            const msg of this.client.fetch({ seq: `${Math.max(1, to)}:${from}` }, {
              uid: true,
              envelope: true,
              flags: true,
            })
          ) {
            messages.push({
              uid: msg.uid,
              seq: msg.seq,
              subject: msg.envelope?.subject ?? null,
              from: msg.envelope?.from?.map((a) => ({
                name: a.name ?? null,
                address: a.address ?? null,
              })) ?? [],
              to: msg.envelope?.to?.map((a) => ({
                name: a.name ?? null,
                address: a.address ?? null,
              })) ?? [],
              date: msg.envelope?.date
                ? new Date(msg.envelope.date as string | Date).toISOString()
                : null,
              flags: [...(msg.flags ?? [])],
            } as JsonValue);
          }
        }
        return { mailbox, total, page, limit, messages };
      } finally {
        lock.release();
      }
    });
  }

  async searchMessages(
    mailbox: string,
    query: Record<string, unknown>,
    limit = 50,
  ): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const uids: number[] = [];
        for await (
          const msg of this.client.fetch({ ...query, uid: true } as never, { uid: true })
        ) {
          uids.push(msg.uid);
          if (uids.length >= limit) break;
        }
        return { mailbox, uids };
      } finally {
        lock.release();
      }
    });
  }

  private static textDecoder = new TextDecoder();

  async getMessage(mailbox: string, uid: number, maxBytes = 256 * 1024): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const msg = await this.client.fetchOne(String(uid), {
          uid: true,
          envelope: true,
          flags: true,
          source: true,
          bodyStructure: true,
        }, { uid: true });
        if (!msg) throw new Error(`message uid ${uid} not found in ${mailbox}`);
        const raw = msg.source?.toString("utf-8") ?? "";
        const truncated = raw.length > maxBytes;
        const bodyText = truncated ? raw.slice(0, maxBytes) : raw;
        const parts: JsonValue[] = [];
        const walk = (bs: unknown): void => {
          if (Array.isArray(bs)) {
            for (const p of bs) walk(p);
          } else if (bs && typeof bs === "object") {
            const b = bs as Record<string, unknown>;
            if (b.type && typeof b.type === "string") {
              const params = b.params as Record<string, unknown> | undefined;
              parts.push({
                part: b.part != null ? String(b.part) : null,
                type: String(b.type),
                subtype: b.subtype != null ? String(b.subtype) : null,
                size: typeof b.size === "number" ? b.size : null,
                fileName: params?.name != null ? String(params.name) : null,
              });
            }
            if (b.parts) walk(b.parts);
          }
        };
        walk(msg.bodyStructure);
        return {
          uid: msg.uid,
          subject: msg.envelope?.subject ?? null,
          from: msg.envelope?.from?.map((a) => a.address ?? null) ?? [],
          date: msg.envelope?.date
            ? new Date(msg.envelope.date as string | Date).toISOString()
            : null,
          flags: [...(msg.flags ?? [])],
          parts,
          body: bodyText,
          truncated,
        } as JsonValue;
      } finally {
        lock.release();
      }
    });
  }

  async getMessagePart(
    mailbox: string,
    uid: number,
    partId: string,
    maxBytes = 256 * 1024,
  ): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const msg = await this.client.fetchOne(String(uid), { bodyParts: [partId] }, { uid: true });
        if (!msg) throw new Error(`message uid ${uid} not found in ${mailbox}`);
        const part = msg.bodyParts?.get(partId);
        const raw = part ? ImapAccountClient.textDecoder.decode(part) : "";
        const truncated = raw.length > maxBytes;
        return { uid, part: partId, body: truncated ? raw.slice(0, maxBytes) : raw, truncated };
      } finally {
        lock.release();
      }
    });
  }

  async getFlags(mailbox: string, uid: number): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const msg = await this.client.fetchOne(String(uid), { flags: true }, { uid: true });
        if (!msg) throw new Error(`message uid ${uid} not found in ${mailbox}`);
        return { uid, flags: [...(msg.flags ?? [])] };
      } finally {
        lock.release();
      }
    });
  }

  async saveDraft(subject: string, to: string[], body: string): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const message = [
        `From: ${this.cfg.user}`,
        `To: ${to.join(", ")}`,
        `Subject: ${subject.replace(/[\r\n]+/g, " ")}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        body,
      ].join("\r\n");
      const res = await this.client.append(this.cfg.draftsMailbox, message);
      return {
        saved: true,
        mailbox: this.cfg.draftsMailbox,
        uid: res && typeof res === "object" ? (res as { uid?: number }).uid ?? null : null,
      };
    });
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch { /* already closed */ }
    this.connected = false;
  }
}

export class ImapHost {
  private accounts = new Map<string, ImapAccountClient>();

  constructor(configs: ImapAccountConfig[]) {
    for (const c of configs) {
      if (this.accounts.has(c.id)) throw new Error(`duplicate imap account id: ${c.id}`);
      this.accounts.set(c.id, new ImapAccountClient(c));
    }
  }

  ids(): string[] {
    return [...this.accounts.keys()];
  }

  get(id: string): ImapAccountClient {
    const c = this.accounts.get(id);
    if (!c) {
      throw new Error(
        `unknown mail account: ${id}. Configured: ${[...this.accounts.keys()].join(", ")}`,
      );
    }
    return c;
  }

  async validateAll(): Promise<void> {
    for (const [id, c] of this.accounts) {
      await c.connect();
      await c.close();
      void id;
    }
  }

  async closeAll(): Promise<void> {
    for (const c of this.accounts.values()) await c.close();
  }
}
