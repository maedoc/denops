import { assert, assertEquals } from "jsr:@std/assert@1";
import { deployConfigFrom, deployConnector } from "../src/connectors/deploy/manifest.ts";
import { devConnector, devRootsFromConfig } from "../src/connectors/dev/manifest.ts";
import type { JsonValue } from "../src/harness/types.ts";

// Everything here runs in throwaway git repos: no network, no real deployment.
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

async function makeRepoPair(): Promise<{ live: string; dev: string; root: string }> {
  const root = await Deno.makeTempDir();
  const live = `${root}/live`;
  const dev = `${root}/dev`;
  await Deno.mkdir(live, { recursive: true });
  await git(live, "init", "-q", "-b", "main");
  await Deno.writeTextFile(`${live}/README.md`, "v1\n");
  await git(live, "add", ".");
  await git(live, "commit", "-qm", "initial");
  // dev worktree on a branch, the way the agent works
  await git(live, "worktree", "add", "-q", "-b", "agent/dev", dev);
  return { live, dev, root };
}

Deno.test("dev: task table runs argv (no shell), unknown task/root are refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/marker.txt`, "x");
    const roots = devRootsFromConfig([{
      name: "here",
      path: dir,
      tasks: {
        // argv only: this must NOT be interpreted by a shell
        echo: ["/bin/echo", "hello", "world"],
        inject: ["/bin/echo", "a; rm -rf /tmp/nope"],
      },
    }]);
    const conn = devConnector({ roots });
    const client = conn.client({ config: {}, secrets: {}, log: () => {} });

    const list = await client["roots"]({}) as { roots: Array<{ name: string; tasks: string[] }> };
    assertEquals(list.roots[0].name, "here");
    assertEquals(list.roots[0].tasks.sort(), ["echo", "inject"]);

    const ok = await client["run"]({ root: "here", task: "echo" }) as {
      code: number;
      stdout: string;
    };
    assertEquals(ok.code, 0);
    assertEquals(ok.stdout.trim(), "hello world");

    // Semicolons are literal argv, not shell syntax.
    const injected = await client["run"]({ root: "here", task: "inject" }) as { stdout: string };
    assertEquals(injected.stdout.trim(), "a; rm -rf /tmp/nope");
    assert((await Deno.stat(`${dir}/marker.txt`)).size === 1);

    await assertRejects(() => client["run"]({ root: "here", task: "nope" }), "unknown task");
    await assertRejects(() => client["run"]({ root: "missing", task: "echo" }), "unknown dev root");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("dev: git verbs are fixed; commit requires a message", async () => {
  const { dev, root } = await makeRepoPair();
  try {
    const roots = devRootsFromConfig([{ name: "dev", path: dev, tasks: {} }]);
    const conn = devConnector({ roots });
    const client = conn.client({ config: {}, secrets: {}, log: () => {} });

    assertEquals(
      (await client["git"]({ root: "dev", action: "status" }) as { code: number }).code,
      0,
    );
    await Deno.writeTextFile(`${dev}/README.md`, "v2\n");
    const status = await client["git"]({ root: "dev", action: "status" }) as { stdout: string };
    assert(status.stdout.includes("README.md"));
    const commit = await client["git"]({
      root: "dev",
      action: "commit",
      message: "change readme",
    }) as { code: number };
    assertEquals(commit.code, 0);
    assertEquals(await git(dev, "log", "-1", "--format=%s"), "change readme");

    const noMessage = conn.ops.find((o) => o.name === "dev.git")!.argSchema({
      root: "dev",
      action: "commit",
    });
    assertEquals(noMessage, "message: required for commit");
    assertEquals(
      conn.ops.find((o) => o.name === "dev.git")!.argSchema({ root: "dev", action: "push" }),
      "action: expected one of status, diff, log, commit",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("deploy: promote refuses dirty trees and red tests, then fast-forwards and requests a restart", async () => {
  const { live, dev, root } = await makeRepoPair();
  try {
    const dataDir = `${root}/data`;
    const devRoot = devRootsFromConfig([{
      name: "dev",
      path: dev,
      tasks: { test: ["/usr/bin/true"] },
    }])[0];
    const cfg = deployConfigFrom({ enabled: true, liveDir: live, devBranch: "agent/dev" }, [
      devRoot,
    ], dataDir)!;
    const conn = deployConnector(cfg);
    const client = conn.client({ config: {}, secrets: {}, log: () => {} });

    // nothing to promote yet
    await assertRejects(() => client["promote"]({}), "nothing to promote");

    // dirty tree blocks
    await Deno.writeTextFile(`${dev}/README.md`, "v2\n");
    await assertRejects(() => client["promote"]({}), "uncommitted changes");
    await git(dev, "commit", "-qam", "v2");

    // red tests block
    const redRoot = { ...devRoot, tasks: { test: ["/usr/bin/false"] } };
    const redConn = deployConnector({ ...cfg, devRoot: redRoot });
    const redClient = redConn.client({ config: {}, secrets: {}, log: () => {} });
    await assertRejects(() => redClient["promote"]({}), "refusing to promote");
    assertEquals(await git(live, "rev-parse", "main"), await git(dev, "rev-parse", "HEAD~1"));

    // green: fast-forward + intent recorded
    const promoted = await client["promote"]({}) as {
      status: string;
      from: string;
      to: string;
    };
    assertEquals(promoted.status, "restart_requested");
    // main is advanced by the supervisor only after the soak, never by promote
    assertEquals(await git(live, "rev-parse", "main"), await git(live, "rev-parse", "HEAD~0"));
    assertEquals(
      await git(live, "rev-parse", "main"),
      await git(live, "rev-parse", "agent/dev~1"),
      "a failed or pending promotion must not move main",
    );
    const desired = (await Deno.readTextFile(`${dataDir}/desired-commit`)).trim();
    assertEquals(desired, await git(dev, "rev-parse", "HEAD"));
    assertEquals((await Deno.readTextFile(`${dataDir}/restart-request`)).trim(), desired);
    const audit = await Deno.readTextFile(`${dataDir}/deploy.jsonl`);
    assert(audit.includes('"action":"promote"'));

    // status reports the pipeline state
    const status = await client["status"]({}) as Record<string, JsonValue>;
    assertEquals(status.restartPending, true);
    // main lags the dev branch until the supervisor's soak succeeds
    assertEquals(status.devAhead, 1);
    assertEquals(status.mainCommit, await git(live, "rev-parse", "main"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// The approval prompt is the human's only view of what ships: it must name the
// commit, its subject and the files, not just "deploy.promote {}".
Deno.test("deploy: promote/rollback approval summaries describe the change", async () => {
  const { live, dev, root } = await makeRepoPair();
  try {
    const dataDir = `${root}/data`;
    const devRoot =
      devRootsFromConfig([{ name: "dev", path: dev, tasks: { test: ["/usr/bin/true"] } }])[0];
    const conn = deployConnector(
      deployConfigFrom(
        { enabled: true, liveDir: live, devBranch: "agent/dev" },
        [devRoot],
        dataDir,
      )!,
    );
    await Deno.writeTextFile(`${dev}/README.md`, "v2\n");
    await Deno.writeTextFile(`${dev}/tests-extra.txt`, "x\n");
    await git(dev, "add", ".");
    await git(dev, "commit", "-qm", "add a thing");

    const promote = conn.ops.find((o) => o.name === "deploy.promote")!;
    const summary = await promote.summarize!({});
    const devSha = await git(dev, "rev-parse", "HEAD");
    assert(summary.includes(devSha.slice(0, 12)), summary);
    assert(summary.includes("add a thing"), summary);
    assert(summary.includes("README.md"), summary);

    await Deno.mkdir(dataDir, { recursive: true });
    await Deno.writeTextFile(`${dataDir}/last-good`, `${await git(live, "rev-parse", "HEAD")}\n`);
    const rollback = conn.ops.find((o) => o.name === "deploy.rollback")!;
    const rbSummary = await rollback.summarize!({});
    assert(rbSummary.includes("last known good"), rbSummary);
    assert(rbSummary.includes("initial"), rbSummary);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("deploy: rollback targets last-good (or an explicit sha) and refuses junk", async () => {
  const { live, dev, root } = await makeRepoPair();
  try {
    const dataDir = `${root}/data`;
    await Deno.mkdir(dataDir, { recursive: true });
    const first = await git(live, "rev-parse", "HEAD");
    const devRoot =
      devRootsFromConfig([{ name: "dev", path: dev, tasks: { test: ["/usr/bin/true"] } }])[0];
    const cfg = deployConfigFrom({ enabled: true, liveDir: live }, [devRoot], dataDir)!;
    const client = deployConnector(cfg).client({ config: {}, secrets: {}, log: () => {} });

    await assertRejects(() => client["rollback"]({}), "no last-good");
    await Deno.writeTextFile(`${dataDir}/last-good`, `${first}\n`);
    const r = await client["rollback"]({}) as { to: string };
    assertEquals(r.to, first);
    assertEquals((await Deno.readTextFile(`${dataDir}/desired-commit`)).trim(), first);

    await assertRejects(() => client["rollback"]({ commit: "not-a-sha" }), "expected a git sha");
    await assertRejects(() => client["rollback"]({ commit: "deadbeef" }), "unknown commit");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function assertRejects(fn: () => Promise<unknown>, needle: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(
      msg.includes(needle),
      `expected error containing ${JSON.stringify(needle)}, got: ${msg}`,
    );
    return;
  }
  throw new Error(`expected rejection containing ${JSON.stringify(needle)}`);
}
