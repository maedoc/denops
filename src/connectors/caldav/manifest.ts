// Calendar (CalDAV) connector: read events, and write them under ETag discipline.
//
// Two boundaries are drawn here, in argSchema/precheck, before any approval prompt:
//
//  * **No attendee writes.** iCloud advertises calendar-auto-schedule, so a PUT that
//    changes ATTENDEE can make the server email real invitations. Payloads carrying
//    attendee/organizer fields are refused outright; an update preserves whatever
//    attendees the event already had, untouched.
//  * **Bounded windows.** A single calendar with 332 events serialises to ~1.3 MB, so
//    every listing requires from/to (≤ 366 days) and a limit. An unbounded "list my
//    calendar" is rejected rather than silently truncated.
//
// Writes are approval-tier and name the event, the calendar and the etags involved.

import { compose, optArr, optNum, optStr, rejectUnknown, str } from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
import { checkShapeArgs, wrapClient } from "../shape.ts";
import {
  type CalDavAccountConfig,
  CalDavHost,
  type CalDavHostOptions,
  type EventInput,
} from "./client.ts";

export interface CalDavConnectorDeps extends CalDavHostOptions {
  accounts: CalDavAccountConfig[];
}

const MAX_SPAN_MS = 366 * 24 * 60 * 60 * 1000;
const SHAPE_HINT =
  ' Returns a summary; pass fields: ["..."] or full: true for the raw object (full includes the ICS).';

/** Times must carry an offset: guessing a zone is how a 09:00 meeting becomes 10:00. */
const OFFSET = /(Z|z|[+-]\d{2}:?\d{2})$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function timeError(field: string, value: unknown, allDay: boolean): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return `${field}: expected an ISO 8601 string`;
  }
  if (allDay) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
      ? null
      : `${field}: all-day events need a YYYY-MM-DD date`;
  }
  if (!OFFSET.test(value.trim())) {
    return `${field}: include a UTC offset (2026-03-03T09:00:00+01:00 or …Z), or pass allDay: true`;
  }
  return Number.isNaN(new Date(value).getTime()) ? `${field}: not a valid date-time` : null;
}

const FORBIDDEN = ["attendee", "attendees", "organizer"];

function attendeeError(field: string, value: unknown): string | null {
  if (!isRecord(value)) return `${field}: expected an object`;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.includes(key.toLowerCase())) {
      return `${field}.${key}: refused — writes never modify attendees (iCloud auto-schedules ` +
        `invitations, so this would email people). Change attendees in a calendar client.`;
    }
  }
  return null;
}

function windowError(field: string, from: unknown, to: unknown): string | null {
  for (const [name, value] of [["from", from], ["to", to]] as const) {
    if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
      return `${field}.${name}: expected an ISO 8601 date-time`;
    }
  }
  const start = new Date(String(from)).getTime();
  const end = new Date(String(to)).getTime();
  if (end <= start) return `${field}: to must be after from`;
  if (end - start > MAX_SPAN_MS) return `${field}: range wider than 366 days; narrow it`;
  return null;
}

export function caldavConnector(deps: CalDavConnectorDeps): Connector {
  const host = new CalDavHost(deps.accounts, {
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.maxBytes === undefined ? {} : { maxBytes: deps.maxBytes }),
  });

  const acc = str("account");
  const cal = str("calendar");

  const eventCreateSchema = (field: string) => (a: unknown): string | null => {
    if (!isRecord(a)) return `${field}: expected an object`;
    const attendee = attendeeError(field, a);
    if (attendee) return attendee;
    const allowed = [
      "summary",
      "start",
      "end",
      "allDay",
      "description",
      "location",
      "rrule",
      "uid",
    ];
    for (const key of Object.keys(a)) {
      if (!allowed.includes(key)) {
        return `${field}: unexpected field "${key}" (allowed: ${allowed.join(", ")})`;
      }
    }
    if (typeof a.summary !== "string" || a.summary.trim() === "") {
      return `${field}.summary: expected a non-empty string`;
    }
    if (a.summary.length > 1024) return `${field}.summary: too long (max 1024)`;
    const allDay = a.allDay === true;
    const startError = timeError(`${field}.start`, a.start, allDay);
    if (startError) return startError;
    if (a.end !== undefined) {
      const endError = timeError(`${field}.end`, a.end, allDay);
      if (endError) return endError;
      const startMs = Date.parse(String(a.start));
      const endMs = Date.parse(String(a.end));
      if (allDay) {
        if (String(a.end) < String(a.start)) return `${field}.end: must not precede start`;
      } else if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs <= startMs) {
        return `${field}.end: must be after start`;
      }
    }
    if (a.description !== undefined) {
      if (typeof a.description !== "string") return `${field}.description: expected a string`;
      if (a.description.length > 8000) return `${field}.description: too long (max 8000)`;
    }
    if (a.location !== undefined) {
      if (typeof a.location !== "string") return `${field}.location: expected a string`;
      if (a.location.length > 512) return `${field}.location: too long (max 512)`;
    }
    if (a.rrule !== undefined) {
      if (typeof a.rrule !== "string" || !/^FREQ=/i.test(a.rrule.trim())) {
        return `${field}.rrule: expected an RRULE value starting with FREQ=`;
      }
      if (a.rrule.length > 256) return `${field}.rrule: too long (max 256)`;
    }
    if (
      a.uid !== undefined && (typeof a.uid !== "string" || a.uid.length === 0 || a.uid.length > 256)
    ) {
      return `${field}.uid: expected a 1..256 char string`;
    }
    if (a.allDay !== undefined && typeof a.allDay !== "boolean") {
      return `${field}.allDay: expected boolean`;
    }
    return null;
  };

  const patchSchema = (field: string) => (a: unknown): string | null => {
    if (!isRecord(a)) return `${field}: expected an object`;
    const attendee = attendeeError(field, a);
    if (attendee) return attendee;
    const allowed = ["summary", "start", "end", "allDay", "description", "location", "rrule"];
    const keys = Object.keys(a);
    for (const key of keys) {
      if (!allowed.includes(key)) {
        return `${field}: unexpected field "${key}" (allowed: ${allowed.join(", ")}; ` +
          `uid and attendees are not editable)`;
      }
    }
    if (keys.length === 0) return `${field}: nothing to change`;
    const allDay = a.allDay === true;
    if (a.summary !== undefined) {
      if (typeof a.summary !== "string" || a.summary.trim() === "") {
        return `${field}.summary: expected a non-empty string`;
      }
      if (a.summary.length > 1024) return `${field}.summary: too long (max 1024)`;
    }
    if (a.start !== undefined) {
      const err = timeError(`${field}.start`, a.start, allDay);
      if (err) return err;
    }
    if (a.end !== undefined) {
      const err = timeError(`${field}.end`, a.end, allDay);
      if (err) return err;
    }
    if (a.description !== undefined && typeof a.description !== "string") {
      return `${field}.description: expected a string (empty clears it)`;
    }
    if (a.location !== undefined) {
      if (typeof a.location !== "string") return `${field}.location: expected a string`;
      if (a.location.length > 512) return `${field}.location: too long (max 512)`;
    }
    if (a.rrule !== undefined && (typeof a.rrule !== "string" || !/^FREQ=/i.test(a.rrule.trim()))) {
      return `${field}.rrule: expected an RRULE value starting with FREQ=`;
    }
    return null;
  };

  const client = (ctx: HostContext) => {
    const wrap = <A extends JsonValue>(
      op: string,
      fn: (a: A) => Promise<JsonValue>,
    ): (a: JsonValue) => Promise<JsonValue> =>
    async (a: JsonValue) => {
      ctx.log({ connector: "calendar", op: `calendar.${op}`, args: a });
      return await fn(a as A);
    };
    return {
      "accounts": wrap(
        "accounts",
        (): Promise<JsonValue> => Promise.resolve({ accounts: host.ids() } as JsonValue),
      ),
      "calendars.list": wrap("calendars.list", async (a) => {
        const account = host.get(String((a as { account: string }).account));
        const calendars = await account.calendars();
        return {
          account: account.id,
          count: calendars.length,
          calendars: calendars.map((c) => ({
            calendar: c.name,
            components: c.components,
            readOnly: c.readOnly,
            ...(c.ctag ? { ctag: c.ctag } : {}),
            ...(c.syncToken ? { syncToken: Boolean(c.syncToken) } : {}),
            ...(c.color ? { color: c.color } : {}),
            href: c.href,
          })),
        } as JsonValue;
      }),
      "events.list": wrap("events.list", async (a) => {
        const r = a as {
          account: string;
          calendar: string;
          from: string;
          to: string;
          limit?: number;
        };
        return await host.get(r.account).listEvents(
          r.calendar,
          new Date(r.from),
          new Date(r.to),
          Math.min(r.limit ?? 50, 200),
        ) as unknown as JsonValue;
      }),
      "events.get": wrap("events.get", async (a) => {
        const r = a as { account: string; calendar: string; uid: string; maxBytes?: number };
        return await host.get(r.account).getEvent(
          r.calendar,
          r.uid,
          r.maxBytes,
        ) as unknown as JsonValue;
      }),
      "events.search": wrap("events.search", async (a) => {
        const r = a as {
          account: string;
          calendars?: string[];
          query: string;
          from?: string;
          to?: string;
          limit?: number;
        };
        const now = Date.now();
        const from = r.from ? new Date(r.from) : new Date(now - 30 * 24 * 3600 * 1000);
        const to = r.to ? new Date(r.to) : new Date(+from + 30 * 24 * 3600 * 1000);
        return await host.get(r.account).search(
          r.calendars,
          r.query,
          from,
          to,
          Math.min(r.limit ?? 20, 100),
        ) as unknown as JsonValue;
      }),
      "events.create": wrap("events.create", async (a) => {
        const r = a as unknown as { account: string; calendar: string; event: EventInput };
        return await host.get(r.account).createEvent(r.calendar, r.event) as unknown as JsonValue;
      }),
      "events.update": wrap("events.update", async (a) => {
        const r = a as {
          account: string;
          calendar: string;
          uid: string;
          etag: string;
          patch: Record<string, unknown>;
        };
        return await host.get(r.account).updateEvent(
          r.calendar,
          r.uid,
          r.etag,
          r.patch,
        ) as unknown as JsonValue;
      }),
      "events.delete": wrap("events.delete", async (a) => {
        const r = a as { account: string; calendar: string; uid: string; etag: string };
        return await host.get(r.account).deleteEvent(
          r.calendar,
          r.uid,
          r.etag,
        ) as unknown as JsonValue;
      }),
    };
  };

  const conn: Connector = {
    id: "calendar",
    ops: [
      {
        name: "calendar.accounts",
        tier: "open",
        doc: "CalDAV accounts this deployment exposes (ids only, never credentials). args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "calendar.calendars.list",
        tier: "open",
        doc: "List calendars (collections) for an account. args: { account }. Returns " +
          "{ account, count, calendars: [{ calendar, components, readOnly, ctag?, syncToken?, color?, href }] }. " +
          "`components` says what a collection holds (VEVENT/VTODO): event ops are VEVENT-only, so " +
          "a VTODO calendar is refused rather than reported as empty." + SHAPE_HINT,
        argSchema: compose(rejectUnknown(), acc),
      },
      {
        name: "calendar.events.list",
        tier: "open",
        doc: "Events overlapping a bounded window, expanded server-side (recurrence included, " +
          "no RRULE engine here). args: { account, calendar, from, to, limit? } — from/to are " +
          "ISO 8601 and the span is capped at 366 days; a whole calendar can be > 1 MB, so an " +
          "unbounded listing is refused. Returns { account, calendar, count, events: [{ uid, href, " +
          "etag, summary, start, end, allDay, location, recurring }] } sorted by start." +
          SHAPE_HINT,
        argSchema: compose(
          rejectUnknown(),
          acc,
          cal,
          str("from"),
          str("to"),
          optNum("limit"),
          (a) => {
            const r = a as { from?: unknown; to?: unknown; limit?: unknown };
            const range = windowError("window", r.from, r.to);
            if (range) return range;
            if (
              r.limit !== undefined && (typeof r.limit !== "number" || r.limit < 1 || r.limit > 200)
            ) {
              return "limit: expected 1..200";
            }
            return null;
          },
        ),
      },
      {
        name: "calendar.events.get",
        tier: "open",
        doc:
          "One event by UID, located with a server-side UID filter (the href is a server detail). " +
          "args: { account, calendar, uid, maxBytes? }. Returns { uid, href, etag, summary, start, end, " +
          "allDay, location, description, recurring, rrule, organizer?, attendees?, ics, truncated }: " +
          "`ics` is the object as the server sent it, capped at maxBytes (default 256KB). Keep the etag — " +
          "update and delete require it." + SHAPE_HINT,
        argSchema: compose(rejectUnknown(), acc, cal, str("uid"), optNum("maxBytes")),
      },
      {
        name: "calendar.events.search",
        tier: "open",
        doc:
          "Substring search over event summaries and locations within a window, across calendars. " +
          "args: { account, query, calendars?, from?, to?, limit? } (from/to default to the last/next 30 " +
          "days; the span cap still applies). Search is done here, not server-side: CalDAV text-match " +
          "support varies too much to depend on. Returns { count, searched, events: [...] }." +
          SHAPE_HINT,
        argSchema: compose(
          rejectUnknown(),
          acc,
          str("query"),
          optArr(
            "calendars",
            (v) =>
              typeof v === "string" && v.length > 0 && v.length <= 512
                ? null
                : "expected calendar name",
          ),
          optStr("from"),
          optStr("to"),
          optNum("limit"),
          (a) => {
            const r = a as { calendars?: unknown; from?: unknown; to?: unknown; limit?: unknown };
            if (Array.isArray(r.calendars) && r.calendars.length > 20) {
              return `calendars: too many (${r.calendars.length} > 20)`;
            }
            if ((r.from === undefined) !== (r.to === undefined)) {
              return "from and to must be given together";
            }
            if (r.from !== undefined) {
              const range = windowError("window", r.from, r.to);
              if (range) return range;
            }
            if (
              r.limit !== undefined && (typeof r.limit !== "number" || r.limit < 1 || r.limit > 100)
            ) {
              return "limit: expected 1..100";
            }
            return null;
          },
        ),
      },
      {
        name: "calendar.events.create",
        tier: "approval",
        summarize: (a) => {
          const r = a as { account?: string; calendar?: string; event?: Record<string, unknown> };
          const e = (r.event ?? {}) as Record<string, unknown>;
          const when = e.allDay
            ? `${e.start} (all day)`
            : `${e.start}${e.end ? ` → ${e.end}` : ""}`;
          return `Create "${e.summary}" in ${r.calendar} (${r.account}): ${when}` +
            `${e.rrule ? `, repeating (${e.rrule})` : ""}. ` +
            `Attendees are never set and no invitations are sent.`;
        },
        doc:
          "Create one event in a calendar. args: { account, calendar, event: { summary, start, end?, " +
          "allDay?, description?, location?, rrule?, uid? } }. Times need an explicit UTC offset; " +
          "all-day events take YYYY-MM-DD (end is exclusive). Writes with If-None-Match: *, so an " +
          "existing UID is a conflict, not an overwrite. ATTENDEE/ORGANIZER fields are refused: iCloud " +
          "auto-schedules invitations. Returns { uid, href, etag }.",
        argSchema: compose(
          rejectUnknown(),
          acc,
          cal,
          (a) => isRecord(a) && isRecord(a.event) ? null : "event: expected an object",
          (a) => eventCreateSchema("event")((a as { event?: unknown }).event),
        ),
      },
      {
        name: "calendar.events.update",
        tier: "approval",
        summarize: (a) => {
          const r = a as { account?: string; calendar?: string; uid?: string; patch?: unknown };
          const fields = isRecord(r.patch) ? Object.keys(r.patch).join(", ") : "?";
          return `Update event ${r.uid} in ${r.calendar} (${r.account}): change ${fields}. ` +
            `Requires the current etag (stale ⇒ refused, not overwritten). Existing attendees are ` +
            `preserved untouched and no invitations are sent.`;
        },
        doc:
          "Update an event by UID, with the etag from events.get. args: { account, calendar, uid, etag, " +
          "patch: { summary?, start?, end?, allDay?, description?, location?, rrule? } }. Read-modify-write: " +
          "only the named properties change, so VALARM/ATTENDEE/VTIMEZONE/vendor properties survive. " +
          "Sends If-Match; a 412 means the event changed since you read it. Returns { uid, href, etag } " +
          "(the new etag).",
        argSchema: compose(
          rejectUnknown(),
          acc,
          cal,
          str("uid"),
          str("etag"),
          (a) => isRecord(a) && isRecord(a.patch) ? null : "patch: expected an object",
          (a) => patchSchema("patch")((a as { patch?: unknown }).patch),
        ),
      },
      {
        name: "calendar.events.delete",
        tier: "approval",
        summarize: (a) => {
          const r = a as { account?: string; calendar?: string; uid?: string };
          return `Delete event ${r.uid} from ${r.calendar} (${r.account}). Requires the current etag; ` +
            `attendees are not notified by denops (the server may still send cancellations).`;
        },
        doc:
          "Delete one event. args: { account, calendar, uid, etag } — the etag is required so a concurrent " +
          "edit is a 412 rather than a lost change. Returns { deleted, uid, href }.",
        argSchema: compose(rejectUnknown(), acc, cal, str("uid"), str("etag")),
      },
    ],
    client: (_ctx: HostContext) => wrapClient(client(_ctx), CALENDAR_SHAPE),
    validateStartup: async () => {
      await host.validateAll();
    },
  };

  conn.ops = conn.ops.map((op) => {
    const short = op.name.slice("calendar.".length);
    return {
      ...op,
      argSchema: compose(op.argSchema, checkShapeArgs),
      doc: CALENDAR_SHAPE[short] && !op.doc.includes("Returns") ? op.doc + SHAPE_HINT : op.doc,
    };
  });
  return conn;
}

// Default projections: what a caller needs to choose an event, not the whole object.
// `ics` and `description` are opt-in (fields/full) because they are the expensive bytes.
const CALENDAR_SHAPE: Partial<Record<string, string[]>> = {
  "events.list": [
    "calendar",
    "count",
    "events.uid",
    "events.summary",
    "events.start",
    "events.end",
    "events.allDay",
    "events.location",
    "events.recurring",
    "events.etag",
  ],
  "events.search": [
    "count",
    "searched",
    "events.uid",
    "events.summary",
    "events.start",
    "events.end",
  ],
  "events.get": [
    "uid",
    "summary",
    "start",
    "end",
    "allDay",
    "location",
    "description",
    "recurring",
    "rrule",
    "organizer",
    "attendees",
    "etag",
    "truncated",
  ],
};
