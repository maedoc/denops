import type { Registry } from "./registry.ts";

const MAX_OPS = 20;
const MAX_CHARS_PER_OP = 4096;

export function search(registry: Registry, query: string, connector?: string): string {
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const everything = registry.index();
  const all = everything.filter((e) => !connector || e.name.startsWith(`${connector}.`));
  const matched = all
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
    .sort((a, b) => b.score - a.score);
  const scored = matched.slice(0, MAX_OPS).map((s) => s.e);
  const lines = scored.map((e) => {
    let line = `${e.name} ${e.tier} — ${e.doc}`;
    if (line.length > MAX_CHARS_PER_OP) line = line.slice(0, MAX_CHARS_PER_OP) + "…";
    return line;
  });
  if (matched.length === 0) {
    // Say how big the registry actually is: "no matching ops" alone reads as
    // "this server has no ops", which is how a caller concluded a 35-op server
    // exposed two.
    return `no matching ops${connector ? ` in ${connector}` : ""}: ${
      describeSize(all, connector)
    }.`;
  }
  const header = tokens.length === 0
    ? `${describeSize(all, connector)}: showing ${scored.length}${
      matched.length > scored.length ? ` of ${matched.length}` : ""
    }:`
    : `${matched.length} op(s)${connector ? ` in ${connector}` : ""} matched${
      matched.length > scored.length ? `, showing the best ${scored.length}` : ""
    }:`;
  const tail = matched.length > scored.length
    ? `\n(+${matched.length - scored.length} more — narrow the query${
      connector ? "" : ', or pass connector "gitlab" / "mail"'
    })`
    : "";
  return `${header}\n${lines.join("\n")}${tail}`;
}

// describeSize spells out the registry size, so "N op(s)" in a result can never
// be mistaken for the size of the whole registry.
function describeSize(
  entries: { name: string; tier: string; doc: string }[],
  connector?: string,
): string {
  if (connector) return `${entries.length} op(s) in ${connector}`;
  const byConnector = new Map<string, number>();
  for (const e of entries) {
    const id = e.name.split(".")[0];
    byConnector.set(id, (byConnector.get(id) ?? 0) + 1);
  }
  const detail = [...byConnector].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, n]) => `${id}:${n}`).join(", ");
  return `${entries.length} op(s) registered${detail ? ` (${detail})` : ""}`;
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
