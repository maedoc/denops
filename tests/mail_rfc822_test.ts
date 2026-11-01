import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  addressOf,
  composeDraft,
  messageIdTokens,
  newMessageId,
  parseMessage,
  quoteBlock,
  referencesChain,
  replySubject,
  splitHeadBody,
} from "../src/connectors/imap/rfc822.ts";
import {
  decodeQuotedPrintable,
  decodeRfc2047,
  htmlToText,
  sanitizeHeaderValue,
} from "../src/text.ts";

// Composing a threaded reply is all string work, so it is tested as string work —
// no IMAP server. These are the cases that silently break a conversation if wrong:
// a References chain that loses order, a doubled "Re:", a draft with no Message-ID,
// or a parent whose From/Subject was echoed into a header unescaped.

const PARENT = [
  "Return-Path: <sender@example.org>",
  "Message-ID: <parent-1@mail.example.org>",
  "References: <root-0@mail.example.org>",
  "From: Alice Example <alice@example.org>",
  "To: me@example.org",
  "Subject: =?UTF-8?B?UXVlc3Rpb24gw6AgcHJvcG9z?=",
  "Date: Fri, 30 Oct 2026 19:36:59 +0100",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>html version</p>",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Line one=2C with a comma",
  "soft broken line",
  "--b1--",
  "",
].join("\r\n");

Deno.test("parseMessage extracts threading headers and the text/plain part", () => {
  const p = parseMessage(PARENT);
  assertEquals(p.messageId, "<parent-1@mail.example.org>");
  assertEquals(p.references, ["<root-0@mail.example.org>"]);
  assertEquals(p.inReplyTo, undefined);
  assertEquals(addressOf(p.from), "alice@example.org");
  assertEquals(p.subject, "Question à propos", "RFC 2047 subject must be decoded");
  assertStringIncludes(p.text, "Line one, with a comma");
  assertStringIncludes(p.text, "soft broken line");
  assert(!p.text.includes("html version"), "the html alternative is not the quoted text");
});

Deno.test("references chain keeps the parent's order and appends its Message-ID last", () => {
  assertEquals(
    referencesChain({
      references: ["<a@x>", "<b@x>"],
      messageId: "<c@x>",
    }),
    ["<a@x>", "<b@x>", "<c@x>"],
  );
  // a parent that already ends with its own id must not duplicate it
  assertEquals(
    referencesChain({ references: ["<a@x>", "<c@x>"], messageId: "<c@x>" }),
    ["<a@x>", "<c@x>"],
  );
  // nothing to chain: no References header at all
  assertEquals(referencesChain({ references: [] }), []);
  // References without a Message-ID still carry the thread
  assertEquals(referencesChain({ references: ["<a@x>"] }), ["<a@x>"]);
});

Deno.test("replySubject never doubles Re: and honours an explicit override", () => {
  assertEquals(replySubject("Upcoming Model Removals"), "Re: Upcoming Model Removals");
  assertEquals(replySubject("Re: Upcoming Model Removals"), "Re: Upcoming Model Removals");
  assertEquals(replySubject("RE: loud"), "RE: loud");
  assertEquals(replySubject("re: lower"), "re: lower");
  assertEquals(replySubject("  spaced  "), "Re: spaced");
  assertEquals(replySubject("anything", "Custom subject"), "Custom subject");
  assertEquals(replySubject(undefined), "Re:");
  // a newline in the parent subject must not become a second header
  const injected = replySubject("hello\r\nBcc: evil@example.org");
  assert(!injected.includes("\n") && !injected.includes("\r"), injected);
  assertEquals(injected, "Re: hello Bcc: evil@example.org");
});

Deno.test("composeDraft emits the full header set, sanitised, with CRLF bodies", () => {
  const messageId = newMessageId("univ-amu.fr", "11111111-2222-3333-4444-555555555555");
  assertEquals(messageId, "<11111111-2222-3333-4444-555555555555@univ-amu.fr>");

  const raw = composeDraft({
    from: "me@univ-amu.fr",
    to: ["alice@example.org"],
    subject: replySubject("Upcoming Model Removals"),
    date: new Date("2026-11-01T16:42:19Z"),
    messageId,
    inReplyTo: "<parent-1@mail.example.org>",
    references: ["<root-0@mail.example.org>", "<parent-1@mail.example.org>"],
  }, "Reply text\r\nsecond line");

  const { head, body } = splitHeadBody(raw);
  const headers = head.split("\r\n");
  assert(headers.includes(`Message-ID: ${messageId}`));
  assert(headers.includes("In-Reply-To: <parent-1@mail.example.org>"));
  assert(
    headers.includes("References: <root-0@mail.example.org> <parent-1@mail.example.org>"),
    "References must be space-joined in order",
  );
  assert(headers.includes("MIME-Version: 1.0"));
  assert(headers.includes("Content-Type: text/plain; charset=utf-8"));
  const dateHeader = headers.find((h) => h.startsWith("Date: "))!;
  assert(
    /^Date: [A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(
      dateHeader,
    ),
    `expected an RFC 5322 date, got ${dateHeader}`,
  );
  assertEquals(body, "Reply text\r\nsecond line\r\n");
});

Deno.test("composeDraft omits empty threading headers and encodes non-ASCII subjects", () => {
  const raw = composeDraft({
    from: "me@example.org",
    to: ["a@b.example"],
    subject: "Réponse — très important",
    date: new Date("2026-11-01T00:00:00Z"),
    messageId: "<x@example.org>",
    references: [],
  }, "hi");
  const { head } = splitHeadBody(raw);
  assert(!head.includes("In-Reply-To:"), "no parent, no In-Reply-To");
  assert(!head.includes("References:"), "empty chain ⇒ header omitted");
  assert(head.includes("Subject: =?UTF-8?B?"), "non-ASCII subject must be an encoded word");
  const decoded = head.split("\r\n").find((l) => l.startsWith("Subject: "))!.slice(9);
  assertEquals(decodeRfc2047(decoded), "Réponse — très important");
});

Deno.test("newMessageId refuses a non-domain so threading never ships a bogus id", () => {
  for (const bad of ["", "no-dot", "@@@", "space here", "a@b@c"]) {
    let msg = "";
    try {
      newMessageId(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "Message-ID", `expected refusal for ${JSON.stringify(bad)}`);
  }
});

Deno.test("quoteBlock attributes and prefixes the parent text", () => {
  const q = quoteBlock({
    text: "first line\n\nthird line",
    date: "Fri, 30 Oct 2026 19:36:59 +0100",
    from: "Alice <alice@example.org>",
  });
  assertEquals(
    q,
    "On Fri, 30 Oct 2026 19:36:59 +0100, Alice <alice@example.org> wrote:\n" +
      "> first line\n>\n> third line",
  );
});

Deno.test("text codecs: quoted-printable, RFC 2047, header sanitising, html", () => {
  assertEquals(decodeQuotedPrintable("a=3Db=0Aline"), "a=b\nline");
  assertEquals(decodeQuotedPrintable("soft=\nbreak"), "softbreak");
  assertEquals(decodeQuotedPrintable("caf=C3=A9"), "café");
  assertEquals(decodeRfc2047("=?UTF-8?Q?caf=C3=A9?="), "café");
  assertEquals(decodeRfc2047("plain ascii"), "plain ascii");
  assertEquals(sanitizeHeaderValue("a\r\nBcc: x\ttabbed"), "a Bcc: x tabbed");
  const text = htmlToText(
    "<html><head><style>p{color:red}</style></head><body><h1>Title</h1><p>One &amp; two</p>" +
      "<script>x()</script><ul><li>a</li><li>b</li></ul></body></html>",
  );
  assertStringIncludes(text, "Title");
  assertStringIncludes(text, "One & two");
  assertStringIncludes(text, "- a");
  assert(!text.includes("color:red") && !text.includes("x()"));
});

Deno.test("messageIdTokens tolerates malformed upstream values", () => {
  assertEquals(messageIdTokens("<a@x> <b@x>"), ["<a@x>", "<b@x>"]);
  assertEquals(messageIdTokens("noless@x"), ["<noless@x>"]);
  assertEquals(messageIdTokens(undefined), []);
});
