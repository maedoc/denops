import { assert, assertEquals } from "jsr:@std/assert@1";
import { fsConnector, fsGrantKey } from "../src/connectors/fs/manifest.ts";
import { grantSatisfies } from "../src/harness/grants.ts";
import { RunLog } from "../src/harness/log.ts";
import { Registry } from "../src/harness/registry.ts";
import { search } from "../src/harness/discover.ts";
import { Harness } from "../src/harness/worker.ts";
import type { Budgets } from "../src/harness/types.ts";

const budgets: Budgets = {
  wallClockMs: 15_000,
  maxOpsPerRun: 50,
  maxOpResultBytes: 1_048_576,
  maxOpArgsBytes: 26_214_400,
  maxLogBytes: 10_485_760,
};

async function setup() {
  const dir = await Deno.makeTempDir();
  const writable = `${dir}/rw`;
  const readonly = `${dir}/ro`;
  await Deno.mkdir(writable, { recursive: true });
  await Deno.mkdir(readonly, { recursive: true });
  await Deno.writeTextFile(`${readonly}/keep.txt`, "keep\n");
  const connector = fsConnector({
    roots: [
      { name: "rw", path: writable, write: true, exec: false },
      { name: "ro", path: readonly, write: false, exec: false },
    ],
    maxFileSize: 1_048_576,
    maxOutput: 65_536,
    execTimeoutSec: 10,
    maxConcurrentExec: 2,
  });
  const registry = new Registry();
  registry.register(connector);
  const clients = new Map([["fs", connector.client({ config: {}, secrets: {}, log: () => {} })]]);
  const harness = new Harness(
    (op) => {
      const r = registry.resolve(op);
      if (!r) return undefined;
      const m = clients.get(r.connector.id)?.[op.slice(`${r.connector.id}.`.length)];
      return m ? { spec: r.spec, connector: r.connector, method: m } : undefined;
    },
    budgets,
    (q, c) => search(registry, q, c),
    () => "doc",
  );
  harness.setConnectorIds(["fs"]);
  // grants come from the replay's grantKeys here; a real lookup would consult RootGrants
  harness.setGrantLookup(fsGrantKey, () => false);
  return { dir, connector, harness, writable, readonly };
}

async function run(harness: Harness, dir: string, code: string, grantKeys?: string[]) {
  const runId = crypto.randomUUID();
  const log = new RunLog(dir, runId, budgets.maxLogBytes);
  await log.init({ runId, code, connectors: ["fs"] });
  return await harness.run(
    runId,
    code,
    log,
    grantKeys
      ? {
        resultsBySeq: new Map(),
        approvedSeqs: new Set<number>(),
        grantKeys: new Set(grantKeys),
      }
      : undefined,
  );
}

// The important property: an op that cannot run on a root must fail outright, not
// suspend and then fail after a human approves it.
Deno.test("fs: capability violations fail before the approval gate", async () => {
  const { dir, harness, readonly } = await setup();
  try {
    for (
      const [code, needle] of [
        [`return await fs.write({ root: "ro", path: "x.txt", content: "x" });`, "read-only"],
        [
          `return await fs.edit({ root: "ro", path: "keep.txt", oldText: "keep", newText: "x" });`,
          "read-only",
        ],
        [`return await fs.rm({ root: "ro", path: "keep.txt" });`, "read-only"],
        [`return await fs.exec({ root: "ro", command: "true" });`, "does not allow exec"],
      ] as const
    ) {
      const out = await run(harness, dir, code);
      assertEquals(out.status, "failed", code);
      assert(!out.pending, "no approval may be created for a capability violation");
      const msg = String(out.error);
      assert(msg.includes("capability_denied"), msg);
      assert(msg.includes(needle), msg);
    }
    // the read-only root is untouched
    assertEquals(await Deno.readTextFile(`${readonly}/keep.txt`), "keep\n");
    // and a read on the same root still works (grants aside: approval, not a failure)
    const read = await run(harness, dir, `return await fs.read({ root: "ro", path: "keep.txt" });`);
    assertEquals(read.status, "awaiting_approval", "reads on a read-only root are fine, gated");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs.rm deletes files/dirs in a writable root and refuses the root itself", async () => {
  const { dir, harness, writable } = await setup();
  try {
    await Deno.mkdir(`${writable}/sub/deep`, { recursive: true });
    await Deno.writeTextFile(`${writable}/sub/deep/file.txt`, "x");
    const ok = await run(
      harness,
      dir,
      `return await fs.rm({ root: "rw", path: "sub", recursive: true });`,
      ["fs:rw:write"],
    );
    assertEquals(ok.status, "completed", String(ok.error));
    assertEquals((ok.result as { removed: boolean }).removed, true);
    let exists = true;
    try {
      await Deno.stat(`${writable}/sub`);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);

    const rootDel = await run(harness, dir, `return await fs.rm({ root: "rw", path: "." });`, [
      "fs:rw:write",
    ]);
    assertEquals(rootDel.status, "failed");
    assert(String(rootDel.error).includes("refusing to delete the root"), String(rootDel.error));

    // directory without recursive is refused, not silently emptied
    await Deno.mkdir(`${writable}/dir2`, { recursive: true });
    const noRec = await run(harness, dir, `return await fs.rm({ root: "rw", path: "dir2" });`, [
      "fs:rw:write",
    ]);
    assertEquals(noRec.status, "failed");
    assert(String(noRec.error).includes("recursive: true"), String(noRec.error));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs: grant levels are independent, write implies read, legacy key covers both", () => {
  assertEquals(fsGrantKey("fs.read", { root: "r" }), "fs:r:read");
  assertEquals(fsGrantKey("fs.grep", { root: "r" }), "fs:r:read");
  assertEquals(fsGrantKey("fs.write", { root: "r" }), "fs:r:write");
  assertEquals(fsGrantKey("fs.editRegex", { root: "r" }), "fs:r:write");
  assertEquals(
    fsGrantKey("fs.exec", { root: "r" }),
    "fs:r:read",
    "exec stays approval-gated per call",
  );

  assert(grantSatisfies(["fs:r:read"], "fs:r:read"));
  assert(!grantSatisfies(["fs:r:read"], "fs:r:write"), "read must not cover write");
  assert(grantSatisfies(["fs:r:write"], "fs:r:read"), "write covers read");
  assert(grantSatisfies(["fs:r"], "fs:r:read"), "legacy key is write-level");
  assert(grantSatisfies(["fs:r"], "fs:r:write"));
  assert(!grantSatisfies(["fs:other:read"], "fs:r:read"));
});
