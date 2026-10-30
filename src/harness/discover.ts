import type { Registry } from "./registry.ts";

const MAX_OPS = 20;
const MAX_CHARS_PER_OP = 4096;

export function search(registry: Registry, query: string, connector?: string): string {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const all = registry.index().filter((e) => !connector || e.name.startsWith(`${connector}.`));
  const scored = all
    .map((e) => {
      const hay = `${e.name} ${e.doc}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (hay.includes(t)) score += t.length;
      }
      if (e.name.toLowerCase() === q) score += 1000;
      return { e, score };
    })
    .filter((s) => s.score > 0 || tokens.length === 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_OPS)
    .map((s) => s.e);
  const lines = scored.map((e) => {
    let line = `${e.name} ${e.tier} — ${e.doc}`;
    if (line.length > MAX_CHARS_PER_OP) line = line.slice(0, MAX_CHARS_PER_OP) + "…";
    return line;
  });
  const header = scored.length === 0
    ? "no matching ops."
    : `${scored.length} op(s)${connector ? ` in ${connector}` : ""}:`;
  return `${header}\n${lines.join("\n")}`;
}

export function describe(registry: Registry, op: string): string {
  const resolved = registry.resolve(op);
  if (!resolved) return `unknown op: ${op}. Use search() to list available ops.`;
  const { spec } = resolved;
  return [
    `${spec.name} ${spec.tier === "approval" ? "[approval]" : "[open]"}`,
    spec.doc,
    "args: validated at the host boundary; call with an object.",
  ].join("\n");
}
