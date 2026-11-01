import { ImapFlow } from "npm:imapflow@2.10.0";
import type { JsonValue } from "../../harness/types.ts";

export interface ImapAccountConfig {
  id: string;
  host: string;
  port: number;
  tls: boolean;
  allowSelfSigned?: boolean;
  user: string;
  password: string;
  draftsMailbox: string;
  /** Socket inactivity timeout; imapflow's default is 300000 (5 min). */
  socketTimeoutMs?: number;
}

interface Queue {
  tail: Promise<unknown>;
}

export class ImapAccountClient {
  private client: ImapFlow;
  private queue: Queue = { tail: Promise.resolve() };
  private connected = false;
  private connError: Error | null = null;

  constructor(private cfg: ImapAccountConfig) {
    this.client = this.newClient();
  }

  private newClient(): ImapFlow {
    const cfg = this.cfg;
    this.connError = null;
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.tls,
      auth: { user: cfg.user, pass: cfg.password },
      logger: false,
      ...(cfg.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
      ...(cfg.socketTimeoutMs ? { socketTimeout: Number(cfg.socketTimeoutMs) } : {}),
    });
    // imapflow reports background connection failures through the 'error'
    // event: its socket inactivity timeout (5 min by default), a server BYE, or
    // a dropped tunnel. An unhandled 'error' event is fatal in Deno, so a single
    // idle timeout would take the whole server down with it. Treat it as "this
    // connection is gone": remember why, drop the socket, and let the next op
    // reconnect instead of failing every later op against a dead client.
    client.on("error", (err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      if (!this.connError) this.connError = e;
      this.connected = false;
      try {
        // Fire-and-forget: close() is async and rejects on an already-dead
        // socket, which must not surface as an unhandled rejection.
        void Promise.resolve(client.close()).catch(() => {});
      } catch { /* already closed */ }
    });
    client.on("close", () => {
      this.connected = false;
    });
    return client;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.tail.then(fn, fn);
    this.queue.tail = run.catch(() => {});
    return run;
  }

  async connect(): Promise<void> {
    // `usable` is imapflow's own liveness flag; once it is false the client is
    // permanently dead, so a fresh one is required (`closed` is not a property
    // imapflow exposes — checking it always read `undefined`).
    const live = this.client as unknown as { usable?: boolean; isClosed?: boolean };
    if (this.connected && live.usable === true && live.isClosed !== true) return;
    this.client = this.newClient();
    try {
      await this.client.connect();
    } catch (e) {
      this.connected = false;
      throw e;
    }
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
            messages.push(envelopeOf(msg));
          }
        }
        messages.sort(byDateDesc);
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
          const msg of this.client.fetch({ ...query } as never, { uid: true })
        ) {
          uids.push(msg.uid);
          if (uids.length >= limit) break;
        }
        // Envelope pass over the matches: a bare uid list forces the caller into a
        // second paginated list-and-filter round trip to learn what it matched.
        const messages: JsonValue[] = [];
        if (uids.length > 0) {
          for await (
            const msg of this.client.fetch({ uid: uids.join(",") }, {
              uid: true,
              envelope: true,
              flags: true,
            })
          ) {
            messages.push(envelopeOf(msg));
          }
          messages.sort(byDateDesc);
        }
        return { mailbox, uids, messages };
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

  async moveMessages(mailbox: string, uids: number[], destMailbox: string): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        await this.client.messageMove(uids.join(","), destMailbox, { uid: true });
        return { moved: uids.length, from: mailbox, to: destMailbox };
      } finally {
        lock.release();
      }
    });
  }

  async fetchRaw(
    mailbox: string,
    uid: number,
  ): Promise<{ raw: string; internalDate: Date | null }> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const msg = (await this.client.fetchOne(
          String(uid),
          { source: true, internalDate: true },
          { uid: true },
        )) as
          | { source?: { toString(enc: string): string }; internalDate?: Date }
          | false
          | null;
        if (!msg || !msg.source) throw new Error(`message uid ${uid} not found in ${mailbox}`);
        return { raw: msg.source.toString("utf-8"), internalDate: msg.internalDate ?? null };
      } finally {
        lock.release();
      }
    });
  }

  async appendRaw(mailbox: string, raw: string, idate?: Date | null): Promise<number | null> {
    return await this.enqueue(async () => {
      await this.connect();
      const res = await this.client.append(mailbox, raw, undefined, idate ?? undefined);
      return res && typeof res === "object" ? (res as { uid?: number }).uid ?? null : null;
    });
  }

  async fingerprint(mailbox: string, uid: number): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        const msg = await this.client.fetchOne(
          String(uid),
          { envelope: true, bodyStructure: true, bodyParts: ["HEADER", "TEXT"] },
          { uid: true },
        );
        if (!msg) throw new Error(`message uid ${uid} not found in ${mailbox}`);
        const env = msg.envelope ?? {};
        const leaves: { part: string; type: string }[] = [];
        const walk = (bs: unknown) => {
          if (!bs || typeof bs !== "object") return;
          const node = bs as { part?: string; type?: string; parts?: unknown };
          if (typeof node.part === "string" && node.type) {
            leaves.push({ part: node.part, type: String(node.type).toLowerCase() });
          } else if (Array.isArray(node.parts)) {
            for (const c of node.parts) walk(c);
          }
        };
        walk(msg.bodyStructure);
        const parts: { type: string; sha256: string }[] = [];
        for (const leaf of leaves) {
          if (leaf.type !== "text/plain") continue;
          const m =
            (await this.client.fetchOne(String(uid), { bodyParts: [leaf.part] }, { uid: true })) as
              | { bodyParts?: Map<string, Uint8Array> }
              | false
              | null;
          const buf = m && m.bodyParts ? m.bodyParts.get(leaf.part) : undefined;
          const raw = buf ? ImapAccountClient.textDecoder.decode(buf) : "";
          parts.push({ type: leaf.type, sha256: await sha256Hex(raw) });
        }
        parts.sort((a, b) => a.type.localeCompare(b.type));
        return {
          subject: env.subject ?? null,
          from: (env.from ?? []).map((a) => a.address ?? ""),
          to: (env.to ?? []).map((a) => a.address ?? ""),
          date: env.date ? new Date(env.date as string | Date).toISOString() : null,
          parts,
        } as JsonValue;
      } finally {
        lock.release();
      }
    });
  }

  async deleteAndExpunge(mailbox: string, uids: number[]): Promise<JsonValue> {
    return await this.enqueue(async () => {
      await this.connect();
      const lock = await this.client.getMailboxLock(mailbox);
      try {
        await this.client.messageDelete(uids.join(","), { uid: true });
        return { deleted: uids.length, mailbox };
      } finally {
        lock.release();
      }
    });
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch { /* already closed */ }
    this.connected = false;
  }
}

// envelopeOf is the canonical message summary: the fields a caller needs to pick
// a message without pulling the whole MIME envelope.
function envelopeOf(
  msg: { uid: number; seq: number; flags?: Set<string> | string[]; envelope?: unknown },
): JsonValue {
  const env = msg.envelope as {
    subject?: string | null;
    date?: string | Date | null;
    from?: Array<{ name?: string | null; address?: string | null }>;
    to?: Array<{ name?: string | null; address?: string | null }>;
  } | undefined;
  const addr = (list?: Array<{ name?: string | null; address?: string | null }>) =>
    list?.map((a) => ({ name: a.name ?? null, address: a.address ?? null })) ?? [];
  return {
    uid: msg.uid,
    seq: msg.seq,
    subject: env?.subject ?? null,
    from: addr(env?.from),
    to: addr(env?.to),
    date: env?.date ? new Date(env.date as string | Date).toISOString() : null,
    flags: [...(msg.flags ?? [])],
  } as JsonValue;
}

function byDateDesc(a: JsonValue, b: JsonValue): number {
  const da = (a as { date?: string | null }).date ?? "";
  const db = (b as { date?: string | null }).date ?? "";
  return db.localeCompare(da);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

  async moveMessages(
    fromAccount: string,
    mailbox: string,
    uids: number[],
    toAccount: string,
    toMailbox: string,
  ): Promise<JsonValue> {
    const src = this.get(fromAccount);
    const dst = this.get(toAccount);
    if (fromAccount === toAccount) {
      return await src.moveMessages(mailbox, uids, toMailbox);
    }
    const mapping: { uid: number; newUid: number | null; sha256: string; verified: boolean }[] = [];
    for (const uid of uids) {
      const { raw, internalDate } = await src.fetchRaw(mailbox, uid);
      const sha256 = await sha256Hex(raw);
      const newUid = await dst.appendRaw(toMailbox, raw, internalDate);
      let verified = false;
      if (newUid !== null) {
        const srcFp = (await src.fingerprint(mailbox, uid)) as Record<string, unknown>;
        const dstFp = (await dst.fingerprint(toMailbox, newUid)) as Record<string, unknown>;
        verified = JSON.stringify(srcFp) === JSON.stringify(dstFp);
      }
      mapping.push({ uid, newUid, sha256, verified });
    }
    if (mapping.some((m) => !m.verified)) {
      throw new Error(
        `verification failed for uids: ${
          mapping.filter((m) => !m.verified).map((m) => m.uid).join(",")
        } — source messages left untouched`,
      );
    }
    const deleted = await src.deleteAndExpunge(mailbox, uids);
    return {
      moved: mapping.length,
      from: `${fromAccount}/${mailbox}`,
      to: `${toAccount}/${toMailbox}`,
      mapping,
      deleted,
    };
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
