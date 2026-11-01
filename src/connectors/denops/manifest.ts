import { compose, rejectUnknown } from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";

// Serves the repo's SKILL.md: the prompt-facing contract for this server. It lives in
// the repository (and is drift-checked by tests/skill_test.ts) so the doc a model reads
// is the same file humans review in a diff, not a string buried in code.
export function denopsConnector(opts: {
  skillPath: string;
  version: string;
  commit?: string;
  /** Connector families this deployment exposes, for denops.about. */
  connectors: () => string[];
}): Connector {
  const cache = { mtime: -1, text: "", updatedAt: "" };

  const readSkill = async (): Promise<{ text: string; updatedAt: string }> => {
    try {
      const info = await Deno.stat(opts.skillPath);
      const mtime = info.mtime?.getTime() ?? 0;
      if (mtime !== cache.mtime) {
        cache.text = await Deno.readTextFile(opts.skillPath);
        cache.mtime = mtime;
        cache.updatedAt = new Date(mtime).toISOString();
      }
      return { text: cache.text, updatedAt: cache.updatedAt };
    } catch (e) {
      throw new Error(
        `SKILL.md is missing or unreadable at ${opts.skillPath}: ${(e as Error).message}`,
      );
    }
  };

  return {
    id: "denops",
    ops: [
      {
        name: "denops.skill",
        tier: "open",
        doc:
          "This server's agent skill sheet (SKILL.md): conventions, discovery, approval/capability semantics, connector crib sheet, dev/deploy loop. args: { section? } filters to matching '## ' sections. Call it first when orienting.",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "denops.about",
        tier: "open",
        doc:
          "Server version, SKILL.md freshness/length, and the connector families this deployment exposes. args: {}",
        argSchema: compose(rejectUnknown()),
      },
    ],
    client: (ctx: HostContext) => ({
      "skill": async (a) => {
        const { text, updatedAt } = await readSkill();
        const section = String((a as { section?: unknown }).section ?? "").trim();
        const bytes = new TextEncoder().encode(text).length;
        if (section === "") return { updatedAt, bytes, content: text } as JsonValue;
        const parts = text.split(/\n(?=## )/);
        const picked = parts.filter((p) => p.toLowerCase().includes(section.toLowerCase()));
        return {
          updatedAt,
          section,
          found: picked.length > 0,
          content: (picked.length ? picked : parts.slice(0, 1)).join("\n"),
        } as JsonValue;
      },
      "about": async () => {
        const { text, updatedAt } = await readSkill();
        return {
          version: opts.version,
          commit: opts.commit ?? null,
          skillUpdatedAt: updatedAt,
          skillBytes: new TextEncoder().encode(text).length,
          connectors: opts.connectors(),
        } as JsonValue;
      },
    }),
    validateStartup: async () => {
      await readSkill();
    },
  };
}
