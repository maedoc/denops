import { assertEquals } from "jsr:@std/assert@1";
import { shapeResult } from "../src/connectors/shape.ts";
import { MAIL_SHAPE } from "../src/connectors/imap/manifest.ts";

// messages.list wraps its results: the wrapper keys must survive the projection
// (projecting the wrapper onto message fields silently returned `{}`).
Deno.test("messages.list summary keeps wrapper keys and trims envelopes", () => {
  const listed = {
    mailbox: "INBOX",
    total: 2,
    page: 1,
    limit: 50,
    messages: [
      {
        uid: 11,
        seq: 1,
        subject: "hello",
        from: [{ name: "A", address: "a@example.org" }],
        to: [{ name: "B", address: "b@example.org" }],
        date: "2026-10-31T09:00:00.000Z",
        flags: ["\\Seen"],
      },
      {
        uid: 12,
        seq: 2,
        subject: "world",
        from: [{ name: "C", address: "c@example.org" }],
        to: [],
        date: "2026-10-31T08:00:00.000Z",
        flags: [],
      },
    ],
  };
  assertEquals(shapeResult(listed, MAIL_SHAPE["messages.list"], {}), {
    mailbox: "INBOX",
    total: 2,
    page: 1,
    limit: 50,
    messages: [
      {
        uid: 11,
        subject: "hello",
        from: [{ name: "A", address: "a@example.org" }],
        date: "2026-10-31T09:00:00.000Z",
        flags: ["\\Seen"],
      },
      {
        uid: 12,
        subject: "world",
        from: [{ name: "C", address: "c@example.org" }],
        date: "2026-10-31T08:00:00.000Z",
        flags: [],
      },
    ],
  });

  const full = shapeResult(listed, MAIL_SHAPE["messages.list"], { full: true });
  assertEquals((full as { messages: Array<Record<string, unknown>> }).messages[0].to, [
    { name: "B", address: "b@example.org" },
  ]);
  assertEquals(shapeResult(listed, MAIL_SHAPE["messages.list"], { fields: ["total"] }), {
    total: 2,
  });
});

// search used to return bare uids, forcing a second paginated list-and-filter
// pass to learn anything about the matches.
Deno.test("messages.search summary carries envelopes with the uids", () => {
  const searched = {
    mailbox: "INBOX",
    count: 1,
    messages: [
      {
        uid: 11,
        seq: 1,
        subject: "hello",
        from: [{ name: "A", address: "a@example.org" }],
        to: [{ name: "B", address: "b@example.org" }],
        date: "2026-10-31T09:00:00.000Z",
        flags: ["\\Seen"],
      },
    ],
  };
  assertEquals(shapeResult(searched, MAIL_SHAPE["messages.search"], {}), {
    mailbox: "INBOX",
    count: 1,
    messages: [{
      uid: 11,
      subject: "hello",
      from: [{ name: "A", address: "a@example.org" }],
      date: "2026-10-31T09:00:00.000Z",
      flags: ["\\Seen"],
    }],
  });
});
