import type { JsonValue } from "./types.ts";

// runArgv runs a program with an explicit argv (never a shell), a wall-clock
// limit, and capped output. Used by the dev/deploy connectors so the agent can
// verify work without arbitrary `sh -c` access.
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

export async function runArgv(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    throw new Error("runArgv: argv must be a non-empty array of strings");
  }
  const started = Date.now();
  const cmd = new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd: opts.cwd,
    env: opts.env,
    clearEnv: opts.env !== undefined,
    stdout: "piped",
    stderr: "piped",
  });
  let proc: Deno.ChildProcess;
  try {
    proc = cmd.spawn();
  } catch (e) {
    return {
      code: -1,
      stdout: "",
      stderr: `failed to start ${argv[0]}: ${(e as Error).message}`,
      timedOut: false,
      durationMs: Date.now() - started,
    };
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch { /* already gone */ }
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const [stdout, stderr, status] = await Promise.all([
      readCapped(proc.stdout, maxBytes),
      readCapped(proc.stderr, maxBytes),
      proc.status,
    ]);
    return {
      code: timedOut ? -1 : (status.code ?? -1),
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let dropped = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = dec.decode(value, { stream: true });
    const room = limit - buf.length;
    if (room > 0) buf += chunk.slice(0, room);
    dropped += Math.max(0, chunk.length - Math.max(0, room));
  }
  buf += dec.decode();
  return dropped > 0 ? `${buf}\n...[${dropped} bytes truncated]` : buf;
}

export function execSummary(r: ExecResult): JsonValue {
  return {
    code: r.code,
    timedOut: r.timedOut,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
  } as JsonValue;
}
