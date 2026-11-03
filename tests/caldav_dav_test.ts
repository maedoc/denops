import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  CALDAV,
  calendarMultigetBody,
  calendarQueryBody,
  DAV,
  okProp,
  okProps,
  parseMultiStatus,
  parseStatus,
  parseXml,
  propfindBody,
  syncCollectionBody,
  syncTokenOf,
  xmlEscape,
} from "../src/connectors/webdav.ts";

// The multistatus reader is the part of CalDAV that fails most expensively when it
// is wrong: a property read from the wrong propstat (or an href taken from the wrong
// element) silently syncs the wrong calendar. These pin the shapes Nextcloud and
// iCloud actually send.

const MULTIGET = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/calendars/me/personal/abc.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"e1-1"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
END:VCALENDAR</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/me/personal/gone.ics</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/me/personal/partial.ics</d:href>
    <d:propstat>
      <d:prop><d:getetag>"e2-1"</d:getetag></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><cal:schedule-tag/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

Deno.test("dav: multistatus keeps response-level status, propstats and hrefs apart", () => {
  const { responses } = parseMultiStatus(MULTIGET);
  assertEquals(responses.length, 3);

  assertEquals(responses[0].href, "/remote.php/dav/calendars/me/personal/abc.ics");
  assertEquals(responses[0].status, undefined);
  assertEquals(okProp(responses[0], "getetag")?.text, '"e1-1"');
  // calendar-data is a CalDAV property, matched by local name regardless of prefix
  assert(okProp(responses[0], "calendar-data")?.text.includes("BEGIN:VCALENDAR"));

  // a resource the server no longer has carries a response-level status
  assertEquals(responses[1].status, 404);
  assertEquals(okProps(responses[1]).length, 0);

  // propstats disagree: getetag is 200, schedule-tag is 404 — never read positionally
  assertEquals(okProps(responses[2]).map((p) => p.name), ["getetag"]);
  assertEquals(okProp(responses[2], "schedule-tag"), undefined);
});

Deno.test("dav: prefix, case and namespace declaration do not matter", () => {
  const variants = [
    `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/c/1.ics</D:href></D:response></D:multistatus>`,
    `<multistatus xmlns="DAV:"><response><href>/c/1.ics</href></response></multistatus>`,
    // undeclared prefix: matched by local name rather than failing the whole sync
    `<x:multistatus><x:response><x:href>/c/1.ics</x:href></x:response></x:multistatus>`,
  ];
  for (const xml of variants) {
    assertEquals(parseMultiStatus(xml).responses.map((r) => r.href), ["/c/1.ics"]);
  }
});

Deno.test("dav: hostile XML is refused, not interpreted", () => {
  // A DOCTYPE can declare entities; refusing it removes the XXE class outright.
  assertThrows(
    () => parseXml(`<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`),
    Error,
    "DOCTYPE",
  );
  // no custom entity expansion (billion laughs needs this door to be open)
  assertThrows(() => parseXml(`<x>&lol1;</x>`), Error, "unknown entity");
  // but the five predefined ones and numeric references are fine
  assertEquals(parseXml(`<x>a&amp;b&lt;c&#65;&#x42;</x>`).text, "a&b<cAB");
  // malformed structure is an error, not a guess
  assertThrows(() => parseXml(`<a><b></a></b>`), Error, "closes");
  assertThrows(() => parseXml(`<a><b></b>`), Error, "unclosed");
  assertThrows(() => parseXml(`<a/><b/>`), Error, "more than one root");
  assertThrows(() => parseXml(`<a attr=unquoted></a>`), Error, "quoted");
  // depth cap
  assertThrows(() => parseXml(`${"<a>".repeat(80)}${"</a>".repeat(80)}`), Error, "deeper");
});

Deno.test("dav: status lines parse, and junk does not", () => {
  assertEquals(parseStatus("HTTP/1.1 207 Multi-Status"), 207);
  assertEquals(parseStatus(" HTTP/2 412 Precondition Failed "), 412);
  assertThrows(() => parseStatus("200 OK"), Error, "unparsable");
});

Deno.test("dav: request bodies are well-formed and escape their inputs", () => {
  const propfind = propfindBody([{ ns: DAV, name: "displayname" }, {
    ns: CALDAV,
    name: "calendar-home-set",
  }]);
  assert(propfind.includes(`xmlns:d="${DAV}"`));
  assert(propfind.includes("<d:displayname/>"));
  assert(propfind.includes("<c:calendar-home-set/>"));

  const query = calendarQueryBody({ start: "20260301T000000Z", end: "20260401T000000Z" });
  assert(query.includes('<c:time-range start="20260301T000000Z" end="20260401T000000Z"/>'));
  assert(query.includes('<c:comp-filter name="VEVENT">'));

  const multiget = calendarMultigetBody(['/c/a"b.ics', "/c/2.ics"]);
  assert(multiget.includes("<d:href>/c/a&quot;b.ics</d:href>"));
  assertThrows(() => calendarMultigetBody([]), Error, "at least one href");

  assertEquals(xmlEscape("<a & b>"), "&lt;a &amp; b&gt;");

  const sync = syncCollectionBody("http://example.org/sync/42");
  assert(sync.includes("<d:sync-token>http://example.org/sync/42</d:sync-token>"));
});

Deno.test("dav: sync-collection token is read back out", () => {
  const xml = `<d:multistatus xmlns:d="DAV:">
     <d:response><d:href>/c/1.ics</d:href><d:propstat><d:prop><d:getetag>"x"</d:getetag></d:prop>` +
    `<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>` +
    `<d:sync-token>http://example.org/sync/43</d:sync-token>` +
    `</d:multistatus>`;
  assertEquals(syncTokenOf(xml), "http://example.org/sync/43");
  assertEquals(syncTokenOf(`<d:multistatus xmlns:d="DAV:"/>`), undefined);
});
