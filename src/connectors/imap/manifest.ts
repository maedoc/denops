import { arr, compose, num, optNum, optStr, rejectUnknown, str } from "../../harness/args.ts";
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
          mailbox: string;
          query: Record<string, unknown>;
          limit?: number;
        };
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
        return await host.get(r.account).getMessage(r.mailbox, r.uid, 100 * 1024 * 1024);
      }),
      "drafts.save": wrap("drafts.save", async (a) => {
        const r = a as { account: string; subject: string; to: string[]; body: string };
        return await host.get(r.account).saveDraft(r.subject, r.to, r.body);
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
        doc:
          "List message envelopes (uid, subject, from, flags) newest-first. args: { account, mailbox, limit?, page? }",
        argSchema: compose(rejectUnknown(), acc, str("mailbox"), optNum("limit"), optNum("page")),
      },
      {
        name: "mail.messages.search",
        tier: "open",
        doc:
          "Server-side IMAP SEARCH. args: { account, mailbox, query: object, limit? } e.g. query { subject: 'invoice', seen: false }",
        argSchema: compose(rejectUnknown(), acc, str("mailbox"), (a) => {
          if (typeof a !== "object" || a === null || Array.isArray(a)) {
            return "query: expected object";
          }
          const q = (a as Record<string, unknown>).query;
          return typeof q === "object" && q !== null && !Array.isArray(q)
            ? null
            : "query: expected object";
        }, optNum("limit")),
      },
      {
        name: "mail.messages.get",
        tier: "open",
        doc:
          "Get full message (parsed envelope + body text). Body capped at maxBytes (default 256KB) with truncated flag. args: { account, mailbox, uid, maxBytes? }",
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
          "Save a draft (APPEND to the account's Drafts folder). Deliberately open: there is no send op in v1. args: { account, subject, to: string[], body }",
        argSchema: compose(
          rejectUnknown(),
          acc,
          str("subject"),
          arr(
            "to",
            (v) => (typeof v === "string" && v.includes("@") ? null : "expected email address"),
          ),
          str("body"),
        ),
      },
      {
        name: "mail.messages.raw",
        tier: "approval",
        doc: "Full raw RFC822 source of a message (uncapped). args: { account, mailbox, uid }",
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
      doc: MAIL_SHAPE[short] ? op.doc + SHAPE_HINT : op.doc,
    };
  });
  return conn;
}

// Default projections for envelope listings: subjects and addresses are what a
// caller needs to choose a message, not whole MIME envelopes.
const SHAPE_HINT = ' Returns a summary; pass fields: ["..."] or full: true for the raw object.';

const MAIL_SHAPE: Record<string, string[]> = {
  "messages.list": ["uid", "subject", "from", "date", "flags"],
  "messages.search": ["mailbox", "uids"],
};
