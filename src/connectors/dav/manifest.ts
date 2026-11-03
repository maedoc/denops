// WebDAV / Nextcloud connector (`dav` family).
//
// The surface is chosen for the caller that actually uses it: a model with a byte
// budget and no filesystem of its own. That has consequences worth stating, because
// they are the difference between a usable surface and a thin WebDAV binding:
//
//  * **One address form.** Every op takes `path`, relative to the account's configured
//    share root. Never a URL, never an absolute path, never a server-side href. The same
//    string comes back in results, so paths round-trip.
//  * **No XML, no base64.** Listings are JSON projections; text reads are inline and
//    byte-capped; bytes go to the host staging root (`dav.stage`) and come back in via
//    `dav.putStaged`, so a PDF never passes through the context window.
//  * **Cheap to be safe.** Create-only by default (`If-None-Match: *`), etag-gated
//    updates (`ifMatch`), `Overwrite: F` on move/copy, and `dav.delete` on a directory
//    needs `recursive: true` as a second, explicit yes.
//  * **Refusals happen before the human.** Read-only accounts and impossible paths are
//    rejected in `precheck`/`argSchema`; an approval prompt only ever asks about work
//    that can actually be done.
//  * **Bounded everything.** A depth-1 PROPFIND has no paging, so a listing has a byte
//    cap and says so; `dav.find` stops on depth/entries/time and reports which.

import {
  compose,
  optBool,
  optNum,
  optOneOf,
  optStr,
  rejectUnknown,
  str,
} from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue, OpSpec } from "../../harness/types.ts";
import { checkShapeArgs, wrapClient } from "../shape.ts";
import {
  type DavAccountConfig,
  DavHost,
  type DavHostOptions,
  DEFAULT_INLINE_BYTES,
} from "./client.ts";
import { MAX_PATH_CHARS, normalizePath } from "./paths.ts";

export interface DavConnectorDeps extends DavHostOptions {
  accounts: DavAccountConfig[];
}

const HINT =
  ' Add fields: ["..."] to project, or full: true for the whole object (rarely worth it here).';

/** Validate a caller path in argSchema, so traversal is refused before any approval. */
function pathArg(field: string): (args: unknown) => string | null {
  return (args) => {
    const v = (args as Record<string, unknown>)[field];
    if (v === undefined) return null;
    if (typeof v !== "string") return `${field}: expected a string`;
    if (v.length > MAX_PATH_CHARS) return `${field}: longer than ${MAX_PATH_CHARS} chars`;
    try {
      normalizePath(v, field);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  };
}

/** Exclude globs are matched against entry *names*; bounded so a call stays reviewable. */
const excludeArg = (field: string) => (args: unknown): string | null => {
  const v = (args as Record<string, unknown>)[field];
  if (v === undefined) return null;
  if (!Array.isArray(v)) return `${field}: expected an array of globs`;
  if (v.length === 0) return `${field}: must not be empty`;
  if (v.length > 10) return `${field}: too many entries (${v.length} > 10)`;
  for (let i = 0; i < v.length; i++) {
    const g = v[i];
    if (typeof g !== "string" || g === "" || g.length > 100) {
      return `${field}[${i}]: expected a glob string of 1..100 chars`;
    }
  }
  return null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function davConnector(deps: DavConnectorDeps): Connector {
  const host = new DavHost(deps.accounts, {
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    ...(deps.maxResponseBytes === undefined ? {} : { maxResponseBytes: deps.maxResponseBytes }),
    ...(deps.stagingRoot === undefined ? {} : { stagingRoot: deps.stagingRoot }),
    ...(deps.maxStageBytes === undefined ? {} : { maxStageBytes: deps.maxStageBytes }),
    ...(deps.stagingFsRoot === undefined ? {} : { stagingFsRoot: deps.stagingFsRoot }),
  });

  const acc = str("account");
  const path = optStr("path", MAX_PATH_CHARS);
  const from = str("from");
  const to = str("to");
  const staged = str("staged");

  /** Mutating ops all carry this: read-only accounts are refused pre-approval. */
  const writable = (op: string) => (args: unknown): string | null => {
    if (!isRecord(args) || typeof args.account !== "string") return null;
    return host.writableProblem(args.account, op);
  };

  /** Best-effort description of what a write will hit, for the approval prompt. */
  const describeTarget = async (account: string, rel: string): Promise<string> => {
    try {
      const a = host.get(account);
      const stat = await a.stat(normalizePath(rel)) as {
        kind: string;
        size?: number;
        modified?: string;
      };
      const size = stat.size === undefined ? "" : `, ${stat.size} B`;
      const when = stat.modified === undefined ? "" : `, modified ${stat.modified}`;
      return stat.kind === "dir" ? "an existing directory" : `an existing file${size}${when}`;
    } catch {
      return "nothing (new path)";
    }
  };

  const redactArgs = (op: string, a: JsonValue): Record<string, unknown> => {
    const r = (a ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      // File bodies never go to the log: data/server.log is rotated and readable by
      // denops.logs, and a payload is not a log line.
      out[k] = k === "text" && typeof v === "string" ? `<${v.length} chars>` : v;
    }
    return { connector: "dav", op, ...out };
  };

  const client = (ctx: HostContext) => {
    const wrap =
      <A>(op: string, fn: (a: A) => Promise<JsonValue>) =>
      async (a: JsonValue): Promise<JsonValue> => {
        ctx.log(redactArgs(op, a));
        return await fn(a as A);
      };

    return {
      "accounts": wrap("accounts", () => Promise.resolve(host.describe())),

      "list": wrap("list", async (a: {
        account: string;
        path?: string;
        limit?: number;
        offset?: number;
        sort?: "name" | "modified" | "size";
        kind?: "file" | "dir" | "all";
        exclude?: string[];
      }) =>
        await host.get(a.account).list(normalizePath(a.path), {
          limit: Math.min(a.limit ?? 100, 500),
          offset: Math.max(a.offset ?? 0, 0),
          sort: a.sort ?? "name",
          kind: a.kind ?? "all",
          ...(a.exclude === undefined ? {} : { exclude: a.exclude }),
        })),

      "stat": wrap(
        "stat",
        async (a: { account: string; path?: string }) =>
          await host.get(a.account).stat(normalizePath(a.path)),
      ),

      "get": wrap(
        "get",
        async (a: { account: string; path: string; maxBytes?: number; offset?: number }) =>
          await host.get(a.account).get(
            normalizePath(a.path),
            Math.min(a.maxBytes ?? DEFAULT_INLINE_BYTES, DEFAULT_INLINE_BYTES),
            Math.max(a.offset ?? 0, 0),
          ),
      ),

      "find": wrap("find", async (a: {
        account: string;
        path?: string;
        pattern: string;
        maxDepth?: number;
        maxEntries?: number;
        maxMs?: number;
        kind?: "file" | "dir" | "all";
        exclude?: string[];
      }) =>
        await host.get(a.account).find(normalizePath(a.path), {
          pattern: a.pattern,
          maxDepth: Math.min(a.maxDepth ?? 3, 6),
          maxEntries: Math.min(a.maxEntries ?? 100, 500),
          maxMs: Math.min(a.maxMs ?? 8_000, 20_000),
          kind: a.kind ?? "file",
          ...(a.exclude === undefined ? {} : { exclude: a.exclude }),
        })),

      "grep": wrap("grep", async (a: {
        account: string;
        path?: string;
        pattern: string;
        namePattern?: string;
        maxDepth?: number;
        maxFiles?: number;
        maxBytesPerFile?: number;
        maxMatches?: number;
        maxMs?: number;
        exclude?: string[];
      }) =>
        await host.get(a.account).grep(normalizePath(a.path), {
          pattern: a.pattern,
          ...(a.namePattern === undefined ? {} : { namePattern: a.namePattern }),
          maxDepth: Math.min(a.maxDepth ?? 2, 5),
          maxFiles: Math.min(a.maxFiles ?? 20, 100),
          maxBytesPerFile: Math.min(a.maxBytesPerFile ?? 64 * 1024, 256 * 1024),
          maxMatches: Math.min(a.maxMatches ?? 50, 200),
          maxMs: Math.min(a.maxMs ?? 8_000, 20_000),
          ...(a.exclude === undefined ? {} : { exclude: a.exclude }),
        })),

      "quota": wrap("quota", async (a: { account: string }) => await host.get(a.account).quota()),

      "stage": wrap("stage", async (a: {
        account: string;
        path: string;
        destName?: string;
      }) => await host.get(a.account).stage(normalizePath(a.path), a.destName)),

      "staging.clear": wrap("staging.clear", async (a: {
        account: string;
        olderThanHours?: number;
      }) => await host.get(a.account).clearStaging(a.olderThanHours ?? 0)),

      "edit": wrap("edit", async (a: {
        account: string;
        path: string;
        prepend?: string;
        append?: string;
        replace?: Array<{ find: string; replace: string; all?: boolean; optional?: boolean }>;
        createIfMissing?: boolean;
        ifMatch?: string;
        maxBytes?: number;
      }) =>
        await host.get(a.account).edit(normalizePath(a.path), {
          ...(a.prepend === undefined ? {} : { prepend: a.prepend }),
          ...(a.append === undefined ? {} : { append: a.append }),
          ...(a.replace === undefined ? {} : { replace: a.replace }),
          ...(a.createIfMissing === undefined ? {} : { createIfMissing: a.createIfMissing }),
          ...(a.ifMatch === undefined ? {} : { ifMatch: a.ifMatch }),
          maxBytes: Math.min(a.maxBytes ?? 1024 * 1024, 1024 * 1024),
        })),

      "put": wrap("put", async (a: {
        account: string;
        path: string;
        text: string;
        contentType?: string;
        overwrite?: boolean;
        ifMatch?: string;
      }) =>
        await host.get(a.account).put(normalizePath(a.path), a.text, {
          ...(a.contentType === undefined ? {} : { contentType: a.contentType }),
          ...(a.overwrite === undefined ? {} : { overwrite: a.overwrite }),
          ...(a.ifMatch === undefined ? {} : { ifMatch: a.ifMatch }),
        })),

      "putStaged": wrap("putStaged", async (a: {
        account: string;
        path: string;
        staged: string;
        contentType?: string;
        overwrite?: boolean;
        ifMatch?: string;
      }) =>
        await host.get(a.account).putStaged(normalizePath(a.path), a.staged, {
          ...(a.contentType === undefined ? {} : { contentType: a.contentType }),
          ...(a.overwrite === undefined ? {} : { overwrite: a.overwrite }),
          ...(a.ifMatch === undefined ? {} : { ifMatch: a.ifMatch }),
        })),

      "mkdir": wrap(
        "mkdir",
        async (a: { account: string; path: string }) =>
          await host.get(a.account).mkdir(normalizePath(a.path)),
      ),

      "move": wrap("move", async (a: {
        account: string;
        from: string;
        to: string;
        overwrite?: boolean;
        ifMatch?: string;
      }) =>
        await host.get(a.account).move(
          normalizePath(a.from, "from"),
          normalizePath(a.to, "to"),
          a.overwrite === true,
          a.ifMatch,
        )),

      "copy": wrap("copy", async (a: {
        account: string;
        from: string;
        to: string;
        overwrite?: boolean;
      }) =>
        await host.get(a.account).copy(
          normalizePath(a.from, "from"),
          normalizePath(a.to, "to"),
          a.overwrite === true,
        )),

      "trash.list": wrap("trash.list", async (a: {
        account: string;
        limit?: number;
        offset?: number;
      }) =>
        await host.get(a.account).trashList(
          Math.min(a.limit ?? 50, 500),
          Math.max(a.offset ?? 0, 0),
        )),

      "trash.restore": wrap("trash.restore", async (a: {
        account: string;
        id: string;
        to?: string;
        overwrite?: boolean;
      }) => await host.get(a.account).trashRestore(a.id, a.to, a.overwrite === true)),

      "trash.purge": wrap(
        "trash.purge",
        async (a: { account: string; id: string }) => await host.get(a.account).trashPurge(a.id),
      ),

      "versions.list": wrap("versions.list", async (a: {
        account: string;
        path: string;
        limit?: number;
      }) =>
        await host.get(a.account).versionsList(
          normalizePath(a.path),
          Math.min(a.limit ?? 50, 200),
        )),

      "versions.restore": wrap("versions.restore", async (a: {
        account: string;
        path: string;
        version: string;
        overwrite?: boolean;
      }) =>
        await host.get(a.account).versionsRestore(
          normalizePath(a.path),
          a.version,
          a.overwrite === true,
        )),

      "delete": wrap("delete", async (a: {
        account: string;
        path: string;
        recursive?: boolean;
        ifMatch?: string;
      }) =>
        await host.get(a.account).remove(normalizePath(a.path), a.recursive === true, a.ifMatch)),
    };
  };

  const ops: OpSpec[] = [
    {
      name: "dav.accounts",
      tier: "open",
      doc: "WebDAV accounts this deployment exposes: id, origin, shareRoot and whether it is " +
        "writable (never credentials). args: {}. Start here: `path` on every other op is " +
        "relative to that account's shareRoot.",
      argSchema: compose(rejectUnknown()),
    },
    {
      name: "dav.list",
      tier: "open",
      doc:
        "One directory, depth 1. args: { account, path?, limit?, offset?, sort?, kind?, exclude? } — " +
        '`exclude` is globs matched against entry names (e.g. ["._*", ".DS_Store"]) so macOS ' +
        "resource-fork junk stays out of the payload; path " +
        "defaults to the share root; sort is name|modified|size (default name; modified/size " +
        "newest/largest first); kind is file|dir|all. Returns { account, path, count, total, " +
        "offset, more, nextOffset, entries: [{ name, path, kind, size?, modified?, etag?, " +
        "contentType? }] }. Not recursive (use dav.find). The server cannot page a PROPFIND, so " +
        "the whole directory is fetched once and sliced here: pass `nextOffset` back as `offset` " +
        "to continue, and treat `more`/`nextOffset: null` as the end." + HINT,
      argSchema: compose(
        rejectUnknown(),
        acc,
        path,
        pathArg("path"),
        optNum("limit"),
        optOneOf("sort", ["name", "modified", "size"]),
        optOneOf("kind", ["file", "dir", "all"]),
        excludeArg("exclude"),
        (a) => {
          const r = a as { limit?: number };
          if (r.limit !== undefined && (r.limit < 1 || r.limit > 500)) {
            return "limit: expected 1..500";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.stat",
      tier: "open",
      doc:
        "One path's metadata: { account, path?, kind, size?, etag?, modified?, contentType? }. " +
        "This is where a fresh `etag` comes from before dav.put({ ifMatch }) — pass it back " +
        "verbatim, it is the server's string." + HINT,
      argSchema: compose(rejectUnknown(), acc, path, pathArg("path")),
    },
    {
      name: "dav.get",
      tier: "open",
      doc:
        "Read a text file inline, or a window of one. args: { account, path, maxBytes?, offset? } " +
        "(maxBytes default 64 KiB, cap 1 MiB; offset is a byte position — Nextcloud honours it as " +
        "a Range request, so a 1 MB log is walkable in slices instead of unreadable). Returns " +
        "{ path, text, bytes, offset, size?, totalBytes?, nextOffset?, truncated, contentType, " +
        "etag?, encodingIssue?, note? }: pass `nextOffset` back as `offset` to continue; `size` is " +
        "the file's size when the server states it (never a bogus 0); `encodingIssue` means the " +
        "bytes are not valid UTF-8 and `text` is lossy. Binary content is refused with a pointer to " +
        "dav.stage.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        optNum("maxBytes"),
        optNum("offset"),
        pathArg("path"),
        (a) => {
          const r = a as { path?: string; maxBytes?: number; offset?: number };
          if (r.path !== undefined && normalizePath(r.path).segments.length === 0) {
            return "path: the share root is a directory, not a file";
          }
          if (r.maxBytes !== undefined && (r.maxBytes < 1 || r.maxBytes > 1024 * 1024)) {
            return "maxBytes: expected 1..1048576";
          }
          if (r.offset !== undefined && (r.offset < 0 || r.offset > 1_073_741_824)) {
            return "offset: expected 0..1073741824";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.find",
      tier: "open",
      doc:
        "Bounded recursive name search — the 'where is that file?' op. args: { account, path?, " +
        "pattern, maxDepth?, maxEntries?, maxMs?, kind? }. pattern is a case-insensitive substring, " +
        "or a `*`/`?` glob when it contains them. maxDepth default 3 (cap 6), maxEntries 100 (cap " +
        "500), maxMs 8000 (cap 20000). Directories are walked in parallel, four at a time. Returns " +
        "{ scanned, matched, truncated, stoppedBy?, unscanned?, resumeFrom?, entries }. truncated is " +
        "honest: stoppedBy says whether depth, entries or time cut the walk, and `resumeFrom` lists " +
        "the directories it never reached — find inside those instead of starting over. `exclude` " +
        "globs filter entry names." + HINT,
      argSchema: compose(
        rejectUnknown(),
        acc,
        path,
        pathArg("path"),
        str("pattern"),
        optNum("maxDepth"),
        optNum("maxEntries"),
        optNum("maxMs"),
        optOneOf("kind", ["file", "dir", "all"]),
        excludeArg("exclude"),
        (a) => {
          const r = a as {
            pattern?: string;
            maxDepth?: number;
            maxEntries?: number;
            maxMs?: number;
          };
          if (r.pattern !== undefined && r.pattern.length > 200) return "pattern: max 200 chars";
          if (r.maxDepth !== undefined && (r.maxDepth < 0 || r.maxDepth > 6)) {
            return "maxDepth: expected 0..6";
          }
          if (r.maxEntries !== undefined && (r.maxEntries < 1 || r.maxEntries > 500)) {
            return "maxEntries: expected 1..500";
          }
          if (r.maxMs !== undefined && (r.maxMs < 100 || r.maxMs > 20_000)) {
            return "maxMs: expected 100..20000";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.grep",
      tier: "open",
      doc:
        "Which files MENTION this text — content search over a bounded walk. args: { account, path?, " +
        "pattern, namePattern?, maxDepth?, maxFiles?, maxBytesPerFile?, maxMatches?, maxMs?, exclude? }. " +
        "`pattern` is a literal, case-insensitive substring (not a regex: a caller-supplied pattern " +
        "is an invitation to catastrophic backtracking, and 'the file that says docathon' is the " +
        'actual question); `namePattern` narrows which files are read, e.g. "*.md". Defaults: ' +
        "maxDepth 2 (cap 5), maxFiles 20 (cap 100), maxBytesPerFile 64 KiB (cap 256 KiB), " +
        "maxMatches 50, maxMs 8000. Returns { filesScanned, filesMatched, matchCount, truncated, " +
        "stoppedBy?, skipped: { binary, tooLarge, unreadable, encoding }, hits: [{ path, line, " +
        "text }] } — `skipped` is counted, never silently dropped. Prefer this over find+get for " +
        "'where is X mentioned'; use dav.find when you know the name." + HINT,
      argSchema: compose(
        rejectUnknown(),
        acc,
        path,
        pathArg("path"),
        str("pattern"),
        optStr("namePattern", 200),
        optNum("maxDepth"),
        optNum("maxFiles"),
        optNum("maxBytesPerFile"),
        optNum("maxMatches"),
        optNum("maxMs"),
        excludeArg("exclude"),
        (a) => {
          const r = a as {
            pattern?: string;
            maxDepth?: number;
            maxFiles?: number;
            maxBytesPerFile?: number;
            maxMatches?: number;
            maxMs?: number;
          };
          if (r.pattern !== undefined && (r.pattern.length < 2 || r.pattern.length > 200)) {
            return "pattern: expected 2..200 chars (a shorter needle matches everything)";
          }
          if (r.maxDepth !== undefined && (r.maxDepth < 0 || r.maxDepth > 5)) {
            return "maxDepth: expected 0..5";
          }
          if (r.maxFiles !== undefined && (r.maxFiles < 1 || r.maxFiles > 100)) {
            return "maxFiles: expected 1..100";
          }
          if (
            r.maxBytesPerFile !== undefined &&
            (r.maxBytesPerFile < 1 || r.maxBytesPerFile > 256 * 1024)
          ) {
            return "maxBytesPerFile: expected 1..262144";
          }
          if (r.maxMatches !== undefined && (r.maxMatches < 1 || r.maxMatches > 200)) {
            return "maxMatches: expected 1..200";
          }
          if (r.maxMs !== undefined && (r.maxMs < 100 || r.maxMs > 20_000)) {
            return "maxMs: expected 100..20000";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.quota",
      tier: "open",
      doc: "Space on the account's share: { reported, usedBytes?, availableBytes?, totalBytes?, " +
        "usedPercent?, note? }. Nextcloud reports quota as oc:quota-* properties; a server that " +
        "does not gets reported: false rather than a guess. args: { account }.",
      argSchema: compose(rejectUnknown(), acc),
    },
    {
      name: "dav.stage",
      tier: "open",
      doc:
        "Download any file (any size, any type) into the host staging root so fs.read / fs.grep / " +
        "fs.glob can work on it. args: { account, path, destName? }. Returns { remotePath, absPath, " +
        "path, fsRoot?, bytes, contentType, sha256 }. When the staging root sits inside a configured " +
        "fs root, `fsRoot` + `path` go straight into fs.read; keep the sha256 to prove what was " +
        "staged. A same-named download with identical bytes is reused (`reused: true`) instead of " +
        "rewritten; different bytes at the same name are refused rather than clobbering — pass " +
        "`destName` to keep both. Staged copies are not pruned automatically — dav.staging.clear.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        optStr("destName", 120),
        pathArg("path"),
      ),
    },
    {
      name: "dav.staging.clear",
      tier: "open",
      doc: "Delete staged copies for one account (the files dav.stage wrote). args: { account, " +
        "olderThanHours? } (0 = all, the default). Returns { account, removed: [names] }. Only the " +
        "account's own staging subdirectory is touched.",
      argSchema: compose(rejectUnknown(), acc, optNum("olderThanHours")),
    },
    {
      name: "dav.edit",
      tier: "approval",
      summarize: async (a) => {
        const r = a as {
          account?: string;
          path?: string;
          prepend?: string;
          append?: string;
          replace?: Array<{ find?: string; replace?: string }>;
          createIfMissing?: boolean;
        };
        const target = await describeTarget(String(r.account), String(r.path ?? ""));
        const parts: string[] = [];
        const replaces = Array.isArray(r.replace) ? r.replace : [];
        if (replaces.length > 0) {
          parts.push(
            replaces.length === 1
              ? `replace ${JSON.stringify(String(replaces[0]?.find ?? ""))}`
              : `${replaces.length} literal replacements`,
          );
        }
        if (r.prepend !== undefined) parts.push(`prepend ${r.prepend.length} chars`);
        if (r.append !== undefined) parts.push(`append ${r.append.length} chars`);
        return `Edit ${r.account}:${r.path} — ${target}; ${parts.join(", ")}. ` +
          `The write is conditional on the etag read in the same call (412 if it changed).`;
      },
      doc: "Read-modify-write in ONE approval: the file is read, the transforms applied, and the " +
        "result written back carrying the etag of that same read — no full body through the " +
        "caller, no lost update. args: { account, path, append?, prepend?, replace?, " +
        "createIfMissing?, ifMatch?, maxBytes? }. `replace` is [{ find, replace, all?, optional? }]: " +
        "**literal** text, first occurrence unless all: true, and a find that matches nothing is an " +
        "error unless that entry is optional — a silent no-op is the one outcome worth failing on. " +
        "Order: replace → prepend → append. A file larger than maxBytes (1 MiB) is refused: stage " +
        "it and rewrite with dav.putStaged instead. If the transforms produce identical text, " +
        "nothing is written (unchanged: true). Returns { path, created, unchanged, previousBytes, " +
        "bytes, etag, replacements, precondition }.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        optStr("prepend", 262_144),
        optStr("append", 262_144),
        optStr("ifMatch", 200),
        optBool("createIfMissing"),
        optNum("maxBytes"),
        pathArg("path"),
        writable("dav.edit"),
        (a) => {
          const r = a as {
            path?: string;
            prepend?: string;
            append?: string;
            maxBytes?: number;
            replace?: unknown;
          };
          if (r.path !== undefined && normalizePath(r.path).segments.length === 0) {
            return "path: the share root is a directory, name a file";
          }
          if (r.prepend === undefined && r.append === undefined && r.replace === undefined) {
            return "pass at least one of append, prepend or replace";
          }
          if (r.maxBytes !== undefined && (r.maxBytes < 1 || r.maxBytes > 1024 * 1024)) {
            return "maxBytes: expected 1..1048576";
          }
          if (r.replace === undefined) return null;
          if (!Array.isArray(r.replace)) return "replace: expected an array of { find, replace }";
          if (r.replace.length === 0) return "replace: must not be empty";
          if (r.replace.length > 20) return `replace: too many entries (${r.replace.length} > 20)`;
          for (let i = 0; i < r.replace.length; i++) {
            const entry = r.replace[i];
            if (!isRecord(entry)) return `replace[${i}]: expected an object`;
            for (const key of Object.keys(entry)) {
              if (!["find", "replace", "all", "optional"].includes(key)) {
                return `replace[${i}]: unexpected field "${key}" (allowed: find, replace, all, optional)`;
              }
            }
            if (typeof entry.find !== "string" || entry.find === "") {
              return `replace[${i}].find: expected a non-empty string (literal text, not a pattern)`;
            }
            if (entry.find.length > 4096) return `replace[${i}].find: max 4096 chars`;
            if (typeof entry.replace !== "string") {
              return `replace[${i}].replace: expected a string (pass "" to delete the match)`;
            }
            if (entry.replace.length > 262_144) return `replace[${i}].replace: max 262144 chars`;
            if (entry.all !== undefined && typeof entry.all !== "boolean") {
              return `replace[${i}].all: expected boolean`;
            }
            if (entry.optional !== undefined && typeof entry.optional !== "boolean") {
              return `replace[${i}].optional: expected boolean`;
            }
          }
          return null;
        },
      ),
    },
    {
      name: "dav.put",
      tier: "approval",
      summarize: async (a) => {
        const r = a as { account?: string; path?: string; text?: string };
        const bytes = new TextEncoder().encode(r.text ?? "").byteLength;
        const target = await describeTarget(String(r.account), String(r.path ?? ""));
        return `Write ${bytes} bytes of text to ${r.account}:${r.path} — ${target}.`;
      },
      doc:
        "Write a text file (no base64). args: { account, path, text, contentType?, overwrite?, " +
        "ifMatch? }. Creates only unless `overwrite: true` (sends If-None-Match: *) or `ifMatch` is " +
        "the etag from dav.stat/dav.get (sends If-Match); a 412 means it changed, so re-read rather " +
        "than clobber. Returns { path, created, bytes, contentType, etag? } — the etag is the new " +
        "one, so consecutive writes can chain without a stat. For >1 MiB or binary content use " +
        "dav.stage + dav.putStaged.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        str("text"),
        optStr("contentType", 200),
        optBool("overwrite"),
        optStr("ifMatch", 200),
        pathArg("path"),
        writable("dav.put"),
        (a) => {
          const r = a as { path?: string; overwrite?: boolean; ifMatch?: string };
          if (r.path !== undefined && normalizePath(r.path).segments.length === 0) {
            return "path: the share root is a directory, name a file";
          }
          if (r.overwrite === true && r.ifMatch !== undefined) {
            return "overwrite and ifMatch are mutually exclusive: ifMatch already allows a winning overwrite";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.putStaged",
      tier: "approval",
      summarize: async (a) => {
        const r = a as { account?: string; path?: string; staged?: string };
        const target = await describeTarget(String(r.account), String(r.path ?? ""));
        return `Upload staged file ${r.staged} to ${r.account}:${r.path} — ${target}.`;
      },
      doc:
        "Upload a file that is already staged on the host (the big/binary path). args: { account, " +
        "path, staged, contentType?, overwrite?, ifMatch? } — `staged` is the name dav.stage " +
        "returned (relative to the staging root) or a file you put there via fs. Same create-only " +
        "and etag rules as dav.put. Returns { path, created, bytes, contentType, staged, etag? }.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        staged,
        optStr("contentType", 200),
        optBool("overwrite"),
        optStr("ifMatch", 200),
        pathArg("path"),
        pathArg("staged"),
        writable("dav.putStaged"),
      ),
    },
    {
      name: "dav.mkdir",
      tier: "approval",
      summarize: (a) => {
        const r = a as { account?: string; path?: string };
        return `Create directory ${r.account}:${r.path} (missing parents included).`;
      },
      doc:
        "Create a directory, parents included, idempotent. args: { account, path }. Returns { path, " +
        "created, createdPaths, note? } — createdPaths lists the segments it actually made, and an " +
        "existing directory is created: false, not an error.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        pathArg("path"),
        writable("dav.mkdir"),
        (a) => {
          const r = a as { path?: string };
          if (r.path !== undefined && normalizePath(r.path).segments.length === 0) {
            return "path: the share root already exists";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.move",
      tier: "approval",
      summarize: (a) => {
        const r = a as { account?: string; from?: string; to?: string; overwrite?: boolean };
        return `Move/rename ${r.account}:${r.from} → ${r.to}` +
          `${
            r.overwrite === true
              ? ", overwriting the target if it exists"
              : " (refused if the target exists)"
          }.`;
      },
      doc:
        "Move or rename a file or directory within one account (server-side MOVE — no bytes travel). " +
        "args: { account, from, to, overwrite?, ifMatch? }. Without overwrite the server is told " +
        "Overwrite: F; `ifMatch` (the etag from dav.stat) makes a changed source a 412 instead of " +
        "moving the wrong bytes. " +
        "so an existing target is a 412 rather than a silent replacement. Returns { moved: { from, " +
        "to }, overwritten }. Cross-account moves are not supported: copy is not either, both stay " +
        "inside the account's share root.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        from,
        to,
        optBool("overwrite"),
        optStr("ifMatch", 200),
        pathArg("from"),
        pathArg("to"),
        writable("dav.move"),
        (a) => {
          const r = a as { from?: string; to?: string };
          if (r.from !== undefined && normalizePath(r.from, "from").segments.length === 0) {
            return "from: the share root cannot be moved";
          }
          if (r.to !== undefined && normalizePath(r.to, "to").segments.length === 0) {
            return "to: expected a target path with a name";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.copy",
      tier: "approval",
      summarize: (a) => {
        const r = a as { account?: string; from?: string; to?: string; overwrite?: boolean };
        return `Copy ${r.account}:${r.from} → ${r.to}` +
          `${
            r.overwrite === true
              ? ", overwriting the target if it exists"
              : " (refused if the target exists)"
          }.`;
      },
      doc:
        "Copy a file or directory within one account (server-side COPY — no download/upload round " +
        "trip). args: { account, from, to, overwrite? }. The cheap way to snapshot before editing: " +
        "copy a.md → a.md.bak, then write a.md. Same Overwrite: F rule as dav.move. Returns " +
        "{ copied: { from, to }, overwritten }.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        from,
        to,
        optBool("overwrite"),
        pathArg("from"),
        pathArg("to"),
        writable("dav.copy"),
        (a) => {
          const r = a as { from?: string; to?: string };
          if (r.from !== undefined && normalizePath(r.from, "from").segments.length === 0) {
            return "from: the share root cannot be copied";
          }
          if (r.to !== undefined && normalizePath(r.to, "to").segments.length === 0) {
            return "to: expected a target path with a name";
          }
          return null;
        },
      ),
    },
    {
      name: "dav.trash.list",
      tier: "open",
      doc:
        "Nextcloud trashbin, newest deletion first. args: { account, limit?, offset? }. Returns " +
        "{ count, total, offset, more, nextOffset, entries: [{ id, name, originalLocation, " +
        "deletedAt, kind, size?, fileid? }] }. `id` is the opaque value dav.trash.restore/purge " +
        "take back verbatim. Only for accounts marked `nextcloud: true`: this tree is a Nextcloud " +
        "extension, not WebDAV." + HINT,
      argSchema: compose(rejectUnknown(), acc, optNum("limit"), optNum("offset")),
    },
    {
      name: "dav.trash.restore",
      tier: "approval",
      summarize: (a) => {
        const r = a as { account?: string; id?: string; to?: string };
        return `Restore ${r.id} from the ${r.account} trash` +
          `${r.to === undefined ? " to the location Nextcloud recorded" : ` to ${r.to}`}. ` +
          `The restored file reappears in the share as a normal file.`;
      },
      doc:
        "Restore one trash entry — the safety net behind `dav.delete` and a bad overwrite. args: " +
        "{ account, id, to?, overwrite? } — `id` from dav.trash.list, `to` overrides the recorded " +
        "location (still share-relative). Without `overwrite` an existing file at the destination " +
        "is refused (412) rather than replaced. Returns { restored: { id, to, name } }.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("id"),
        optStr("to", MAX_PATH_CHARS),
        optBool("overwrite"),
        (a) => (a as { to?: string }).to === undefined ? null : pathArg("to")(a),
        writable("dav.trash.restore"),
      ),
    },
    {
      name: "dav.trash.purge",
      tier: "approval",
      summarize: (a) => {
        const r = a as { account?: string; id?: string };
        return `Permanently delete trash entry ${r.id} on ${r.account}. This is the one delete ` +
          `that cannot be undone afterwards.`;
      },
      doc:
        "Permanently remove one entry from the trash, freeing its space. args: { account, id }. " +
        "Returns { purged }. Nothing else in the trash is touched — there is no 'empty trash' op, " +
        "on purpose: it is the one call with no way back.",
      argSchema: compose(rejectUnknown(), acc, str("id"), writable("dav.trash.purge")),
    },
    {
      name: "dav.versions.list",
      tier: "open",
      doc: "Version history of one file, newest first. args: { account, path, limit? }. Returns " +
        "{ path, fileid, count, total, versions: [{ version, modified, size? }] }. Nextcloud keeps a " +
        "version per overwrite, so this is how you get the bytes back that a `dav.put({overwrite: " +
        "true})` replaced — dashboard `replaced` in that op's result tells you it happened." + HINT,
      argSchema: compose(rejectUnknown(), acc, str("path"), optNum("limit"), pathArg("path")),
    },
    {
      name: "dav.versions.restore",
      tier: "approval",
      summarize: (a) => {
        const r = a as { account?: string; path?: string; version?: string };
        return `Restore ${r.account}:${r.path} from version ${r.version}. The current content becomes ` +
          `another version (nothing is destroyed), so this is reversible.`;
      },
      doc:
        "Roll one file back to a version from dav.versions.list. args: { account, path, version, " +
        "overwrite? }. Restoring keeps the current content as a new version, so it is reversible. " +
        "Returns { path, restored, etag }.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        str("version"),
        optBool("overwrite"),
        pathArg("path"),
        writable("dav.versions.restore"),
        (a) =>
          /^\d+$/.test(String((a as { version?: string }).version ?? ""))
            ? null
            : "version: expected the numeric version id from dav.versions.list",
      ),
    },
    {
      name: "dav.delete",
      tier: "approval",
      summarize: async (a) => {
        const r = a as { account?: string; path?: string; recursive?: boolean };
        const target = await describeTarget(String(r.account), String(r.path ?? ""));
        const scope = r.recursive === true ? " (and everything inside it)" : "";
        return `Delete ${r.account}:${r.path} — ${target}${scope}. Deletion is permanent through ` +
          `this server; prefer dav.move into a _trash/ folder if the content must survive.`;
      },
      doc:
        "Delete a file, or a directory with recursive: true. args: { account, path, recursive?, " +
        "ifMatch? } — `ifMatch` (the etag from dav.stat) refuses to delete a file that changed " +
        "since you read it. " +
        "A non-empty directory is refused without recursive: true, so removing a tree is always two " +
        "explicit decisions. No grant or remembered approval ever covers this op. Returns { deleted, " +
        "kind }.",
      argSchema: compose(
        rejectUnknown(),
        acc,
        str("path"),
        optBool("recursive"),
        optStr("ifMatch", 200),
        pathArg("path"),
        writable("dav.delete"),
        (a) => {
          const r = a as { path?: string };
          if (r.path !== undefined && normalizePath(r.path).segments.length === 0) {
            return "path: refusing to delete the share root";
          }
          return null;
        },
      ),
    },
  ];

  // The trash/versions trees are a Nextcloud extension; when no account claims to be one,
  // the ops are absent rather than always-failing (the registry drops `absent` ops, so
  // they never reach api.search either).
  const anyNextcloud = deps.accounts.some((a) => a.nextcloud === true);
  const NEXTCLOUD_ONLY = new Set([
    "dav.trash.list",
    "dav.trash.restore",
    "dav.trash.purge",
    "dav.versions.list",
    "dav.versions.restore",
  ]);

  const conn: Connector = {
    id: "dav",
    ops: ops.filter((op) => anyNextcloud || !NEXTCLOUD_ONLY.has(op.name)).map((op) => ({
      ...op,
      argSchema: compose(op.argSchema, checkShapeArgs),
      doc: DAV_SHAPE[shortOf(op.name)] && !op.doc.includes("Returns") ? op.doc + HINT : op.doc,
    })),
    client: (ctx: HostContext) => wrapClient(client(ctx), DAV_SHAPE),
    validateStartup: async () => {
      await host.validateAll();
    },
  };
  return conn;
}

function shortOf(name: string): string {
  return name.startsWith("dav.") ? name.slice("dav.".length) : name;
}

// Defaults trim the noise a caller pays for. Entries are already compact; these keep
// `list`/`find` from shipping contentType on every row.
const DAV_SHAPE: Partial<Record<string, string[]>> = {
  list: [
    "account",
    "path",
    "count",
    "total",
    "offset",
    "more",
    "nextOffset",
    "entries.name",
    "entries.path",
    "entries.kind",
    "entries.size",
    "entries.modified",
    "entries.etag",
  ],
  find: [
    "pattern",
    "scanned",
    "matched",
    "truncated",
    "stoppedBy",
    "unscanned",
    "resumeFrom",
    "entries.name",
    "entries.path",
    "entries.kind",
    "entries.size",
    "entries.modified",
  ],
};
