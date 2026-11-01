import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { devConnector, devRootsFromConfig } from "../src/connectors/dev/manifest.ts";

// dev.sync is the replacement for "ssh homelab && git fetch && git merge --ff-only":
// it takes no ref, remote or flag from the caller, fetches origin, and only ever
// fast-forwards the current branch. A diverged or detached branch must fail rather
// than discard anyone's work.

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    const err = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`git ${args.join(" ")} (in ${cwd}): ${err}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

interface Fixture {
  base: string;
  origin: string;
  seed: string;
  dev: string;
}

/** bare origin + a "seed" clone that plays the role of the remote's owner + a dev clone */
async function makeRemoteFixture(): Promise<Fixture> {
  const base = await Deno.makeTempDir();
  const origin = `${base}/origin.git`;
  const seed = `${base}/seed`;
  const dev = `${base}/dev`;
  await Deno.mkdir(origin, { recursive: true });
  await git(origin, "init", "-q", "--bare", "-b", "main");
  await Deno.mkdir(seed, { recursive: true });
  await git(seed, "init", "-q", "-b", "main");
  await Deno.writeTextFile(`${seed}/README.md`, "v1\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-qm", "initial");
  await git(seed, "remote", "add", "origin", origin);
  await git(seed, "push", "-q", "-u", "origin", "main");
  await git(base, "clone", "-q", origin, dev);
  return { base, origin, seed, dev };
}

function client(conn: ReturnType<typeof devConnector>) {
  return conn.client({ config: {}, secrets: {}, log: () => {} });
}

Deno.test("dev.sync fast-forwards the current branch to origin", async () => {
  const f = await makeRemoteFixture();
  try {
    const conn = devConnector({
      roots: devRootsFromConfig([{ name: "dev", path: f.dev, tasks: {} }]),
    });
    const c = client(conn);

    // nothing to do yet
    const idle = await c["sync"]({ root: "dev" }) as { changed: boolean; branch: string };
    assertEquals(idle.branch, "main");
    assertEquals(idle.changed, false);

    // the remote moves on
    await Deno.writeTextFile(`${f.seed}/README.md`, "v2\n");
    await git(f.seed, "commit", "-qam", "v2");
    await git(f.seed, "push", "-q", "origin", "main");
    const remote = await git(f.seed, "rev-parse", "HEAD");

    const moved = await c["sync"]({ root: "dev" }) as {
      changed: boolean;
      from: string;
      to: string;
      code: number;
    };
    assertEquals(moved.code, 0);
    assertEquals(moved.changed, true);
    assertEquals(moved.to, remote);
    assertEquals(await git(f.dev, "rev-parse", "HEAD"), remote);
    assertEquals(await Deno.readTextFile(`${f.dev}/README.md`), "v2\n");
  } finally {
    await Deno.remove(f.base, { recursive: true });
  }
});

Deno.test("dev.sync refuses a diverged branch instead of discarding work", async () => {
  const f = await makeRemoteFixture();
  try {
    const conn = devConnector({
      roots: devRootsFromConfig([{ name: "dev", path: f.dev, tasks: {} }]),
    });
    const c = client(conn);
    // local commit...
    await Deno.writeTextFile(`${f.dev}/local.txt`, "mine\n");
    await git(f.dev, "add", "-A");
    await git(f.dev, "commit", "-qm", "local work");
    const local = await git(f.dev, "rev-parse", "HEAD");
    // ...and the remote moves on independently
    await Deno.writeTextFile(`${f.seed}/README.md`, "theirs\n");
    await git(f.seed, "commit", "-qam", "theirs");
    await git(f.seed, "push", "-q", "origin", "main");

    const res = await c["sync"]({ root: "dev" }) as { code: number; stderr: string };
    assert(res.code !== 0, "a diverged branch must fail");
    assertStringIncludes(res.stderr.toLowerCase(), "fast-forward");
    assertEquals(await git(f.dev, "rev-parse", "HEAD"), local, "local work must survive");
    assertEquals(await Deno.readTextFile(`${f.dev}/local.txt`), "mine\n");
  } finally {
    await Deno.remove(f.base, { recursive: true });
  }
});

Deno.test("dev.sync refuses a detached HEAD and a non-repo", async () => {
  const f = await makeRemoteFixture();
  try {
    const conn = devConnector({
      roots: devRootsFromConfig([
        { name: "dev", path: f.dev, tasks: {} },
        { name: "plain", path: `${f.base}/plain`, tasks: {} },
      ]),
    });
    const c = client(conn);
    await git(f.dev, "checkout", "-q", "--detach", "HEAD");
    let msg = "";
    try {
      await c["sync"]({ root: "dev" });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "detached HEAD");

    await Deno.mkdir(`${f.base}/plain`, { recursive: true });
    msg = "";
    try {
      await c["sync"]({ root: "plain" });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "not a git checkout");
  } finally {
    await Deno.remove(f.base, { recursive: true });
  }
});

Deno.test("dev.sync honours an operator-set syncFrom, and reports a missing upstream", async () => {
  const f = await makeRemoteFixture();
  try {
    // detach from the upstream: the branch no longer tracks anything
    await git(f.dev, "branch", "--unset-upstream");
    const conn = devConnector({
      roots: devRootsFromConfig([
        { name: "plain", path: f.dev, tasks: {} },
        { name: "pinned", path: f.dev, tasks: {}, syncFrom: "origin/main" },
      ]),
    });
    const c = client(conn);

    let msg = "";
    try {
      await c["sync"]({ root: "plain" });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "cannot resolve @{u}");
    assertStringIncludes(msg, "syncFrom");

    // with syncFrom pinned, the same worktree fast-forwards happily
    await Deno.writeTextFile(`${f.seed}/README.md`, "v2\n");
    await git(f.seed, "commit", "-qam", "v2");
    await git(f.seed, "push", "-q", "origin", "main");
    const res = await c["sync"]({ root: "pinned" }) as { target: string; changed: boolean };
    assertEquals(res.target, "origin/main");
    assertEquals(res.changed, true);

    // a bogus ref is refused at config time, not at sync time
    let cfgMsg = "";
    try {
      devRootsFromConfig([{
        name: "x",
        path: f.dev,
        tasks: {},
        syncFrom: "origin/main; rm -rf /",
      }]);
    } catch (e) {
      cfgMsg = (e as Error).message;
    }
    assertStringIncludes(cfgMsg, "not a git ref");
  } finally {
    await Deno.remove(f.base, { recursive: true });
  }
});

Deno.test("dev.sync is approval-tier with a summary naming the operation", async () => {
  const conn = devConnector({
    roots: devRootsFromConfig([{ name: "dev", path: "/tmp", tasks: {} }]),
  });
  const spec = conn.ops.find((o) => o.name === "dev.sync")!;
  assertEquals(spec.tier, "approval");
  const summary = await spec.summarize!({ root: "dev" });
  assertStringIncludes(summary, "fast-forward");
  assertStringIncludes(summary, "no reset");
  // no caller-supplied ref/remote is read: `root` is the only field the client looks
  // at (unknown keys are ignored — rejectUnknown only caps their count)
  assertStringIncludes(String(spec.argSchema({})), "root");
  assertEquals(spec.argSchema({ root: "dev" }), null);
});
