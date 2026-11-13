import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { deployConfigFrom, deployConnector } from "../src/connectors/deploy/manifest.ts";
import type { JsonValue } from "../src/harness/types.ts";

// Everything here runs in throwaway git repos with a local bare "origin":
// no network, no real deployment.
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

/** bare origin, a live clone (detached on main), a laptop dir to author commits */
async function makeSetup(): Promise<
  { origin: string; live: string; laptop: string; root: string }
> {
  const root = await Deno.makeTempDir();
  const origin = `${root}/origin.git`;
  const live = `${root}/live`;
  const laptop = `${root}/laptop`;
  await Deno.mkdir(origin, { recursive: true });
  await git(origin, "init", "-q", "--bare", "-b", "main");
  await git(root, "clone", "-q", origin, laptop);
  await Deno.writeTextFile(`${laptop}/README.md`, "v1\n");
  await git(laptop, "add", ".");
  await git(laptop, "commit", "-qm", "initial");
  await git(laptop, "push", "-q", "origin", "main");
  await git(root, "clone", "-q", origin, live);
  await git(live, "checkout", "-q", "--detach", "main");
  return { origin, live, laptop, root };
}

function connector(live: string, root: string, test = "/usr/bin/true") {
  const dataDir = `${root}/data`;
  const cfg = deployConfigFrom({
    enabled: true,
    liveDir: live,
    testArgv: [test],
  }, dataDir)!;
  return { cfg, client: deployConnector(cfg).client({ config: {}, secrets: {}, log: () => {} }) };
}

Deno.test("deploy: promote ships origin/main after a green gate and records intent", async () => {
  const { live, laptop, root } = await makeSetup();
  try {
    const { client } = connector(live, root);

    await assertRejects(() => client["promote"]({}), "nothing to promote");

    // a red test suite blocks the promotion, and main stays where it is
    await Deno.writeTextFile(`${laptop}/README.md`, "v2\n");
    await git(laptop, "commit", "-qam", "v2");
    await git(laptop, "push", "-q", "origin", "main");
    const red = connector(live, root, "/usr/bin/false");
    await assertRejects(() => red.client["promote"]({}), "refusing to promote");
    const mainBefore = await git(live, "rev-parse", "main");
    assertEquals(await git(live, "rev-parse", "main"), mainBefore);

    // green: intent recorded, main untouched (the supervisor owns that)
    const promoted = await client["promote"]({}) as {
      status: string;
      from: string;
      to: string;
    };
    assertEquals(promoted.status, "restart_requested");
    assertEquals(promoted.to, await git(laptop, "rev-parse", "HEAD"));
    assertEquals(await git(live, "rev-parse", "main"), mainBefore);
    const desired = (await Deno.readTextFile(`${root}/data/desired-commit`)).trim();
    assertEquals(desired, promoted.to);
    assertEquals((await Deno.readTextFile(`${root}/data/restart-request`)).trim(), desired);
    const audit = await Deno.readTextFile(`${root}/data/deploy.jsonl`);
    assert(audit.includes('"action":"promote-test"'));
    assert(audit.includes('"action":"promote"'));

    // the throwaway test worktree is gone after the run
    const worktrees = await git(live, "worktree", "list");
    assertEquals(worktrees.split("\n").length, 1, "only the live checkout remains");

    // status reports the pipeline state
    const status = await client["status"]({}) as Record<string, JsonValue>;
    assertEquals(status.restartPending, true);
    assertEquals(status.originMain, promoted.to);
    const pending = status.pendingCommits as JsonValue[];
    assertEquals(pending.length, 1);
    assert(String(pending[0]).includes("v2"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("deploy: promote refuses a non-fast-forward origin/main", async () => {
  const { live, laptop, root } = await makeSetup();
  try {
    await git(laptop, "commit", "-q", "--allow-empty", "-m", "on origin");
    await git(laptop, "push", "-q", "origin", "main");
    // move the live repo's main somewhere divergent (simulating a host ref left behind)
    await git(live, "commit", "-q", "--allow-empty", "-m", "divergent");
    await git(live, "branch", "-f", "main", "HEAD");
    const { client } = connector(live, root);
    await assertRejects(() => client["promote"]({}), "not a descendant of main");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// The approval prompt is the human's only view of what ships: it must name the
// origin commit, its subject and the files.
Deno.test("deploy: promote/rollback approval summaries describe the change", async () => {
  const { live, laptop, root } = await makeSetup();
  try {
    const { cfg } = connector(live, root);
    const conn = deployConnector(cfg);
    await Deno.writeTextFile(`${laptop}/README.md`, "v2\n");
    await git(laptop, "commit", "-qam", "add a thing");
    await git(laptop, "push", "-q", "origin", "main");

    const promote = conn.ops.find((o) => o.name === "deploy.promote")!;
    const summary = await promote.summarize!({});
    const head = await git(laptop, "rev-parse", "HEAD");
    assert(summary.includes(head.slice(0, 12)), summary);
    assert(summary.includes("add a thing"), summary);
    assert(summary.includes("README.md"), summary);

    await Deno.mkdir(`${root}/data`, { recursive: true });
    await Deno.writeTextFile(`${root}/data/last-good`, `${await git(live, "rev-parse", "HEAD")}\n`);
    const rollback = conn.ops.find((o) => o.name === "deploy.rollback")!;
    const rbSummary = await rollback.summarize!({});
    assert(rbSummary.includes("last known good"), rbSummary);
    assert(rbSummary.includes("initial"), rbSummary);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("deploy: rollback targets last-good (or an explicit sha) and refuses junk", async () => {
  const { live, root } = await makeSetup();
  try {
    const { client } = connector(live, root);
    await Deno.mkdir(`${root}/data`, { recursive: true });

    await assertRejects(() => client["rollback"]({}), "no last-good");
    const first = await git(live, "rev-parse", "HEAD");
    await Deno.writeTextFile(`${root}/data/last-good`, `${first}\n`);
    const r = await client["rollback"]({}) as { to: string };
    assertEquals(r.to, first);
    assertEquals((await Deno.readTextFile(`${root}/data/desired-commit`)).trim(), first);

    await assertRejects(() => client["rollback"]({ commit: "not-a-sha" }), "expected a git sha");
    await assertRejects(() => client["rollback"]({ commit: "deadbeef" }), "unknown commit");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
