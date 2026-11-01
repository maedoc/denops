import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { assertFetchable, isPrivateAddress } from "../src/connectors/web/manifest.ts";

// web.fetch can reach the network, and this server lives on a homelab LAN. The
// guard is deliberately testable without a network: the resolver is injected, so
// every address class below is exercised for real.

const allows = ["example.org", "*.example.org", "arxiv.org", "localhost.org:8080"];

function resolver(map: Record<string, string[]>) {
  return (host: string) => Promise.resolve(map[host] ?? []);
}

const publicDns = resolver({
  "example.org": ["93.184.216.34"],
  "www.example.org": ["93.184.216.34"],
  "arxiv.org": ["151.101.3.42"],
  "localhost.org": ["127.0.0.1"],
  "evil.example.org": ["10.0.0.7"],
});

Deno.test("web.fetch allowlist: only configured hosts, and only http(s)", async () => {
  const ok = await assertFetchable("https://arxiv.org/abs/2401.00001", allows, publicDns);
  assertEquals(ok.url.hostname, "arxiv.org");
  assertEquals(ok.addresses, ["151.101.3.42"]);

  const wildcard = await assertFetchable("https://www.example.org/x", allows, publicDns);
  assertEquals(wildcard.url.pathname, "/x");

  const cases: [string, string][] = [
    ["https://not-listed.example.net/", "not in connectors.web.allowedHosts"],
    ["https://example.org.evil.net/", "not in connectors.web.allowedHosts"],
    ["file:///etc/passwd", "only http and https"],
    ["ftp://example.org/", "only http and https"],
    ["https://user:pass@example.org/", "embedded credentials"],
    ["https://localhost.org/", "not in connectors.web.allowedHosts"], // entry pins :8080
    ["https://localhost.org:8080/", "loopback/private/link-local"], // allowed port, private IP
    ["https://evil.example.org/", "loopback/private/link-local"], // wildcard match, private A record
    ["not a url", "not a URL"],
  ];
  for (const [url, needle] of cases) {
    let msg = "";
    try {
      await assertFetchable(url, allows, publicDns);
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, needle, `expected ${url} to be refused with ${needle}`);
  }
});

Deno.test("web.fetch refuses IP literals in private space, without DNS", async () => {
  const literals = [
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://0.0.0.0/",
  ];
  for (const url of literals) {
    let msg = "";
    try {
      // the host is in the allowlist by construction, so only the guard can refuse
      await assertFetchable(url, [new URL(url).host], publicDns);
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "SSRF guard", `expected ${url} to be refused`);
  }
});

Deno.test("isPrivateAddress classifies the address space", () => {
  const priv = [
    "127.0.0.1",
    "10.0.0.1",
    "172.20.5.5",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:192.168.1.1",
    "2001:db8::1",
    "not-an-ip",
  ];
  for (const ip of priv) assert(isPrivateAddress(ip), `${ip} should be refused`);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2a04:4e42::1", "151.101.3.42"]) {
    assert(!isPrivateAddress(ip), `${ip} should be allowed`);
  }
});

Deno.test("web.fetch: a configured-port host only matches that port", async () => {
  const svc = resolver({ "localhost.org": ["93.184.216.34"] });
  const ok = await assertFetchable("http://localhost.org:8080/x", allows, svc);
  assertEquals(ok.url.port, "8080");
  let msg = "";
  try {
    await assertFetchable("http://localhost.org:9999/x", allows, svc);
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, "allowedHosts");
});
