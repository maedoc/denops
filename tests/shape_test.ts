import { assert, assertEquals } from "jsr:@std/assert@1";
import { checkShapeArgs, project, shapeResult } from "../src/connectors/shape.ts";

Deno.test("project selects flat and dotted fields", () => {
  const value = {
    id: 1,
    name: "proj",
    namespace: { id: 3, full_path: "grp/sub" },
    author: { username: "tester", avatar_url: "https://x/y.png" },
  };
  assertEquals(project(value, ["id", "namespace.full_path", "author.username"]), {
    id: 1,
    namespace: { full_path: "grp/sub" },
    author: { username: "tester" },
  });
  assertEquals(project(value, ["missing"]), {});
});

Deno.test("project maps over arrays, including paths that cross them", () => {
  const changes = {
    iid: 7,
    changes: [
      { file: "a.ts", diff: "huge", new_file: false },
      { file: "b.ts", diff: "huge", new_file: true },
    ],
  };
  assertEquals(project(changes, ["iid", "changes.file", "changes.new_file"]), {
    iid: 7,
    changes: [{ file: "a.ts", new_file: false }, { file: "b.ts", new_file: true }],
  });
  assertEquals(project([{ id: 1 }, { id: 2 }], ["id"]), [{ id: 1 }, { id: 2 }]);
});

Deno.test("shapeResult honours defaults, fields and full", () => {
  const item = { id: 1, name: "n", description: "x".repeat(100) };
  assertEquals(shapeResult([item], ["id"], {}), [{ id: 1 }]);
  assertEquals(shapeResult([item], ["id"], { full: true }), [item]);
  assertEquals(shapeResult([item], ["id"], { fields: ["name"] }), [{ name: "n" }]);
  // no defaults and no fields: untouched
  assertEquals(shapeResult([item], undefined, {}), [item]);
});

Deno.test("checkShapeArgs validates fields/full", () => {
  assert(checkShapeArgs({}) === null);
  assert(checkShapeArgs({ fields: ["a", "b.c"], full: false }) === null);
  assertEquals(checkShapeArgs({ fields: "a" }), "fields: expected array of strings");
  assertEquals(checkShapeArgs({ fields: [] }), "fields: must not be empty");
  assertEquals(
    checkShapeArgs({ fields: [1] }),
    "fields[0]: expected a non-empty string (max 100 chars)",
  );
  assertEquals(checkShapeArgs({ fields: ["a"], full: "yes" }), "full: expected boolean");
  assertEquals(
    checkShapeArgs({ fields: Array.from({ length: 25 }, (_, i) => `f${i}`) }),
    "fields: too many entries (25 > 24)",
  );
});
