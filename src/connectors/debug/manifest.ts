import { compose, optStr, rejectUnknown } from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";

export const debugConnector: Connector = {
  id: "debug",
  ops: [
    {
      name: "debug.echo",
      tier: "open",
      doc: "Echo args back. Used to smoke-test the execute path.",
      argSchema: compose(rejectUnknown(), optStr("text")),
    },
    {
      name: "debug.boom",
      tier: "open",
      doc: "Always throws. Used to test error propagation.",
      argSchema: compose(rejectUnknown()),
    },
    {
      name: "debug.gated",
      tier: "approval",
      doc: "Approval-gated op. Suspends the run until approve(pendingId) resolves it.",
      argSchema: compose(rejectUnknown(), optStr("reason")),
    },
  ],
  client: (_ctx: HostContext) => ({
    "echo": (args) => Promise.resolve({ echoed: args }),
    "boom": () => {
      throw new Error("debug.boom: intentional failure");
    },
    "gated": (args: JsonValue) => Promise.resolve({ gated: true, args }),
  }),
};
