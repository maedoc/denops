import type { Connector, OpSpec, OpTier } from "./types.ts";

export class Registry {
  private connectors = new Map<string, Connector>();
  private ops = new Map<string, { spec: OpSpec; connector: Connector }>();

  register(connector: Connector): void {
    if (this.connectors.has(connector.id)) {
      throw new Error(`duplicate connector id: ${connector.id}`);
    }
    this.connectors.set(connector.id, connector);
    for (const op of connector.ops) {
      if (op.tier === "absent") continue;
      if (this.ops.has(op.name)) {
        throw new Error(`duplicate op name: ${op.name}`);
      }
      this.ops.set(op.name, { spec: op, connector });
    }
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  resolve(op: string): { spec: OpSpec; connector: Connector } | undefined {
    return this.ops.get(op);
  }

  tierOf(op: string): OpTier {
    return this.ops.get(op)?.spec.tier ?? "absent";
  }

  index(): { name: string; tier: string; doc: string }[] {
    return [...this.ops.values()].map(({ spec }) => ({
      name: spec.name,
      tier: spec.tier === "approval" ? "[approval]" : "open",
      doc: spec.doc.split("\n")[0],
    }));
  }
}
