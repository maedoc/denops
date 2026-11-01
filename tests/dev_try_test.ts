import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { devConnector, devRootsFromConfig } from "../src/connectors/dev/manifest.ts";
import { derivePermissions, permissionFlags, tryPermissions } from "../src/permissions.ts";

// dev.try runs agent-written code, with the agent's own config in reach. These tests
// pin the two things that keep that safe:
//   1. the child's permission envelope is *pinned* (src/permissions.ts), so a dev
//      config cannot grant the live tree, --allow-run, or an arbitrary origin;
//   2. only committed code that passed `check` for that exact sha is executed.

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

// A committed dev checkout: config.yaml (names dataDir), a symlinked secrets file that
// points OUTSIDE the checkout (like ~/denops-dev/secrets.json), the check task, and a
// dev_try.ts that probes its own permissions instead of running a real op.
const PROBE_RUNNER = `
const [root, op, argsJson] = Deno.args;
const args = JSON.parse(argsJson ?? "{}");
const results: Record<string, { ok: boolean; value?: string; err?: string }> = {};
const probe = async (name: string, fn: () => Promise<unknown>) => {
  try {
    const v = await fn();
    results[name] = { ok: true, value: String(v).slice(0, 40) };
  } catch (e) {
    results[name] = { ok: false, err: String(e instanceof Error ? e.name + ": " + e.message : e).slice(0, 160) };
  }
};
await probe("readOutside", () => Deno.readTextFile(args.outside));
await probe("readSecrets", () => Deno.readTextFile(args.secrets));
await probe("writeOutside", () => Deno.writeTextFile(args.outsideWrite, "escaped"));
await probe("writeInside", () => Deno.writeTextFile(args.insideWrite, "ok"));
await probe("spawn", async () => {
  const out = await new Deno.Command("/bin/echo", { args: ["hi"] }).output();
  return "exit " + out.code;
});
console.log(JSON.stringify({ root, op, results }));
`;

interface Fixture {
  base: string;
  dev: string;
  secretsReal: string;
  connect: (opts?: { checkTask?: string }) => ReturnType<typeof devConnector>;
}

async function makeFixture(
  opts: { config?: string; checkTask?: string; checksGreen?: string } = {},
): Promise<Fixture> {
  const base = await Deno.makeTempDir();
  const dev = `${base}/dev`;
  await Deno.mkdir(`${dev}/scripts`, { recursive: true });
  await Deno.mkdir(`${dev}/data-dev`, { recursive: true });
  await Deno.writeTextFile(`${base}/outside.txt`, "not yours\n");
  // the live secrets file, outside the checkout, reached through a symlink
  await Deno.writeTextFile(`${base}/secrets.json`, `{"serverToken":"x"}\n`);
  await Deno.writeTextFile(`${dev}/config.yaml`, opts.config ?? "dataDir: data-dev\n");
  await Deno.symlink(`${base}/secrets.json`, `${dev}/secrets.json`);
  await Deno.writeTextFile(`${dev}/scripts/dev_try.ts`, PROBE_RUNNER);
  await Deno.writeTextFile(`${dev}/.gitignore`, "data-dev/\n");
  await Deno.writeTextFile(`${dev}/README.md`, "v1\n");
  await git(dev, "init", "-q", "-b", "main");
  await git(dev, "add", "-A");
  await git(dev, "commit", "-qm", "initial");

  const connect = (o: { checkTask?: string } = {}) => {
    const roots = devRootsFromConfig([{
      name: "dev",
      path: dev,
      tasks: { check: [opts.checksGreen ?? "/usr/bin/true"], test: ["/usr/bin/true"] },
    }]);
    // the live config's hosts, not the checkout's
    return devConnector({ roots, tryNet: ["127.0.0.1:3101"], ...o });
  };
  return { base, dev, secretsReal: `${base}/secrets.json`, connect };
}

function client(conn: ReturnType<typeof devConnector>) {
  return conn.client({ config: {}, secrets: {}, log: () => {} });
}

Deno.test("dev.try envelope: pinned, never derived from the dev config", () => {
  const plan = tryPermissions({ devRoot: "/home/freebox/denops-dev", net: ["127.0.0.1:3101"] });
  assertEquals(plan.read, ["/home/freebox/denops-dev"]);
  assertEquals(plan.write, ["/home/freebox/denops-dev/data-dev"]);
  assertEquals(plan.run, [], "dev.try must never get --allow-run");
  assertEquals(plan.net, ["127.0.0.1:3101"]);

  // a relative dataDir is resolved under the root; escapes are refused
  assertEquals(
    tryPermissions({ devRoot: "/r/dev", dataDir: "data-dev", net: [] }).write,
    ["/r/dev/data-dev"],
  );
  for (const escape of ["/etc", "../other", "data/../../.."]) {
    let msg = "";
    try {
      tryPermissions({ devRoot: "/r/dev", dataDir: escape, net: [] });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "escapes", `dataDir ${escape} must be refused`);
  }

  // symlink targets of config/secrets are additive reads, not a widened root
  const withLinks = tryPermissions({
    devRoot: "/r/dev",
    readExtra: ["/home/freebox/denops/secrets.json"],
    net: ["h:1"],
  });
  assertEquals(withLinks.read, ["/r/dev", "/home/freebox/denops/secrets.json"]);

  const flags = permissionFlags(plan);
  assertStringIncludes(flags.join(" "), "--allow-read=/home/freebox/denops-dev");
  assertStringIncludes(flags.join(" "), "--allow-write=/home/freebox/denops-dev/data-dev");
  assert(!flags.join(" ").includes("--allow-run"), "no run permission");
  assert(!flags.some((f) => f.startsWith("--allow-all")), "never --allow-all");
});

Deno.test("server envelope: connector-driven, and still no --allow-all", () => {
  const plan = derivePermissions({
    server: { host: "127.0.0.1", port: 3100 },
    connectors: {
      fs: { enabled: true, roots: [{ path: "/srv/dev", write: true }] },
      dev: { enabled: true, roots: [{ path: "/srv/dev" }] },
      mistral: { enabled: true, origin: "https://api.mistral.ai" },
      imap: { enabled: true, accounts: [{ host: "imap.example.org", port: 993 }] },
      gitlab: { enabled: false, origin: "https://nope.example" },
    },
  }, { read: ["config.yaml"], write: ["data/"], connectorRun: true });

  assertEquals(plan.net.sort(), [
    "*.blob.core.windows.net",
    "127.0.0.1:3100",
    "api.mistral.ai",
    "imap.example.org:993",
  ]);
  assert(plan.read.includes("/srv/dev"));
  assert(plan.write.includes("/srv/dev"));
  assert(plan.run.includes("deno") && plan.run.includes("git"));
  if (Deno.build.os === "linux") assert(plan.run.includes("/bin/sh"));
  assert(!permissionFlags(plan).some((f) => f.startsWith("--allow-all")));
  // connectorRun is what turns --allow-run on; the try child never asks for it
  assertEquals(derivePermissions({ connectors: { dev: { enabled: true } } }).run, []);
});

Deno.test("dev.try: committed code only — dirtiness and check provenance gate it", async () => {
  const f = await makeFixture();
  try {
    const c = client(f.connect());

    // no check yet
    let msg = "";
    try {
      await c["try"]({ root: "dev", op: "debug.echo", args: {} });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, 'needs a green "check"');

    // green check on the committed sha: gating passes and the child runs
    const check = await c["run"]({ root: "dev", task: "check" }) as {
      code: number;
      sha: string;
      dirty: boolean;
    };
    assertEquals(check.code, 0);
    assertEquals(check.dirty, false);
    assert(check.sha.length === 40);

    const res = await c["try"]({
      root: "dev",
      op: "debug.echo",
      args: {
        outside: `${f.base}/outside.txt`,
        secrets: `${f.dev}/secrets.json`,
        outsideWrite: `${f.base}/escaped.txt`,
        insideWrite: `${f.dev}/data-dev/ok.txt`,
      },
    }) as {
      code: number;
      commit: string;
      subject: string;
      dirty: boolean;
      check: { task: string; code: number } | null;
      stdout: string;
    };
    assertEquals(res.code, 0);
    assertEquals(res.commit, check.sha);
    assertEquals(res.subject, "initial");
    assertEquals(res.dirty, false);
    assertEquals(res.check?.task, "check");
    assertEquals(res.check?.code, 0);

    // The child ran under the pinned envelope: outside reads/writes and subprocesses
    // are denied, while its own data dir and the symlinked secrets stay usable.
    const probes = JSON.parse(res.stdout).results as Record<
      string,
      { ok: boolean; err?: string }
    >;
    assertEquals(probes.readOutside.ok, false, "outside reads must be denied");
    assertStringIncludes(probes.readOutside.err ?? "", "read access");
    assertEquals(probes.writeOutside.ok, false, "writes outside the data dir must be denied");
    assertStringIncludes(probes.writeOutside.err ?? "", "write access");
    assertEquals(probes.spawn.ok, false, "subprocesses must be denied");
    assertStringIncludes(probes.spawn.err ?? "", "run access");
    assertEquals(probes.writeInside.ok, true, "its own data dir stays writable");
    assertEquals(probes.readSecrets.ok, true, "the symlinked live secrets stay readable");
    assertEquals(await Deno.readTextFile(`${f.dev}/data-dev/ok.txt`), "ok");
    assertEquals(await Deno.readTextFile(`${f.base}/outside.txt`), "not yours\n");
    assertEquals(await Deno.stat(`${f.base}/escaped.txt`).catch(() => null), null);

    // a new commit with different content invalidates the check
    await Deno.writeTextFile(`${f.dev}/README.md`, "v2\n");
    await git(f.dev, "commit", "-qam", "v2");
    msg = "";
    try {
      await c["try"]({ root: "dev", op: "debug.echo", args: {} });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "ran on different code");

    // ...but checking BEFORE committing the same content still describes it
    await Deno.writeTextFile(`${f.dev}/README.md`, "v3\n");
    const dirtyCheck = await c["run"]({ root: "dev", task: "check" }) as { dirty: boolean };
    assertEquals(dirtyCheck.dirty, true);
    await git(f.dev, "commit", "-qam", "v3");
    const afterCommit = await c["try"]({ root: "dev", op: "debug.echo", args: {} }) as {
      commit: string;
      dirty: boolean;
    };
    assertEquals(afterCommit.commit, await git(f.dev, "rev-parse", "HEAD"));
    assertEquals(afterCommit.dirty, false);

    // a dirty (tracked) tree is refused outright, even with a fresh green check
    await c["run"]({ root: "dev", task: "check" });
    await Deno.writeTextFile(`${f.dev}/README.md`, "v4\n");
    msg = "";
    try {
      await c["try"]({ root: "dev", op: "debug.echo", args: {} });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "tracked files are modified");
  } finally {
    await Deno.remove(f.base, { recursive: true });
  }
});

Deno.test("dev.try: a red check blocks, and a dataDir escape is refused", async () => {
  const red = await makeFixture({ checksGreen: "/usr/bin/false" });
  try {
    const c = client(red.connect());
    await c["run"]({ root: "dev", task: "check" });
    let msg = "";
    try {
      await c["try"]({ root: "dev", op: "debug.echo", args: {} });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "exited 1");
  } finally {
    await Deno.remove(red.base, { recursive: true });
  }

  // the dev config is agent-writable; naming an outside dataDir must not widen the
  // child's write permission (and must not silently fall back to it either)
  const escape = await makeFixture({ config: "dataDir: ../../etc\n" });
  try {
    const c = client(escape.connect());
    await c["run"]({ root: "dev", task: "check" });
    let msg = "";
    try {
      await c["try"]({ root: "dev", op: "debug.echo", args: {} });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "escapes");
  } finally {
    await Deno.remove(escape.base, { recursive: true });
  }
});
