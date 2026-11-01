import {
  decodeRfc2047,
  decodeTransferEncoding,
  encodeHeaderWord,
  sanitizeHeaderValue,
} from "../../text.ts";

// RFC 5322 / MIME assembly for the mail connector, kept free of IMAP so it can be
// tested without a server. The server owns header correctness on purpose: agents
// get angle brackets, References ordering and "Re:" prefixes wrong, and a draft
// with a broken References chain silently starts a new conversation.
//
// Security note: every value that comes from a *parent message* (subject, from,
// message ids) is attacker-controlled. Values are sanitised before they reach a
// header, and the subject is encoded as an RFC 2047 word when non-ASCII, so a
// crafted subject cannot inject headers into the draft we compose.

export interface ParsedMessage {
  /** lowercased header name -> values in arrival order (unfolded) */
  headers: Map<string, string[]>;
  body: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  from?: string;
  subject?: string;
  date?: string;
  contentType: string;
  /** decoded text/plain content of the message (or of its first text/plain part) */
  text: string;
  /** why `text` is empty, when it is */
  textMissing?: string;
}

export function splitHeadBody(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: "" };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** Parse a header block: unfolds continuations, lowercases names, keeps order. */
export function parseHeaders(head: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (line === "") continue;
    if (/^[ \t]/.test(line) && current) {
      const prev = out.get(current)!;
      prev[prev.length - 1] = `${prev[prev.length - 1]} ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    const list = out.get(name) ?? [];
    list.push(value);
    out.set(name, list);
    current = name;
  }
  return out;
}

export function header(headers: Map<string, string[]>, name: string): string | undefined {
  return headers.get(name.toLowerCase())?.[0];
}

/** Extract `<id@host>` tokens; falls back to whitespace-split for malformed values. */
export function messageIdTokens(value: string | undefined): string[] {
  if (!value) return [];
  const angled = [...value.matchAll(/<[^<>]+>/g)].map((m) => m[0]);
  if (angled.length > 0) return angled;
  return value.split(/\s+/).filter((t) => t.includes("@")).map((t) =>
    `<${t.replace(/[<>]/g, "")}>`
  );
}

function contentParams(contentType: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of contentType.split(";").slice(1)) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
    out[key] = value;
  }
  return out;
}

/** Split a multipart body into its raw parts (first-level only). */
function multipartParts(body: string, boundary: string): string[] {
  if (!boundary) return [];
  const parts: string[] = [];
  for (const chunk of body.split(`--${boundary}`)) {
    if (chunk.startsWith("--")) break; // closing delimiter
    const trimmed = chunk.replace(/^[ \t]*\r?\n/, "");
    if (trimmed.trim() === "") continue;
    parts.push(trimmed.replace(/\r?\n$/, ""));
  }
  return parts;
}

function decodePart(headers: Map<string, string[]>, body: string): string {
  const charset = contentParams(header(headers, "content-type") ?? "")["charset"] ?? "utf-8";
  return decodeTransferEncoding(body, header(headers, "content-transfer-encoding") ?? "", charset);
}

/** Find and decode the first text/plain content, descending at most two levels. */
function textOf(
  headers: Map<string, string[]>,
  body: string,
  depth = 0,
): { text: string; missing?: string } {
  const ct = (header(headers, "content-type") ?? "text/plain").toLowerCase();
  if (ct.startsWith("text/plain")) {
    return { text: decodePart(headers, body) };
  }
  if (ct.startsWith("multipart/")) {
    if (depth >= 2) return { text: "", missing: "multipart nesting too deep" };
    const boundary = contentParams(header(headers, "content-type") ?? "")["boundary"] ?? "";
    for (const part of multipartParts(body, boundary)) {
      const { head, body: partBody } = splitHeadBody(part);
      const found = textOf(parseHeaders(head), partBody, depth + 1);
      if (found.text.trim() !== "") return found;
    }
    return { text: "", missing: "no text/plain part" };
  }
  if (ct.startsWith("text/html")) return { text: "", missing: "html-only message" };
  return { text: "", missing: `not a text type (${ct.split(";")[0]})` };
}

export function parseMessage(raw: string): ParsedMessage {
  const { head, body } = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const { text, missing } = textOf(headers, body);
  const subject = header(headers, "subject");
  return {
    headers,
    body,
    messageId: messageIdTokens(header(headers, "message-id"))[0],
    inReplyTo: messageIdTokens(header(headers, "in-reply-to"))[0],
    references: messageIdTokens(header(headers, "references")),
    from: header(headers, "from"),
    subject: subject === undefined ? undefined : decodeRfc2047(subject),
    date: header(headers, "date"),
    contentType: header(headers, "content-type") ?? "",
    text,
    ...(missing ? { textMissing: missing } : {}),
  };
}

/** `addr-spec` of a From header: `Name <a@b>` -> `a@b`, `a@b (Name)` -> `a@b`. */
export function addressOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angled = /<([^<>]+)>/.exec(value);
  const candidate = (angled ? angled[1] : value.replace(/\([^)]*\)/g, "")).trim();
  return /^[^@\s]+@[^@\s]+$/.test(candidate) ? candidate : undefined;
}

/**
 * References for a reply: the parent's chain in order, then the parent's
 * Message-ID. Empty when the parent has neither (the header is then omitted
 * rather than invented).
 */
export function referencesChain(parent: {
  references: string[];
  messageId?: string;
}): string[] {
  const out: string[] = [];
  for (const id of [...parent.references, ...(parent.messageId ? [parent.messageId] : [])]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** "Re: " + subject, without doubling an existing prefix. */
export function replySubject(subject: string | undefined, override?: string): string {
  if (override !== undefined) return sanitizeHeaderValue(override);
  const base = sanitizeHeaderValue(subject ?? "");
  if (base === "") return "Re:";
  return /^re\s*:/i.test(base) ? base : `Re: ${base}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date-time in the sending host's zone, e.g. `Sun, 1 Nov 2026 17:42:19 +0100`. */
export function rfc5322Date(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${DAYS[date.getDay()]}, ${date.getDate()} ${
    MONTHS[date.getMonth()]
  } ${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}:${
    p(date.getSeconds())
  } ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

const DOMAIN_RE =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function newMessageId(domain: string, uuid = crypto.randomUUID()): string {
  const clean = String(domain).trim().replace(/^[.@]+|[.@]+$/g, "");
  if (!DOMAIN_RE.test(clean)) {
    throw new Error(
      `cannot mint a Message-ID: ${
        JSON.stringify(domain)
      } is not a domain (set the account's messageIdDomain)`,
    );
  }
  return `<${uuid}@${clean}>`;
}

export interface DraftHeaders {
  from: string;
  to: string[];
  subject: string;
  date: Date;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

/** Compose a draft message. Every value is sanitised; nothing is caller-supplied raw. */
export function composeDraft(h: DraftHeaders, body: string): string {
  const lines = [
    `From: ${encodeHeaderWord(h.from)}`,
    `To: ${h.to.map((t) => encodeHeaderWord(t)).join(", ")}`,
    `Subject: ${encodeHeaderWord(h.subject)}`,
    `Date: ${rfc5322Date(h.date)}`,
    `Message-ID: ${sanitizeHeaderValue(h.messageId)}`,
  ];
  if (h.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeaderValue(h.inReplyTo)}`);
  if (h.references && h.references.length > 0) {
    lines.push(`References: ${h.references.map((r) => sanitizeHeaderValue(r)).join(" ")}`);
  }
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8");
  lines.push("Content-Transfer-Encoding: 8bit");
  const eolBody = body.replace(/\r?\n/g, "\r\n");
  return `${lines.join("\r\n")}\r\n\r\n${eolBody}\r\n`;
}

/** Quoted reply block: attribution line plus `> `-prefixed parent lines. */
export function quoteBlock(parent: { text: string; date?: string; from?: string }): string {
  const when = parent.date ? sanitizeHeaderValue(parent.date) : "an earlier date";
  const who = parent.from ? sanitizeHeaderValue(parent.from) : "the previous sender";
  const quoted = parent.text.split(/\r?\n/).map((line) => (line === "" ? ">" : `> ${line}`));
  return `On ${when}, ${who} wrote:\n${quoted.join("\n")}`;
}
