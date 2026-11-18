import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { imapConnector } from "../src/connectors/imap/manifest.ts";
import {
  draftFromAllowlist,
  ImapAccountClient,
  type ImapAccountConfig,
} from "../src/connectors/imap/client.ts";

// No connection is ever attempted: these tests exercise the connection
// lifecycle wiring only, using host/port that would fail immediately if used.
const cfg: ImapAccountConfig = {
  id: "test",
  host: "127.0.0.1",
  port: 1,
  tls: false,
  user: "user",
  password: "pass",
  draftsMailbox: "Drafts",
};

function internals(acct: ImapAccountClient) {
  return acct as unknown as {
    client: {
      listenerCount(event: string): number;
      emit(event: string, ...args: unknown[]): boolean;
      socketTimeout: number;
    };
    connected: boolean;
    connError: Error | null;
  };
}

// Regression: imapflow reports a background socket timeout (5 min of inactivity
// by default), a server BYE, or a dropped tunnel through the 'error' event. An
// unhandled 'error' event is fatal in Deno, so a single idle connection used to
// take the whole server process down minutes after the last mail op.
Deno.test("imap client survives a background connection error", () => {
  const acct = new ImapAccountClient(cfg);
  const inner = internals(acct);

  assertEquals(inner.client.listenerCount("error"), 1, "an 'error' listener must be attached");
  assertEquals(inner.client.listenerCount("close"), 1, "a 'close' listener must be attached");

  inner.connected = true;
  inner.client.emit("error", new Error("Socket timeout"));

  assertEquals(inner.connected, false, "a dead connection must not be reused");
  assertEquals(inner.connError?.message, "Socket timeout");
});

Deno.test("imap client accepts a socket timeout override", () => {
  const acct = new ImapAccountClient({ ...cfg, socketTimeoutMs: 1234 });
  assertEquals(internals(acct).client.socketTimeout, 1234);
});

// drafts.save's From allowlist: the amu account needs drafts to go out as
// marmaduke.woodman@univ-amu.fr, a different identity from the IMAP login. The
// allowlist is config (the account's own address plus `aliases`), so a caller
// cannot pick an arbitrary From — a spoofed one is an invalid-args error, before
// anything is appended.
const aliasCfg: ImapAccountConfig = {
  ...cfg,
  id: "amu",
  user: "woodman.m@univ-amu.fr",
  aliases: ["marmaduke.woodman@univ-amu.fr"],
};

function draftsArgSchema() {
  const conn = imapConnector({ accounts: [aliasCfg] });
  const op = conn.ops.find((o) => o.name === "mail.drafts.save");
  if (!op) throw new Error("mail.drafts.save not registered");
  return op.argSchema;
}

Deno.test("drafts.save accepts a from that is the account identity or an alias", () => {
  const check = draftsArgSchema();
  const base = { account: "amu", body: "x", subject: "s", to: ["a@b.example"] };
  assertEquals(check({ ...base }), null, "default is unchanged: no from");
  assertEquals(
    check({ ...base, from: aliasCfg.user }),
    null,
    "the account's own address is always allowed",
  );
  assertEquals(
    check({ ...base, from: "Marmaduke.Woodman@univ-amu.fr" }),
    null,
    "aliases match case-insensitively",
  );
});

Deno.test("drafts.save rejects a from outside the allowlist, before the client runs", () => {
  const check = draftsArgSchema();
  const base = { account: "amu", body: "x", subject: "s", to: ["a@b.example"] };
  const err = check({ ...base, from: "someone.else@univ-amu.fr" });
  assertStringIncludes(
    String(err),
    "is not the account's own address or one of its configured aliases",
  );
  assertEquals(check({ ...base, from: "not-an-address" }), "from: expected an email address");
  // an unknown account is not an arg-schema concern (acc only rejects missing/empty):
  // the from allowlist is skipped for it, and the run fails at account resolution
  assertEquals(
    check({ account: "nope", body: "x", subject: "s", to: ["a@b.example"], from: aliasCfg.user }),
    null,
  );
});

Deno.test("drafts.save flags unknown arg names instead of dropping them", () => {
  const check = draftsArgSchema();
  const err = check({ account: "amu", body: "x", frm: "marmaduke.woodman@univ-amu.fr" });
  assertStringIncludes(
    String(err),
    "unknown arg 'frm'; allowed: account, subject, to, body, from, replyTo, includeQuote",
  );
});

Deno.test("draftFromAllowlist: own identity first, then aliases; host fallback without a domain", () => {
  assertEquals(draftFromAllowlist(aliasCfg), [
    "woodman.m@univ-amu.fr",
    "marmaduke.woodman@univ-amu.fr",
  ]);
  assertEquals(draftFromAllowlist(cfg), ["user@127.0.0.1"]);
  assertEquals(
    draftFromAllowlist({ ...cfg, messageIdDomain: "example.org" }),
    ["user@example.org"],
  );
});
