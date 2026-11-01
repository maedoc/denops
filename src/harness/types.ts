export type OpTier = "open" | "approval" | "absent";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface OpSpec {
  name: string;
  tier: OpTier;
  doc: string;
  argSchema: (args: unknown) => string | null;
  /**
   * Optional, connector-supplied plain-language summary for the approval prompt.
   * Called instead of the generic summarizeOp() so a human sees *what* will happen
   * (which commit ships, which mailbox moves, …) rather than just the args.
   */
  summarize?: (args: JsonValue) => string | Promise<string>;
}

export interface OpResult {
  ok: boolean;
  result?: JsonValue;
  error?: string;
}

export type HostContext = {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  log: (entry: Record<string, unknown>) => void;
};

export interface Connector {
  id: string;
  ops: OpSpec[];
  client: (ctx: HostContext) => Record<string, (args: JsonValue) => Promise<JsonValue>>;
  validateStartup?: (ctx: HostContext) => Promise<void>;
}

export interface Budgets {
  wallClockMs: number;
  maxOpsPerRun: number;
  maxOpResultBytes: number;
  maxOpArgsBytes: number;
  maxLogBytes: number;
}
