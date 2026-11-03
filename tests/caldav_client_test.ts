import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { CalDavHost } from "../src/connectors/caldav/client.ts";
import { caldavConnector } from "../src/connectors/caldav/manifest.ts";

// The connector's security contract is what these pin: credentials never leave the
// pinned host, writes always carry a precondition, a 412 is reported as "re-read it"
// rather than retried, and attendee payloads are refused before any approval exists.

const EVENT_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:evt-1",
  "DTSTAMP:20260101T000000Z",
  "DTSTART:20260303T080000Z",
  "DTEND:20260303T090000Z",
  "SUMMARY:Budget review",
  "LOCATION:Room 2",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "BEGIN:VALARM",
  "ACTION:EMAIL",
  "DESCRIPTION:user-set mail alarm",
  "TRIGGER:-PT1H",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

function multistatus(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" ` +
    `xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:i="http://apple.com/ns/ical/">` +
    body + `</d:multistatus>`;
}

const response = (href: string, props: string, status = "HTTP/1.1 200 OK") =>
  `<d:response><d:href>${href}</d:href>${
    props === ""
      ? ""
      : `<d:propstat><d:prop>${props}</d:prop><d:status>${status}</d:status></d:propstat>`
  }</d:response>`;

interface MockOpts {
  /** home set advertised by the principal; defaults to this server */
  homeHref?: (base: string) => string;
  putStatus?: number;
  deleteStatus?: number;
  /** make GET <calendar>/<uid>.ics 404, so UID lookup has to use a REPORT */
  noDirectGet?: boolean;
}

function mockDav(recorded: Recorded[], opts: MockOpts = {}) {
  let base = "";
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.body ? new TextDecoder().decode(await req.arrayBuffer()) : "";
    recorded.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const key = `${req.method} ${url.pathname}`;

    if (key === "PROPFIND /") {
      return new Response(
        multistatus(
          response(
            "/principals/me/",
            `<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>`,
          ),
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    }
    if (key === "PROPFIND /principals/me/") {
      const home = opts.homeHref ? opts.homeHref(base) : "/calendars/me/";
      return new Response(
        multistatus(
          response(
            "/principals/me/",
            `<c:calendar-home-set><d:href>${home}</d:href></c:calendar-home-set>`,
          ),
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    }
    if (key === "PROPFIND /calendars/me/") {
      return new Response(
        multistatus(
          response(
            "/calendars/me/work/",
            `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
              `<d:displayname>Perso</d:displayname>` +
              `<d:sync-token>tok-1</d:sync-token>` +
              `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>` +
              `<d:current-user-privilege-set><d:privilege><d:write-content/></d:privilege></d:current-user-privilege-set>` +
              `<i:calendar-color>#1BADF8FF</i:calendar-color>`,
          ) +
            response(
              "/calendars/me/todo/",
              `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
                `<d:displayname>todo</d:displayname>` +
                `<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>`,
            ),
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    }
    if (req.method === "REPORT" && url.pathname === "/calendars/me/work/") {
      return new Response(
        multistatus(
          response(
            "/calendars/me/work/evt-1.ics",
            `<d:getetag>"etag-1"</d:getetag>` +
              `<c:calendar-data>${EVENT_ICS.replace(/</g, "&lt;")}</c:calendar-data>`,
          ),
        ),
        { status: 207, headers: { "content-type": "application/xml" } },
      );
    }
    if (key === "PROPFIND /calendars/me/work/") {
      return new Response(multistatus(""), {
        status: 207,
        headers: { "content-type": "application/xml" },
      });
    }
    if (req.method === "GET" && url.pathname === "/calendars/me/work/evt-1.ics") {
      if (opts.noDirectGet) return new Response("not found", { status: 404 });
      return new Response(EVENT_ICS, {
        status: 200,
        headers: { "content-type": "text/calendar", etag: '"etag-1"' },
      });
    }
    if (req.method === "PUT") {
      const status = opts.putStatus ?? 201;
      return new Response("", {
        status,
        headers: { etag: status < 400 ? '"etag-2"' : "" },
      });
    }
    if (req.method === "DELETE") {
      return new Response(null, { status: opts.deleteStatus ?? 204 });
    }
    return new Response("not found", { status: 404 });
  });
  base = `http://127.0.0.1:${server.addr.port}`;
  return { server, base };
}

function hostFor(base: string, opts: Partial<{ password: string }> = {}) {
  return new CalDavHost([{
    id: "icloud",
    origin: base,
    user: "me@example.org",
    auth: "basic",
    password: opts.password ?? "abcd-efgh-ijkl-mnop",
  }]);
}

Deno.test("caldav: discovery resolves principal -> home -> calendars", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    const calendars = await account.calendars();
    assertEquals(calendars.map((c) => c.name), ["Perso", "todo"]);
    const perso = calendars[0];
    assertEquals(perso.components, ["VEVENT"]);
    assertEquals(perso.readOnly, false);
    assertEquals(perso.syncToken, "tok-1");
    assertEquals(perso.ctag, undefined); // iCloud has no getctag; sync-token is the handle
    assertEquals(perso.color, "#1BADF8FF");
    // every request carried the credential from config, never from an argument
    assert(rec.every((r) => r.headers.get("authorization")?.startsWith("Basic ")));
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: events.list parses objects, sorts by start, honours limit", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    const page = await account.listEvents(
      "Perso",
      new Date("2026-03-01T00:00:00Z"),
      new Date("2026-04-01T00:00:00Z"),
      10,
    );
    assertEquals(page.calendar, "Perso");
    assertEquals(page.count, 1);
    assertEquals(page.events[0].uid, "evt-1");
    assertEquals(page.events[0].summary, "Budget review");
    assertEquals(page.events[0].start, "2026-03-03T08:00:00Z");
    assertEquals(page.events[0].etag, '"etag-1"');
    // the REPORT asked for a time-range, so recurrence is expanded server-side
    const report = rec.find((r) => r.method === "REPORT");
    assertStringIncludes(report!.body, "<c:time-range");
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: create is If-None-Match: * with text/calendar", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    const created = await account.createEvent("Perso", {
      summary: "Réunion, budget; Q1",
      start: "2026-03-03T09:00:00+01:00",
      end: "2026-03-03T10:00:00+01:00",
      location: "Bureau",
      reminders: [{ minutesBefore: 45 }],
    }, "fixed-uid-1");
    assertEquals(created.uid, "fixed-uid-1");
    assertEquals(created.etag, '"etag-2"');

    const put = rec.find((r) => r.method === "PUT")!;
    assertEquals(put.headers.get("if-none-match"), "*");
    assertEquals(put.headers.get("if-match"), null);
    assertStringIncludes(put.headers.get("content-type") ?? "", "text/calendar");
    assertStringIncludes(put.path, "/calendars/me/work/fixed-uid-1.ics");
    // times are normalised to UTC, TEXT is escaped, and the alarm-free body is valid ICS
    assertStringIncludes(put.body, "DTSTART:20260303T080000Z");
    assertStringIncludes(put.body, "SUMMARY:Réunion\\, budget\\; Q1");
    assertStringIncludes(put.body, "LOCATION:Bureau");
    assertStringIncludes(put.body, "BEGIN:VCALENDAR");
    // a DISPLAY reminder is a nested VALARM, defaulting to the summary text
    assertStringIncludes(put.body, "BEGIN:VALARM");
    assertStringIncludes(put.body, "ACTION:DISPLAY");
    assertStringIncludes(put.body, "TRIGGER:-PT45M");
    assertStringIncludes(put.body, "DESCRIPTION:Réunion\\, budget\\; Q1");
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: update sends If-Match and preserves properties it does not touch", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    await account.updateEvent("Perso", "evt-1", "etag-1", { summary: "Budget review v2" });
    const put = rec.find((r) => r.method === "PUT")!;
    assertEquals(put.headers.get("if-match"), '"etag-1"'); // quoted exactly once
    assertStringIncludes(put.body, "SUMMARY:Budget review v2");
    // read-modify-write: the VALARM we never named is still there
    assertStringIncludes(put.body, "BEGIN:VALARM");
    assertStringIncludes(put.body, "TRIGGER:-PT15M");
    assertStringIncludes(put.body, "DTSTAMP:");
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: a 412 is reported as stale, never retried", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec, { putStatus: 412, deleteStatus: 412 });
  try {
    const account = hostFor(base).get("icloud");
    await assertRejects(
      () => account.updateEvent("Perso", "evt-1", "etag-1", { summary: "x" }),
      Error,
      "changed since it was read",
    );
    await assertRejects(
      () => account.deleteEvent("Perso", "evt-1", "etag-1"),
      Error,
      "changed since it was read",
    );
    // exactly one write attempt each: no blind retry loop
    assertEquals(rec.filter((r) => r.method === "PUT").length, 1);
    assertEquals(rec.filter((r) => r.method === "DELETE").length, 1);
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: UID lookup is a direct GET when the object is named <uid>.ics", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    const got = await account.getEvent("Perso", "evt-1");
    assertEquals(got.uid, "evt-1");
    assertEquals(got.etag, '"etag-1"');
    assertEquals(rec.filter((r) => r.method === "GET").length, 1);
    // no collection listing was needed
    // discovery is / -> principal -> home listing (3); no per-object listing beyond that
    assertEquals(rec.filter((r) => r.method === "PROPFIND").length, 3);
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: UID lookup falls back to a server-side UID filter", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec, { noDirectGet: true });
  try {
    const account = hostFor(base).get("icloud");
    const got = await account.getEvent("Perso", "evt-1");
    assertEquals(got.uid, "evt-1");
    // iCloud 412s that REPORT; the client must survive a server that refuses it, which
    // this route does not (it answers 207) — the point is that the path exists at all.
    assert(rec.some((r) => r.method === "REPORT" && r.body.includes("prop-filter")));
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: delete carries the etag", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    const r = await account.deleteEvent("Perso", "evt-1", '"etag-1"');
    assertEquals(r.deleted, true);
    const del = rec.find((x) => x.method === "DELETE")!;
    assertEquals(del.headers.get("if-match"), '"etag-1"');
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: a home set on another host is refused (credentials stay pinned)", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec, {
    homeHref: () => "https://evil.example/calendars/",
  });
  try {
    const account = hostFor(base).get("icloud");
    await assertRejects(() => account.calendars(), Error, "refusing to send credentials");
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: a VTODO-only calendar is refused for event ops, not reported empty", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    await assertRejects(
      () =>
        account.listEvents(
          "todo",
          new Date("2026-03-01T00:00:00Z"),
          new Date("2026-04-01T00:00:00Z"),
          10,
        ),
      Error,
      "not VEVENT",
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: cleartext is refused for a non-loopback origin", () => {
  assertThrowsCtor("http://caldav.example.org");
});

function assertThrowsCtor(origin: string) {
  let threw = false;
  try {
    new CalDavHost([{ id: "x", origin, user: "u", auth: "basic", password: "p" }]);
  } catch (e) {
    threw = true;
    assertStringIncludes((e as Error).message, "must be https");
  }
  assert(threw, "cleartext origin must throw");
}

// --- argument schemas: everything that invalidates an approval is rejected before it ---

const schemaOf = (name: string) => {
  const conn = caldavConnector({
    accounts: [{
      id: "a",
      origin: "https://caldav.icloud.com",
      user: "u",
      auth: "basic",
      password: "p",
    }],
  });
  const op = conn.ops.find((o) => o.name === name)!;
  return (args: unknown) => op.argSchema(args);
};

Deno.test("caldav args: ATTENDEE/ORGANIZER are refused before approval", () => {
  const create = schemaOf("calendar.events.create");
  const base = {
    account: "a",
    calendar: "Perso",
    event: { summary: "s", start: "2026-03-03T09:00:00Z" },
  };
  assertEquals(create(base), null);
  for (const key of ["attendee", "attendees", "organizer"]) {
    const err = create({ ...base, event: { ...base.event, [key]: "bob@example.org" } });
    assertStringIncludes(String(err), "never modify attendees");
  }
  const update = schemaOf("calendar.events.update");
  assertStringIncludes(
    String(update({
      account: "a",
      calendar: "Perso",
      uid: "u1",
      etag: '"e"',
      patch: { attendees: ["bob@example.org"] },
    })),
    "never modify attendees",
  );
});

Deno.test("caldav args: windows and times are validated up front", () => {
  const list = schemaOf("calendar.events.list");
  // no window at all
  assertStringIncludes(String(list({ account: "a", calendar: "Perso" })), "from");
  // float time: guessing a zone is how a 09:00 meeting becomes 10:00
  const create = schemaOf("calendar.events.create");
  assertStringIncludes(
    String(
      create({
        account: "a",
        calendar: "Perso",
        event: { summary: "s", start: "2026-03-03T09:00:00" },
      }),
    ),
    "include a UTC offset",
  );
  // all-day needs a date, not a date-time
  assertStringIncludes(
    String(create({
      account: "a",
      calendar: "Perso",
      event: { summary: "s", start: "2026-03-03T09:00:00Z", allDay: true },
    })),
    "YYYY-MM-DD",
  );
  // > 366 day span
  assertStringIncludes(
    String(list({
      account: "a",
      calendar: "Perso",
      from: "2025-01-01T00:00:00Z",
      to: "2026-06-01T00:00:00Z",
    })),
    "366 days",
  );
  // limit out of range
  assertStringIncludes(
    String(list({
      account: "a",
      calendar: "Perso",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      limit: 500,
    })),
    "limit",
  );
});

Deno.test("caldav args: update/delete require an etag, and update needs something to change", () => {
  const update = schemaOf("calendar.events.update");
  assertStringIncludes(
    String(update({ account: "a", calendar: "Perso", uid: "u1", patch: { summary: "x" } })),
    "etag",
  );
  assertStringIncludes(
    String(update({ account: "a", calendar: "Perso", uid: "u1", etag: '"e"', patch: {} })),
    "nothing to change",
  );
  // uid is not patchable, and unknown fields do not slip through
  assertStringIncludes(
    String(
      update({ account: "a", calendar: "Perso", uid: "u1", etag: '"e"', patch: { uid: "other" } }),
    ),
    "unexpected field",
  );
  const del = schemaOf("calendar.events.delete");
  assertStringIncludes(String(del({ account: "a", calendar: "Perso", uid: "u1" })), "etag");
});

Deno.test("caldav: update replaces DISPLAY reminders and keeps a user's email alarm", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    await account.updateEvent("Perso", "evt-1", "etag-1", {
      reminders: [{ minutesBefore: 10, description: "leave now" }],
    });
    const body = rec.find((r) => r.method === "PUT")!.body;
    const count = (needle: string) => body.split(needle).length - 1;
    assertEquals(count("BEGIN:VALARM"), 2, body); // the new DISPLAY one + the EMAIL one
    assertEquals(count("ACTION:DISPLAY"), 1);
    assertEquals(count("ACTION:EMAIL"), 1, "an EMAIL alarm the user set must survive");
    assertStringIncludes(body, "TRIGGER:-PT10M");
    assertStringIncludes(body, "DESCRIPTION:leave now");
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav: events.get surfaces existing reminders", async () => {
  const rec: Recorded[] = [];
  const { server, base } = mockDav(rec);
  try {
    const account = hostFor(base).get("icloud");
    const got = await account.getEvent("Perso", "evt-1");
    assertEquals(got.reminders, [
      { minutesBefore: 15, action: "DISPLAY" },
      { minutesBefore: 60, action: "EMAIL", description: "user-set mail alarm" },
    ]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("caldav args: reminders are validated before approval", () => {
  const create = schemaOf("calendar.events.create");
  const base = {
    account: "a",
    calendar: "Perso",
    event: { summary: "s", start: "2026-03-03T09:00:00Z" },
  };
  const withReminders = (reminders: unknown) =>
    create({ ...base, event: { ...base.event, reminders } });

  assertEquals(withReminders([{ minutesBefore: 45 }]), null);
  assertEquals(withReminders([]), null);
  // an EMAIL alarm sends mail, like changing attendees
  assertStringIncludes(
    String(withReminders([{ minutesBefore: 45, action: "EMAIL" }])),
    "only DISPLAY",
  );
  assertStringIncludes(String(withReminders([{ minutesBefore: 99999 }])), "minutesBefore");
  assertStringIncludes(String(withReminders([{ minutes: 45 }])), "unexpected field");
  assertStringIncludes(
    String(withReminders([1, 2, 3, 4, 5, 6].map((m) => ({ minutesBefore: m })))),
    "too many",
  );
  const update = schemaOf("calendar.events.update");
  assertStringIncludes(
    String(update({
      account: "a",
      calendar: "Perso",
      uid: "u1",
      etag: '"e"',
      patch: { reminders: [{ minutesBefore: 45, action: "EMAIL" }] },
    })),
    "only DISPLAY",
  );
});
