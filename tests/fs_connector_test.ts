import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fsConnector, fsGrantKey } from "../src/connectors/fs/manifest.ts";
import { globToRegExp } from "../src/connectors/fs/client.ts";
import { RootGrants } from "../src/harness/grants.ts";
import { ApprovalQueue } from "../src/harness/approvals.ts";
import { search } from "../src/harness/discover.ts";
import { RunLog } from "../src/harness/log.ts";
import { Registry } from "../src/harness/registry.ts";
import type { Budgets, JsonValue } from "../src/harness/types.ts";
import { Harness } from "../src/harness/worker.ts";

const budgets: Budgets = {
  wallClockMs: 15_000,
  maxOpsPerRun: 50,
  maxOpResultBytes: 1_048_576,
  maxOpArgsBytes: 26_214_400,
  maxLogBytes: 10_485_760,
};

async function setup() {
  const dir = await Deno.makeTempDir();
  const root = `${dir}/repo`;
  await Deno.mkdir(`${root}/src`, { recursive: true });
  await Deno.writeTextFile(`${root}/src/main.ts`, "line1\nline2\nline3\n");
  await Deno.writeTextFile(`${root}/README.md`, "# hello\n");
  await Deno.writeTextFile(`${root}/secret-env.txt`, "should not be readable via env\n");
  const registry = new Registry();
  const connector = fsConnector({
    roots: [{ name: "repo", path: root, write: true, exec: true }],
    maxFileSize: 1_048_576,
    maxOutput: 65_536,
    execTimeoutSec: 10,
    maxConcurrentExec: 2,
  });
  registry.register(connector);
  const clients = new Map<string, Record<string, (args: JsonValue) => Promise<JsonValue>>>();
  clients.set("fs", connector.client({ config: {}, secrets: {}, log: () => {} }));
  const grants = new RootGrants({ dataDir: dir, isGrantOp: fsGrantKey });
  await grants.init();
  const harness = new Harness(
    (op) => {
      const r = registry.resolve(op);
      if (!r) return undefined;
      const method = clients.get(r.connector.id)?.[op.slice("fs.".length)];
      return method ? { spec: r.spec, connector: r.connector, method } : undefined;
    },
    budgets,
    (q, c) => search(registry, q, c),
    () => "doc",
  );
  harness.setConnectorIds(["fs"]);
  harness.setGrantLookup(fsGrantKey, (k) => grants.isGranted(k));
  return { dir, root, registry, harness, grants };
}

async function runCode(
  harness: Harness,
  dir: string,
  code: string,
  replay?: { grantKeys?: Set<string>; approvedSeqs?: Set<number> },
) {
  const runId = crypto.randomUUID();
  const log = new RunLog(dir, runId, budgets.maxLogBytes);
  await log.init({ runId, code, connectors: ["fs"] });
  return await harness.run(
    runId,
    code,
    log,
    replay
      ? {
        resultsBySeq: new Map<number, { op: string; result: JsonValue }>(),
        approvedSeqs: replay.approvedSeqs ?? new Set<number>(),
        grantKeys: replay.grantKeys,
      }
      : undefined,
  );
}

// runCodeResult unwraps the guest value: completed runs carry { result }, failed
// runs carry the error string in result.
function outcomeText(out: { status: string; result?: unknown; error?: string }): string {
  return JSON.stringify(out.result ?? out.error ?? out.status);
}

Deno.test("fs.glob finds files, skips .git/node_modules", async () => {
  const { dir, root, harness } = await setup();
  try {
    await Deno.mkdir(`${root}/.git`);
    await Deno.writeTextFile(`${root}/.git/config`, "x");
    await Deno.mkdir(`${root}/node_modules`);
    await Deno.writeTextFile(`${root}/node_modules/dep.js`, "x");
    // grant the root so the op is open
    const out = await runCode(
      harness,
      dir,
      `return await fs.glob({ root: "repo", pattern: "**/*" });`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertEquals(out.status, "completed");
    const entries = (out.result as { entries: string[] }).entries;
    assert(entries.includes("src/main.ts"), JSON.stringify(entries));
    assert(entries.includes("README.md"), JSON.stringify(entries));
    assert(!entries.some((e) => e.includes(".git") || e.includes("node_modules")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs.read windows lines; hasMore paging", async () => {
  const { dir, harness } = await setup();
  try {
    const out = await runCode(
      harness,
      dir,
      `return await fs.read({ root: "repo", path: "src/main.ts", offset: 1, limit: 1 });`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertEquals(out.status, "completed");
    const r = out.result as {
      content: string;
      offset: number;
      returnedLines: number;
      totalLines: number;
      hasMore: boolean;
    };
    assertEquals(r.content, "line2");
    assertEquals(r.offset, 1);
    assertEquals(r.returnedLines, 1);
    assertEquals(r.totalLines, 4);
    assertEquals(r.hasMore, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("path escape via .. and absolute path is rejected", async () => {
  const { dir, root, harness } = await setup();
  try {
    await Deno.writeTextFile(`${dir}/outside.txt`, "secret");
    for (const p of ["../outside.txt", "/etc/passwd", "src/../../outside.txt"]) {
      const out = await runCode(
        harness,
        dir,
        `try { await fs.read({ root: "repo", path: ${
          JSON.stringify(p)
        } }); return "READ-UNEXPECTEDLY-OK"; } catch (e) { return String(e); }`,
        { grantKeys: new Set(["fs:repo"]) },
      );
      assertEquals(out.status, "completed", `run should complete for ${p}: ${outcomeText(out)}`);
      const text = outcomeText(out);
      assert(
        text.includes("escapes root") || text.includes("must be relative"),
        `path ${p} should be rejected, got ${text}`,
      );
    }
    // symlink escape
    await Deno.symlink(dir, `${root}/link`, { type: "dir" }).catch(() => {});
    const out = await runCode(
      harness,
      dir,
      `try { await fs.read({ root: "repo", path: "link/outside.txt" }); return "READ-UNEXPECTEDLY-OK"; } catch (e) { return String(e); }`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertStringIncludes(outcomeText(out), "escapes root");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs.write/edit create and modify files inside root only", async () => {
  const { dir, root, harness } = await setup();
  try {
    const g = { grantKeys: new Set(["fs:repo"]) };
    let out = await runCode(
      harness,
      dir,
      `return await fs.write({ root: "repo", path: "src/new/deep.ts", content: "a\\nb\\n" });`,
      g,
    );
    assertEquals(out.status, "completed");
    assertEquals(await Deno.readTextFile(`${root}/src/new/deep.ts`), "a\nb\n");
    out = await runCode(
      harness,
      dir,
      `return await fs.edit({ root: "repo", path: "src/new/deep.ts", oldText: "a", newText: "z" });`,
      g,
    );
    assertEquals(out.status, "completed");
    assertEquals(await Deno.readTextFile(`${root}/src/new/deep.ts`), "z\nb\n");
    // edit with non-unique match fails
    out = await runCode(
      harness,
      dir,
      `return await fs.edit({ root: "repo", path: "src/main.ts", oldText: "line", newText: "x" });`,
      g,
    );
    assertStringIncludes(outcomeText(out), "must be unique");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs.exec runs in root with scrubbed env and captures output", async () => {
  const { dir, root, harness } = await setup();
  try {
    const out = await runCode(
      harness,
      dir,
      `const r = await fs.exec({ root: "repo", command: "pwd; echo SECRET=$MY_SECRET; ls" }); return r;`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertEquals(out.status, "completed");
    const r = out.result as { stdout: string; exitCode: number; timedOut: boolean };
    assertEquals(r.exitCode, 0);
    assertStringIncludes(r.stdout, root);
    assertStringIncludes(r.stdout, "SECRET=");
    assert(!r.stdout.includes("SECRET=topsecret"), "env must be scrubbed");
    assertStringIncludes(r.stdout, "src");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ungranted root suspends for approval; granted root runs open", async () => {
  const { dir, harness, grants } = await setup();
  try {
    // not granted yet -> awaiting_approval
    let out = await runCode(
      harness,
      dir,
      `return await fs.read({ root: "repo", path: "README.md" });`,
    );
    assertEquals(out.status, "awaiting_approval");
    assertEquals(out.pending?.op, "fs.read");
    // simulate approve: grant + replay
    await grants.grant(fsGrantKey("fs.read", { root: "repo", path: "README.md" })!);
    out = await runCode(harness, dir, `return await fs.read({ root: "repo", path: "README.md" });`);
    assertEquals(out.status, "completed", outcomeText(out));
    assertStringIncludes(outcomeText(out), "# hello");
    // write on a granted root also runs open
    out = await runCode(
      harness,
      dir,
      `return await fs.write({ root: "repo", path: "ok.txt", content: "x" });`,
    );
    assertEquals(out.status, "completed", outcomeText(out));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("grants persist across RootGrants instances (restart)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const g1 = new RootGrants({ dataDir: dir, isGrantOp: fsGrantKey });
    await g1.init();
    await g1.grant("fs:repo");
    const g2 = new RootGrants({ dataDir: dir, isGrantOp: fsGrantKey });
    await g2.init();
    assertEquals(g2.isGranted("fs:repo"), true);
    assertEquals(g2.list(), ["fs:repo"]);
    assertEquals(await g2.revoke("fs:repo"), true);
    assertEquals(g2.isGranted("fs:repo"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("unknown root name rejected by schema before client", async () => {
  const { dir, harness } = await setup();
  try {
    const out = await runCode(
      harness,
      dir,
      `return await fs.read({ root: "etc", path: "passwd" });`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertStringIncludes(outcomeText(out), "invalid args");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("globToRegExp semantics", () => {
  assert(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  assert(globToRegExp("src/*.ts").test("src/main.ts"));
  assert(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert(globToRegExp("*.md").test("README.md"));
  assert(!globToRegExp("*.md").test("src/README.md"));
  assert(globToRegExp("a?c").test("abc"));
});

Deno.test("approvals queue decide flow unchanged", () => {
  const q = new ApprovalQueue();
  const p = { pendingId: "p1", runId: "r1", op: "fs.read", args: { root: "repo" }, summary: "s" };
  q.add(p);
  const decided = q.decide("p1", "approve");
  assert(decided, "first decide should return the pending");
  assertEquals(decided.pendingId, "p1");
  assertEquals(q.decide("p1", "approve") ?? null, null);
});

// readPgrp mirrors the /proc parse used by the client: pgrp of a live pid, or
// null once the process is gone.
function readPgrp(pid: number): number | null {
  try {
    const stat = Deno.readTextFileSync(`/proc/${pid}/stat`);
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return null;
  }
}

// Regression: the exec timeout must kill the command's own process group and
// nothing else. A previous implementation shelled out to `kill -KILL -<pid>`;
// Ubuntu's /bin/kill is procps-ng, which truncates multi-digit negative pids to
// their first digit, so a 5-digit group id became kill(-1, SIGKILL) and killed
// every process the test runner could signal — the login shell included. If
// this ever regresses, this test *process* dies instead of failing cleanly.
Deno.test("fs.exec timeout kills only the command's process group", async () => {
  const { dir, harness } = await setup();
  const ownGroup = Deno.build.os === "linux" ? readPgrp(Deno.pid) : null;
  // Linux only: the pid file lets us assert the exec'd group leader is gone.
  // macOS has no setsid, so the timeout can only kill the direct child (a
  // shell that forked `sleep` would keep the output pipes open past the budget).
  const command = Deno.build.os === "linux" ? "echo $$ > pid.txt; sleep 30" : "sleep 30";
  try {
    const out = await runCode(
      harness,
      dir,
      `const r = await fs.exec({ root: "repo", command: ${
        JSON.stringify(command)
      }, timeout: 1 }); return r;`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertEquals(out.status, "completed", outcomeText(out));
    const r = out.result as { timedOut: boolean; exitCode: number };
    assertEquals(r.timedOut, true);
    assertEquals(r.exitCode, -1);

    // Still running: the SIGKILL above did not reach our own process group.
    if (Deno.build.os !== "linux") return;
    assertEquals(readPgrp(Deno.pid), ownGroup, "runner process group must be untouched");

    // The exec'd shell was its own group leader and is gone.
    const childPid = Number(Deno.readTextFileSync(`${dir}/repo/pid.txt`).trim());
    assert(childPid > 1 && childPid !== Deno.pid, `unexpected child pid ${childPid}`);
    assert(readPgrp(childPid) === null, `timed-out child ${childPid} should be gone`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("fs.exec timeout flags the result (1s timeout on sleep 30)", async () => {
  const { dir, harness } = await setup();
  try {
    const out = await runCode(
      harness,
      dir,
      `const t0 = Date.now(); const r = await fs.exec({ root: "repo", command: "sleep 30", timeout: 1 }); return { ...r, waitedMs: Date.now() - t0 };`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertEquals(out.status, "completed", outcomeText(out));
    const r = out.result as { timedOut: boolean; exitCode: number; waitedMs: number };
    assertEquals(r.timedOut, true);
    assertEquals(r.exitCode, -1);
    assert(r.waitedMs < 10_000, `should return after ~1s, took ${r.waitedMs}ms`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Stage-then-grep: reading a large downloaded document without a shell.
Deno.test("fs.grep finds matches in a file and across a directory", async () => {
  const { dir, harness } = await setup();
  try {
    await Deno.writeTextFile(`${dir}/repo/src/a.ts`, "const alpha = 1;\nconst beta = 2;\n");
    await Deno.writeTextFile(`${dir}/repo/src/b.md`, "# notes\nALPHA here\n");
    const one = await runCode(
      harness,
      dir,
      `return await fs.grep({ root: "repo", path: "src/a.ts", pattern: "beta" });`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertEquals(one.status, "completed", outcomeText(one));
    const hit = one.result as { matches: Array<{ file: string; line: number; text: string }> };
    assertEquals(hit.matches.length, 1);
    assertEquals(hit.matches[0].line, 2);
    assertStringIncludes(hit.matches[0].text, "beta");

    const many = await runCode(
      harness,
      dir,
      `return await fs.grep({ root: "repo", path: "src", pattern: "alpha", ignoreCase: true });`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    const all = many.result as { matches: Array<{ file: string }>; truncated: boolean };
    assertEquals(all.matches.length, 2, "case-insensitive across files");
    assertEquals(all.truncated, false);

    // binary files are skipped rather than matched as noise
    await Deno.writeFile(
      `${dir}/repo/src/blob.bin`,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
    );
    const bin = await runCode(
      harness,
      dir,
      `return await fs.grep({ root: "repo", path: "src", pattern: "alpha", ignoreCase: true });`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    const binRes = bin.result as { matches: unknown[]; skippedBinary: number };
    assertEquals(binRes.matches.length, 2, "binary file contributes no matches");
    assertEquals(binRes.skippedBinary, 1);

    const bad = await runCode(
      harness,
      dir,
      `return await fs.grep({ root: "repo", path: "src", pattern: "(" });`,
      { grantKeys: new Set(["fs:repo"]) },
    );
    assertEquals(bad.status, "failed");
    assertStringIncludes(outcomeText(bad), "invalid regex");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
