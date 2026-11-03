// CalDAV client: one instance per configured account. Host-side credentials, no
// shell, op arguments never carry a secret.
//
// Three rules are enforced here rather than trusted to callers:
//
//  * **Host pinning.** Every URL we touch — discovery hrefs, redirect targets,
//    calendar hrefs — must be the account's origin, or (for iCloud, whose
//    calendar-home-set lives on a per-partition pNN-caldav.icloud.com host) the same
//    registrable domain. A server that hands back somebody else's URL does not get
//    our password.
//  * **Optimistic concurrency.** Writes carry If-Match (or If-None-Match: * on
//    create). A 412 is surfaced as "it changed, re-read", never retried blind.
//  * **No attendee writes.** iCloud advertises calendar-auto-schedule: a PUT with
//    ATTENDEE can make the server email real invitations. Updates preserve existing
//    attendees untouched; adding or changing them is refused in the manifest's
//    argSchema, before any approval prompt.

import type { JsonValue } from "../../harness/types.ts";
import {
  CALDAV,
  calendarCollectionBody,
  calendarQueryBody,
  DAV,
  okProp,
  okProps,
  parseMultiStatus,
  propfindBody,
  type PropRef,
  xmlEscape,
} from "./dav.ts";
import {
  alarmsOf,
  componentsNamed,
  durationOfMinutes,
  escapeText,
  getProp,
  type IcsComponent,
  type IcsDoc,
  type IcsProperty,
  localPropName,
  objectsOf,
  parseDurationMinutes,
  parseIcs,
  serializeIcs,
  setProp,
  timeRangeOf,
  utcStamp,
} from "./ical.ts";

export interface CalDavAccountConfig {
  id: string;
  /** scheme + host (and optional port) the operator pinned; never a path guess */
  origin: string;
  user: string;
  auth: "basic" | "bearer";
  /** basic: app password; bearer: token */
  password: string;
}

export interface CalDavHostOptions {
  timeoutMs?: number;
  /** per-object cap for calendar-data read back from the server */
  maxBytes?: number;
}

export interface Calendar {
  /** server href, absolute path or URL as returned */
  href: string;
  url: string;
  name: string;
  /** component types this collection holds: VEVENT, VTODO, VJOURNAL */
  components: string[];
  ctag?: string;
  syncToken?: string;
  readOnly: boolean;
  color?: string;
}

/** A VALARM the connector can author: a DISPLAY reminder at an offset from the start. */
export interface Reminder {
  /** positive = before the start, negative = after, 0 = at the start */
  minutesBefore: number;
  /** read-back only: what the server had (writes always produce DISPLAY) */
  action?: string;
  description?: string;
}

export interface EventInput {
  summary: string;
  /** ISO 8601 with an explicit offset (or YYYY-MM-DD when allDay) */
  start: string;
  /** exclusive end, per RFC 5545 */
  end?: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  rrule?: string;
  uid?: string;
  /** replaces the DISPLAY alarms; other alarm types on an existing event are preserved */
  reminders?: Reminder[];
}

export interface EventSummary {
  uid: string;
  href: string;
  etag?: string;
  summary?: string;
  start?: string;
  end?: string;
  allDay: boolean;
  location?: string;
  recurring: boolean;
  component?: string;
}

export interface EventObject extends EventSummary {
  description?: string;
  organizer?: string;
  attendees?: string[];
  rrule?: string;
  reminders?: Reminder[];
  /** the object as the server sent it, capped at maxBytes */
  ics: string;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function isICloud(hostname: string): boolean {
  return hostname === "icloud.com" || hostname.endsWith(".icloud.com");
}

function basicAuth(user: string, secret: string): string {
  const bytes = new TextEncoder().encode(`${user}:${secret}`);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** An entity tag as it goes on the wire: quoted exactly once. */
function ifMatchValue(etag: string): string {
  const t = etag.trim();
  if (t === "" || t === "*") throw new Error("etag: empty or wildcard is not a precondition");
  return /^".*"$/.test(t) ? t : `"${t}"`;
}

/** ISO 8601 with an offset, or nothing: a floating time is a guess we refuse. */
function requireOffset(iso: string, field: string): Date {
  const value = iso.trim();
  if (!/(Z|z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error(
      `${field}: must include a UTC offset (e.g. 2026-03-03T09:00:00+01:00 or …Z); ` +
        `pass allDay: true for a date-only event`,
    );
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`${field}: not a valid date-time`);
  return d;
}

function timeProperty(name: string, iso: string, allDay: boolean, field: string): IcsProperty {
  if (allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) {
      throw new Error(`${field}: all-day events need a YYYY-MM-DD date`);
    }
    return {
      name,
      params: [{ name: "VALUE", values: ["DATE"] }],
      value: iso.trim().replace(/-/g, ""),
    };
  }
  return { name, params: [], value: utcStamp(requireOffset(iso, field)) };
}

/** One DISPLAY VALARM. Only DISPLAY is ever written: EMAIL alarms send mail. */
function alarmComponent(reminder: Reminder, fallbackDescription: string): IcsComponent {
  return {
    name: "VALARM",
    properties: [
      { name: "ACTION", params: [], value: "DISPLAY" },
      {
        name: "DESCRIPTION",
        params: [],
        value: escapeText(reminder.description ?? fallbackDescription),
      },
      { name: "TRIGGER", params: [], value: durationOfMinutes(reminder.minutesBefore) },
    ],
    children: [],
  };
}

/** A fresh VCALENDAR around one VEVENT, for create. */
function buildEvent(input: EventInput, uid: string, allDay: boolean, now: Date): IcsDoc {
  const event: IcsComponent = {
    name: "VEVENT",
    properties: [
      { name: "UID", params: [], value: uid },
      { name: "DTSTAMP", params: [], value: utcStamp(now) },
      timeProperty("DTSTART", input.start, allDay, "start"),
    ],
    children: [],
  };
  if (input.end !== undefined) {
    event.properties.push(timeProperty("DTEND", input.end, allDay, "end"));
  }
  event.properties.push({ name: "SUMMARY", params: [], value: escapeText(input.summary) });
  if (input.description !== undefined) {
    event.properties.push({
      name: "DESCRIPTION",
      params: [],
      value: escapeText(input.description),
    });
  }
  if (input.location !== undefined) {
    event.properties.push({ name: "LOCATION", params: [], value: escapeText(input.location) });
  }
  if (input.rrule !== undefined) {
    event.properties.push({ name: "RRULE", params: [], value: input.rrule.trim().toUpperCase() });
  }
  for (const reminder of input.reminders ?? []) {
    event.children.push(alarmComponent(reminder, input.summary));
  }
  return {
    components: [{
      name: "VCALENDAR",
      properties: [
        { name: "VERSION", params: [], value: "2.0" },
        { name: "PRODID", params: [], value: "-//denops//calendar//EN" },
        { name: "CALSCALE", params: [], value: "GREGORIAN" },
      ],
      children: [event],
    }],
  };
}

/** Project one object as the server sent it (no interpretation of unknown props). */
function summarize(event: IcsComponent): Omit<EventSummary, "href" | "etag" | "calendar"> {
  const range = timeRangeOf(event);
  const uid = getProp(event, "UID")?.value ?? "";
  const summary = getProp(event, "SUMMARY");
  const location = getProp(event, "LOCATION");
  const rrule = getProp(event, "RRULE");
  return {
    uid,
    ...(summary === undefined ? {} : { summary: unescape(summary.value) }),
    ...(range.start === undefined ? {} : { start: range.start.value }),
    ...(range.end === undefined ? {} : { end: range.end.value }),
    allDay: range.allDay,
    ...(location === undefined ? {} : { location: unescape(location.value) }),
    recurring: rrule !== undefined,
    component: event.name,
  };
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([\\;,])/g, "$1");
}

class CalDavAccount {
  private readonly origin: URL;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly loopback: boolean;
  private discovery?: { principal: URL; home: URL };
  private calendarCache?: { at: number; calendars: Calendar[] };

  constructor(readonly id: string, cfg: CalDavAccountConfig, opts: CalDavHostOptions = {}) {
    this.origin = new URL(cfg.origin);
    // Credentials over cleartext is not a configuration choice we offer — loopback is
    // the one exception, so the client can be exercised against a local mock server.
    this.loopback = ["127.0.0.1", "::1", "localhost"].includes(this.origin.hostname);
    if (this.origin.protocol !== "https:" && !(this.loopback && this.origin.protocol === "http:")) {
      throw new Error(`caldav account ${id}: origin must be https (got ${cfg.origin})`);
    }
    this.headers = {
      authorization: cfg.auth === "bearer"
        ? `Bearer ${cfg.password}`
        : basicAuth(cfg.user, cfg.password),
      "user-agent": "denops-caldav/0.5",
    };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  // --- plumbing -------------------------------------------------------------

  private pin(url: URL): URL {
    const sameHost = url.hostname === this.origin.hostname;
    // iCloud answers calendar-home-set on a per-partition host (pNN-caldav.icloud.com),
    // so the same registrable domain has to be acceptable for an iCloud account.
    const sameDomain = isICloud(this.origin.hostname) && isICloud(url.hostname);
    if (!sameHost && !sameDomain) {
      throw new Error(
        `caldav account ${this.id}: refusing to send credentials to ${url.hostname} ` +
          `(allowed: ${this.origin.hostname}${
            isICloud(this.origin.hostname) ? ", *.icloud.com" : ""
          })`,
      );
    }
    if (url.protocol !== "https:" && !(this.loopback && url.protocol === "http:")) {
      throw new Error(`caldav account ${this.id}: refusing to downgrade to ${url.protocol}`);
    }
    return url;
  }

  private async request(
    method: string,
    url: URL,
    opts: {
      body?: string;
      depth?: string;
      contentType?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; headers: Headers; text: string; url: URL }> {
    let current = this.pin(url);
    const headers: Record<string, string> = { ...this.headers, ...(opts.headers ?? {}) };
    if (opts.body !== undefined) {
      headers["content-type"] = opts.contentType ?? "application/xml; charset=utf-8";
    }
    if (opts.depth !== undefined) headers["depth"] = opts.depth;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, {
        method,
        headers,
        body: opts.body,
        redirect: "manual", // each hop is re-pinned by hand
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) {
          throw new Error(`caldav ${method} ${current.pathname}: redirect without Location`);
        }
        current = this.pin(new URL(location, current));
        continue;
      }
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`caldav ${method}: response larger than ${MAX_RESPONSE_BYTES} bytes`);
      }
      if (res.status === 401) {
        throw new Error(
          `caldav account ${this.id}: authentication failed (401) — app password revoked or wrong`,
        );
      }
      if (res.status === 403) {
        throw new Error(`caldav account ${this.id}: server refused (403) — read-only calendar?`);
      }
      return { status: res.status, headers: res.headers, text, url: current };
    }
    throw new Error(`caldav ${method}: too many redirects (> ${MAX_REDIRECTS})`);
  }

  private async propfind(url: URL, depth: string, body: string) {
    const res = await this.request("PROPFIND", url, { body, depth });
    if (res.status !== 207) {
      throw new Error(
        `caldav PROPFIND ${url.pathname} -> ${res.status}: ${res.text.slice(0, 200)}`,
      );
    }
    return parseMultiStatus(res.text).responses;
  }

  private async report(url: URL, depth: string, body: string) {
    const res = await this.request("REPORT", url, { body, depth });
    if (res.status === 404) throw new Error(`caldav REPORT: calendar not found (404)`);
    if (res.status !== 207 && res.status !== 200) {
      throw new Error(`caldav REPORT ${url.pathname} -> ${res.status}: ${res.text.slice(0, 200)}`);
    }
    return parseMultiStatus(res.text).responses;
  }

  private hrefOf(node: ReturnType<typeof okProp>, base: URL): URL | undefined {
    const href = node?.children.find((c) => c.name.toLowerCase() === "href")?.text.trim();
    return href ? this.pin(new URL(href, base)) : undefined;
  }

  // --- discovery ------------------------------------------------------------

  async discover(): Promise<{ principal: URL; home: URL }> {
    if (this.discovery) return this.discovery;
    const root = this.origin.toString();
    // iCloud answers /.well-known/caldav with 400, so discovery is a PROPFIND on the
    // origin. A server that does implement well-known gets it tried first, but the
    // fallback is the path that matters.
    const [propfind] = await this.propfind(
      new URL("/", this.origin),
      "0",
      propfindBody([{ ns: DAV, name: "current-user-principal" }]),
    );
    const principal = this.hrefOf(okProp(propfind, "current-user-principal"), this.origin);
    if (!principal) {
      throw new Error(`caldav account ${this.id}: no current-user-principal at ${root}`);
    }
    const [pr] = await this.propfind(
      principal,
      "0",
      propfindBody([{ ns: CALDAV, name: "calendar-home-set" }, {
        ns: DAV,
        name: "displayname",
      }]),
    );
    const home = this.hrefOf(okProp(pr, "calendar-home-set"), principal);
    if (!home) {
      throw new Error(`caldav account ${this.id}: no calendar-home-set at ${principal.pathname}`);
    }
    this.discovery = { principal, home };
    return this.discovery;
  }

  async calendars(refresh = false): Promise<Calendar[]> {
    if (!refresh && this.calendarCache && Date.now() - this.calendarCache.at < 60_000) {
      return this.calendarCache.calendars;
    }
    const { home } = await this.discover();
    const responses = await this.propfind(home, "1", calendarCollectionBody());
    const calendars: Calendar[] = [];
    for (const resp of responses) {
      const rt = okProp(resp, "resourcetype");
      if (!rt?.children.some((c) => c.name.toLowerCase() === "calendar")) continue;
      const url = this.pin(new URL(resp.href, home));
      const components = okProp(resp, "supported-calendar-component-set")
        ?.children.filter((c) => c.name.toLowerCase() === "comp")
        .map((c) => String(c.attrs.name ?? "").toUpperCase())
        .filter((s) => s !== "") ?? [];
      const privileges = okProp(resp, "current-user-privilege-set")?.children.map((c) =>
        c.children[0]?.name.toLowerCase() ?? ""
      ) ?? [];
      const ctag = okProp(resp, "getctag")?.text.trim();
      const syncToken = okProp(resp, "sync-token")?.text.trim();
      calendars.push({
        href: resp.href,
        url: url.toString(),
        name: okProp(resp, "displayname")?.text.trim() ||
          resp.href.split("/").filter(Boolean).pop() ||
          "calendar",
        components,
        ...(ctag ? { ctag } : {}),
        ...(syncToken ? { syncToken } : {}),
        readOnly: privileges.length > 0 &&
          !privileges.includes("write-content") && !privileges.includes("write"),
        ...(okProp(resp, "calendar-color")
          ? { color: okProp(resp, "calendar-color")!.text.trim() }
          : {}),
      });
    }
    this.calendarCache = { at: Date.now(), calendars };
    return calendars;
  }

  async calendar(nameOrHref: string): Promise<Calendar> {
    const want = nameOrHref.trim();
    const all = await this.calendars();
    const found = all.find((c) => c.name === want) ??
      all.find((c) => c.name.toLowerCase() === want.toLowerCase()) ??
      all.find((c) => c.href === want || c.url === want) ??
      all.find((c) => decodeURIComponent(c.href).includes(want));
    if (!found) {
      const known = all.map((c) => c.name).join(", ") || "(none)";
      throw new Error(`calendar "${want}" not found in account ${this.id}; known: ${known}`);
    }
    return found;
  }

  /** Refuse event ops on a collection that holds only VTODOs: an empty list would look
   * like an empty calendar, which is a worse answer than an error. */
  private assertHoldsEvents(calendar: Calendar): void {
    if (calendar.components.length > 0 && !calendar.components.includes("VEVENT")) {
      throw new Error(
        `calendar "${calendar.name}" holds ${calendar.components.join("/")}, not VEVENT; ` +
          `calendar events ops are VEVENT-only for now`,
      );
    }
  }

  // --- reads ----------------------------------------------------------------

  async listEvents(
    calendarName: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<{ account: string; calendar: string; count: number; events: EventSummary[] }> {
    const calendar = await this.calendar(calendarName);
    this.assertHoldsEvents(calendar);
    const url = this.pin(new URL(calendar.url));
    const responses = await this.report(
      url,
      "1",
      calendarQueryBody({ start: utcStamp(from), end: utcStamp(to) }, "VEVENT"),
    );
    const events: EventSummary[] = [];
    for (const resp of responses) {
      const etag = okProp(resp, "getetag")?.text.trim();
      const data = okProp(resp, "calendar-data")?.text ?? "";
      const event = this.firstEvent(data);
      if (!event) continue;
      events.push({
        ...summarize(event),
        href: resp.href,
        ...(etag ? { etag } : {}),
      });
    }
    events.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
    const capped = events.slice(0, limit);
    return {
      account: this.id,
      calendar: calendar.name,
      count: capped.length,
      events: capped,
    };
  }

  private firstEvent(ics: string): IcsComponent | undefined {
    if (ics.trim() === "") return undefined;
    try {
      return objectsOf(parseIcs(ics), "VEVENT")[0];
    } catch {
      return undefined; // one unparsable object must not kill the listing
    }
  }

  /** Fetch one object by its own URL: the ICS and the etag that goes with it. */
  private async fetchObject(
    url: URL,
  ): Promise<{ ics: string; etag?: string } | undefined> {
    const res = await this.request("GET", url, { headers: { accept: "text/calendar" } });
    if (res.status === 404) return undefined;
    if (res.status !== 200) {
      throw new Error(`caldav GET ${url.pathname} -> ${res.status}: ${res.text.slice(0, 200)}`);
    }
    if (!res.text.includes("BEGIN:VCALENDAR")) return undefined;
    const etag = res.headers.get("etag") ?? undefined;
    return { ics: res.text, ...(etag ? { etag } : {}) };
  }

  /**
   * Locate an object by UID. The caller names a UID; the href is a server detail.
   *
   * Order matters, and it is driven by what servers actually implement:
   *  1. GET `<calendar>/<uid>.ics`. Both iCloud and Nextcloud name objects that way, so
   *     this is one request and no listing.
   *  2. PROPFIND depth 1 (hrefs + etags only, no calendar-data) and match the basename.
   *  3. Only then a server-side UID prop-filter REPORT — Nextcloud honours it, iCloud
   *     answers 412 (and 500 without the comp-filter nesting), so it must be last and
   *     must not be the only path.
   */
  private async locate(
    calendar: Calendar,
    uid: string,
  ): Promise<{ href: string; url: URL; etag?: string; ics: string }> {
    const base = this.pin(new URL(calendar.url));
    const direct = this.pin(
      new URL(`${base.pathname.replace(/\/$/, "")}/${encodeURIComponent(uid)}.ics`, base),
    );
    const hit = await this.fetchObject(direct);
    if (hit) return { href: direct.pathname, url: direct, ...hit };

    // Best effort: a server may refuse a depth-1 listing, and that must not stop the
    // UID filter below from being tried.
    const listing = await this.propfind(base, "1", propfindBody([{ ns: DAV, name: "getetag" }]))
      .catch(() => []);
    const match = listing.find((r) => {
      let href = r.href;
      try {
        href = decodeURIComponent(href);
      } catch { /* keep the raw href */ }
      return href.endsWith(`/${uid}.ics`);
    });
    if (match) {
      const url = this.pin(new URL(match.href, base));
      const found = await this.fetchObject(url);
      if (found) return { href: match.href, url, ...found };
    }

    const filter = `<c:filter><c:comp-filter name="VCALENDAR">` +
      `<c:comp-filter name="VEVENT">` +
      `<c:prop-filter name="UID"><c:text-match>${xmlEscape(uid)}</c:text-match></c:prop-filter>` +
      `</c:comp-filter></c:comp-filter></c:filter>`;
    const body = `<?xml version="1.0" encoding="utf-8"?>` +
      `<c:calendar-query xmlns:d="${DAV}" xmlns:c="${CALDAV}">` +
      `<d:prop><d:getetag/><c:calendar-data/></d:prop>${filter}</c:calendar-query>`;
    try {
      for (const resp of await this.report(base, "1", body)) {
        const data = okProp(resp, "calendar-data")?.text ?? "";
        const event = this.firstEvent(data);
        if (!event || getProp(event, "UID")?.value.trim() !== uid) continue;
        const etag = okProp(resp, "getetag")?.text.trim();
        return {
          href: resp.href,
          url: this.pin(new URL(resp.href, base)),
          ics: data,
          ...(etag ? { etag } : {}),
        };
      }
    } catch {
      // server-side UID filtering unsupported (iCloud: 412); the paths above are the
      // real contract, this is only for servers with opaque object names.
    }
    throw new Error(`no event with uid "${uid}" in calendar "${calendar.name}"`);
  }

  async getEvent(
    calendarName: string,
    uid: string,
    maxBytes?: number,
  ): Promise<EventObject> {
    const calendar = await this.calendar(calendarName);
    this.assertHoldsEvents(calendar);
    const found = await this.locate(calendar, uid);
    const cap = maxBytes ?? this.maxBytes;
    const event = objectsOf(parseIcs(found.ics), "VEVENT")[0];
    if (!event) throw new Error(`uid "${uid}" is not a VEVENT in calendar "${calendar.name}"`);
    const organizer = getProp(event, "ORGANIZER");
    const attendees = event.properties
      .filter((p) => localPropName(p.name) === "ATTENDEE")
      .map((p) => p.value.replace(/^mailto:/i, ""));
    const rrule = getProp(event, "RRULE");
    const description = getProp(event, "DESCRIPTION");
    const reminders: Reminder[] = [];
    for (const alarm of alarmsOf(event)) {
      const trigger = getProp(alarm, "TRIGGER");
      const offset = trigger ? parseDurationMinutes(trigger.value) : undefined;
      if (offset === undefined) continue; // absolute triggers are not modelled
      const text = getProp(alarm, "DESCRIPTION")?.value;
      const action = (getProp(alarm, "ACTION")?.value ?? "").trim().toUpperCase();
      reminders.push({
        minutesBefore: -offset,
        ...(action === "" ? {} : { action }),
        ...(text === undefined ? {} : { description: unescape(text) }),
      });
    }
    const truncated = found.ics.length > cap;
    return {
      ...summarize(event),
      href: found.href,
      ...(found.etag ? { etag: found.etag } : {}),
      ...(description === undefined ? {} : { description: unescape(description.value) }),
      ...(organizer === undefined ? {} : { organizer: organizer.value.replace(/^mailto:/i, "") }),
      ...(attendees.length > 0 ? { attendees } : {}),
      ...(rrule === undefined ? {} : { rrule: rrule.value }),
      ...(reminders.length > 0 ? { reminders } : {}),
      ics: truncated ? found.ics.slice(0, cap) : found.ics,
      truncated,
    };
  }

  async search(
    calendarNames: string[] | undefined,
    query: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<{ count: number; searched: string[]; events: EventSummary[] }> {
    const all = await this.calendars();
    const targets = calendarNames && calendarNames.length > 0
      ? await Promise.all(calendarNames.map((n) => this.calendar(n)))
      : all.filter((c) => c.components.length === 0 || c.components.includes("VEVENT"));
    const needle = query.toLowerCase();
    const hits: EventSummary[] = [];
    const searched: string[] = [];
    for (const cal of targets) {
      if (cal.components.length > 0 && !cal.components.includes("VEVENT")) continue;
      searched.push(cal.name);
      try {
        const { events } = await this.listEvents(cal.name, from, to, limit);
        for (const e of events) {
          const hay = [e.summary ?? "", e.location ?? ""].join(" ").toLowerCase();
          if (hay.includes(needle)) hits.push({ ...e });
          if (hits.length >= limit) break;
        }
      } catch (e) {
        // one unreadable calendar must not fail the whole search
        searched.push(`${cal.name} (failed: ${(e as Error).message.slice(0, 80)})`);
      }
      if (hits.length >= limit) break;
    }
    return { count: hits.length, searched, events: hits.slice(0, limit) };
  }

  // --- writes ---------------------------------------------------------------

  async createEvent(
    calendarName: string,
    input: EventInput,
    uidOverride?: string,
  ): Promise<{ uid: string; href: string; etag?: string }> {
    const calendar = await this.calendar(calendarName);
    this.assertHoldsEvents(calendar);
    if (calendar.readOnly) {
      throw new Error(`calendar "${calendar.name}" is read-only for this account`);
    }
    const uid = (uidOverride ?? input.uid ?? "").trim() || crypto.randomUUID();
    const allDay = input.allDay === true;
    const doc = buildEvent(input, uid, allDay, new Date());
    const base = this.pin(new URL(calendar.url));
    const target = this.pin(new URL(`${base.pathname.replace(/\/$/, "")}/${uid}.ics`, base));
    const res = await this.request("PUT", target, {
      body: serializeIcs(doc),
      contentType: "text/calendar; charset=utf-8",
      headers: { "if-none-match": "*" },
    });
    if (res.status === 412) {
      throw new Error(`an event with uid "${uid}" already exists in "${calendar.name}"`);
    }
    if (res.status !== 201 && res.status !== 204 && res.status !== 200) {
      throw new Error(`caldav PUT ${target.pathname} -> ${res.status}: ${res.text.slice(0, 200)}`);
    }
    const etag = res.headers.get("etag") ??
      (await this.locate(calendar, uid).catch(() => undefined))?.etag;
    return { uid, href: target.pathname, ...(etag ? { etag } : {}) };
  }

  async updateEvent(
    calendarName: string,
    uid: string,
    etag: string,
    patch: Partial<Omit<EventInput, "uid" | "allDay">> & { allDay?: boolean },
  ): Promise<{ uid: string; href: string; etag?: string }> {
    const calendar = await this.calendar(calendarName);
    this.assertHoldsEvents(calendar);
    if (calendar.readOnly) {
      throw new Error(`calendar "${calendar.name}" is read-only for this account`);
    }
    const found = await this.locate(calendar, uid);
    const doc = parseIcs(found.ics);
    const event = objectsOf(doc, "VEVENT").find((e) => getProp(e, "UID")?.value.trim() === uid);
    if (!event) throw new Error(`uid "${uid}" is not a VEVENT in calendar "${calendar.name}"`);
    const allDay = patch.allDay ?? timeRangeOf(event).allDay;

    // Read-modify-write: only the named properties change, so VALARM, ATTENDEE,
    // VTIMEZONE and vendor properties survive untouched.
    if (patch.summary !== undefined) setProp(event, "SUMMARY", escapeText(patch.summary));
    if (patch.description !== undefined) {
      setProp(
        event,
        "DESCRIPTION",
        patch.description === "" ? "" : escapeText(patch.description),
      );
    }
    if (patch.location !== undefined) setProp(event, "LOCATION", escapeText(patch.location));
    if (patch.rrule !== undefined) setProp(event, "RRULE", patch.rrule.trim().toUpperCase());
    if (patch.start !== undefined) {
      const prop = timeProperty("DTSTART", patch.start, allDay, "start");
      setProp(event, prop.name, prop.value, prop.params);
    }
    if (patch.end !== undefined) {
      const prop = timeProperty("DTEND", patch.end, allDay, "end");
      setProp(event, prop.name, prop.value, prop.params);
    }
    if (patch.reminders !== undefined) {
      // Replace the DISPLAY alarms only: an EMAIL/AUDIO alarm the user set in a
      // calendar client is not ours to delete.
      event.children = event.children.filter((c) =>
        !(c.name === "VALARM" &&
          (getProp(c, "ACTION")?.value ?? "").trim().toUpperCase() === "DISPLAY")
      );
      const summary = getProp(event, "SUMMARY")?.value ?? "";
      for (const reminder of patch.reminders) {
        event.children.push(
          alarmComponent(reminder, summary === "" ? "Reminder" : unescape(summary)),
        );
      }
    }
    setProp(event, "DTSTAMP", utcStamp(new Date()));

    const res = await this.request("PUT", found.url, {
      body: serializeIcs(doc),
      contentType: "text/calendar; charset=utf-8",
      headers: { "if-match": ifMatchValue(etag) },
    });
    if (res.status === 412) {
      throw new Error(
        `the event changed since it was read (etag mismatch); call calendar.events.get again for a fresh etag`,
      );
    }
    if (res.status !== 204 && res.status !== 200 && res.status !== 201) {
      throw new Error(`caldav PUT -> ${res.status}: ${res.text.slice(0, 200)}`);
    }
    const newEtag = res.headers.get("etag") ??
      (await this.locate(calendar, uid).catch(() => undefined))?.etag;
    return { uid, href: found.href, ...(newEtag ? { etag: newEtag } : {}) };
  }

  async deleteEvent(
    calendarName: string,
    uid: string,
    etag: string,
  ): Promise<{ deleted: true; uid: string; href: string }> {
    const calendar = await this.calendar(calendarName);
    this.assertHoldsEvents(calendar);
    if (calendar.readOnly) {
      throw new Error(`calendar "${calendar.name}" is read-only for this account`);
    }
    const found = await this.locate(calendar, uid);
    const res = await this.request("DELETE", found.url, {
      headers: { "if-match": ifMatchValue(etag) },
    });
    if (res.status === 412) {
      throw new Error(
        `the event changed since it was read (etag mismatch); re-read it before deleting`,
      );
    }
    if (res.status !== 204 && res.status !== 200) {
      throw new Error(`caldav DELETE -> ${res.status}: ${res.text.slice(0, 200)}`);
    }
    return { deleted: true, uid, href: found.href };
  }

  /** Startup probe: reachable, authenticated, and how many calendars we can see. */
  async validate(): Promise<{ principal: string; home: string; calendars: number }> {
    const { principal, home } = await this.discover();
    const calendars = await this.calendars(true);
    return { principal: principal.pathname, home: home.host, calendars: calendars.length };
  }

  /** For denops.about-style reporting: which props the server actually returned. */
  async capabilities(calendarName: string): Promise<JsonValue> {
    const calendar = await this.calendar(calendarName);
    const body = propfindBody([
      { ns: DAV, name: "getctag" },
      { ns: DAV, name: "sync-token" },
      { ns: DAV, name: "supported-report-set" },
    ] as PropRef[]);
    const [resp] = await this.propfind(this.pin(new URL(calendar.url)), "0", body);
    return {
      calendar: calendar.name,
      props: resp ? okProps(resp).map((p) => p.name) : [],
      components: calendar.components,
      readOnly: calendar.readOnly,
    } as JsonValue;
  }
}

export class CalDavHost {
  private readonly accounts = new Map<string, CalDavAccount>();

  constructor(configs: CalDavAccountConfig[], opts: CalDavHostOptions = {}) {
    for (const cfg of configs) {
      this.accounts.set(cfg.id, new CalDavAccount(cfg.id, cfg, opts));
    }
  }

  ids(): string[] {
    return [...this.accounts.keys()];
  }

  get(id: string): CalDavAccount {
    const account = this.accounts.get(id);
    if (!account) {
      throw new Error(
        `unknown caldav account "${id}"; known: ${this.ids().join(", ") || "(none)"}`,
      );
    }
    return account;
  }

  async validateAll(): Promise<Array<{ account: string; calendars: number }>> {
    const out: Array<{ account: string; calendars: number }> = [];
    for (const [id, account] of this.accounts) {
      const r = await account.validate();
      out.push({ account: id, calendars: r.calendars });
    }
    return out;
  }
}

// Re-exported so the manifest can validate argument payloads without importing ical.
export { componentsNamed, parseIcs };
