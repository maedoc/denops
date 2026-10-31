import type { JsonValue } from "./types.ts";

export interface RootGrantsOptions {
  dataDir: string;
  isGrantOp?: (op: string, args: JsonValue) => string | null;
}

// RootGrants persists "root approved" grants across runs: the first op that
// touches a configured fs root is approval-tier; once approved (via the
// approve tool or pending CLI), the root is granted and all later fs.* ops
// on that root run open, so follow-up work in the same root needs no more
// approvals. Grants are keyed by connector-qualified root name (e.g. "fs:myrepo").
export class RootGrants {
  private file: string;
  private grants = new Set<string>();
  private isGrantOp: (op: string, args: JsonValue) => string | null;

  constructor(opts: RootGrantsOptions) {
    this.file = `${opts.dataDir}/root_grants.json`;
    this.isGrantOp = opts.isGrantOp ?? (() => null);
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await Deno.readTextFile(this.file)) as unknown;
      if (Array.isArray(parsed)) {
        for (const g of parsed) if (typeof g === "string") this.grants.add(g);
      }
    } catch { /* missing file = no grants yet */ }
  }

  private async persist(): Promise<void> {
    await Deno.mkdir(this.file.split("/").slice(0, -1).join("/"), { recursive: true });
    const tmp = this.file + ".tmp";
    await Deno.writeTextFile(tmp, JSON.stringify([...this.grants].sort(), null, 2), {
      mode: 0o600,
    });
    await Deno.rename(tmp, this.file);
  }

  isGranted(key: string): boolean {
    return this.grants.has(key);
  }

  // grantKeyFor returns the grant key for an op/args pair, or null if the op
  // is not a grant-gated op (e.g. not an fs.* op or no root arg).
  grantKeyFor(op: string, args: JsonValue): string | null {
    return this.isGrantOp(op, args);
  }

  async grant(key: string): Promise<void> {
    if (this.grants.has(key)) return;
    this.grants.add(key);
    await this.persist();
  }

  async revoke(key: string): Promise<boolean> {
    const had = this.grants.delete(key);
    if (had) await this.persist();
    return had;
  }

  list(): string[] {
    return [...this.grants].sort();
  }
}
