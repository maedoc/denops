// Fail2ban-style source filtering: per-subnet brute-force bans plus manual
// CIDR blacklist/whitelist, ported from ins-mcp's internal/server/ban.go and
// hardened: atomic ban-file writes, bounded in-memory state, configurable
// policy, and per-IP failure tracking on top of subnet bans.

export interface BanPolicy {
  maxFailures: number;
  windowMs: number;
  durationMs: number;
  maxEntries?: number;
}

export function defaultBanPolicy(): BanPolicy {
  return {
    maxFailures: 5,
    windowMs: 10 * 60 * 1000,
    durationMs: 24 * 60 * 60 * 1000,
    maxEntries: 100_000,
  };
}

export interface BanStoreOptions {
  policy: BanPolicy;
  banFile?: string;
  blacklistFile?: string;
  whitelistFile?: string;
  trustedProxy?: string;
  skipLoopback?: boolean;
  now?: () => number;
}

interface BanEntry {
  failures: number[];
  bannedAt: number;
}

const DEFAULT_MAX_ENTRIES = 100_000;

function parseIp(s: string): string | null {
  const t = s.trim();
  if (t.startsWith("[") && t.includes("]")) {
    const inner = t.slice(1, t.indexOf("]"));
    return isIp(inner) ? inner : null;
  }
  return isIp(t) ? t : null;
}

function isIp(s: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split(".").every((o) => Number(o) <= 255);
  }
  if (!s.includes(":") || !/^[0-9a-fA-F:]+$/.test(s)) return false;
  if (s.includes("::")) {
    return s.split("::").length === 2 && s.indexOf("::") === s.lastIndexOf("::");
  }
  return s.split(":").length === 8;
}

export function clientIpFromAddr(addr: string): string | null {
  if (!addr) return null;
  const idx = addr.lastIndexOf(":");
  if (addr.includes("]") && idx > addr.indexOf("]")) {
    return parseIp(addr.slice(0, idx));
  }
  if (!addr.includes(":") || addr.split(":").length > 2) return parseIp(addr);
  return parseIp(addr.slice(0, idx));
}

function ipToBigInt(ip: string): bigint {
  if (ip.includes(":")) {
    const parts = ip.split("::");
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts[1] ? parts[1].split(":") : [];
    const missing = 8 - head.length - tail.length;
    const groups = [...head, ...Array(Math.max(0, missing)).fill("0"), ...tail];
    let v = 0n;
    for (const g of groups) v = (v << 16n) | BigInt(parseInt(g || "0", 16));
    return v;
  }
  const octets = ip.split(".").map(Number);
  return ((BigInt(octets[0]) << 24n) | (BigInt(octets[1]) << 16n) |
    (BigInt(octets[2]) << 8n) | BigInt(octets[3])) & 0xffffffffn;
}

function bigIntToIp(v: bigint, v6: boolean): string {
  if (!v6) {
    return [24n, 16n, 8n, 0n].map((s) => ((v >> s) & 0xffn).toString()).join(".");
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(((v >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen = i - curStart + 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen > 1) {
    const head = groups.slice(0, bestStart).join(":");
    const tail = groups.slice(bestStart + bestLen).join(":");
    return `${head}::${tail}`;
  }
  return groups.join(":");
}

export function subnetOf(ip: string): string {
  if (ip.includes(":")) {
    const v = ipToBigInt(ip);
    const masked = v & (0xffffffffffffffffffffffffffffffffn << 64n);
    return bigIntToIp(masked, true) + "/64";
  }
  const v = ipToBigInt(ip);
  const masked = v & (0xffffff00n);
  return bigIntToIp(masked, false) + "/24";
}

export function parseCidr(s: string): { net: bigint; bits: number; v6: boolean } | null {
  const slash = s.indexOf("/");
  const ipPart = slash === -1 ? s : s.slice(0, slash);
  const ip = parseIp(ipPart);
  if (!ip) return null;
  const v6 = ip.includes(":");
  const bits = slash === -1 ? (v6 ? 128 : 32) : Number(s.slice(slash + 1));
  const max = v6 ? 128 : 32;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  return {
    net: ipToBigInt(ip) &
      (bits === 0 ? 0n : ((1n << BigInt(max)) - 1n) & ~((1n << BigInt(max - bits)) - 1n)),
    bits,
    v6,
  };
}

export function cidrContains(
  cidr: { net: bigint; bits: number; v6: boolean },
  ip: string,
): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  const v6 = parsed.includes(":");
  if (v6 !== cidr.v6) return false;
  const v = ipToBigInt(parsed);
  const max = v6 ? 128 : 32;
  const mask = cidr.bits === 0
    ? 0n
    : ((1n << BigInt(max)) - 1n) & ~((1n << BigInt(max - cidr.bits)) - 1n);
  return (v & mask) === cidr.net;
}

export function loadCidrFile(path: string): Array<{ net: bigint; bits: number; v6: boolean }> {
  let data: string;
  try {
    data = Deno.readTextFileSync(path);
  } catch {
    return [];
  }
  const nets: Array<{ net: bigint; bits: number; v6: boolean }> = [];
  for (let line of data.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const cidr = parseCidr(line);
    if (cidr) nets.push(cidr);
  }
  return nets;
}

export class BanStore {
  private policy: BanPolicy;
  private entries = new Map<string, BanEntry>();
  private ipFailures = new Map<string, number[]>();
  private banFile?: string;
  private banFileMtime = 0;
  private blacklistFile?: string;
  private blacklistMtime = 0;
  private blacklist: Array<{ net: bigint; bits: number; v6: boolean }> = [];
  private whitelistFile?: string;
  private whitelistMtime = 0;
  private whitelist: Array<{ net: bigint; bits: number; v6: boolean }> = [];
  private trustedProxy: { net: bigint; bits: number; v6: boolean } | null = null;
  private skipLoopback: boolean;
  private now: () => number;
  private mu = Promise.resolve();

  private get maxEntries(): number {
    return this.policy.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  constructor(opts: BanStoreOptions) {
    this.policy = { ...opts.policy };
    this.banFile = opts.banFile;
    this.blacklistFile = opts.blacklistFile;
    this.whitelistFile = opts.whitelistFile;
    this.skipLoopback = opts.skipLoopback ?? true;
    this.now = opts.now ?? (() => Date.now());
    if (opts.trustedProxy) {
      const cidr = parseCidr(opts.trustedProxy);
      if (!cidr) {
        throw new Error(`trustedProxy: invalid CIDR or IP ${JSON.stringify(opts.trustedProxy)}`);
      }
      this.trustedProxy = cidr;
    }
    this.loadPersisted();
    this.reloadBlacklist();
    this.reloadWhitelist();
  }

  private async lock<T>(fn: () => T): Promise<T> {
    const prev = this.mu;
    let release!: () => void;
    this.mu = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return fn();
    } finally {
      release();
    }
  }

  private lockSync<T>(fn: () => T): Promise<T> {
    return this.lock(fn);
  }

  effectiveClientIp(req: Request, remoteAddr: string): string | null {
    const peer = clientIpFromAddr(remoteAddr);
    if (this.trustedProxy && peer && cidrContains(this.trustedProxy, peer)) {
      const parts = (req.headers.get("x-forwarded-for") ?? "").split(",");
      for (let i = parts.length - 1; i >= 0; i--) {
        const ip = parseIp(parts[i]);
        if (!ip) continue;
        if (cidrContains(this.trustedProxy, ip)) continue;
        return ip;
      }
    }
    return peer;
  }

  private isLoopback(ip: string): boolean {
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
  }

  banned(req: Request, remoteAddr: string): Promise<{ banned: boolean; retryAfterSec: number }> {
    return this.lockSync(() => {
      const ip = this.effectiveClientIp(req, remoteAddr);
      if (!ip) return { banned: false, retryAfterSec: 0 };
      if (this.skipLoopback && this.isLoopback(ip)) return { banned: false, retryAfterSec: 0 };
      const now = this.now();
      this.maybeReload(now);
      if (this.whitelist.some((c) => cidrContains(c, ip))) {
        return { banned: false, retryAfterSec: 0 };
      }
      if (this.blacklist.some((c) => cidrContains(c, ip))) {
        return { banned: true, retryAfterSec: Math.ceil(this.policy.durationMs / 1000) };
      }
      const subnet = subnetOf(ip);
      const ipKey = ip + (ip.includes(":") ? "/128" : "/32");
      const candidates = [this.entries.get(subnet), this.entries.get(ipKey)];
      const e = candidates.find((c) => c && c.bannedAt !== 0);
      if (!e) return { banned: false, retryAfterSec: 0 };
      const elapsed = now - e.bannedAt;
      if (elapsed >= this.policy.durationMs) {
        this.entries.delete(subnet);
        this.entries.delete(ipKey);
        this.persistLocked();
        return { banned: false, retryAfterSec: 0 };
      }
      return { banned: true, retryAfterSec: Math.ceil((this.policy.durationMs - elapsed) / 1000) };
    });
  }

  recordFailure(ip: string): Promise<boolean> {
    return this.lockSync(() => {
      if (!ip) return false;
      if (this.skipLoopback && this.isLoopback(ip)) return false;
      const now = this.now();
      const subnet = subnetOf(ip);
      let e = this.entries.get(subnet);
      if (!e) {
        e = { failures: [], bannedAt: 0 };
        this.entries.set(subnet, e);
        if (this.entries.size > this.maxEntries) this.evictOldestLocked();
      }
      if (e.bannedAt !== 0) return true;
      const cutoff = now - this.policy.windowMs;
      e.failures = e.failures.filter((t) => t > cutoff);
      e.failures.push(now);
      if (e.failures.length >= this.policy.maxFailures) {
        e.bannedAt = now;
        this.persistLocked();
        return true;
      }
      let ipf = this.ipFailures.get(ip);
      if (!ipf) {
        ipf = [];
        this.ipFailures.set(ip, ipf);
        if (this.ipFailures.size > this.maxEntries) {
          const oldest = this.ipFailures.keys().next().value;
          if (oldest !== undefined) this.ipFailures.delete(oldest);
        }
      }
      ipf.push(now);
      if (ipf.length >= this.policy.maxFailures) {
        const ipKey = ip + (ip.includes(":") ? "/128" : "/32");
        this.entries.set(ipKey, { failures: [], bannedAt: now });
        this.persistLocked();
        return true;
      }
      return false;
    });
  }

  recordSuccess(ip: string): Promise<void> {
    return this.lockSync(() => {
      if (!ip) return;
      const e = this.entries.get(subnetOf(ip));
      if (e) e.failures = [];
      this.ipFailures.delete(ip);
    });
  }

  private evictOldestLocked(): void {
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [k, e] of this.entries) {
      const t = e.bannedAt || (e.failures[e.failures.length - 1] ?? 0);
      if (t < oldest) {
        oldest = t;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }

  private statMtime(path: string | undefined): number {
    if (!path) return 0;
    try {
      return Deno.statSync(path).mtime?.getTime() ?? 0;
    } catch {
      return 0;
    }
  }

  private maybeReload(_now: number): void {
    if (this.banFile && this.statMtime(this.banFile) !== this.banFileMtime) {
      this.entries = new Map();
      this.loadPersisted();
    }
    if (this.blacklistFile && this.statMtime(this.blacklistFile) !== this.blacklistMtime) {
      this.reloadBlacklist();
    }
    if (this.whitelistFile && this.statMtime(this.whitelistFile) !== this.whitelistMtime) {
      this.reloadWhitelist();
    }
  }

  private persistLocked(): void {
    if (!this.banFile) return;
    const now = this.now();
    const lines: string[] = [];
    for (const [subnet, e] of this.entries) {
      if (e.bannedAt === 0 || now - e.bannedAt >= this.policy.durationMs) continue;
      lines.push(`${(e.bannedAt + this.policy.durationMs) / 1000 | 0} ${subnet}`);
    }
    const tmp = this.banFile + ".tmp";
    try {
      Deno.writeTextFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""), { mode: 0o600 });
      Deno.renameSync(tmp, this.banFile);
      this.banFileMtime = this.statMtime(this.banFile);
    } catch {
      // Persistence is best-effort; in-memory state stays authoritative.
    }
  }

  private loadPersisted(): void {
    if (!this.banFile) return;
    let data: string;
    try {
      data = Deno.readTextFileSync(this.banFile);
    } catch {
      return;
    }
    const now = this.now();
    for (const line of data.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 2) continue;
      const expiry = Number(fields[0]);
      if (!Number.isFinite(expiry)) continue;
      if (expiry * 1000 <= now) continue;
      const e = this.entries.get(fields[1]) ?? { failures: [], bannedAt: 0 };
      e.bannedAt = expiry * 1000 - this.policy.durationMs;
      this.entries.set(fields[1], e);
    }
    this.banFileMtime = this.statMtime(this.banFile);
  }

  private reloadBlacklist(): void {
    this.blacklist = this.blacklistFile ? loadCidrFile(this.blacklistFile) : [];
    this.blacklistMtime = this.statMtime(this.blacklistFile);
  }

  private reloadWhitelist(): void {
    this.whitelist = this.whitelistFile ? loadCidrFile(this.whitelistFile) : [];
    this.whitelistMtime = this.statMtime(this.whitelistFile);
  }
}
