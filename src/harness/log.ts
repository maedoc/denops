import type { JsonValue } from "./types.ts";

export interface RunManifest {
  kind: "run";
  runId: string;
  started: string;
  code: string;
  connectors: string[];
}

export interface OpLogEntry {
  kind?: "op";
  seq: number;
  ts: string;
  op: string;
  args?: JsonValue;
  argsSummary?: { bytes: number; sha256: string };
  status: "ok" | "error" | "pending" | "approved" | "rejected";
  /**
   * 1-based dispatch index of the op call within the run. Stable across replays
   * (the guest code is deterministic), unlike `seq`, which also counts approval
   * marker entries. Replay keys on this.
   */
  call?: number;
  result?: JsonValue;
  resultSummary?: { bytes: number; sha256: string; storedAt?: string };
  error?: string;
}

export interface FinalEntry {
  kind: "final";
  ts: string;
  status: "completed" | "failed" | "awaiting_approval" | "rejected" | "budget_exceeded";
  error?: string;
  pendingId?: string;
}

export type LogLine = RunManifest | OpLogEntry | FinalEntry;

export function isOpEntry(l: LogLine): l is OpLogEntry {
  return (l as { kind?: string }).kind === "op" || ("seq" in l && "op" in l && !("kind" in l));
}

export function isManifest(l: LogLine): l is RunManifest {
  return l.kind === "run";
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class RunLog {
  private file: string;
  private resultsDir: string;
  private seq = 0;
  private bytesWritten = 0;
  private maxLogBytes: number;

  constructor(dataDir: string, runId: string, maxLogBytes: number) {
    this.file = `${dataDir}/runs/${runId}.jsonl`;
    this.resultsDir = `${dataDir}/runs/${runId}/results`;
    this.maxLogBytes = maxLogBytes;
  }

  async init(
    manifest: Omit<RunManifest, "kind" | "started"> & { started?: string },
  ): Promise<void> {
    await Deno.mkdir(`${this.dataDir()}/runs`, { recursive: true });
    await Deno.mkdir(this.resultsDir, { recursive: true });
    const line: RunManifest = {
      kind: "run",
      started: new Date().toISOString(),
      ...manifest,
    };
    await this.append(line);
  }

  private dataDir(): string {
    return this.file.split("/runs/")[0];
  }

  private async append(line: LogLine): Promise<void> {
    if (this.bytesWritten > this.maxLogBytes) {
      throw new Error(`op log exceeded ${this.maxLogBytes} bytes (budget)`);
    }
    const text = JSON.stringify(line) + "\n";
    await Deno.writeTextFile(this.file, text, { append: true });
    this.bytesWritten += text.length;
  }

  async recordOp(
    entry: Omit<OpLogEntry, "seq" | "ts" | "call"> & { args?: JsonValue; call?: number },
  ): Promise<number> {
    this.seq += 1;
    const seq = this.seq;
    let args = entry.args;
    let argsSummary: OpLogEntry["argsSummary"];
    if (args !== undefined) {
      const s = JSON.stringify(args);
      const bytes = new TextEncoder().encode(s).length;
      if (bytes > 4096) {
        argsSummary = { bytes, sha256: await sha256Hex(s) };
        args = undefined;
      }
    }
    let result = entry.result;
    let resultSummary: OpLogEntry["resultSummary"];
    if (result !== undefined) {
      const s = JSON.stringify(result);
      const bytes = new TextEncoder().encode(s).length;
      if (bytes > 4096) {
        resultSummary = { bytes, sha256: await sha256Hex(s) };
        if (bytes <= 10 * 1024 * 1024) {
          const storedAt = `${seq}.json`;
          await Deno.writeTextFile(`${this.resultsDir}/${storedAt}`, s);
          resultSummary.storedAt = storedAt;
        }
        result = undefined;
      }
    }
    await this.append({
      seq,
      ts: new Date().toISOString(),
      ...(entry.call !== undefined ? { call: entry.call } : {}),
      op: entry.op,
      ...(args !== undefined ? { args } : {}),
      ...(argsSummary ? { argsSummary } : {}),
      status: entry.status,
      ...(result !== undefined ? { result } : {}),
      ...(resultSummary ? { resultSummary } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    });
    return seq;
  }

  async recordFinal(entry: Omit<FinalEntry, "kind" | "ts">): Promise<void> {
    await this.append({ kind: "final", ts: new Date().toISOString(), ...entry });
  }

  static async read(dataDir: string, runId: string): Promise<LogLine[]> {
    const text = await Deno.readTextFile(`${dataDir}/runs/${runId}.jsonl`);
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LogLine);
  }

  static async readOpResult(
    dataDir: string,
    runId: string,
    seq: number,
  ): Promise<JsonValue | undefined> {
    try {
      const text = await Deno.readTextFile(`${dataDir}/runs/${runId}/results/${seq}.json`);
      return JSON.parse(text) as JsonValue;
    } catch {
      return undefined;
    }
  }
}
