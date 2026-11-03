// Minimal, strict reader/writer for the WebDAV XML this connector consumes.
//
// Why hand-rolled (same reasoning as ../imap/rfc822.ts): the XML comes from a
// calendar server, and a permissive parser is exactly what XXE and billion-laughs
// eat. This one refuses DOCTYPE and custom entities outright, caps depth and node
// count, and has no external entity resolution. It is not a general XML
// implementation — it reads multistatus documents and writes the handful of
// request bodies CalDAV needs.
//
// Namespace handling is deliberately lenient in one direction only: an undeclared
// prefix resolves to "" instead of throwing (servers do emit malformed documents
// and we would rather match a `href` than fail the whole sync), while anything
// that could expand into an entity is a hard error.

/** Resolved namespaces this connector cares about. */
export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";
export const APPLE_ICAL = "http://apple.com/ns/ical/";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

const MAX_DEPTH = 64;
const MAX_NODES = 50_000;

export interface XmlNode {
  /** local name, verbatim case (matching is done case-insensitively by helpers) */
  name: string;
  /** resolved namespace URI, "" when none was declared */
  ns: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** direct character data, entities decoded */
  text: string;
}

/** A property requested in a PROPFIND/REPORT body: which namespace, which local name. */
export interface PropRef {
  ns: string;
  name: string;
}

function localName(qname: string): string {
  const at = qname.indexOf(":");
  return at < 0 ? qname : qname.slice(at + 1);
}

function prefixOf(qname: string): string {
  const at = qname.indexOf(":");
  return at < 0 ? "" : qname.slice(0, at);
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "&") {
      out += c;
      continue;
    }
    const semi = s.indexOf(";", i + 1);
    if (semi < 0) throw new Error("xml: unescaped & in character data");
    const body = s.slice(i + 1, semi);
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) {
        throw new Error(`xml: bad character reference &${body};`);
      }
      out += String.fromCodePoint(cp);
    } else if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) {
        throw new Error(`xml: bad character reference &${body};`);
      }
      out += String.fromCodePoint(cp);
    } else {
      switch (body) {
        case "amp":
          out += "&";
          break;
        case "lt":
          out += "<";
          break;
        case "gt":
          out += ">";
          break;
        case "quot":
          out += '"';
          break;
        case "apos":
          out += "'";
          break;
        default:
          // No custom entity expansion, ever: that is the billion-laughs door.
          throw new Error(`xml: unknown entity &${body};`);
      }
    }
    i = semi;
  }
  return out;
}

/** Parse one XML document into a node tree. Throws on anything malformed. */
export function parseXml(src: string): XmlNode {
  if (typeof src !== "string" || src.trim() === "") throw new Error("xml: empty document");
  let i = 0;
  let count = 0;
  const stack: XmlNode[] = [];
  const nsStack: Record<string, string>[] = [{ xml: XML_NS }];
  let root: XmlNode | undefined;

  const fail = (why: string): never => {
    throw new Error(`xml: ${why} (at offset ${i})`);
  };
  const appendText = (s: string) => {
    if (s === "") return;
    if (stack.length === 0) {
      if (s.trim() !== "") fail("character data outside the root element");
      return;
    }
    stack[stack.length - 1].text += s;
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      appendText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(src.slice(i, lt)));
    i = lt;

    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) fail("unterminated comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end < 0) fail("unterminated CDATA section");
      appendText(src.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end < 0) fail("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      // A DOCTYPE can declare entities; refusing it removes the whole XXE class
      // instead of trying to filter it.
      fail("DOCTYPE and markup declarations are not accepted");
    }

    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i + 2);
      if (end < 0) fail("unterminated closing tag");
      const raw = src.slice(i + 2, end).trim();
      const open = stack.pop();
      nsStack.pop();
      if (!open) fail(`closing tag </${raw}> with no open element`);
      if (open!.name !== localName(raw)) fail(`</${raw}> closes <${open!.name}>`);
      i = end + 1;
      continue;
    }

    // Start tag: <name attr="v" attr2='v' ...> or <name/>
    const head = /^<([^\s/>]+)/.exec(src.slice(i, i + 512));
    if (!head) fail("expected an element name");
    const qname = head![1];
    i += head![0].length;

    const attrs: Record<string, string> = {};
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith("/>", i)) {
        i += 2;
        break;
      }
      if (src[i] === ">") {
        i += 1;
        break;
      }
      const aname = /^([^\s=/>]+)\s*=\s*/.exec(src.slice(i, i + 512));
      if (!aname) fail("expected an attribute name and value");
      i += aname![0].length;
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail("attribute value must be quoted");
      const end = src.indexOf(quote, i + 1);
      if (end < 0) fail("unterminated attribute value");
      attrs[aname![1]] = decodeEntities(src.slice(i + 1, end));
      i = end + 1;
    }

    if (stack.length + 1 > MAX_DEPTH) fail(`nesting deeper than ${MAX_DEPTH}`);
    if (++count > MAX_NODES) fail(`more than ${MAX_NODES} elements`);

    // Namespace scope: declarations apply to this element and its descendants.
    const parentNs = nsStack[nsStack.length - 1];
    let nsMap = parentNs;
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        if (nsMap === parentNs) nsMap = { ...parentNs };
        nsMap[key === "xmlns" ? "" : key.slice(6)] = value;
        delete attrs[key]; // declarations are scope, not data
      }
    }
    const node: XmlNode = {
      name: localName(qname),
      ns: nsMap[prefixOf(qname)] ?? "",
      attrs,
      children: [],
      text: "",
    };
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else if (root === undefined) root = node;
    else fail("more than one root element");

    const selfClosed = src[i - 2] === "/" && src[i - 1] === ">";
    if (!selfClosed) {
      stack.push(node);
      nsStack.push(nsMap);
    }
  }

  if (stack.length > 0) throw new Error(`xml: unclosed element <${stack[stack.length - 1].name}>`);
  if (root === undefined) throw new Error("xml: no root element");
  return root;
}

/** First direct child with this local name (case-insensitive). */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  const want = name.toLowerCase();
  return node.children.find((c) => c.name.toLowerCase() === want);
}

/** Direct children with this local name. */
export function children(node: XmlNode, name: string): XmlNode[] {
  const want = name.toLowerCase();
  return node.children.filter((c) => c.name.toLowerCase() === want);
}

/** Depth-first search for the first matching local name. */
export function descendant(node: XmlNode, name: string): XmlNode | undefined {
  const want = name.toLowerCase();
  for (const c of node.children) {
    if (c.name.toLowerCase() === want) return c;
    const found = descendant(c, name);
    if (found) return found;
  }
  return undefined;
}

/** Depth-first search for every matching local name (document order). */
export function descendants(node: XmlNode, name: string): XmlNode[] {
  const want = name.toLowerCase();
  const out: XmlNode[] = [];
  for (const c of node.children) {
    if (c.name.toLowerCase() === want) out.push(c);
    out.push(...descendants(c, name));
  }
  return out;
}

/** Parse a WebDAV status line ("HTTP/1.1 207 Multi-Status") into its code. */
export function parseStatus(text: string): number {
  const m = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(text.trim());
  if (!m) throw new Error(`dav: unparsable status line: ${text.trim().slice(0, 60)}`);
  return Number(m[1]);
}

export interface PropStat {
  /** HTTP status for this group of properties (200 for the ones that exist). */
  status: number;
  props: XmlNode[];
}

export interface DavResponse {
  /** the resource href, exactly as the server returned it (may be absolute) */
  href: string;
  /** status of the whole response, when the server sent one instead of propstats */
  status?: number;
  propstats: PropStat[];
}

export interface MultiStatus {
  responses: DavResponse[];
}

/**
 * Parse a 207 Multi-Status body: one entry per resource, each carrying propstats
 * that may disagree with each other (asking for getctag on a calendar that does not
 * have one yields a 404 propstat next to a 200 for displayname). Callers must read
 * properties through `okProps`, never positionally.
 */
export function parseMultiStatus(xml: string): MultiStatus {
  const root = parseXml(xml);
  if (root.name.toLowerCase() !== "multistatus") {
    throw new Error(`dav: expected <multistatus>, got <${root.name}>`);
  }
  const responses: DavResponse[] = [];
  for (const r of children(root, "response")) {
    const href = child(r, "href")?.text.trim() ?? "";
    if (href === "") continue;
    const out: DavResponse = { href, propstats: [] };
    const statusNode = child(r, "status");
    if (statusNode) out.status = parseStatus(statusNode.text);
    for (const ps of children(r, "propstat")) {
      const code = parseStatus(child(ps, "status")?.text ?? "");
      const prop = child(ps, "prop");
      out.propstats.push({ status: code, props: prop ? prop.children : [] });
    }
    responses.push(out);
  }
  return { responses };
}

/** Properties the server actually returned in a 2xx propstat. */
export function okProps(response: DavResponse): XmlNode[] {
  return response.propstats.filter((p) => p.status >= 200 && p.status < 300).flatMap((p) =>
    p.props
  );
}

/** First 2xx property with this local name, if the server returned it. */
export function okProp(response: DavResponse, name: string): XmlNode | undefined {
  const want = name.toLowerCase();
  return okProps(response).find((p) => p.name.toLowerCase() === want);
}

// -----------------------------------------------------------------------------
// request bodies
//
// Props are named by namespace rather than by prefix: a server is free to call the
// DAV namespace `d`, `D` or nothing at all, and the writer should not have to care.

function nsPrefixes(props: readonly PropRef[]): Map<string, string> {
  const out = new Map<string, string>([[DAV, "d"], [CALDAV, "c"]]);
  for (const p of props) {
    if (!out.has(p.ns)) out.set(p.ns, `n${out.size}`);
  }
  return out;
}

function declarations(prefixes: Map<string, string>): string {
  return [...prefixes].map(([ns, prefix]) => `xmlns:${prefix}="${xmlEscape(ns)}"`).join(" ");
}

function renderProps(props: readonly PropRef[], prefixes: Map<string, string>): string {
  return props.map((p) => `<${prefixes.get(p.ns)!}:${p.name}/>`).join("");
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** PROPFIND body asking for exactly these properties. */
export function propfindBody(props: readonly PropRef[]): string {
  const prefixes = nsPrefixes(props);
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:propfind ${declarations(prefixes)}><d:prop>${renderProps(props, prefixes)}` +
    `</d:prop></d:propfind>`;
}

/** PROPFIND body for `resourcetype` + `displayname` + the CalDAV component set. */
export function calendarHomeBody(): string {
  return propfindBody([
    { ns: DAV, name: "resourcetype" },
    { ns: DAV, name: "displayname" },
    { ns: DAV, name: "current-user-principal" },
    { ns: CALDAV, name: "calendar-home-set" },
    { ns: CALDAV, name: "supported-calendar-component-set" },
    { ns: DAV, name: "current-user-privilege-set" },
  ]);
}

/** PROPFIND body for the calendar collection itself (etag/ctag/colour/description). */
export function calendarCollectionBody(): string {
  return propfindBody([
    { ns: DAV, name: "resourcetype" },
    { ns: DAV, name: "displayname" },
    { ns: DAV, name: "getetag" },
    { ns: DAV, name: "getctag" },
    { ns: DAV, name: "sync-token" },
    { ns: DAV, name: "current-user-privilege-set" },
    { ns: CALDAV, name: "supported-calendar-component-set" },
    { ns: CALDAV, name: "calendar-description" },
    { ns: APPLE_ICAL, name: "calendar-color" },
    { ns: APPLE_ICAL, name: "calendar-order" },
  ]);
}

export interface TimeRange {
  /** iCalendar UTC stamp, YYYYMMDDTHHMMSSZ (see ../caldav/ical.ts utcStamp) */
  start: string;
  end: string;
}

/**
 * calendar-query REPORT: objects of one component type overlapping [start, end).
 * The server expands recurrence here, which is the whole reason the connector does
 * not need an RRULE engine of its own.
 */
export function calendarQueryBody(
  range: TimeRange,
  component: "VEVENT" | "VTODO" | "VJOURNAL" = "VEVENT",
): string {
  const prefixes = nsPrefixes([]);
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<c:calendar-query ${declarations(prefixes)}>` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR">` +
    `<c:comp-filter name="${xmlEscape(component)}">` +
    `<c:time-range start="${xmlEscape(range.start)}" end="${xmlEscape(range.end)}"/>` +
    `</c:comp-filter></c:comp-filter></c:filter>` +
    `</c:calendar-query>`;
}

/** calendar-multiget REPORT: the exact resources the caller named. */
export function calendarMultigetBody(hrefs: readonly string[]): string {
  if (hrefs.length === 0) throw new Error("dav: multiget needs at least one href");
  const prefixes = nsPrefixes([]);
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<c:calendar-multiget ${declarations(prefixes)}>` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    hrefs.map((h) => `<d:href>${xmlEscape(h)}</d:href>`).join("") +
    `</c:calendar-multiget>`;
}

/** sync-collection REPORT (RFC 6578): what changed since `token`. */
export function syncCollectionBody(token: string, extra: readonly PropRef[] = []): string {
  const props: PropRef[] = [{ ns: DAV, name: "getetag" }, ...extra];
  const prefixes = nsPrefixes(props);
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<d:sync-collection ${declarations(prefixes)}>` +
    `<d:sync-token>${xmlEscape(token)}</d:sync-token>` +
    `<d:sync-level>1</d:sync-level>` +
    `<d:prop>${renderProps(props, prefixes)}</d:prop>` +
    `</d:sync-collection>`;
}

/** The `sync-token` a sync-collection response ends with (absent on servers without it). */
export function syncTokenOf(xml: string): string | undefined {
  const root = parseXml(xml);
  return descendant(root, "sync-token")?.text.trim() || undefined;
}
