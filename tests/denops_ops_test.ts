import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  denopsConnector,
  redactLine,
  summarizeConnectorLine,
  summarizeRun,
} from "../src/connectors/denops/manifest.ts";
import { Harness } from "../src/harness/worker.ts";
import type { JsonValue } from "../src/harness/types.ts";

// The audit surface: what is running (version/changelog), what it has done
// (oplog), and how much budget is left (budget). The oplog is the one that has to
// stay redacted — it is shown to agents and humans after something went wrong.

const CHANGELOG = `# Changelog

## 0.2.0 — 2026-11-01

- something

## 0.1.0 — 2026-10-29

- first
`;

async function tmpSkill(): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/SKILL.md`;
  await Deno.writeTextFile(path, "# skill\n\n## 1. What\n\ntext\n\n## 2. Else\n\nmore\n");
  return path;
}

function client(
  conn: ReturnType<typeof denopsConnector>,
): Record<string, (a: JsonValue) => Promise<JsonValue>> {
  return conn.client({ config: {}, secrets: {}, log: () => {} });
}

Deno.test("denops.version reports version, commit and the changelog head", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const changelog = `${dir}/CHANGELOG.md`;
    await Deno.writeTextFile(changelog, CHANGELOG);
    const conn = denopsConnector({
      skillPath: await tmpSkill(),
      version: "0.2.0",
      commit: "abc1234",
      connectors: () => ["debug"],
      changelogPath: changelog,
    });
    const v = await client(conn)["version"]({}) as {
      version: string;
      commit: string;
      changelog: {
        available: boolean;
        latest: { version: string; date: string };
        entries: unknown[];
      };
    };
    assertEquals(v.version, "0.2.0");
    assertEquals(v.commit, "abc1234");
    assertEquals(v.changelog.available, true);
    assertEquals(v.changelog.latest.version, "0.2.0");
    assertEquals(v.changelog.latest.date, "2026-11-01");
    assertEquals(v.changelog.entries.length, 2);

    // a missing changelog is reported, not thrown
    const bare = denopsConnector({
      skillPath: await tmpSkill(),
      version: "0.2.0",
      connectors: () => [],
      changelogPath: `${dir}/nope.md`,
    });
    assertEquals(
      (await client(bare)["version"]({}) as { changelog: { available: boolean } }).changelog
        .available,
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function writeRun(
  dataDir: string,
  runId: string,
  opts: { status?: string; withArgs?: boolean } = {},
): Promise<void> {
  const dir = `${dataDir}/runs`;
  await Deno.mkdir(dir, { recursive: true });
  const lines = [
    {
      kind: "run",
      runId,
      started: "2026-11-01T10:00:00.000Z",
      code: "return 1",
      connectors: ["mail"],
    },
    {
      seq: 1,
      ts: "2026-11-01T10:00:01.000Z",
      op: "mail.messages.get",
      ...(opts.withArgs
        ? {
          args: { account: "amu", mailbox: "INBOX", uid: 5 },
          argsSummary: { bytes: 41, sha256: "bb" },
        }
        : {}),
      status: "ok",
      resultSummary: { bytes: 90_000, sha256: "aa" },
    },
    { seq: 2, ts: "2026-11-01T10:00:02.000Z", op: "mail.drafts.save", status: "approved" },
    {
      seq: 3,
      ts: "2026-11-01T10:00:03.000Z",
      op: "mail.messages.move",
      status: "error",
      error: `boom ${"x".repeat(400)}`,
    },
    { kind: "final", ts: "2026-11-01T10:00:04.000Z", status: opts.status ?? "completed" },
  ];
  await Deno.writeTextFile(`${dir}/${runId}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n"));
}

Deno.test("denops.oplog summarises runs and never echoes args or results", async () => {
  const dataDir = await Deno.makeTempDir();
  try {
    await writeRun(dataDir, "run-one", { withArgs: true });
    const conn = denopsConnector({
      skillPath: await tmpSkill(),
      version: "0.2.0",
      connectors: () => [],
      dataDir,
    });
    const out = await client(conn)["oplog"]({ limit: 5 }) as {
      available: boolean;
      runs: Array<{
        runId: string;
        finalStatus: string;
        approvals: number;
        errors: number;
        ops: Array<{ op: string; status: string; argsBytes?: number; error?: string }>;
      }>;
    };
    assertEquals(out.available, true);
    assertEquals(out.runs.length, 1);
    const run = out.runs[0];
    assertEquals(run.runId, "run-one");
    assertEquals(run.finalStatus, "completed");
    assertEquals(run.approvals, 1);
    assertEquals(run.errors, 1);
    assertEquals(run.ops.map((o) => o.op), [
      "mail.messages.get",
      "mail.drafts.save",
      "mail.messages.move",
    ]);
    // redaction: no args object, only its size; errors truncated
    const first = run.ops[0] as unknown as Record<string, unknown>;
    assertEquals(first.args, undefined);
    assertEquals(typeof first.argsBytes, "number");
    assert((run.ops[2].error ?? "").length <= 241, "errors are truncated");

    // ops cap
    const capped = await client(conn)["oplog"]({ runId: "run-one", ops: 2 }) as {
      runs: Array<{ ops: unknown[] }>;
    };
    assertEquals(capped.runs[0].ops.length, 2);

    // a runId is an id, not a path
    let msg = "";
    try {
      await client(conn)["oplog"]({ runId: "../../secrets" });
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "not a path");

    // unknown run id: empty, not an error
    const missing = await client(conn)["oplog"]({ runId: "nope" }) as { runs: unknown[] };
    assertEquals(missing.runs, []);
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("summarizeRun survives a truncated log (manifest only)", () => {
  const summary = summarizeRun("r", [
    { kind: "run", runId: "r", started: "2026-11-01T00:00:00.000Z", code: "", connectors: [] },
  ]) as unknown as Record<string, unknown>;
  assertEquals(summary.finalStatus, null);
  assertEquals(summary.ops, []);
});

Deno.test("denops.logs tails the server log, filtered and redacted", async () => {
  const dataDir = await Deno.makeTempDir();
  try {
    const logPath = `${dataDir}/server.log`;
    await Deno.writeTextFile(
      logPath,
      [
        "=== 2026-11-01T17:00:00Z supervisor: starting abc ===",
        "[denops] listening on http://127.0.0.1:3100/mcp",
        '[connector] {"event":"gitlab","authorization":"Bearer abcdefghijklmnopqrstuvwxyz"}',
        "fetch https://api.example/v1/models?api_key=sk-verysecretvalue&x=1",
        "PRIVATE-TOKEN: f00b4r-token-value",
        "error: invalid host: '[:53'",
        "another line with no secrets",
      ].join("\n"),
    );
    const conn = denopsConnector({
      skillPath: await tmpSkill(),
      version: "0.3.0",
      connectors: () => [],
      dataDir,
      serverLogPath: logPath,
    });
    const c = client(conn);

    const tail = await c["logs"]({ lines: 3 }) as {
      available: boolean;
      lines: string[];
      matched: number;
      fileBytes: number;
    };
    assertEquals(tail.available, true);
    assertEquals(tail.lines.length, 3);
    assertStringIncludes(tail.lines[2], "no secrets");
    assert(tail.fileBytes > 0);

    const hit = await c["logs"]({ grep: "invalid host" }) as { lines: string[]; matched: number };
    assertEquals(hit.matched, 1);
    assertStringIncludes(hit.lines[0], "invalid host");

    const all = (await c["logs"]({ lines: 2000 }) as { lines: string[] }).lines.join("\n");
    assert(!all.includes("abcdefghijklmnopqrstuvwxyz"), "bearer token must be masked");
    assert(!all.includes("sk-verysecretvalue"), "api_key query parameter must be masked");
    assert(!all.includes("f00b4r-token-value"), "PRIVATE-TOKEN must be masked");
    assertStringIncludes(all, "<redacted>");

    // a missing log is a fact, not an error
    const missing = denopsConnector({
      skillPath: await tmpSkill(),
      version: "0.3.0",
      connectors: () => [],
      dataDir,
      serverLogPath: `${dataDir}/nope.log`,
    });
    const empty = await client(missing)["logs"]({}) as { available: boolean; note?: string };
    assertEquals(empty.available, false);
    assertStringIncludes(empty.note ?? "", "at the next start");
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("denops.logs summarises connector args instead of echoing them", () => {
  const line =
    '[connector] {"connector":"mail","op":"mail.drafts.save","args":{"body":"a private body"}}';
  const summarized = summarizeConnectorLine(line);
  assert(!summarized.includes("a private body"), summarized);
  assertStringIncludes(summarized, '"op":"mail.drafts.save"');
  assertStringIncludes(summarized, '"bytes":');
  // a non-JSON or non-connector line is left alone
  assertEquals(summarizeConnectorLine("plain line"), "plain line");
  assertEquals(summarizeConnectorLine("[connector] not json"), "[connector] not json");
});

Deno.test("redactLine masks credentials without mangling ordinary text", () => {
  assertEquals(
    redactLine("Authorization: Bearer abcd1234efgh5678"),
    "Authorization: <redacted>",
  );
  assertStringIncludes(redactLine("GET /x?token=abcdef123456"), "token=<redacted>");
  // a 40-char git sha and 64-char ssh fingerprint-ish words are fine to keep
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assertStringIncludes(redactLine(`starting ${sha}`), sha);
  assertEquals(redactLine("plain line"), "plain line");
});

Deno.test("denops.about reports the derived permission envelope", async () => {
  const conn = denopsConnector({
    skillPath: await tmpSkill(),
    version: "0.3.0",
    connectors: () => ["web"],
    permissions: () => ({ net: ["arxiv.org"], read: ["src/"], write: ["data/"], run: [] }),
  });
  const about = await client(conn)["about"]({}) as {
    permissions: { net: string[]; run: string[] };
  };
  assertEquals(about.permissions.net, ["arxiv.org"]);
  assertEquals(about.permissions.run, []);
});

Deno.test("denops.budget reports the live harness budget", async () => {
  const harness = new Harness(
    () => undefined,
    {
      wallClockMs: 1000,
      maxOpsPerRun: 5,
      maxOpResultBytes: 1024,
      maxOpArgsBytes: 1024,
      maxLogBytes: 1024,
    },
    () => "",
    () => "",
  );
  const idle = harness.budgetSnapshot();
  assertEquals(idle.runId, null);
  assertEquals(idle.opLimit, 5);
  assertEquals(idle.opsRemaining, 5);

  const conn = denopsConnector({
    skillPath: await tmpSkill(),
    version: "0.2.0",
    connectors: () => [],
    budget: () => harness.budgetSnapshot() as unknown as Record<string, JsonValue>,
  });
  const b = await client(conn)["budget"]({}) as {
    available: boolean;
    runId: string | null;
    remainingMs: number;
    opsRemaining: number;
  };
  assertEquals(b.available, true);
  assertEquals(b.runId, null);
  assertEquals(b.opsRemaining, 5);
  assert(b.remainingMs <= 1000 && b.remainingMs >= 0);

  // a connector without a harness says so instead of guessing
  const bare = denopsConnector({
    skillPath: await tmpSkill(),
    version: "0.2.0",
    connectors: () => [],
  });
  assertEquals(
    (await client(bare)["budget"]({}) as { available: boolean }).available,
    false,
  );
});
