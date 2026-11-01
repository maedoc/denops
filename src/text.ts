// Small, dependency-free text codecs shared by the mail (RFC822/MIME) and web
// (HTML) connectors. Deliberately partial: UTF-8 with ISO-8859-1 as a fallback,
// base64, quoted-printable, RFC 2047 encoded words, and a best-effort html→text.
// Exotic charsets and structures are reported by the caller, never guessed at.

/** Decode bytes with a charset label, falling back to UTF-8 when it is unknown. */
export function decodeBytes(bytes: Uint8Array, charset = "utf-8"): string {
  const label = (charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function encodeBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function decodeBase64Text(input: string, charset = "utf-8"): string {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, "");
  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    return "";
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return decodeBytes(bytes, charset);
}

export function encodeBase64Text(text: string): string {
  const bytes = encodeBytes(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Decode quoted-printable. Handles `=XX` escapes and soft line breaks; characters
 * above 0x7f are passed through as UTF-8 (bodies are supposed to be escaped, but
 * real mail is not always).
 */
export function decodeQuotedPrintable(input: string, charset = "utf-8"): string {
  const chunks: number[] = [];
  const pushUtf8 = (s: string) => {
    for (const b of encodeBytes(s)) chunks.push(b);
  };
  const src = input.replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      chunks.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    pushUtf8(c);
  }
  return decodeBytes(new Uint8Array(chunks), charset);
}

export function decodeTransferEncoding(body: string, encoding = "", charset = "utf-8"): string {
  const enc = encoding.trim().toLowerCase();
  if (enc === "base64") return decodeBase64Text(body, charset);
  if (enc === "quoted-printable") return decodeQuotedPrintable(body, charset);
  return body;
}

/** Decode RFC 2047 encoded words (`=?UTF-8?B?…?=`) in a header value. */
export function decodeRfc2047(value: string): string {
  return value.replace(
    /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=\s*/g,
    (_m, charset: string, enc: string, text: string) => {
      if (enc.toUpperCase() === "B") return decodeBase64Text(text, charset);
      // Q encoding: `_` is a space, the rest is quoted-printable
      return decodeQuotedPrintable(text.replace(/_/g, " "), charset);
    },
  ).trim();
}

/**
 * Encode a header value for transport: ASCII passes through, anything else becomes
 * one UTF-8 base64 encoded word. Never emits CR/LF, so a value derived from an
 * untrusted message cannot inject headers.
 */
export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${encodeBase64Text(clean)}?=`;
}

/** Strip CR/LF and control characters, collapse runs of whitespace, trim. */
export function sanitizeHeaderValue(value: string): string {
  // deno-lint-ignore no-control-regex
  return String(value).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  euro: "€",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  Eacute: "É",
  Agrave: "À",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? m;
  });
}

/**
 * Best-effort html→text: drop non-content elements, turn block boundaries into
 * newlines, strip tags, decode entities. Good enough to read an article or a docs
 * page; it is NOT a renderer and says so in the op doc.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(p|div|section|article|header|footer|main|nav|aside|table|thead|tbody|tr)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n> ")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
