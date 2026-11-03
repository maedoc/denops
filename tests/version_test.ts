import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

// `denops.version` is served from a literal in server.ts (the connector takes the version
// as an option so tests can pin it), while the release is cut by bumping deno.json and
// the CHANGELOG head. Three copies is two too many, so this pins them together: a release
// that forgets one of them fails here instead of lying to a caller at runtime.

Deno.test("release: deno.json, server.ts and the CHANGELOG head agree", async () => {
  const deno = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  const server = await Deno.readTextFile(new URL("../src/server.ts", import.meta.url));
  const changelog = await Deno.readTextFile(new URL("../CHANGELOG.md", import.meta.url));

  const match = server.match(/skillPath:\s*"SKILL\.md",\s*\/\/[^]*?version:\s*"([^"]+)"/);
  assertEquals(match !== null, true, "could not find the denopsConnector version in server.ts");
  const serverVersion = match![1];

  assertEquals(serverVersion, deno.version, "server.ts version must equal deno.json version");

  const head = changelog.match(/^##\s+([0-9]+\.[0-9]+\.[0-9]+)\s+—/m);
  assertEquals(head !== null, true, "CHANGELOG has no '## <version> — <date>' heading");
  assertEquals(head![1], deno.version, "CHANGELOG head must equal deno.json version");
  assertStringIncludes(changelog.slice(0, changelog.indexOf(head![0]) + 1), "# Changelog");
});
