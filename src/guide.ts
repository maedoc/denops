// Agent-facing usage guide, returned as `instructions` in the MCP initialize
// result so a client sees it once per session instead of discovering the
// contract through failed calls.

export interface GuideFacts {
  connectors: Array<{ id: string; ops: number }>;
  totalOps: number;
  budgets: { wallClockMs: number; maxOpsPerRun: number; maxOpResultBytes: number };
}

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

export function agentGuide(facts: GuideFacts): string {
  const perConnector = facts.connectors
    .map((c) => `${c.id} ${c.ops}`)
    .join(", ");
  return `denops: Code Mode access to external APIs (${facts.totalOps} ops — ${perConnector}).

TOOLS
- search(query, connector?) — find ops. api.search inside execute is equivalent.
- execute(code, description?) — run one JavaScript async function BODY in a sandbox.
- approve(pendingId, "approve" | "reject") — resolve an approval-tier op.
- grants(action, key?) — list/revoke persistent fs root grants (only present when
  the fs connector is enabled).
- The full, always-current usage guide is an op: \`await denops.skill({})\` (add
  { section: "gitlab" } to filter). Read it before non-trivial work.

HOW TO CALL OPS
Write the body of an async function; it may use \`return\` and \`await\`:
  const p = await gitlab.projects.list({ perPage: 5 }); return p.map((x) => x.path_with_namespace);
Ops are namespaced globals (${facts.connectors.map((c) => `${c.id}.*`).join(", ") || "none"}).
Discovery inside the sandbox: \`await api.search("", "gitlab")\` (empty query lists the
registry) and \`await api.describe("gitlab.issues.create")\` (full doc, incl. arg and
return shapes). There is no \`tools\` object: \`Object.keys(tools)\` is a ReferenceError.

NOT AVAILABLE IN THE SANDBOX
fetch, WebSocket, XMLHttpRequest, Deno APIs, filesystem, env. Ops are the only egress;
they hold the credentials host-side. Pure computation, loops and chaining are free —
prefer ONE execute that loops over ops over many round trips.

GENERIC GITLAB COVERAGE
Curated ops cover common paths. For anything else under /api/v4:
  gitlab.get({ path: "/projects/42/labels", query: { per_page: 20 } })   (open tier)
  gitlab.mutate({ method: "POST", path: "/projects", body: { name: "x" } }) (approval)
Reads that would dump secrets (variables, *_tokens, ...) are refused by design.

PAYLOADS
List/get ops return summary projections. Narrow with \`fields: ["id","namespace.full_path"]\`
(dotted paths; arrays are shaped per element) or ask for the raw upstream object with
\`full: true\`. Prefer the default; it is usually 10-20x smaller.

APPROVAL TIER
Ops marked [approval] suspend the run and return
\`{ status: "awaiting_approval", pendingId, op, summary, args }\`. Show \`summary\` to the
user, then call approve(pendingId, "approve"). Approval replays the run
deterministically and executes the op live; "reject" terminates it.

ERRORS AND LIMITS
Failures return \`{ status: "failed", error }\` with the message only (no stack).
Invalid JS is reported as SyntaxError before any sandbox starts; invalid arguments are
rejected at the host boundary with the offending field named. Budgets per run:
${facts.budgets.wallClockMs / 1000}s wall clock, ${facts.budgets.maxOpsPerRun} ops,
${kb(facts.budgets.maxOpResultBytes)} per op result.`;
}
