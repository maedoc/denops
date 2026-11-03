import { assert, assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1";
import {
  contentTypeFor,
  encodeSegments,
  hrefToRel,
  isTextual,
  looksBinary,
  normalizePath,
  sanitizeName,
  shareSegmentsOf,
} from "../src/connectors/dav/paths.ts";

// The confinement story for `dav` is entirely in these two functions: the caller's
// path never becomes a URL segment it did not name, and an href from the server is
// only adopted when it sits under the share root.

const base = new URL("https://nc.example.org");

Deno.test("dav paths: canonical forms", () => {
  assertEquals(normalizePath("").rel, "");
  assertEquals(normalizePath(undefined).rel, "");
  assertEquals(normalizePath("a").rel, "a");
  assertEquals(normalizePath("a/b").segments, ["a", "b"]);
  assertEquals(normalizePath("a//b").rel, "a/b", "empty segments collapse");
  assertEquals(normalizePath("a/./b/").rel, "a/b", "dots and trailing slash collapse");
  assertEquals(normalizePath("  a/b  ").rel, "a/b", "surrounding space is trimmed");
  // a space inside a name is data, not structure
  assertEquals(normalizePath("my docs/quarter 1.pdf").segments, ["my docs", "quarter 1.pdf"]);
});

Deno.test("dav paths: every escape shape is refused with something actionable", () => {
  const bad: Array<[string, string]> = [
    ["../etc/passwd", '".." segments are refused'],
    ["a/../../b", '".." segments are refused'],
    ["a/..", '".." segments are refused'],
    ["/etc/passwd", "relative to the account's share root"],
    ["a\\b", 'use "/" as the separator'],
    ["a\u0000b", "control character"],
    ["a\u001fb", "control character"],
  ];
  for (const [input, needle] of bad) {
    const err = assertThrows(() => normalizePath(input)) as Error;
    assertStringIncludes(err.message, needle, `input ${JSON.stringify(input)}`);
  }
  assertThrows(() => normalizePath("a".repeat(1025)), Error, "longer than 1024");
  assertThrows(() => normalizePath(`${"a".repeat(256)}`), Error, "segment is longer");
  assertThrows(() => normalizePath(42), Error, "expected a string");
});

Deno.test("dav paths: caller text is literal, not percent-decoded", () => {
  // "%2e%2e" is a file name, not a traversal: it is encoded as data and survives.
  const p = normalizePath("%2e%2e/ok.txt");
  assertEquals(p.segments, ["%2e%2e", "ok.txt"]);
  assertEquals(encodeSegments(p.segments), "%252e%252e/ok.txt");
  // and the characters that would otherwise break a URL are encoded, one segment at a
  // time, so "/" can only ever be structure
  assertEquals(encodeSegments(["a b", "c#d", "e?f&g", "é"]), "a%20b/c%23d/e%3Ff%26g/%C3%A9");
});

Deno.test("dav paths: hrefs are adopted only under the share root", () => {
  const share = shareSegmentsOf("/remote.php/dav/files/alice");
  assertEquals(share, ["remote.php", "dav", "files", "alice"]);
  assertEquals(
    hrefToRel(share, "/remote.php/dav/files/alice/a%20b/c.txt", base),
    "a b/c.txt",
  );
  assertEquals(
    hrefToRel(share, "https://nc.example.org/remote.php/dav/files/alice/docs/", base),
    "docs",
  );
  assertEquals(hrefToRel(share, "/remote.php/dav/files/alice", base), "");
  // outside the share: another user, another host, another API root
  assertEquals(hrefToRel(share, "/remote.php/dav/files/bob/secret", base), undefined);
  assertEquals(hrefToRel(share, "/remote.php/dav/calendars/alice/x", base), undefined);
  assertEquals(
    hrefToRel(share, "https://evil.example.net/remote.php/dav/files/alice/x", base),
    undefined,
  );
  assertEquals(hrefToRel(share, "/short", base), undefined);
});

Deno.test("dav paths: content-type judgement", () => {
  assertEquals(contentTypeFor("a.md"), "text/markdown; charset=utf-8");
  assertEquals(contentTypeFor("a.JSON"), "application/json");
  assertEquals(contentTypeFor("a.bin"), "application/octet-stream");
  assertEquals(contentTypeFor("noext"), "application/octet-stream");

  assert(isTextual("text/plain"));
  assert(isTextual("application/json"));
  assert(isTextual("application/xml; charset=utf-8"));
  assert(isTextual("application/vnd.api+json"));
  assert(!isTextual("application/octet-stream"));
  assert(!isTextual("image/png"));
  assert(!isTextual(""));

  assert(!looksBinary(new TextEncoder().encode("hello\nworld\t!")));
  assert(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00])));
  assert(looksBinary(new Uint8Array([0x1b, 0x41])));
});

Deno.test("dav paths: staging names cannot escape the staging directory", () => {
  assertEquals(sanitizeName("../../etc/passwd"), "_.._etc_passwd");
  assertEquals(sanitizeName("a/b c:d.pdf"), "a_b_c_d.pdf");
  assertEquals(sanitizeName(""), "_");
  assertEquals(sanitizeName(".hidden"), "hidden");
  // no separator survives, so the result can only ever be one path segment
  for (const name of ["../x", "a/b", "..", ".", "a\\b"]) {
    assert(!sanitizeName(name).includes("/"), name);
  }
  assert(sanitizeName("x".repeat(400)).length <= 120);
});
