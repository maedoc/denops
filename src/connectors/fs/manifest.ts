import {
  compose,
  oneOf,
  optBool,
  optNum,
  optStr,
  rejectUnknown,
  str,
  strMax,
} from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
import { FSClient } from "./client.ts";

export interface FsRootConfig {
  name: string;
  path: string;
  write: boolean;
  exec: boolean;
}

export function fsConnector(opts: {
  roots: FsRootConfig[];
  maxFileSize: number;
  maxOutput: number;
  execTimeoutSec: number;
  maxConcurrentExec: number;
}): Connector {
  if (opts.roots.length === 0) throw new Error("fs connector enabled but no roots configured");
  const names = new Set<string>();
  for (const r of opts.roots) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(r.name)) {
      throw new Error(`fs root name ${JSON.stringify(r.name)} must match [A-Za-z0-9_-]{1,64}`);
    }
    if (names.has(r.name)) throw new Error(`duplicate fs root name: ${r.name}`);
    names.add(r.name);
  }
  const client = new FSClient(opts);

  const pathArg = strMax("path", 4096);
  const rootNames = opts.roots.map((r) => r.name);

  return {
    id: "fs",
    ops: [
      {
        name: "fs.roots",
        tier: "open",
        doc: "List configured fs roots and their capabilities. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "fs.glob",
        tier: "approval",
        doc:
          "Glob files under a root. First call per root needs approval; approving grants the root for later calls. args: { root, pattern, maxEntries? }",
        argSchema: compose(
          rejectUnknown(),
          oneOf("root", rootNames),
          strMax("pattern", 1024),
          optNum("maxEntries"),
        ),
      },
      {
        name: "fs.list",
        tier: "approval",
        doc: "List directory entries under a root. args: { root, path?, recursive? }",
        argSchema: compose(
          rejectUnknown(),
          oneOf("root", rootNames),
          optStr("path", 4096),
          optBool("recursive"),
        ),
      },
      {
        name: "fs.read",
        tier: "approval",
        doc:
          "Read a text file under a root with line windowing. args: { root, path, offset?, limit? } (offset/limit are 0-based line numbers)",
        argSchema: compose(
          rejectUnknown(),
          oneOf("root", rootNames),
          pathArg,
          optNum("offset"),
          optNum("limit"),
        ),
      },
      {
        name: "fs.write",
        tier: "approval",
        doc:
          "Create or overwrite a file under a root (root must have write:true). args: { root, path, content }",
        argSchema: compose(rejectUnknown(), oneOf("root", rootNames), pathArg, str("content")),
      },
      {
        name: "fs.edit",
        tier: "approval",
        doc:
          "Replace one exact text passage in a file (must match exactly once). args: { root, path, oldText, newText }",
        argSchema: compose(
          rejectUnknown(),
          oneOf("root", rootNames),
          pathArg,
          str("oldText"),
          str("newText"),
        ),
      },
      {
        name: "fs.editRegex",
        tier: "approval",
        doc:
          "Replace one regex match (supports $1 group refs). args: { root, path, pattern, replacement }",
        argSchema: compose(
          rejectUnknown(),
          oneOf("root", rootNames),
          pathArg,
          strMax("pattern", 10_000),
          strMax("replacement", 1_000_000),
        ),
      },
      {
        name: "fs.exec",
        tier: "approval",
        doc:
          "Run a shell command with cwd = the root (root must have exec:true), scrubbed environment, timeout and output caps. args: { root, command, timeout? (seconds) }",
        argSchema: compose(
          rejectUnknown(),
          oneOf("root", rootNames),
          strMax("command", 100_000),
          optNum("timeout"),
        ),
      },
    ],
    client: (_ctx: HostContext) => ({
      "roots": () =>
        Promise.resolve({
          roots: opts.roots.map((r) => ({
            name: r.name,
            path: r.path,
            write: r.write,
            exec: r.exec,
          })),
        } as JsonValue),
      "glob": (args) => client.glob(args),
      "list": (args) => client.list(args),
      "read": (args) => client.read(args),
      "write": (args) => client.write(args),
      "edit": (args) => client.edit(args),
      "editRegex": (args) => client.editRegex(args),
      "exec": (args) => client.exec(args),
    }),
  };
}

// grantKey extracts the fs root grant key from op args, or null for non-fs ops.
export function fsGrantKey(op: string, args: JsonValue): string | null {
  if (!op.startsWith("fs.")) return null;
  const root = (args as { root?: unknown } | null)?.root;
  return typeof root === "string" && root.length > 0 ? `fs:${root}` : null;
}
