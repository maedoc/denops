import {
  arr,
  compose,
  num,
  optArr,
  optBool,
  optNum,
  optStr,
  rejectUnknown,
  str,
} from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
import { type ImapAccountConfig, ImapHost } from "./client.ts";
import { checkShapeArgs, wrapClient } from "../shape.ts";

export interface ImapConnectorDeps {
  accounts: ImapAccountConfig[];
}

export function imapConnector(deps: ImapConnectorDeps): Connector {
  const host = new ImapHost(deps.accounts);
  const acc = str("account");

  const client = (ctx: HostContext) => {
    const wrap = <A extends JsonValue>(
      op: string,
      fn: (a: A) => Promise<JsonValue>,
    ): (a: JsonValue) => Promise<JsonValue> =>
    async (a: JsonValue) => {
      ctx.log({ connector: "mail", op: `mail.${op}`, args: a });
      return await fn(a as A);
    };
    return {
      "accounts": wrap(
        "accounts",
        (): Promise<JsonValue> => Promise.resolve({ accounts: host.ids() } as JsonValue),
      ),
      "mailboxes.list": wrap("mailboxes.list", async (a) => {
        const account = host.get(String((a as { account: string }).account));
        return await account.listMailboxes();
      }),
      "messages.list": wrap("messages.list", async (a) => {
        const r = a as { account: string; mailbox: string; limit?: number; page?: number };
        return await host.get(r.account).listMessages(r.mailbox, r.limit ?? 50, r.page ?? 1);
      }),
      "messages.search": wrap("messages.search", async (a) => {
        const r = a as {
          account: string;
          mailbox?: string;
          mailboxes?: string[];
          query: Record<string, unknown>;
          limit?: number;
        };
        if (r.mailboxes && r.mailboxes.length > 0) {
          if (r.mailbox) throw new Error("pass either `mailbox` or `mailboxes`, not both");
          return await host.get(r.account).searchMany(r.mailboxes, r.query, r.limit ?? 20);
        }
        if (!r.mailbox) throw new Error("messages.search needs `mailbox` or `mailboxes`");
        return await host.get(r.account).searchMessages(r.mailbox, r.query, r.limit ?? 50);
      }),
      "messages.get": wrap("messages.get", async (a) => {
        const r = a as { account: string; mailbox: string; uid: number; maxBytes?: number };
        return await host.get(r.account).getMessage(r.mailbox, r.uid, r.maxBytes);
      }),
      "messages.getPart": wrap("messages.getPart", async (a) => {
        const r = a as {
          account: string;
          mailbox: string;
          uid: number;
          part: string;
          maxBytes?: number;
        };
        return await host.get(r.account).getMessagePart(r.mailbox, r.uid, r.part, r.maxBytes);
      }),
      "messages.flags.get": wrap("messages.flags.get", async (a) => {
        const r = a as { account: string; mailbox: string; uid: number };
        return await host.get(r.account).getFlags(r.mailbox, r.uid);
      }),
      "messages.raw": wrap("messages.raw", async (a) => {
        const r = a as { account: string; mailbox: string; uid: number };
        // full source, headers and all: `messages.get` deliberately splits them now
        const { raw, internalDate } = await host.get(r.account).fetchRaw(r.mailbox, r.uid);
        return {
          uid: r.uid,
          raw,
          internalDate: internalDate ? internalDate.toISOString() : null,
        } as JsonValue;
      }),
      "drafts.save": wrap("drafts.save", async (a) => {
        const r = a as {
          account: string;
          subject?: string;
          to?: string[];
          body: string;
          replyTo?: { mailbox: string; uid: number };
          includeQuote?: boolean;
        };
        return await host.get(r.account).saveDraft({
          ...(r.subject === undefined ? {} : { subject: r.subject }),
          ...(r.to === undefined ? {} : { to: r.to }),
          body: r.body,
          ...(r.replyTo === undefined ? {} : { replyTo: r.replyTo }),
          ...(r.includeQuote === undefined ? {} : { includeQuote: r.includeQuote }),
        });
      }),
      "messages.move": wrap("messages.move", async (a) => {
        const r = a as {
          account: string;
          mailbox: string;
          uids: number[];
          toAccount?: string;
          toMailbox: string;
        };
        return await host.moveMessages(
          r.account,
          r.mailbox,
          r.uids,
          r.toAccount ?? r.account,
          r.toMailbox,
        );
      }),
    };
  };

  const conn: Connector = {
    id: "mail",
    ops: [
      {
        name: "mail.accounts",
        tier: "open",
        doc: "List configured mail account ids. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "mail.mailboxes.list",
        tier: "open",
        doc: "List mailboxes of an account. args: { account: string }",
        argSchema: compose(rejectUnknown(), acc),
      },
      {
        name: "mail.messages.list",
        tier: "open",
        doc: "List message envelopes newest-first. args: { account, mailbox, limit?, page? }. " +
          "Returns { mailbox, total, page, limit, messages: [{ uid, subject, from, date, flags }] } " +
          "(messages also carry seq/to unless fields/full is used).",
        argSchema: compose(rejectUnknown(), acc, str("mailbox"), optNum("limit"), optNum("page")),
      },
      {
        name: "mail.messages.search",
        tier: "open",
        doc:
          "Server-side IMAP SEARCH. args: { account, mailbox, query: object, limit? } e.g. query { subject: 'invoice', seen: false }; " +
          "or { account, mailboxes: string[] (max 20), query, limit? } to search several folders in one call (results carry their mailbox; a failing folder is reported, not fatal). " +
          "Returns { mailbox, count, messages: [{ uid, subject, from, date, flags }] } (multi-mailbox: { count, searched, messages }) — envelopes are " +
          "included (each with its uid), so no second list-and-filter pass is needed.",
        argSchema: compose(
          rejectUnknown(),
          acc,
          optStr("mailbox", 512),
          optArr(
            "mailboxes",
            (v) =>
              typeof v === "string" && v.length > 0 && v.length <= 512
                ? null
                : "expected mailbox path",
          ),
          (a) => {
            const r = a as { mailbox?: unknown; mailboxes?: unknown };
            const hasOne = typeof r.mailbox === "string" && r.mailbox.length > 0;
            const hasMany = Array.isArray(r.mailboxes) && r.mailboxes.length > 0;
            if (hasOne && hasMany) return "pass either mailbox or mailboxes, not both";
            if (!hasOne && !hasMany) return "mailbox or mailboxes is required";
            if (Array.isArray(r.mailboxes) && r.mailboxes.length > 20) {
              return `mailboxes: too many (${r.mailboxes.length} > 20)`;
            }
            return null;
          },
          (a) => {
            if (typeof a !== "object" || a === null || Array.isArray(a)) {
              return "query: expected object";
            }
            const q = (a as Record<string, unknown>).query;
            return typeof q === "object" && q !== null && !Array.isArray(q)
              ? null
              : "query: expected object";
          },
          optNum("limit"),
        ),
      },
      {
        name: "mail.messages.get",
        tier: "open",
        doc:
          "Get one message: envelope + threading headers + raw header block + body. Returns { uid, subject, from, date, flags, parts, contentType, messageId, inReplyTo, references[], headers, body, truncated }: `body` is the message body only (headers are split off, not embedded). Both `headers` and `body` are capped at maxBytes (default 256KB) with a truncated flag; mail.messages.raw returns the uncapped source. args: { account, mailbox, uid, maxBytes? }",
        argSchema: compose(rejectUnknown(), acc, str("mailbox"), num("uid"), optNum("maxBytes")),
      },
      {
        name: "mail.messages.getPart",
        tier: "open",
        doc:
          "Fetch one MIME part of a message by part id (see messages.get parts). args: { account, mailbox, uid, part, maxBytes? }",
        argSchema: compose(
          rejectUnknown(),
          acc,
          str("mailbox"),
          num("uid"),
          str("part"),
          optNum("maxBytes"),
        ),
      },
      {
        name: "mail.messages.flags.get",
        tier: "open",
        doc: "Get flags of one message. args: { account, mailbox, uid }",
        argSchema: compose(rejectUnknown(), acc, str("mailbox"), num("uid")),
      },
      {
        name: "mail.drafts.save",
        tier: "open",
        doc:
          "Save a draft (APPEND to the account's Drafts folder, flagged \\Draft so OWA/Outlook treat it as a draft). Deliberately open: there is no send op in v1. " +
          "args: { account, body, subject?, to?: string[], replyTo?: { mailbox, uid }, includeQuote? }. " +
          "With `replyTo` the server reads the parent and owns the threading: In-Reply-To = parent Message-ID, References = parent's chain + its Message-ID, " +
          "Subject defaults to a non-doubled \"Re: …\", To defaults to the parent's From, and the parent's text is quoted (includeQuote, default true). Every draft gets a fresh Message-ID. " +
          "Returns { saved, mailbox, uid, messageId, inReplyTo, references, subject, to, quoted, quoteSkipped? }: `mailbox` is the resolved folder — nothing is taken raw from the caller.",
        argSchema: compose(
          rejectUnknown(),
          acc,
          optStr("subject", 998),
          optArr(
            "to",
            (v) => (typeof v === "string" && v.includes("@") ? null : "expected email address"),
          ),
          str("body"),
          (a) => {
            if ((a as { replyTo?: unknown }).replyTo === undefined) return null;
            const r = (a as { replyTo?: unknown }).replyTo;
            if (typeof r !== "object" || r === null || Array.isArray(r)) {
              return "replyTo: expected { mailbox, uid }";
            }
            const { mailbox, uid } = r as Record<string, unknown>;
            const keys = Object.keys(r as Record<string, unknown>);
            if (keys.some((k) => k !== "mailbox" && k !== "uid")) {
              return "replyTo: expected only mailbox and uid";
            }
            if (typeof mailbox !== "string" || mailbox.length === 0) {
              return "replyTo.mailbox: expected non-empty string";
            }
            if (typeof uid !== "number" || !Number.isFinite(uid) || uid <= 0) {
              return "replyTo.uid: expected a positive uid";
            }
            return null;
          },
          optBool("includeQuote"),
          (a) => {
            const r = a as { replyTo?: unknown; subject?: unknown; to?: unknown };
            if (r.replyTo !== undefined) return null;
            if (typeof r.subject !== "string" || r.subject.trim() === "") {
              return "subject: required unless replyTo is given";
            }
            if (!Array.isArray(r.to) || r.to.length === 0) {
              return "to: required unless replyTo is given";
            }
            return null;
          },
        ),
      },
      {
        name: "mail.messages.raw",
        tier: "approval",
        doc:
          "Full raw RFC822 source of a message, headers and body together (uncapped). args: { account, mailbox, uid }. Returns { uid, raw, internalDate }.",
        argSchema: compose(rejectUnknown(), acc, str("mailbox"), num("uid")),
      },
      {
        name: "mail.messages.move",
        tier: "approval",
        doc:
          "Move message(s) to another mailbox, optionally on another account (cross-account = COPY + SHA-256 verification of the landed copy + delete/expunge on source). args: { account, mailbox, uids: number[], toMailbox, toAccount? }",
        argSchema: compose(
          rejectUnknown(),
          acc,
          str("mailbox"),
          arr(
            "uids",
            (v) =>
              typeof v === "number" && Number.isFinite(v) && v > 0 ? null : "expected positive uid",
          ),
          str("toMailbox"),
          optStr("toAccount"),
        ),
      },
    ],
    client: (_ctx: HostContext) => wrapClient(client(_ctx), MAIL_SHAPE),
    validateStartup: async () => {
      await host.validateAll();
    },
  };

  conn.ops = conn.ops.map((op) => {
    const short = op.name.slice("mail.".length);
    return {
      ...op,
      argSchema: compose(op.argSchema, checkShapeArgs),
      doc: MAIL_SHAPE[short] && !op.doc.includes("Returns") ? op.doc + SHAPE_HINT : op.doc,
    };
  });
  return conn;
}

// Default projections for envelope listings: subjects and addresses are what a
// caller needs to choose a message, not whole MIME envelopes.
const SHAPE_HINT = ' Returns a summary; pass fields: ["..."] or full: true for the raw object.';

// messages.list returns { mailbox, total, page, limit, messages: [...] }: the
// wrapper keys are part of the answer, the envelope fields inside each message
// are what gets trimmed.
export const MAIL_SHAPE: Record<string, string[]> = {
  "messages.list": [
    "mailbox",
    "total",
    "page",
    "limit",
    "messages.uid",
    "messages.subject",
    "messages.from",
    "messages.date",
    "messages.flags",
  ],
  "messages.search": [
    "mailbox",
    "count",
    "searched",
    "messages.mailbox",
    "messages.uid",
    "messages.subject",
    "messages.from",
    "messages.date",
    "messages.flags",
  ],
};
