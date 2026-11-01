import { assertEquals } from "jsr:@std/assert@1";
import { mistralTierOverride } from "../src/connectors/mistral/tiers.ts";

const state = (ids: string[]) => ({ createdLibraryIds: new Set(ids) });

Deno.test("mistral: writes are open only for a library created in the same run", () => {
  for (
    const op of ["mistral.documents.put", "mistral.documents.upload", "mistral.documents.replace"]
  ) {
    // pre-existing library: falls back to the op's declared approval tier
    assertEquals(mistralTierOverride(op, { libraryId: "old-lib" }, state(["new-lib"])), null, op);
    // created in this run: open
    assertEquals(mistralTierOverride(op, { libraryId: "new-lib" }, state(["new-lib"])), "open", op);
    // no libraryId at all: no exemption
    assertEquals(mistralTierOverride(op, {}, state(["new-lib"])), null, op);
  }
  // unrelated ops are untouched
  assertEquals(
    mistralTierOverride("mistral.documents.list", { libraryId: "old-lib" }, state([])),
    null,
  );
});

Deno.test("mistral: allowOpenUploads keeps the old, ungated behaviour", () => {
  assertEquals(
    mistralTierOverride("mistral.documents.put", { libraryId: "old-lib" }, state([]), {
      allowOpenUploads: true,
    }),
    "open",
  );
});
