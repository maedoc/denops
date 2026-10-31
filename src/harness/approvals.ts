import type { PendingApproval } from "./worker.ts";

export class ApprovalQueue {
  private pending = new Map<string, PendingApproval>();
  private resolved = new Map<string, "approve" | "reject">();

  add(p: PendingApproval): void {
    this.pending.set(p.pendingId, p);
  }

  get(pendingId: string): PendingApproval | undefined {
    return this.pending.get(pendingId);
  }

  decide(pendingId: string, decision: "approve" | "reject"): PendingApproval | undefined {
    const p = this.pending.get(pendingId);
    if (!p) return undefined;
    this.pending.delete(pendingId);
    this.resolved.set(pendingId, decision);
    return p;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()];
  }

  decision(pendingId: string): "approve" | "reject" | undefined {
    return this.resolved.get(pendingId);
  }
}
