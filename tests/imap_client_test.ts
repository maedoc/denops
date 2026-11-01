import { assertEquals } from "jsr:@std/assert@1";
import { ImapAccountClient, type ImapAccountConfig } from "../src/connectors/imap/client.ts";

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
