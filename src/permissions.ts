import { resolve, sep } from "node:path";

// Deno permission derivation, shared by the live launcher (scripts/start.ts) and by
// `dev.try`'s child process. One place, on purpose: a hand-copied flag list drifts,
// and the child that executes agent-written code must never end up with a wider
// envelope than the server. `derivePermissions` is for the server (it trusts the
// config it was started with); `tryPermissions` is for the child and is *pinned*
// rather than derived, because the dev checkout's config.yaml is agent-writable.
export interface PermissionPlan {
  net: string[];
  read: string[];
  write: string[];
  run: string[];
}

/** What derivation needs: the raw YAML parse and the normalized Config both fit. */
export interface PermissionSource {
  server?: Record<string, unknown>;
  connectors?: Record<string, Record<string, unknown> | undefined>;
}

export interface DeriveOptions {
  /** paths always readable, regardless of connector config (config, secrets, code) */
  read?: string[];
  /** paths always writable (runtime state) */
  write?: string[];
  /** derive --allow-run from connector config (fs.exec, dev/deploy tasks) */
  connectorRun?: boolean;
}

const truthy = (v: unknown): boolean => v === true || v === "true";
const str = (v: unknown, fallback: string): string =>
  v === undefined || v === null ? fallback : String(v);

/** The server's envelope: everything the configured connectors legitimately need. */
export function derivePermissions(
  src: PermissionSource,
  opts: DeriveOptions = {},
): PermissionPlan {
  const host = str(src.server?.host, "127.0.0.1");
  const port = str(src.server?.port, "3100");
  const connectors = src.connectors ?? {};
  const net = new Set<string>([`${host}:${port}`]);
  const read = new Set<string>(opts.read ?? []);
  const write = new Set<string>(opts.write ?? []);
  const execRoots = new Set<string>();

  for (const [name, raw] of Object.entries(connectors)) {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (!truthy(c.enabled)) continue;
    if (c.origin) net.add(new URL(String(c.origin)).host);
    if (name === "imap") {
      for (const acc of (c.accounts ?? []) as Array<Record<string, unknown>>) {
        net.add(`${acc.host}:${acc.port ?? 993}`);
      }
    }
    if (name === "web") {
      // A list that the YAML reader handed back as a scalar must not be iterated
      // character by character into --allow-net (it once produced "[:53", "1:53"…).
      const asList = (v: unknown): string[] =>
        Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" ? v.split(",") : [];
      // web.fetch may reach exactly the hosts the operator listed (Deno enforces it
      // too, so a bug in the SSRF guard is not the only line of defence), plus the
      // resolvers the guard queries: Deno.resolveDns needs net access to the
      // resolver, not only to the name being resolved.
      for (const host of asList(c.allowedHosts)) {
        const h = host.trim();
        if (h !== "") net.add(h);
      }
      for (const dns of asList(c.dnsServers)) {
        const d = dns.trim();
        if (d === "") continue;
        if (/:\d+$/.test(d)) {
          net.add(d);
        } else {
          // bare address: assume :53, bracketing IPv6 (Deno wants host:port form)
          net.add(d.includes(":") ? `[${d}]:53` : `${d}:53`);
        }
      }
    }
    if (name === "mistral") {
      // documents.stage writes into the staging root; signed URLs point at Azure blob
      // storage, which is a different host from the API origin.
      const staging = String(c.stagingRoot ?? "data/staging");
      read.add(staging);
      write.add(staging);
      net.add("*.blob.core.windows.net");
    }
    if (name === "dev" || name === "deploy") {
      for (const r of (c.roots ?? []) as Array<Record<string, unknown>>) {
        const p = String(r.path);
        read.add(p);
        write.add(p);
      }
      if (c.path) read.add(String(c.path));
    }
    if (name === "deploy" && c.liveDir) {
      read.add(String(c.liveDir));
      write.add(String(c.liveDir));
    }
    if (name === "fs") {
      for (const r of (c.roots ?? []) as Array<Record<string, unknown>>) {
        const p = String(r.path);
        read.add(p);
        if (truthy(r.write)) write.add(p);
        if (truthy(r.exec)) execRoots.add(p);
      }
    }
  }

  const run: string[] = [];
  if (opts.connectorRun) {
    // fs.exec spawns `/bin/sh` and, on Linux, wraps it in `/usr/bin/setsid` so the
    // timeout can kill the whole process group; `/bin/kill` is the fallback used to
    // signal that group when Deno.kill is not permitted.
    if (execRoots.size > 0) {
      run.push("/bin/sh", ...(Deno.build.os === "linux" ? ["/usr/bin/setsid", "/bin/kill"] : []));
    }
    // dev runs a project's declared argv tables (deno/git/…); deploy runs git and the
    // dev root's test task. Both are explicit connector opt-ins, never defaults.
    if (truthy(connectors.dev?.enabled) || truthy(connectors.deploy?.enabled)) {
      run.push("deno", "git");
    }
  }

  return {
    net: [...net],
    read: [...read],
    write: [...write],
    run: [...new Set(run)],
  };
}

export interface TryPermissionOptions {
  /** the checkout whose (agent-written) code the child will import */
  devRoot: string;
  /**
   * runtime state directory named by the dev config; confined to devRoot. Anything
   * absolute or containing `..` is refused, not silently accepted.
   */
  dataDir?: string;
  /**
   * resolved paths the child may also read — the real targets of the checkout's
   * config.yaml / secrets.json. The dev secrets file is usually a symlink to the
   * live one, and Deno resolves symlinks before checking, so the target must be
   * listed explicitly.
   */
  readExtra?: string[];
  /** hosts the child may reach, taken from the LIVE config (see SKILL.md) */
  net: string[];
}

/**
 * The envelope for `dev.try`'s child. Deliberately *not* derived from the dev
 * config: that file lives in the agent's worktree, so deriving from it would let an
 * agent grant itself the live tree (`fs.roots`), arbitrary origins (credential
 * exfiltration) or `--allow-run`. Pinned to: its own checkout (read), its own data
 * dir (write), live-configured hosts (net), no subprocesses at all.
 */
export function tryPermissions(opts: TryPermissionOptions): PermissionPlan {
  const root = resolve(opts.devRoot);
  const dataDir = confine(root, opts.dataDir ?? "data-dev");
  const read = new Set<string>([root]);
  for (const p of opts.readExtra ?? []) read.add(resolve(p));
  return {
    net: [...new Set(opts.net.filter((h) => h.length > 0))],
    read: [...read],
    write: [dataDir],
    run: [],
  };
}

/** Resolve `rel` against `root`, refusing anything that escapes it. */
export function confine(root: string, rel: string): string {
  const base = resolve(root);
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`dev.try: dataDir ${JSON.stringify(rel)} escapes the dev root ${base}`);
  }
  return target;
}

/** Turn a plan into `deno run` flags. Never emits a bare --allow-all/read/write/net. */
export function permissionFlags(plan: PermissionPlan): string[] {
  const flags = [`--allow-net=${plan.net.join(",")}`];
  if (plan.read.length > 0) flags.push(`--allow-read=${plan.read.join(",")}`);
  if (plan.write.length > 0) flags.push(`--allow-write=${plan.write.join(",")}`);
  flags.push("--allow-env", "--allow-sys");
  if (plan.run.length > 0) flags.push(`--allow-run=${plan.run.join(",")}`);
  return flags;
}
