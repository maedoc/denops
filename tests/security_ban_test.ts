import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BanStore,
  cidrContains,
  clientIpFromAddr,
  defaultBanPolicy,
  loadCidrFile,
  parseCidr,
  subnetOf,
} from "../src/security/ban.ts";

function req(xff?: string): Request {
  const headers = new Headers();
  if (xff) headers.set("x-forwarded-for", xff);
  return new Request("http://127.0.0.1:3100/mcp", { headers });
}

function policy(overrides: Partial<ReturnType<typeof defaultBanPolicy>> = {}) {
  return { ...defaultBanPolicy(), ...overrides };
}

Deno.test("subnetOf: IPv4 /24 and IPv6 /64", () => {
  assertEquals(subnetOf("203.0.113.77"), "203.0.113.0/24");
  assertEquals(subnetOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
});

Deno.test("clientIpFromAddr handles host:port, [v6]:port, bare", () => {
  assertEquals(clientIpFromAddr("203.0.113.9:1234"), "203.0.113.9");
  assertEquals(clientIpFromAddr("[2001:db8::1]:4444"), "2001:db8::1");
  assertEquals(clientIpFromAddr("203.0.113.9"), "203.0.113.9");
  assertEquals(clientIpFromAddr("garbage"), null);
});

Deno.test("parseCidr / cidrContains: bare IPs become host routes", () => {
  const c = parseCidr("192.0.2.5");
  assert(c);
  assert(cidrContains(c, "192.0.2.5"));
  assert(!cidrContains(c, "192.0.2.6"));
  const n = parseCidr("10.0.0.0/8");
  assert(n);
  assert(cidrContains(n, "10.255.0.1"));
  assert(!cidrContains(n, "11.0.0.1"));
  const v6 = parseCidr("2001:db8::/32");
  assert(v6);
  assert(cidrContains(v6, "2001:db8:1:2:3:4:5:6"));
  assert(!cidrContains(v6, "2001:db9::1"));
  assertEquals(parseCidr("not-an-ip"), null);
  assertEquals(parseCidr("10.0.0.0/33"), null);
});

Deno.test("auto-ban triggers at maxFailures within window and expires", async () => {
  const store = new BanStore({
    policy: policy({ maxFailures: 3, windowMs: 60_000, durationMs: 60_000 }),
  });
  const r = req();
  assertEquals((await store.banned(r, "203.0.113.9:1000")).banned, false);
  await store.recordFailure("203.0.113.9");
  await store.recordFailure("203.0.113.9");
  assertEquals((await store.banned(r, "203.0.113.9:1000")).banned, false);
  const banned = await store.recordFailure("203.0.113.9");
  assertEquals(banned, true);
  const v = await store.banned(r, "203.0.113.9:1000");
  assertEquals(v.banned, true);
  assert(v.retryAfterSec > 0);
  const later = await store.banned(req(), "203.0.113.9:1000");
  assertEquals(later.banned, true);
});

Deno.test("per-IP ban fires even when subnets differ (distributed attacker)", async () => {
  const store = new BanStore({
    policy: policy({ maxFailures: 2, windowMs: 60_000, durationMs: 60_000 }),
  });
  await store.recordFailure("198.51.100.10");
  const banned = await store.recordFailure("198.51.100.10");
  assertEquals(banned, true);
  const v = await store.banned(req(), "198.51.100.10:5555");
  assertEquals(v.banned, true);
  const neighbor = await store.banned(req(), "198.51.100.99:5555");
  assertEquals(neighbor.banned, true, "same /24 gets subnet-banned too");
});

Deno.test("recordSuccess clears failures but does not lift an active ban", async () => {
  const store = new BanStore({
    policy: policy({ maxFailures: 2, windowMs: 60_000, durationMs: 60_000 }),
  });
  await store.recordFailure("192.0.2.1");
  await store.recordSuccess("192.0.2.1");
  await store.recordFailure("192.0.2.1");
  assertEquals((await store.banned(req(), "192.0.2.1:1")).banned, false);
  await store.recordFailure("192.0.2.1");
  assertEquals((await store.banned(req(), "192.0.2.1:1")).banned, true);
  await store.recordSuccess("192.0.2.1");
  assertEquals((await store.banned(req(), "192.0.2.1:1")).banned, true);
});

Deno.test("loopback peers are exempt from banning by default", async () => {
  const store = new BanStore({ policy: policy({ maxFailures: 1 }) });
  for (let i = 0; i < 5; i++) await store.recordFailure("127.0.0.1");
  assertEquals((await store.banned(req(), "127.0.0.1:1")).banned, false);
});

Deno.test("ban file persists bans across restarts and truncation resets live", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const banFile = `${dir}/bans`;
    const p = policy({ maxFailures: 1, windowMs: 60_000, durationMs: 3_600_000 });
    const store = new BanStore({ policy: p, banFile });
    await store.recordFailure("203.0.113.44");
    assert((await Deno.stat(banFile)).isFile, "ban file written");
    const store2 = new BanStore({ policy: p, banFile });
    assertEquals(
      (await store2.banned(req(), "203.0.113.44:9")).banned,
      true,
      "ban survives restart",
    );
    await Deno.writeTextFile(banFile, "");
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(
      (await store2.banned(req(), "203.0.113.44:9")).banned,
      false,
      "truncation resets live bans",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("blacklist and whitelist CIDR files hot-reload", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bl = `${dir}/blacklist`;
    const wl = `${dir}/whitelist`;
    await Deno.writeTextFile(bl, "# bad\n192.0.2.0/24\n198.51.100.5\n");
    await Deno.writeTextFile(wl, "203.0.113.0/24\n");
    const store = new BanStore({
      policy: policy({ maxFailures: 100 }),
      blacklistFile: bl,
      whitelistFile: wl,
    });
    assertEquals((await store.banned(req(), "192.0.2.99:1")).banned, true);
    assertEquals(
      (await store.banned(req(), "198.51.100.5:1")).banned,
      true,
      "bare IP = host route",
    );
    assertEquals((await store.banned(req(), "203.0.113.1:1")).banned, false, "whitelisted");
    assertEquals((await store.banned(req(), "203.0.113.1:1")).banned, false);
    await store.recordFailure("203.0.113.1");
    await store.recordFailure("203.0.113.1");
    assertEquals(
      (await store.banned(req(), "203.0.113.1:1")).banned,
      false,
      "whitelist exempts auto-ban",
    );
    await Deno.writeTextFile(bl, "");
    await new Promise((r) => setTimeout(r, 20));
    assertEquals((await store.banned(req(), "192.0.2.99:1")).banned, false, "blacklist hot-reload");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("trusted proxy: right-most non-trusted X-Forwarded-For wins; untrusted peers cannot spoof", async () => {
  const store = new BanStore({
    policy: policy({ maxFailures: 2, windowMs: 60_000, durationMs: 60_000 }),
    trustedProxy: "127.0.0.0/8",
  });
  const r1 = req("203.0.113.5");
  await store.recordFailure(store.effectiveClientIp(r1, "127.0.0.1:9999")!);
  const r2 = req("203.0.113.9");
  await store.recordFailure(store.effectiveClientIp(r2, "127.0.0.1:9999")!);
  const r3 = req("203.0.113.9, 127.0.0.1");
  const ip = store.effectiveClientIp(r3, "127.0.0.1:9999");
  assertEquals(ip, "203.0.113.9", "rightmost non-trusted entry wins (Caddy appends)");
  await store.recordFailure(ip!);
  assertEquals((await store.banned(r3, "127.0.0.1:9999")).banned, true);

  const untrusted = new BanStore({ policy: policy({ maxFailures: 1 }) });
  const spoofed = req("203.0.113.5");
  assertEquals(
    untrusted.effectiveClientIp(spoofed, "198.51.100.7:1"),
    "198.51.100.7",
    "XFF ignored from untrusted peer",
  );
});

Deno.test("loadCidrFile skips comments and blank lines", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const f = `${dir}/list`;
    await Deno.writeTextFile(f, "# comment\n\n10.0.0.0/8\n  192.0.2.1  \n");
    const nets = loadCidrFile(f);
    assertEquals(nets.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
