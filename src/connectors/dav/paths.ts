// Path handling for the WebDAV (`dav`) connector.
//
// The whole point of this module is that the caller never gets to name a URL. An op
// takes `path`, relative to the account's configured share root, and this module turns
// it into URL path segments. Traversal is then structurally impossible rather than
// filtered: a path is split on "/", "." and empty segments are dropped, ".." is
// refused outright, and each surviving segment is percent-encoded on its own — so no
// segment can contain a "/" or a ".." by the time it reaches the URL.
//
// The caller's text is taken literally: "%2e%2e" is the five characters that spell a
// file name, gets encoded to "%252e%252e", and comes back unchanged. Only hrefs coming
// *from* the server are decoded, and only after checking they sit under the share root.

export const MAX_PATH_CHARS = 1024;
export const MAX_SEGMENT_CHARS = 255;

export interface DavPath {
  /** canonical path relative to the share root ("" is the root itself) */
  rel: string;
  segments: string[];
}

/**
 * Validate and canonicalize a caller-supplied path. Throws with an actionable message
 * rather than returning null: every failure here is the caller's to fix.
 */
export function normalizePath(raw: unknown, field = "path"): DavPath {
  if (raw === undefined || raw === null) return { rel: "", segments: [] };
  if (typeof raw !== "string") {
    throw new Error(`${field}: expected a string (relative to the account share root)`);
  }
  const input = raw.trim();
  if (input.length > MAX_PATH_CHARS) {
    throw new Error(`${field}: longer than ${MAX_PATH_CHARS} chars`);
  }
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new Error(`${field}: contains a control character (offset ${i})`);
    }
  }
  if (input.includes("\\")) {
    throw new Error(`${field}: use "/" as the separator, not "\\"`);
  }
  if (input.startsWith("/")) {
    throw new Error(
      `${field}: paths are relative to the account's share root — drop the leading "/" ` +
        `(the root is not addressable as an absolute path)`,
    );
  }
  const segments: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new Error(`${field}: ".." segments are refused — name the path you mean instead`);
    }
    if (part.length > MAX_SEGMENT_CHARS) {
      throw new Error(`${field}: a segment is longer than ${MAX_SEGMENT_CHARS} chars`);
    }
    segments.push(part);
  }
  return { rel: segments.join("/"), segments };
}

/** Percent-encode each segment separately, so "/" is structure and never data. */
export function encodeSegments(segments: readonly string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

/** Decode one href segment; a malformed escape stays literal rather than throwing. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a server href into decoded segments (absolute or absolute-path form). */
export function hrefSegments(href: string, base: URL): string[] | undefined {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return undefined;
  }
  if (url.hostname !== base.hostname) return undefined;
  return url.pathname.split("/").filter((s) => s !== "").map(decodeSegment);
}

/**
 * Map a server href onto a share-relative path, or undefined when it points outside
 * the share (a server is free to advertise anything; we do not adopt it).
 */
export function hrefToRel(
  shareSegments: readonly string[],
  href: string,
  base: URL,
): string | undefined {
  const segments = hrefSegments(href, base);
  if (!segments) return undefined;
  if (segments.length < shareSegments.length) return undefined;
  for (let i = 0; i < shareSegments.length; i++) {
    if (segments[i] !== shareSegments[i]) return undefined;
  }
  return segments.slice(shareSegments.length).join("/");
}

/** Share root as decoded segments, for comparing against hrefs. */
export function shareSegmentsOf(shareRoot: string): string[] {
  return shareRoot.split("/").filter((s) => s !== "").map(decodeSegment);
}

// --- content types -----------------------------------------------------------

const BY_EXTENSION: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  py: "text/x-python; charset=utf-8",
  sh: "text/x-shellscript; charset=utf-8",
  tex: "text/x-tex; charset=utf-8",
  bib: "text/plain; charset=utf-8",
  ipynb: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/** Text-ish media types — the ones `dav.get` is willing to return inline. */
export function isTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (ct === "") return false;
  if (ct.startsWith("text/")) return true;
  return /^(application\/(json|xml|x-yaml|yaml|toml|markdown|x-ndjson|javascript|x-sh|x-tex|sql|graphql)|[a-z-]+\/[a-z0-9.+-]*\+(json|xml|yaml))$/
    .test(ct);
}

/**
 * Sniff for binary content: a NUL byte in the prefix is the cheap, reliable tell that
 * "text" judgement by content-type got (e.g. application/octet-stream, or a .bin
 * mislabelled as text/plain).
 */
export function looksBinary(bytes: Uint8Array, sample = 8192): boolean {
  const end = Math.min(bytes.length, sample);
  for (let i = 0; i < end; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    // stray control bytes other than tab/newline/carriage-return/formfeed
    if (b < 9 || (b > 13 && b < 32)) return true;
  }
  return false;
}

/** Filesystem-safe name for staging: no separators, no dot-dot, bounded length. */
export function sanitizeName(name: string, max = 120): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return (cleaned === "" ? "_" : cleaned).slice(0, max);
}
