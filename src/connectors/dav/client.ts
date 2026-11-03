// WebDAV client (`dav` connector): one instance per configured account.
//
// Shaped for an LLM caller rather than for a WebDAV spec: the caller names a *path
// relative to a configured share root*, never a URL, never a method, and never base64.
// Everything sharp is decided here or in the manifest's argSchema:
//
//  * **Host pinning.** Every request goes to the account's origin, full stop. Redirects
//    are followed by hand, re-pinned each hop, and a scheme downgrade is refused — the
//    same rule caldav applies, because the failure mode (password to somebody else) is
//    the same.
//  * **Structural confinement.** `./paths.ts` turns the caller's path into segments and
//    percent-encodes each one, so "..", "/" and "\\" cannot survive into a URL. hrefs
//    coming back from the server are only adopted when they sit under the share root.
//  * **Optimistic concurrency, by default on create.** A PUT with no precondition
//    creates only (`If-None-Match: *`); overwriting needs `overwrite: true` or the
//    etag from `stat`/`get` (`If-Match`). MOVE/COPY send `Overwrite: F` unless told
//    otherwise. A 412 is always reported as "re-read and retry", never retried blind.
//  * **Payload economy.** Listings and stats are JSON projections of the multistatus;
//    no XML is ever returned to a caller. Inline reads are text-only and byte-capped;
//    binaries go to the host staging root so `fs.read`/`fs.grep` can work on them
//    without a base64 round trip through the context window.
//  * **Read-only means read-only.** `writable: false` on an account refuses every
//    mutating op in `precheck`, before a human is ever asked to approve one.

import type { JsonValue } from "../../harness/types.ts";
import { DAV, okProp, parseMultiStatus, propfindBody, type PropRef } from "../webdav.ts";
import {
  contentTypeFor,
  type DavPath,
  encodeSegments,
  hrefToRel,
  isTextual,
  looksBinary,
  normalizePath,
  sanitizeName,
  shareSegmentsOf,
} from "./paths.ts";

/** Nextcloud/ownCloud quota properties. */
const OC = "http://owncloud.org/ns";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_BYTES = 1024 * 1024;
export const DEFAULT_INLINE_BYTES = 64 * 1024;
const DEFAULT_MAX_STAGE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface DavAccountConfig {
  id: string;
  /** scheme + host (+ optional port): the only host credentials may be sent to */
  origin: string;
  /** absolute path (on the server) that `path: ""` names; never caller-supplied */
  shareRoot: string;
  user: string;
  auth: "basic" | "bearer";
  /** basic: app password; bearer: token */
  password: string;
  /** false ⇒ every mutating op is refused in precheck */
  writable: boolean;
}

export interface DavHostOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** where `stage` writes; must be a host path the agent can also read via fs */
  stagingRoot?: string;
  maxStageBytes?: number;
  /** fs root that contains stagingRoot, resolved from the live config by the caller */
  stagingFsRoot?: { name: string; path: string };
}

export interface DavEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size?: number;
  modified?: string;
  etag?: string;
  contentType?: string;
}

export type DavEntryKind = "file" | "dir" | "all";

interface DavReply {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

/** Properties every listing/stat asks for; the multistatus may answer fewer. */
const ENTRY_PROPS: PropRef[] = [
  { ns: DAV, name: "resourcetype" },
  { ns: DAV, name: "getcontentlength" },
  { ns: DAV, name: "getlastmodified" },
  { ns: DAV, name: "getetag" },
  { ns: DAV, name: "getcontenttype" },
  { ns: DAV, name: "displayname" },
];

// Both spellings are requested: RFC 4331 puts these in the DAV: namespace and
// Nextcloud 33+ answers only there, while older ownCloud/Nextcloud builds answer the
// oc: names. Asking for both and reading whichever propstat came back 2xx is cheaper
// than guessing the server version.
const QUOTA_PROPS: PropRef[] = [
  { ns: DAV, name: "quota-available-bytes" },
  { ns: DAV, name: "quota-used-bytes" },
  { ns: OC, name: "quota-available-bytes" },
  { ns: OC, name: "quota-used-bytes" },
];

function basicAuth(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

function isoDate(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString();
}

/** Trim a content-type to `type/subtype` — charset parameters are noise for a caller. */
function bareType(v: string | null | undefined): string | undefined {
  const ct = (v ?? "").split(";")[0].trim().toLowerCase();
  return ct === "" ? undefined : ct;
}

/**
 * Map an HTTP status onto something a caller can act on. The whole reason this exists:
 * "412 Precondition Failed" is useless to a model, "it changed since you read it — call
 * dav.stat and retry with the new etag" is not.
 */
function failure(op: string, path: string, status: number, body: string): Error {
  const where = path === "" ? "the share root" : JSON.stringify(path);
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  const tail = snippet === "" ? "" : ` — ${snippet}`;
  switch (status) {
    case 401:
      return new Error(
        `${op} ${where}: authentication failed (401) — the app password was revoked or is ` +
          `wrong; check secrets.dav.<account>.password`,
      );
    case 403:
      return new Error(
        `${op} ${where}: the server refused (403) — this account has no permission there, or ` +
          `the share is read-only server-side${tail}`,
      );
    case 404:
      return new Error(
        `${op} ${where}: no such path (404). Paths are relative to the account's share root; ` +
          `run dav.list({ account }) to see what is there${tail}`,
      );
    case 405:
      return new Error(
        `${op} ${where}: the server does not allow that method (405) — usually a file/directory ` +
          `mismatch, or a collection that already exists${tail}`,
      );
    case 409:
      return new Error(
        `${op} ${where}: conflict (409) — the parent directory does not exist; create it with ` +
          `dav.mkdir first${tail}`,
      );
    case 412:
      return new Error(
        `${op} ${where}: precondition failed (412) — the file changed since you read it, or the ` +
          `destination already exists. Re-read with dav.stat and retry with the new etag, or pass ` +
          `overwrite: true${tail}`,
      );
    case 413:
      return new Error(`${op} ${where}: the server rejected the body as too large (413)`);
    case 423:
      return new Error(`${op} ${where}: the resource is locked (423) — another client holds it`);
    case 507:
      return new Error(
        `${op} ${where}: quota exceeded (507) — no space left on this share`,
      );
    case 429:
      return new Error(`${op} ${where}: rate-limited by the server (429); retry later`);
    default:
      return new Error(`${op} ${where}: server answered ${status}${tail}`);
  }
}

async function readCapped(
  res: Response,
  cap: number,
  op: string,
  path: string,
  partial: boolean,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const declared = Number(res.headers.get("content-length") ?? "");
  if (!partial && Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel();
    throw new Error(
      `${op} ${path === "" ? "the share root" : JSON.stringify(path)}: the server wants to send ` +
        `${declared} bytes, over the ${cap}-byte cap. Narrow the request (dav.list a ` +
        `subdirectory, dav.get with maxBytes, dav.stage for bytes on disk)`,
    );
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total >= cap && partial) {
        // A truncated inline read is a feature (dav.get reports `truncated`); a
        // truncated *staging* download would be a corrupt file, so only partial
        // callers get to stop here.
        const keep = value.subarray(0, Math.max(0, value.byteLength - (total - cap)));
        if (keep.byteLength > 0) chunks.push(keep);
        total = cap;
        await reader.cancel().catch(() => {});
        break;
      }
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `${op} ${path === "" ? "the share root" : JSON.stringify(path)}: response over the ` +
            `${cap}-byte cap; narrow the request`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

class DavAccount {
  private readonly origin: URL;
  private readonly shareRoot: string;
  private readonly shareSegments: string[];
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly stagingRoot: string;
  private readonly maxStageBytes: number;
  private readonly stagingFsRoot?: { name: string; path: string };

  constructor(
    readonly id: string,
    cfg: DavAccountConfig,
    readonly writable: boolean,
    opts: DavHostOptions = {},
  ) {
    this.origin = new URL(cfg.origin);
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(this.origin.hostname);
    if (this.origin.protocol !== "https:" && !(loopback && this.origin.protocol === "http:")) {
      throw new Error(`dav account ${id}: origin must be https (got ${cfg.origin})`);
    }
    this.shareRoot = cfg.shareRoot.replace(/\/+$/, "");
    if (!this.shareRoot.startsWith("/")) {
      throw new Error(
        `dav account ${id}: shareRoot must be an absolute path (got ${cfg.shareRoot})`,
      );
    }
    if (/\/\.\.?(\/|$)/.test(this.shareRoot)) {
      throw new Error(`dav account ${id}: shareRoot must not contain "." or ".." segments`);
    }
    this.shareSegments = shareSegmentsOf(this.shareRoot);
    this.base = `${this.origin.origin}${this.shareRoot}`;
    this.headers = {
      authorization: cfg.auth === "bearer"
        ? `Bearer ${cfg.password}`
        : basicAuth(cfg.user, cfg.password),
      "user-agent": "denops-dav/0.10",
    };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.stagingRoot = opts.stagingRoot ?? "data/staging-dav";
    this.maxStageBytes = opts.maxStageBytes ?? DEFAULT_MAX_STAGE_BYTES;
    this.stagingFsRoot = opts.stagingFsRoot;
  }

  // --- plumbing -------------------------------------------------------------

  private pin(url: URL): URL {
    if (url.hostname !== this.origin.hostname || url.port !== this.origin.port) {
      throw new Error(
        `dav account ${this.id}: refusing to send credentials to ${url.host} ` +
          `(allowed: ${this.origin.host})`,
      );
    }
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(this.origin.hostname);
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
      throw new Error(`dav account ${this.id}: refusing to downgrade to ${url.protocol}`);
    }
    return url;
  }

  /** Absolute URL for a share-relative path; segments are encoded one by one. */
  private urlOf(path: DavPath): URL {
    const encoded = encodeSegments(path.segments);
    return this.pin(
      new URL(
        encoded === "" ? `${this.shareRoot}/` : `${this.shareRoot}/${encoded}`,
        this.origin.origin,
      ),
    );
  }

  /** Trailing-slash form, which is what collection hrefs are compared against. */
  private collectionUrl(path: DavPath): URL {
    const url = this.urlOf(path);
    if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
    return url;
  }

  private async send(
    method: string,
    url: URL,
    opts: {
      body?: Uint8Array | string;
      headers?: Record<string, string>;
      maxBytes?: number;
      partial?: boolean;
    } = {},
  ): Promise<DavReply> {
    let current = this.pin(url);
    const cap = opts.maxBytes ?? this.maxResponseBytes;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers: Record<string, string> = { ...this.headers, ...(opts.headers ?? {}) };
      const res = await fetch(current, {
        method,
        headers,
        body: opts.body as BodyInit | undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) {
          throw new Error(`dav ${method} ${current.pathname}: redirect without a Location header`);
        }
        current = this.pin(new URL(location, current));
        continue;
      }
      const bytes = await readCapped(res, cap, method, current.pathname, opts.partial === true);
      return { status: res.status, headers: res.headers, bytes };
    }
    throw new Error(`dav ${method}: more than ${MAX_REDIRECTS} redirects`);
  }

  private async expect(
    method: string,
    url: URL,
    opts: {
      body?: Uint8Array | string;
      headers?: Record<string, string>;
      maxBytes?: number;
      partial?: boolean;
      ok?: number[];
      path?: string;
    } = {},
  ): Promise<DavReply> {
    const reply = await this.send(method, url, opts);
    const ok = opts.ok ?? [];
    if (!ok.includes(reply.status)) {
      const text = new TextDecoder().decode(reply.bytes);
      throw failure(`dav.${method.toLowerCase()}`, opts.path ?? "", reply.status, text);
    }
    return reply;
  }

  private async propfind(
    path: DavPath,
    depth: "0" | "1",
    props: PropRef[] = ENTRY_PROPS,
  ): Promise<Array<{ href: string; entries: ReturnType<typeof okProp>[] }>> {
    const reply = await this.expect("PROPFIND", this.urlOf(path), {
      body: propfindBody(props),
      headers: { depth, "content-type": "application/xml; charset=utf-8" },
      ok: [207],
      path: path.rel,
    });
    const parsed = parseMultiStatus(new TextDecoder().decode(reply.bytes));
    return parsed.responses.map((r) => ({
      href: r.href,
      entries: props.map((p) => okProp(r, p.name)),
    }));
  }

  /** True when the multistatus says this response is a collection. */
  private static isCollection(prop: ReturnType<typeof okProp>): boolean {
    return prop?.children.some((c) => c.name.toLowerCase() === "collection") ?? false;
  }

  private entryOf(
    href: string,
    response: { href: string; entries: ReturnType<typeof okProp>[] },
    props: PropRef[],
    base: URL,
  ): DavEntry | undefined {
    const rel = hrefToRel(this.shareSegments, href, base);
    if (rel === undefined) return undefined; // outside the share: not adopted
    const find = (name: string) =>
      response.entries[props.findIndex((p) => p.name.toLowerCase() === name)];
    const collection = DavAccount.isCollection(find("resourcetype"));
    const name = rel === "" ? "" : (rel.split("/").pop() ?? rel);
    const size = find("getcontentlength")?.text.trim();
    const etag = find("getetag")?.text.trim();
    const modified = isoDate(find("getlastmodified")?.text.trim());
    const contentType = bareType(find("getcontenttype")?.text.trim());
    return {
      name,
      path: rel,
      kind: collection ? "dir" : "file",
      ...(collection || size === undefined || size === "" ? {} : { size: Number(size) }),
      ...(modified === undefined ? {} : { modified }),
      ...(etag === undefined || etag === "" ? {} : { etag }),
      ...(collection || contentType === undefined ? {} : { contentType }),
    };
  }

  private decode(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  /**
   * Resolve stage targets so the returned path is usable by `fs.read` directly:
   * `{ fsRoot, path }` when the staging root sits inside a configured fs root.
   */
  private stagedLocation(absPath: string): { fsRoot?: string; path: string; absPath: string } {
    const fs = this.stagingFsRoot;
    if (fs && (absPath === fs.path || absPath.startsWith(`${fs.path}/`))) {
      return {
        fsRoot: fs.name,
        path: absPath.slice(fs.path.length + 1),
        absPath,
      };
    }
    return { path: absPath, absPath };
  }

  // --- reads ----------------------------------------------------------------

  /** What `dav.accounts` reports: where the account is, and whether it writes. */
  describe(): JsonValue {
    return {
      account: this.id,
      origin: this.origin.origin,
      shareRoot: this.shareRoot,
      writable: this.writable,
    } as JsonValue;
  }

  /** Startup probe: the share root must be a collection we can PROPFIND. */
  async validate(): Promise<JsonValue> {
    const stat = await this.stat(normalizePath("")) as { kind: string };
    if (stat.kind !== "dir") {
      throw new Error("the share root is not a collection — check shareRoot in config.yaml");
    }
    return { writable: this.writable } as JsonValue;
  }

  async list(
    path: DavPath,
    opts: { limit: number; sort: "name" | "modified" | "size"; kind: DavEntryKind },
  ): Promise<JsonValue> {
    const responses = await this.propfind(path, "1");
    const self = this.urlOf(path).pathname;
    const entries: DavEntry[] = [];
    for (const r of responses) {
      // The multistatus includes the collection itself; drop it by href, and drop any
      // entry that does not resolve under the share root (a server may advertise more).
      if (
        new URL(r.href, this.origin.origin).pathname.replace(/\/$/, "") === self.replace(/\/$/, "")
      ) {
        continue;
      }
      const entry = this.entryOf(r.href, r, ENTRY_PROPS, this.origin);
      if (entry) entries.push(entry);
    }
    const filtered = opts.kind === "all" ? entries : entries.filter((e) => e.kind === opts.kind);
    const sorted = [...filtered].sort((a, b) => {
      if (opts.sort === "name") return a.name.localeCompare(b.name);
      if (opts.sort === "size") return (b.size ?? -1) - (a.size ?? -1);
      return (b.modified ?? "").localeCompare(a.modified ?? "");
    });
    const page = sorted.slice(0, opts.limit);
    return {
      account: this.id,
      path: path.rel,
      count: page.length,
      total: sorted.length,
      more: Math.max(0, sorted.length - page.length),
      entries: page,
    } as unknown as JsonValue;
  }

  async stat(path: DavPath): Promise<JsonValue> {
    const responses = await this.propfind(path, "0");
    const first = responses[0];
    if (!first) throw new Error(`dav.stat ${JSON.stringify(path.rel)}: empty multistatus`);
    const entry = this.entryOf(first.href, first, ENTRY_PROPS, this.origin);
    if (!entry) {
      throw new Error(
        `dav.stat ${JSON.stringify(path.rel)}: the server answered for a resource outside the ` +
          `share root (${first.href}) — refusing to report it`,
      );
    }
    return {
      account: this.id,
      path: path.rel,
      kind: entry.kind,
      ...(entry.size === undefined ? {} : { size: entry.size }),
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
      ...(entry.modified === undefined ? {} : { modified: entry.modified }),
      ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
    } as JsonValue;
  }

  /** Refuse a file-shaped op on a collection, before its bytes are fetched. */
  private async requireFile(op: string, path: DavPath): Promise<void> {
    const stat = await this.stat(path) as { kind: string };
    if (stat.kind !== "file") {
      throw new Error(
        `${op} ${JSON.stringify(path.rel)}: that is a directory, not a file — use dav.list ` +
          `(or dav.find) to see what is inside`,
      );
    }
  }

  async get(path: DavPath, maxBytes: number): Promise<JsonValue> {
    await this.requireFile("dav.get", path);
    const cap = Math.min(maxBytes, MAX_INLINE_BYTES);
    const reply = await this.expect("GET", this.urlOf(path), {
      ok: [200],
      maxBytes: cap + 1,
      partial: true,
      path: path.rel,
    });
    const contentType = bareType(reply.headers.get("content-type")) ?? contentTypeFor(path.rel);
    if (!isTextual(contentType) || looksBinary(reply.bytes)) {
      throw new Error(
        `dav.get ${JSON.stringify(path.rel)}: ${contentType} is not text — refusing to inline ` +
          `binary bytes. Use dav.stage({ account, path }) and read the staged file with ` +
          `fs.read/fs.grep (or fs.glob for a listing)`,
      );
    }
    const truncated = reply.bytes.byteLength > cap;
    const slice = truncated ? reply.bytes.subarray(0, cap) : reply.bytes;
    const declared = Number(reply.headers.get("content-length") ?? "");
    return {
      account: this.id,
      path: path.rel,
      contentType,
      ...(Number.isFinite(declared) ? { size: declared } : {}),
      bytes: reply.bytes.byteLength,
      truncated,
      etag: reply.headers.get("etag") ?? undefined,
      text: this.decode(slice),
    } as JsonValue;
  }

  /**
   * Bounded recursive name search. Nextcloud has no portable server-side file search
   * (SEARCH is a draft most servers do not implement), so this walks depth-1 listings
   * breadth-first under hard caps and reports exactly which cap it stopped on.
   */
  async find(
    path: DavPath,
    opts: {
      pattern: string;
      maxDepth: number;
      maxEntries: number;
      maxMs: number;
      kind: DavEntryKind;
    },
  ): Promise<JsonValue> {
    const glob = globToRegExp(opts.pattern);
    const matches: DavEntry[] = [];
    let scanned = 0;
    let stoppedBy: "depth" | "entries" | "time" | null = null;
    const deadline = Date.now() + opts.maxMs;
    let frontier: DavPath[] = [path];
    let depth = 0;
    while (frontier.length > 0) {
      if (depth > opts.maxDepth) {
        stoppedBy = stoppedBy ?? "depth";
        break;
      }
      const next: DavPath[] = [];
      for (const dir of frontier) {
        if (Date.now() > deadline) {
          stoppedBy = "time";
          break;
        }
        let entries: DavEntry[];
        try {
          entries = await this.depth1(dir);
        } catch (err) {
          // A subdirectory we cannot read (403 on a share inside a share) must not fail
          // the whole search: skip it, the caller still gets what is reachable.
          if (dir.rel === path.rel) throw err;
          continue;
        }
        scanned += 1;
        for (const e of entries) {
          if (e.kind === "dir") {
            if (e.name !== ".snapshot" && e.name !== "versions") next.push(normalizePath(e.path));
            if (opts.kind !== "file" && glob(e.name)) matches.push(e);
            continue;
          }
          if (opts.kind !== "dir" && glob(e.name)) matches.push(e);
          if (matches.length >= opts.maxEntries) {
            stoppedBy = "entries";
            break;
          }
        }
        if (stoppedBy) break;
      }
      if (stoppedBy) break;
      frontier = next;
      depth += 1;
    }
    matches.sort((a, b) => a.path.localeCompare(b.path));
    return {
      account: this.id,
      path: path.rel,
      pattern: opts.pattern,
      scanned,
      matched: matches.length,
      truncated: stoppedBy !== null,
      ...(stoppedBy === null ? {} : { stoppedBy }),
      entries: matches,
    } as unknown as JsonValue;
  }

  /** Depth-1 listing without paging, used by find/quota-class ops. */
  private async depth1(path: DavPath): Promise<DavEntry[]> {
    const responses = await this.propfind(path, "1");
    const self = this.urlOf(path).pathname.replace(/\/$/, "");
    const out: DavEntry[] = [];
    for (const r of responses) {
      const href = new URL(r.href, this.origin.origin).pathname.replace(/\/$/, "");
      if (href === self) continue;
      const entry = this.entryOf(r.href, r, ENTRY_PROPS, this.origin);
      if (entry && entry.path !== path.rel) out.push(entry);
    }
    return out;
  }

  async quota(): Promise<JsonValue> {
    const responses = await this.propfind(normalizePath(""), "0", QUOTA_PROPS);
    const first = responses[0];
    if (!first) throw new Error("dav.quota: empty multistatus");
    const available = first.entries[0]?.text.trim();
    const used = first.entries[1]?.text.trim();
    const usedBytes = used === undefined || used === "" ? undefined : Number(used);
    const availableBytes = available === undefined || available === ""
      ? undefined
      : Number(available);
    if (usedBytes === undefined && availableBytes === undefined) {
      return {
        account: this.id,
        reported: false,
        note: "this server did not report quota properties (oc:quota-used-bytes / " +
          "oc:quota-available-bytes) on the share root; quota is a Nextcloud extension",
      } as JsonValue;
    }
    // Nextcloud reports -1 for "no quota limit". Derived totals are meaningless there
    // (used + (-1) < used), so they are omitted rather than reported as nonsense.
    const unlimited = availableBytes !== undefined && availableBytes < 0;
    const totalBytes = usedBytes !== undefined && availableBytes !== undefined && !unlimited
      ? usedBytes + availableBytes
      : undefined;
    return {
      account: this.id,
      reported: true,
      ...(usedBytes === undefined ? {} : { usedBytes }),
      ...(availableBytes === undefined || unlimited ? {} : { availableBytes }),
      ...(totalBytes === undefined ? {} : { totalBytes }),
      ...(totalBytes && usedBytes !== undefined
        ? { usedPercent: Math.round((usedBytes / totalBytes) * 100) }
        : {}),
      ...(unlimited
        ? { unlimited: true, note: "the server reports no quota limit (-1 available bytes)" }
        : {}),
    } as JsonValue;
  }

  async stage(path: DavPath, destName?: string): Promise<JsonValue> {
    await this.requireFile("dav.stage", path);
    const reply = await this.expect("GET", this.urlOf(path), {
      ok: [200],
      maxBytes: this.maxStageBytes,
      path: path.rel,
    });
    const contentType = bareType(reply.headers.get("content-type")) ??
      contentTypeFor(path.rel);
    const dir = `${this.stagingRoot}/${this.id}`;
    await Deno.mkdir(dir, { recursive: true });
    const base = destName ?? (path.rel.split("/").pop() ?? "download");
    const target = `${dir}/${sanitizeName(base)}`;
    await Deno.writeFile(target, reply.bytes);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      reply.bytes.slice() as unknown as ArrayBuffer,
    );
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return {
      account: this.id,
      remotePath: path.rel,
      staged: `${this.id}/${sanitizeName(base)}`,
      ...this.stagedLocation(target),
      bytes: reply.bytes.byteLength,
      contentType,
      sha256,
    } as unknown as JsonValue;
  }

  async clearStaging(olderThanHours: number): Promise<JsonValue> {
    const dir = `${this.stagingRoot}/${this.id}`;
    const removed: string[] = [];
    const cutoff = Date.now() - Math.max(olderThanHours, 0) * 3600 * 1000;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return { account: this.id, removed } as JsonValue;
      throw err;
    }
    for (const e of entries) {
      if (!e.isFile) continue;
      const abs = `${dir}/${e.name}`;
      const info = await Deno.stat(abs);
      if (olderThanHours > 0 && (info.mtime?.getTime() ?? 0) > cutoff) continue;
      await Deno.remove(abs);
      removed.push(e.name);
    }
    return { account: this.id, removed } as JsonValue;
  }

  // --- writes ---------------------------------------------------------------

  private requireWritable(op: string): void {
    if (!this.writable) {
      throw new Error(
        `${op}: account ${this.id} is configured read-only (writable: false); ` +
          `mutating ops are refused before approval`,
      );
    }
  }

  private async freshEtag(path: DavPath): Promise<string | undefined> {
    try {
      const stat = await this.stat(path) as { etag?: string };
      return stat.etag;
    } catch {
      return undefined;
    }
  }

  async put(
    path: DavPath,
    text: string,
    opts: { contentType?: string; overwrite?: boolean; ifMatch?: string },
  ): Promise<JsonValue> {
    this.requireWritable("dav.put");
    if (path.rel === "") throw new Error("dav.put: the share root is a collection, not a file");
    const headers: Record<string, string> = {
      "content-type": opts.contentType ?? contentTypeFor(path.rel),
    };
    if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
    else if (opts.overwrite !== true) headers["if-none-match"] = "*";
    const body = new TextEncoder().encode(text);
    const reply = await this.expect("PUT", this.urlOf(path), {
      body,
      headers,
      ok: [200, 201, 204],
      path: path.rel,
    });
    const created = reply.status === 201;
    const etag = reply.headers.get("etag") ?? reply.headers.get("oc-etag") ??
      await this.freshEtag(path);
    return {
      account: this.id,
      path: path.rel,
      created,
      bytes: body.byteLength,
      contentType: headers["content-type"],
      ...(etag === undefined ? {} : { etag }),
    } as JsonValue;
  }

  async putStaged(
    path: DavPath,
    staged: string,
    opts: { contentType?: string; overwrite?: boolean; ifMatch?: string },
  ): Promise<JsonValue> {
    this.requireWritable("dav.putStaged");
    if (path.rel === "") {
      throw new Error("dav.putStaged: the share root is a collection, not a file");
    }
    const source = normalizePath(staged, "staged");
    if (source.rel === "") throw new Error("dav.putStaged: staged: expected a file name");
    const bytes = await readStagedBytes(this.stagingRoot, source);
    const headers: Record<string, string> = {
      "content-type": opts.contentType ?? contentTypeFor(path.rel),
    };
    if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
    else if (opts.overwrite !== true) headers["if-none-match"] = "*";
    const reply = await this.expect("PUT", this.urlOf(path), {
      body: bytes,
      headers,
      ok: [200, 201, 204],
      path: path.rel,
    });
    const created = reply.status === 201;
    const etag = reply.headers.get("etag") ?? reply.headers.get("oc-etag") ??
      await this.freshEtag(path);
    return {
      account: this.id,
      path: path.rel,
      created,
      bytes: bytes.byteLength,
      contentType: headers["content-type"],
      staged: source.rel,
      ...(etag === undefined ? {} : { etag }),
    } as JsonValue;
  }

  async mkdir(path: DavPath): Promise<JsonValue> {
    this.requireWritable("dav.mkdir");
    if (path.rel === "") throw new Error("dav.mkdir: the share root already exists");
    const created: string[] = [];
    let existed = false;
    for (let i = 1; i <= path.segments.length; i++) {
      const step = normalizePath(path.segments.slice(0, i).join("/"));
      const reply = await this.send("MKCOL", this.collectionUrl(step), {});
      if (reply.status === 201) {
        created.push(step.rel);
        continue;
      }
      if (reply.status === 405 || reply.status === 301) {
        // 405/301 = the collection is already there; that is the idempotent case.
        existed = true;
        continue;
      }
      throw failure("dav.mkdir", step.rel, reply.status, this.decode(reply.bytes));
    }
    return {
      account: this.id,
      path: path.rel,
      created: created.length > 0,
      createdPaths: created,
      ...(existed && created.length === 0 ? { note: "the directory already existed" } : {}),
    } as unknown as JsonValue;
  }

  private async transfer(
    op: "move" | "copy",
    from: DavPath,
    to: DavPath,
    overwrite: boolean,
  ): Promise<JsonValue> {
    this.requireWritable(`dav.${op}`);
    if (from.rel === "") throw new Error(`dav.${op}: the share root cannot be moved`);
    if (to.rel === "") throw new Error(`dav.${op}: to: expected a target path with a name`);
    const destination = this.urlOf(to);
    const reply = await this.send(op === "move" ? "MOVE" : "COPY", this.urlOf(from), {
      headers: {
        destination: destination.href,
        overwrite: overwrite ? "T" : "F",
      },
    });
    if (![201, 204].includes(reply.status)) {
      throw failure(`dav.${op}`, from.rel, reply.status, this.decode(reply.bytes));
    }
    return {
      account: this.id,
      [op === "move" ? "moved" : "copied"]: { from: from.rel, to: to.rel },
      overwritten: reply.status === 204,
    } as unknown as JsonValue;
  }

  move(from: DavPath, to: DavPath, overwrite: boolean): Promise<JsonValue> {
    return this.transfer("move", from, to, overwrite);
  }

  copy(from: DavPath, to: DavPath, overwrite: boolean): Promise<JsonValue> {
    return this.transfer("copy", from, to, overwrite);
  }

  async remove(path: DavPath, recursive: boolean): Promise<JsonValue> {
    this.requireWritable("dav.delete");
    if (path.rel === "") throw new Error("dav.delete: refusing to delete the share root");
    const stat = await this.stat(path) as { kind: string; size?: number };
    if (stat.kind === "dir" && !recursive) {
      throw new Error(
        `dav.delete ${JSON.stringify(path.rel)}: it is a directory. Passing recursive: true ` +
          `deletes it and everything inside it — that has to be explicit`,
      );
    }
    const reply = await this.send("DELETE", this.urlOf(path), {});
    if (![200, 204].includes(reply.status)) {
      throw failure("dav.delete", path.rel, reply.status, this.decode(reply.bytes));
    }
    return {
      account: this.id,
      deleted: path.rel,
      kind: stat.kind === "dir" ? "dir" : "file",
    } as JsonValue;
  }
}

/** Read a staged file, refusing anything that is not a regular file under the root. */
async function readStagedBytes(root: string, staged: DavPath): Promise<Uint8Array> {
  let realRoot: string;
  try {
    realRoot = await Deno.realPath(root);
  } catch {
    throw new Error(
      `dav.putStaged: the staging root is not there yet (${root}); run dav.stage first`,
    );
  }
  let real: string;
  try {
    real = await Deno.realPath(`${root}/${staged.rel}`);
  } catch {
    throw new Error(
      `dav.putStaged: staged ${JSON.stringify(staged.rel)} is not staged (no such file under ` +
        `${root}); dav.stage it first, or check the name dav.stage returned`,
    );
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}/`)) {
    throw new Error(
      `dav.putStaged: staged ${JSON.stringify(staged.rel)} resolves outside the staging root ` +
        `(${real}); refusing to upload it`,
    );
  }
  const info = await Deno.stat(real);
  if (!info.isFile) throw new Error(`dav.putStaged: ${JSON.stringify(staged.rel)} is not a file`);
  return await Deno.readFile(real);
}

/**
 * Basename matcher: `*` and `?` glob when the pattern has them, plain case-insensitive
 * substring otherwise. Keeping both keeps the common call (`find "budget"`) from
 * needing the caller to know which dialect it is in.
 */
export function globToRegExp(pattern: string): (name: string) => boolean {
  if (!/[*?]/.test(pattern)) {
    const needle = pattern.toLowerCase();
    return (name) => name.toLowerCase().includes(needle);
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(
    /\?/g,
    ".",
  );
  const re = new RegExp(`^${escaped}$`, "i");
  return (name) => re.test(name);
}

export class DavHost {
  private readonly accounts = new Map<string, DavAccount>();
  private readonly broken = new Map<string, string>();

  constructor(configs: DavAccountConfig[], opts: DavHostOptions = {}) {
    for (const cfg of configs) {
      // One unusable account must not take the family down (same rule as forge): the
      // server still boots and the other account still works.
      try {
        this.accounts.set(cfg.id, new DavAccount(cfg.id, cfg, cfg.writable, opts));
      } catch (err) {
        this.broken.set(cfg.id, (err as Error).message);
      }
    }
  }

  ids(): string[] {
    return [...this.accounts.keys()];
  }

  get(id: string): DavAccount {
    const account = this.accounts.get(id);
    if (account) return account;
    const reason = this.broken.get(id);
    if (reason) throw new Error(`dav account ${id} is unusable: ${reason}`);
    throw new Error(
      `unknown dav account "${id}"; known: ${this.ids().join(", ") || "(none)"}`,
    );
  }

  /** Describe accounts for `dav.accounts` — no credentials, ever. */
  describe(): JsonValue {
    return {
      accounts: [...this.accounts.values()].map((a) => a.describe()),
      ...(this.broken.size === 0 ? {} : {
        unusable: [...this.broken].map(([id, error]) => ({ id, error })),
      }),
    };
  }

  /** Precheck helper: refuse a mutating op on a read-only account before approval. */
  writableProblem(id: string, op: string): string | null {
    const account = this.accounts.get(id);
    if (!account) {
      if (this.broken.has(id)) return `dav account ${id} is unusable: ${this.broken.get(id)}`;
      return `unknown dav account "${id}"; known: ${this.ids().join(", ") || "(none)"}`;
    }
    return account.writable ? null : `${op}: account ${id} is read-only (writable: false)`;
  }

  /** Startup reachability probe: one authenticated PROPFIND per share root. */
  async validateAll(): Promise<Array<{ account: string; writable: boolean }>> {
    const out: Array<{ account: string; writable: boolean }> = [];
    const failures: string[] = [];
    for (const [id, account] of this.accounts) {
      try {
        const r = await account.validate() as { writable: boolean };
        out.push({ account: id, writable: r.writable });
      } catch (err) {
        failures.push(`${id}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
    return out;
  }
}

export { DavAccount };
