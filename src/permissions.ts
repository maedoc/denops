// Deno permission derivation for the live launcher (scripts/start.ts). One place,
// on purpose: a hand-copied flag list drifts, and the server's --allow-* flags are
// the outer boundary of every connector. `derivePermissions` derives from the
// config the server was started with; `serverPlan` is the typed projection the
// launcher and denops.permissions consume.
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
  /** derive --allow-run from connector config (fs.exec, deploy's git/test gate) */
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
    if (name === "dav" || name === "caldav") {
      for (const a of (c.accounts ?? []) as Array<Record<string, unknown>>) {
        let origin: URL;
        try {
          origin = new URL(String(a.origin));
        } catch {
          continue; // a bad origin is reported by the connector's own build-time check
        }
        net.add(
          `${origin.hostname}:${origin.port || (origin.protocol === "http:" ? "80" : "443")}`,
        );
        // iCloud answers calendar-home-set on a per-partition host
        // (pNN-caldav.icloud.com) whose name is only known after discovery, so the
        // wildcard has to be in the sandbox envelope up front. The fetch layer pins
        // requests to the same registrable domain on top of this.
        if (origin.hostname === "icloud.com" || origin.hostname.endsWith(".icloud.com")) {
          net.add("*.icloud.com:443");
        }
      }
      if (name === "dav" && c.stagingRoot) {
        // dav.stage writes here and the agent reads what it wrote with fs.*: the
        // staging root is the only bridge between "bytes on the host" and "a path the
        // model can grep", so it needs both halves of the grant.
        const staging = String(c.stagingRoot);
        read.add(staging);
        write.add(staging);
      }
    }
    if (name === "forge") {
      // One family, several accounts, each on its own origin; the pinned client is only
      // as narrow as the sandbox lets it be, so every account host has to be here.
      for (const a of (c.accounts ?? []) as Array<Record<string, unknown>>) {
        try {
          const origin = new URL(String(a.origin));
          net.add(
            `${origin.hostname}:${origin.port || (origin.protocol === "http:" ? "80" : "443")}`,
          );
        } catch {
          continue; // a bad origin is reported by the connector's own config check
        }
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
    // deploy runs git (fetch/merge-base) and the promotion test gate (deno).
    // An explicit connector opt-in, never a default.
    if (truthy(connectors.deploy?.enabled)) {
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

/**
 * Paths the launcher always allows, relative to the live checkout. One list, used by
 * scripts/start.ts and reported by `denops.about` — a second copy would drift and
 * tell the model something untrue about what the server can read.
 */
export const SERVER_READ_BASE = [
  "config.yaml",
  "secrets.json",
  "data/",
  "deno.json",
  "deno.lock",
  "SKILL.md",
  "CHANGELOG.md",
  "src/",
  "scripts/",
];
export const SERVER_WRITE_BASE = ["data/"];

/** The live server's plan: base paths + everything the configured connectors need. */
export function serverPlan(src: PermissionSource): PermissionPlan {
  return derivePermissions(src, {
    read: SERVER_READ_BASE,
    write: SERVER_WRITE_BASE,
    connectorRun: true,
  });
}

/** Options for permissionFlags. */
export interface permissionFlagsOpts {
  /**
   * Omit --allow-env/--allow-sys entirely. For children that execute agent-written
   * code: an unscoped env grant reads every variable on the host, including
   * credentials the server itself never needed in-process.
   */
  noEnv?: boolean;
  /**
   * Names to re-grant under `noEnv`, as `--allow-env=<names>`. Only for modules that
   * probe a specific variable at *import* time: the child's graph pulls imapflow → pino
   * → thread-stream, which reads `NODE_V8_COVERAGE` while it loads, so without this the
   * process dies before the op it was asked to run. Names allowed here carry no secrets.
   */
  envAllow?: string[];
  /**
   * Names to re-grant under `noEnv`, as `--allow-sys=<names>`. Same reason: pino stamps
   * `os.hostname()` on every log record it builds.
   */
  sysAllow?: string[];
}

/** Turn a plan into `deno run` flags. Never emits a bare --allow-all/read/write/net. */
export function permissionFlags(plan: PermissionPlan, opts: permissionFlagsOpts = {}): string[] {
  const flags = [`--allow-net=${plan.net.join(",")}`];
  if (plan.read.length > 0) flags.push(`--allow-read=${plan.read.join(",")}`);
  if (plan.write.length > 0) flags.push(`--allow-write=${plan.write.join(",")}`);
  if (opts.noEnv) {
    // scoped, never bare: an empty list stays fully denied
    if (opts.envAllow && opts.envAllow.length > 0) {
      flags.push(`--allow-env=${opts.envAllow.join(",")}`);
    }
    if (opts.sysAllow && opts.sysAllow.length > 0) {
      flags.push(`--allow-sys=${opts.sysAllow.join(",")}`);
    }
  } else {
    flags.push("--allow-env", "--allow-sys");
  }
  if (plan.run.length > 0) flags.push(`--allow-run=${plan.run.join(",")}`);
  return flags;
}
