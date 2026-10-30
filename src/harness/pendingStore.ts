import type { PendingApproval } from "./worker.ts";

export interface StoredPending extends PendingApproval {
  createdAt: string;
}

export class PendingStore {
  constructor(private dataDir: string) {}

  private file(): string {
    return `${this.dataDir}/pending.json`;
  }

  private async readAll(): Promise<StoredPending[]> {
    try {
      const text = await Deno.readTextFile(this.file());
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredPending[]) : [];
    } catch {
      return [];
    }
  }

  private async writeAll(items: StoredPending[]): Promise<void> {
    await Deno.mkdir(this.dataDir, { recursive: true });
    await Deno.writeTextFile(this.file(), JSON.stringify(items, null, 2));
  }

  async add(p: PendingApproval): Promise<StoredPending> {
    const items = await this.readAll();
    const stored: StoredPending = { ...p, createdAt: new Date().toISOString() };
    items.push(stored);
    await this.writeAll(items);
    return stored;
  }

  async remove(pendingId: string): Promise<StoredPending | undefined> {
    const items = await this.readAll();
    const idx = items.findIndex((i) => i.pendingId === pendingId);
    if (idx < 0) return undefined;
    const [removed] = items.splice(idx, 1);
    await this.writeAll(items);
    return removed;
  }

  async list(): Promise<StoredPending[]> {
    return await this.readAll();
  }

  async get(pendingId: string): Promise<StoredPending | undefined> {
    return (await this.readAll()).find((i) => i.pendingId === pendingId);
  }
}
