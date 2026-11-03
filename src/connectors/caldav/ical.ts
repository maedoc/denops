// Minimal iCalendar (RFC 5545) reader/writer for the calendar connector.
//
// Same reasoning as ../imap/rfc822.ts: no dependency, and the server owns the bytes
// that land in a user's calendar. The rule that matters most here is round-trip
// fidelity: an update reads the object, changes only the properties the caller
// named, and writes it back, so VALARM, ATTENDEE, VTIMEZONE and X-APPLE-* survive
// even though this module does not interpret them. Unknown properties are carried
// verbatim, in order.
//
// Deliberately absent: recurrence expansion and timezone conversion. Expansion is
// the server's job (CalDAV time-range filters), and there is no tz database here —
// a TZID is surfaced as a TZID, never silently converted.

export interface IcsParam {
  /** upper-case parameter name, e.g. TZID */
  name: string;
  values: string[];
}

export interface IcsProperty {
  /** upper-case, including any group prefix ("ITEM1.X-APPLE-STRUCTURED-LOCATION") */
  name: string;
  params: IcsParam[];
  /** the raw value, still escaped as it arrived */
  value: string;
}

export interface IcsComponent {
  /** upper-case component name, e.g. VCALENDAR, VEVENT */
  name: string;
  properties: IcsProperty[];
  children: IcsComponent[];
}

export interface IcsDoc {
  /** top-level components, normally one VCALENDAR */
  components: IcsComponent[];
}

/** The part of a property name after any group prefix: "ITEM1.X-FOO" -> "X-FOO". */
export function localPropName(name: string): string {
  const upper = name.toUpperCase();
  const at = upper.lastIndexOf(".");
  return at < 0 ? upper : upper.slice(at + 1);
}

/** Unfold continuation lines. RFC 5545 allows CRLF, LF or CR line endings. */
export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (out.length === 0) throw new Error("ical: continuation line before any property");
      out[out.length - 1] += line.slice(1);
      continue;
    }
    out.push(line);
  }
  return out.filter((l) => l.trim() !== "");
}

/**
 * Fold one logical line into physical lines of at most `maxOctets` bytes (75 by
 * default, excluding CRLF), never splitting a UTF-8 sequence: a naive slice at
 * 75 bytes turns an accent into a replacement character on the server's side.
 */
export function foldLine(line: string, maxOctets = 75): string[] {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > maxOctets && current !== "") {
      out.push(current);
      current = ` ${ch}`; // continuation lines start with one space, which counts
      bytes = 1 + size;
      continue;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out;
}

/** Split on `sep`, ignoring separators inside double quotes. */
function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      quoted = !quoted;
      current += c;
      continue;
    }
    if (c === sep && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Parse one already-unfolded content line. */
export function parseContentLine(line: string): IcsProperty {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) throw new Error(`ical: content line without a value: ${line.slice(0, 60)}`);
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = splitUnquoted(head, ";");
  const name = parts[0].trim().toUpperCase();
  if (name === "") throw new Error("ical: content line without a name");
  const params: IcsParam[] = [];
  for (const raw of parts.slice(1)) {
    const eq = raw.indexOf("=");
    if (eq < 0) throw new Error(`ical: parameter without a value: ${raw.slice(0, 40)}`);
    params.push({
      name: raw.slice(0, eq).trim().toUpperCase(),
      // A quoted parameter value is a literal: "A,B" is one value, not two.
      values: splitUnquoted(raw.slice(eq + 1), ",").map(unquote),
    });
  }
  return { name, params, value };
}

/** Reassemble a content line (params quoted where they would be ambiguous). */
export function formatContentLine(p: IcsProperty): string {
  const params = p.params.map((q) => {
    const values = q.values.map((v) => (/[;:,"]/.test(v) ? `"${v}"` : v)).join(",");
    return `;${q.name}=${values}`;
  }).join("");
  return `${p.name}${params}:${p.value}`;
}

export function parseIcs(text: string): IcsDoc {
  const lines = unfoldLines(text);
  const doc: IcsDoc = { components: [] };
  const stack: IcsComponent[] = [];
  for (const line of lines) {
    const prop = parseContentLine(line);
    if (prop.name === "BEGIN") {
      const component: IcsComponent = {
        name: prop.value.trim().toUpperCase(),
        properties: [],
        children: [],
      };
      if (component.name === "") throw new Error("ical: BEGIN without a component name");
      if (stack.length === 0) doc.components.push(component);
      else stack[stack.length - 1].children.push(component);
      stack.push(component);
      continue;
    }
    if (prop.name === "END") {
      const open = stack.pop();
      if (!open) throw new Error(`ical: END:${prop.value} without a matching BEGIN`);
      if (open.name !== prop.value.trim().toUpperCase()) {
        throw new Error(`ical: END:${prop.value} closes BEGIN:${open.name}`);
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top) throw new Error(`ical: ${prop.name} outside any component`);
    top.properties.push(prop);
  }
  if (stack.length > 0) throw new Error(`ical: unclosed component ${stack[stack.length - 1].name}`);
  return doc;
}

export function serializeIcs(doc: IcsDoc): string {
  const lines: string[] = [];
  const emit = (c: IcsComponent) => {
    lines.push(...foldLine(`BEGIN:${c.name}`));
    for (const p of c.properties) lines.push(...foldLine(formatContentLine(p)));
    for (const child of c.children) emit(child);
    lines.push(...foldLine(`END:${c.name}`));
  };
  for (const c of doc.components) emit(c);
  return `${lines.join("\r\n")}\r\n`;
}

/** RFC 5545 TEXT escaping (values the connector authors, e.g. a new SUMMARY). */
export function escapeText(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/** Reverse of escapeText, for values surfaced to a caller. */
export function unescapeText(v: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] !== "\\") {
      out += v[i];
      continue;
    }
    const next = v[++i];
    if (next === undefined) break;
    out += next === "n" || next === "N" ? "\n" : next;
  }
  return out;
}

export function getProps(component: IcsComponent, name: string): IcsProperty[] {
  const want = localPropName(name);
  return component.properties.filter((p) => localPropName(p.name) === want);
}

export function getProp(component: IcsComponent, name: string): IcsProperty | undefined {
  return getProps(component, name)[0];
}

/**
 * Replace a property in place (keeping its position, so an update produces a
 * minimal diff) or append it. Callers own the value encoding: pass `escapeText()`
 * output for TEXT properties, and explicit params rather than inheriting stale ones.
 */
export function setProp(
  component: IcsComponent,
  name: string,
  value: string,
  params: IcsParam[] = [],
): void {
  const want = localPropName(name);
  const existing = component.properties.find((p) => localPropName(p.name) === want);
  if (existing) {
    existing.value = value;
    existing.params = params;
    return;
  }
  component.properties.push({ name: name.toUpperCase(), params, value });
}

/** Remove a property; returns whether anything was removed. */
export function removeProp(component: IcsComponent, name: string): boolean {
  const want = localPropName(name);
  const before = component.properties.length;
  component.properties = component.properties.filter((p) => localPropName(p.name) !== want);
  return component.properties.length !== before;
}

/** Every component of this type, depth-first. */
export function componentsNamed(component: IcsComponent, name: string): IcsComponent[] {
  const want = name.toUpperCase();
  const out: IcsComponent[] = [];
  for (const c of component.children) {
    if (c.name === want) out.push(c);
    out.push(...componentsNamed(c, want));
  }
  return out;
}

/** The VEVENT (or VTODO) objects of a parsed VCALENDAR, as the server sent them. */
export function objectsOf(doc: IcsDoc, name = "VEVENT"): IcsComponent[] {
  const out: IcsComponent[] = [];
  for (const c of doc.components) out.push(...componentsNamed(c, name));
  return out;
}

// -----------------------------------------------------------------------------
// timestamps

/** iCalendar UTC timestamp: YYYYMMDDTHHMMSSZ (CalDAV time-range uses this format). */
export function utcStamp(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

export type IcsTimeKind = "utc" | "date" | "floating" | "tzid";

export interface IcsTime {
  kind: IcsTimeKind;
  /** ISO 8601 for utc ("…Z") and date ("YYYY-MM-DD"); local wall time otherwise */
  value: string;
  /** set when kind === "tzid" — surfaced, never resolved (no tz database here) */
  tzid?: string;
}

/**
 * Interpret a DATE / DATE-TIME value. A floating time is reported as floating
 * rather than guessed into UTC: the caller decides, and writes are UTC-only.
 */
export function parseTime(raw: string, params: readonly IcsParam[] = []): IcsTime {
  const v = raw.trim();
  const param = (name: string) =>
    params.find((p) => p.name === name.toUpperCase())?.values[0] ?? undefined;
  const isDate = (param("VALUE") ?? "").toUpperCase() === "DATE" || /^\d{8}$/.test(v);
  if (isDate) {
    if (!/^\d{8}$/.test(v)) throw new Error(`ical: bad DATE value ${v}`);
    return { kind: "date", value: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) throw new Error(`ical: unparsable DATE-TIME value ${v}`);
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (m[7] === "Z") return { kind: "utc", value: `${local}Z` };
  const tzid = param("TZID");
  if (tzid) return { kind: "tzid", value: local, tzid };
  return { kind: "floating", value: local };
}

/** Start/end of an object, best-effort, without ever inventing a timezone. */
export function timeRangeOf(component: IcsComponent): {
  start?: IcsTime;
  end?: IcsTime;
  allDay: boolean;
} {
  const startProp = getProp(component, "DTSTART");
  const endProp = getProp(component, "DTEND") ?? getProp(component, "DUE");
  const start = startProp ? parseTime(startProp.value, startProp.params) : undefined;
  const end = endProp ? parseTime(endProp.value, endProp.params) : undefined;
  return {
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    allDay: start?.kind === "date",
  };
}
