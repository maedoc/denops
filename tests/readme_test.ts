import { assert, assertEquals } from "jsr:@std/assert@1";
import { allConnectors } from "./connector_set.ts";

// README.md is the human-facing counterpart of SKILL.md, and nothing watched it: it
// advertised `gitlab (27 ops)` a release after that family became `forge`, said
// `dev (4 ops)` when it was 5, and never gained a section for `calendar` or `dav`.
// This is the same mechanical half-done gate SKILL.md already has, so the next
// family rename cannot rot the front page silently.

const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));

Deno.test("README documents every connector family with the right op count", async () => {
  const connectors = await allConnectors();
  const missing: string[] = [];
  for (const c of connectors) {
    // headings come in a few shapes: "### dav (16 ops) — ...", "### mistral — Libraries API (17 ops)"
    const section = new RegExp(`^### ${c.id}\\b.*$`, "m").exec(readme);
    const count = c.ops.filter((o) => o.tier !== "absent").length;
    if (!section) {
      missing.push(`${c.id}: no "### ${c.id} …" heading`);
      continue;
    }
    const stated = new RegExp(`\\(${count} op(s)?\\)`).test(section[0]);
    if (!stated) {
      missing.push(
        `${c.id}: heading should say "(${count} ops)", says ${JSON.stringify(section[0])}`,
      );
    }
  }
  assertEquals(missing, [], "README.md has drifted from the registry");
});

Deno.test("README does not still describe families that were renamed away", () => {
  // `gitlab` became a flavor of `forge` in 0.8.0; the README kept a whole section for it.
  assert(!/^### gitlab\b/m.test(readme), "README still has a ### gitlab section");
  assert(!readme.includes("connectors for GitLab,"), "README still lists the old family names");
  assert(readme.includes("### forge "), "README must document the forge family");
});
