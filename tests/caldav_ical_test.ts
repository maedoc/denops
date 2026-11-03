import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  componentsNamed,
  durationOfMinutes,
  escapeText,
  foldLine,
  formatContentLine,
  getProp,
  objectsOf,
  parseContentLine,
  parseDurationMinutes,
  parseIcs,
  parseTime,
  removeProp,
  serializeIcs,
  setProp,
  timeRangeOf,
  unescapeText,
  unfoldLines,
  utcStamp,
} from "../src/connectors/caldav/ical.ts";

// What these guard: an update must never silently drop a property it did not
// understand (VALARM, ATTENDEE, VTIMEZONE, X-APPLE-*), and a long non-ASCII value
// must survive folding at 75 octets. Both are how a connector corrupts a user's
// calendar without anyone noticing until a reminder fails to fire.

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Nextcloud//CalDAV//EN",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Paris",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "UID:abc-123",
  "DTSTAMP:20260101T000000Z",
  "DTSTART;TZID=Europe/Paris:20260303T090000",
  "DTEND;TZID=Europe/Paris:20260303T100000",
  "SUMMARY:Réunion — budget",
  "DESCRIPTION:Ligne 1\\nLigne 2",
  "LOCATION:Bureau\\, 3e étage",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE=Bureau:geo:48.85,2.35",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

Deno.test("ical: parse keeps component tree, unknown properties and order", () => {
  const doc = parseIcs(SAMPLE);
  const events = objectsOf(doc);
  assertEquals(events.length, 1);
  const ev = events[0];
  assertEquals(ev.name, "VEVENT");
  assertEquals(
    ev.properties.map((p) => p.name),
    [
      "UID",
      "DTSTAMP",
      "DTSTART",
      "DTEND",
      "SUMMARY",
      "DESCRIPTION",
      "LOCATION",
      "RRULE",
      "X-APPLE-STRUCTURED-LOCATION",
    ],
  );
  // VTIMEZONE and VALARM are not interpreted, only carried
  assertEquals(componentsNamed(doc.components[0], "VTIMEZONE").length, 1);
  assertEquals(componentsNamed(ev, "VALARM").length, 1);

  assertEquals(unescapeText(getProp(ev, "SUMMARY")!.value), "Réunion — budget");
  assertEquals(unescapeText(getProp(ev, "DESCRIPTION")!.value), "Ligne 1\nLigne 2");
  assertEquals(unescapeText(getProp(ev, "LOCATION")!.value), "Bureau, 3e étage");
});

Deno.test("ical: serialize/parse round-trip is lossless for what we do not model", () => {
  const once = serializeIcs(parseIcs(SAMPLE));
  const twice = parseIcs(once);
  const a = objectsOf(parseIcs(SAMPLE))[0];
  const b = objectsOf(twice)[0];
  assertEquals(
    b.properties.map((p) => [p.name, p.params, p.value]),
    a.properties.map((p) => [p.name, p.params, p.value]),
  );
  // the nested alarm survives with its own properties intact
  const alarm = fields(componentsNamed(b, "VALARM")[0]);
  assertEquals(alarm, ["ACTION:DISPLAY", "TRIGGER:-PT15M"]);
});

function fields(c: { properties: Array<{ name: string; value: string }> }): string[] {
  return c.properties.map((p) => `${p.name}:${p.value}`);
}

Deno.test("ical: folding never splits a UTF-8 sequence and round-trips", () => {
  const long = "🎉 Réunion trimestrielle — " + "détails ".repeat(40);
  const doc = parseIcs(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:x",
      `SUMMARY:${escapeText(long)}`,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"),
  );
  const out = serializeIcs(doc);
  const encoder = new TextEncoder();
  for (const line of out.split("\r\n")) {
    assert(encoder.encode(line).length <= 75, `line longer than 75 octets: ${line.length}`);
  }
  // continuation lines exist (the value is longer than one line) and re-parse clean
  assert(out.split("\r\n").some((l) => l.startsWith(" ")));
  const back = objectsOf(parseIcs(out))[0];
  assertEquals(unescapeText(getProp(back, "SUMMARY")!.value), long);
});

Deno.test("ical: continuation lines with tab and CR-only endings unfold", () => {
  assertEquals(unfoldLines("SUMMARY:a\r\n b\r\n\tc\r\n"), ["SUMMARY:abc"]);
  assertEquals(unfoldLines("A:1\nB:2\n"), ["A:1", "B:2"]);
  assertThrows(() => unfoldLines(" folded first\n"), Error, "continuation");
});

Deno.test("ical: text escaping is reversible", () => {
  for (const value of ["a,b;c\\d", "line1\nline2", "plain", "\\n literal"]) {
    assertEquals(unescapeText(escapeText(value)), value);
  }
});

Deno.test("ical: parameters and group prefixes are parsed without being mangled", () => {
  const p = parseContentLine('ITEM1.X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE="a,b":geo:1,2');
  assertEquals(p.name, "ITEM1.X-APPLE-STRUCTURED-LOCATION");
  assertEquals(p.params, [{ name: "VALUE", values: ["URI"] }, {
    name: "X-TITLE",
    values: ["a,b"],
  }]);
  // the group prefix must survive a round-trip
  assertEquals(
    formatContentLine(p),
    'ITEM1.X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-TITLE="a,b":geo:1,2',
  );

  const ev = objectsOf(parseIcs(SAMPLE))[0];
  // getProp matches on the local name, so the group prefix does not hide a property
  assert(getProp(ev, "X-APPLE-STRUCTURED-LOCATION"));
});

Deno.test("ical: setProp edits in place, appends when absent, removeProp drops", () => {
  const ev = objectsOf(parseIcs(SAMPLE))[0];
  const before = ev.properties.map((p) => p.name);
  setProp(ev, "SUMMARY", escapeText("Nouveau titre"));
  assertEquals(ev.properties.map((p) => p.name), before); // position preserved
  assertEquals(unescapeText(getProp(ev, "SUMMARY")!.value), "Nouveau titre");

  setProp(ev, "CATEGORIES", escapeText("travail"));
  assertEquals(ev.properties[ev.properties.length - 1].name, "CATEGORIES");

  assert(removeProp(ev, "LOCATION"));
  assertEquals(getProp(ev, "LOCATION"), undefined);
  assertEquals(removeProp(ev, "LOCATION"), false);
});

Deno.test("ical: times are surfaced with their kind, never converted", () => {
  const ev = objectsOf(parseIcs(SAMPLE))[0];
  const range = timeRangeOf(ev);
  assertEquals(range.allDay, false);
  // a TZID stays a TZID: there is no tz database here to convert it with
  assertEquals(range.start, { kind: "tzid", value: "2026-03-03T09:00:00", tzid: "Europe/Paris" });

  assertEquals(parseTime("20260303T090000Z").kind, "utc");
  assertEquals(parseTime("20260303T090000"), { kind: "floating", value: "2026-03-03T09:00:00" });
  assertEquals(parseTime("20260303", [{ name: "VALUE", values: ["DATE"] }]), {
    kind: "date",
    value: "2026-03-03",
  });
  assertThrows(() => parseTime("not-a-time"), Error, "unparsable");

  const allDay = objectsOf(
    parseIcs(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260401\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    ),
  )[0];
  assertEquals(timeRangeOf(allDay).allDay, true);
});

Deno.test("ical: malformed documents are refused", () => {
  assertThrows(() => parseIcs("BEGIN:VCALENDAR\r\nSUMMARY:x\r\n"), Error, "unclosed");
  assertThrows(() => parseIcs("BEGIN:VEVENT\r\nEND:VCALENDAR\r\n"), Error, "closes");
  assertThrows(() => parseIcs("SUMMARY:x\r\n"), Error, "outside any component");
  assertThrows(() => parseIcs("BEGIN:VEVENT\r\nno-colon-here\r\nEND:VEVENT\r\n"), Error, "value");
});

Deno.test("ical: utcStamp is the CalDAV/iCalendar form", () => {
  assertEquals(utcStamp(new Date("2026-03-03T09:04:05Z")), "20260303T090405Z");
  // foldLine leaves a short line alone
  assertEquals(foldLine("UID:abc"), ["UID:abc"]);
});

Deno.test("ical: reminder durations round-trip in both directions", () => {
  assertEquals(durationOfMinutes(45), "-PT45M");
  assertEquals(durationOfMinutes(90), "-PT1H30M");
  assertEquals(durationOfMinutes(0), "PT0S");
  assertEquals(durationOfMinutes(-10), "PT10M"); // after the start
  assertEquals(durationOfMinutes(1440), "-PT24H");

  assertEquals(parseDurationMinutes("-PT45M"), -45);
  assertEquals(parseDurationMinutes("PT1H30M"), 90);
  assertEquals(parseDurationMinutes("-P1D"), -1440);
  assertEquals(parseDurationMinutes("PT0S"), 0);
  // an absolute TRIGGER (VALUE=DATE-TIME) is not a duration and must not be guessed
  assertEquals(parseDurationMinutes("20260101T000000Z"), undefined);

  for (const minutes of [0, 5, 45, 60, 90, 1440, -15]) {
    assertEquals(-parseDurationMinutes(durationOfMinutes(minutes))!, minutes);
  }
});
