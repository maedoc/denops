import {
  compose,
  oneOf,
  optOneOf,
  optStr,
  rejectUnknown,
  str,
  strMax,
} from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue, OpSpec } from "../../harness/types.ts";
import { checkShapeArgs, wrapClient } from "../shape.ts";
import { ForgeHttp } from "./client.ts";
import { gitlabPort } from "./flavors/gitlab.ts";
import { forgejoPort } from "./flavors/forgejo.ts";
import { type ForgeAccount, type ForgePort, parseRepoRef, repoRefString } from "./port.ts";

// The `forge` family: one flavor-neutral op surface over several code-hosting APIs.
//
// Design rules that the rest of this file follows:
//  - Ops speak the normalized vocabulary from port.ts. Flavor-specific richness is
//    reached through forge.api.get (raw JSON) rather than by widening the curated set.
//  - Every op names an account; the account carries flavor, origin and credential, so
//    nothing about *where* a request goes ever comes from an argument.
//  - Reads are open, writes are approval with a summarize() that names account, flavor,
//    host and repo — an approval prompt that says "create a pull request" without
//    saying where is not reviewable.
//  - Anything that cannot succeed is rejected in argSchema/precheck, never after the
//    human approves.

export interface ForgeConnectorOptions {
  accounts: ForgeAccount[];
  /** Injectable for tests; defaults to the real adapters. */
  buildPort?: (account: ForgeAccount) => ForgePort;
}

export function forgeConnector(opts: ForgeConnectorOptions): Connector {
  const build = opts.buildPort ?? buildPort;
  const ports = new Map<string, ForgePort>();
  const byId = new Map<string, ForgeAccount>();
  for (const account of opts.accounts) {
    byId.set(account.id, account);
    ports.set(account.id, build(account));
  }

  const resolve = (accountId: string): ForgePort => {
    const port = ports.get(accountId);
    if (!port) {
      const known = [...ports.keys()].sort().join(", ") || "(none configured)";
      throw new Error(`unknown forge account '${accountId}'; configured: ${known}`);
    }
    return port;
  };

  const target = (a: Record<string, unknown>): string => {
    const acct = byId.get(String(a.account));
    if (!acct) return String(a.account);
    const ref = typeof a.repo === "string" ? ` ${a.repo}` : "";
    return `${acct.id} (${acct.flavor} ${new URL(acct.origin).host})${ref}`;
  };

  const handlers: Record<string, (a: JsonValue) => Promise<JsonValue>> = {
    "accounts": () =>
      Promise.resolve(
        opts.accounts.map((a) => ({
          id: a.id,
          flavor: a.flavor,
          origin: a.origin,
          maxLimit: a.maxLimit,
        })) as unknown as JsonValue,
      ),

    "projects.list": async (a) => {
      const r = a as unknown as { account: string; search?: string; limit?: number; page?: number };
      return (await resolve(r.account).listProjects({
        search: r.search,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "projects.get": async (a) => {
      const r = a as unknown as { account: string; repo: string };
      return (await resolve(r.account).getProject(parseRepoRef(r.repo))) as unknown as JsonValue;
    },
    "projects.search": async (a) => {
      const r = a as unknown as { account: string; search: string; limit?: number; page?: number };
      return (await resolve(r.account).listProjects({
        search: r.search,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },

    "issues.list": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        state?: "open" | "closed" | "all";
        search?: string;
        limit?: number;
        page?: number;
      };
      return (await resolve(r.account).listIssues(parseRepoRef(r.repo), {
        state: r.state,
        search: r.search,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "issues.get": async (a) => {
      const r = a as unknown as { account: string; repo: string; number: number };
      return (await resolve(r.account).getIssue(
        parseRepoRef(r.repo),
        r.number,
      )) as unknown as JsonValue;
    },
    "issues.create": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        title: string;
        body?: string;
        labels?: string[];
      };
      return (await resolve(r.account).createIssue(parseRepoRef(r.repo), {
        title: r.title,
        body: r.body,
        labels: r.labels,
      })) as unknown as JsonValue;
    },
    "issues.update": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        number: number;
        title?: string;
        body?: string;
        state?: "open" | "closed";
        labels?: string[];
      };
      return (await resolve(r.account).updateIssue(parseRepoRef(r.repo), r.number, {
        title: r.title,
        body: r.body,
        state: r.state,
        labels: r.labels,
      })) as unknown as JsonValue;
    },
    "issues.notes.list": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        number: number;
        limit?: number;
        page?: number;
      };
      return (await resolve(r.account).listNotes(parseRepoRef(r.repo), r.number, {
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "issues.notes.create": async (a) => {
      const r = a as unknown as { account: string; repo: string; number: number; body: string };
      return (await resolve(r.account).createNote(
        parseRepoRef(r.repo),
        r.number,
        r.body,
      )) as unknown as JsonValue;
    },

    "pulls.list": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        state?: "open" | "closed" | "merged" | "all";
        search?: string;
        limit?: number;
        page?: number;
      };
      return (await resolve(r.account).listPulls(parseRepoRef(r.repo), {
        state: r.state as "open" | "closed" | "all" | undefined,
        search: r.search,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "pulls.get": async (a) => {
      const r = a as unknown as { account: string; repo: string; number: number };
      return (await resolve(r.account).getPull(
        parseRepoRef(r.repo),
        r.number,
      )) as unknown as JsonValue;
    },
    "pulls.changes.get": async (a) => {
      const r = a as unknown as { account: string; repo: string; number: number };
      return (await resolve(r.account).getChanges(
        parseRepoRef(r.repo),
        r.number,
      )) as unknown as JsonValue;
    },
    "pulls.create": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        title: string;
        sourceBranch: string;
        targetBranch: string;
        body?: string;
      };
      return (await resolve(r.account).createPull(parseRepoRef(r.repo), {
        title: r.title,
        sourceBranch: r.sourceBranch,
        targetBranch: r.targetBranch,
        body: r.body,
      })) as unknown as JsonValue;
    },
    "pulls.comment": async (a) => {
      const r = a as unknown as { account: string; repo: string; number: number; body: string };
      return (await resolve(r.account).createPullNote(
        parseRepoRef(r.repo),
        r.number,
        r.body,
      )) as unknown as JsonValue;
    },
    "pulls.merge": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        number: number;
        message?: string;
      };
      return (await resolve(r.account).mergePull(
        parseRepoRef(r.repo),
        r.number,
        r.message,
      )) as unknown as JsonValue;
    },

    "repository.branches.list": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        search?: string;
        limit?: number;
        page?: number;
      };
      return (await resolve(r.account).listBranches(parseRepoRef(r.repo), {
        search: r.search,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "repository.commits.list": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        ref?: string;
        limit?: number;
        page?: number;
      };
      return (await resolve(r.account).listCommits(parseRepoRef(r.repo), {
        ref: r.ref,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "repository.tree.list": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        path?: string;
        ref?: string;
        limit?: number;
        page?: number;
      };
      return (await resolve(r.account).listTree(parseRepoRef(r.repo), {
        path: r.path,
        ref: r.ref,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "repository.files.get": async (a) => {
      const r = a as unknown as { account: string; repo: string; path: string; ref?: string };
      return (await resolve(r.account).getFile(parseRepoRef(r.repo), {
        path: r.path,
        ref: r.ref,
      })) as unknown as JsonValue;
    },
    "repository.files.create": async (a) => {
      const r = a as unknown as {
        account: string;
        repo: string;
        path: string;
        branch: string;
        content: string;
        message: string;
      };
      return (await resolve(r.account).writeFile(parseRepoRef(r.repo), {
        path: r.path,
        branch: r.branch,
        content: r.content,
        message: r.message,
      })) as unknown as JsonValue;
    },

    "users.current": async (a) => {
      const r = a as unknown as { account: string };
      return (await resolve(r.account).currentUser()) as unknown as JsonValue;
    },
    "users.get": async (a) => {
      const r = a as unknown as { account: string; username: string };
      return (await resolve(r.account).getUser(r.username)) as unknown as JsonValue;
    },
    "users.search": async (a) => {
      const r = a as unknown as { account: string; search: string; limit?: number; page?: number };
      return (await resolve(r.account).searchUsers({
        search: r.search,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "orgs.list": async (a) => {
      const r = a as unknown as { account: string; search?: string; limit?: number; page?: number };
      return (await resolve(r.account).listOrgs({
        search: r.search,
        limit: r.limit,
        page: r.page,
      })) as unknown as JsonValue;
    },
    "mutate": async (a) => {
      const r = a as unknown as {
        account: string;
        method: "POST" | "PUT" | "PATCH" | "DELETE";
        path: string;
        query?: Record<string, unknown>;
        body?: JsonValue;
      };
      return await resolve(r.account).apiMutate(r.method, r.path, {
        ...(r.query === undefined ? {} : { query: r.query }),
        ...(r.body === undefined ? {} : { body: r.body }),
      });
    },

    "api.get": async (a) => {
      const r = a as unknown as {
        account: string;
        path: string;
        query?: Record<string, string | number | boolean>;
      };
      return await resolve(r.account).apiGet(r.path, r.query);
    },
  };

  const ops: OpSpec[] = [
    {
      name: "forge.accounts",
      tier: "open" as const,
      doc:
        "Forge accounts this deployment exposes (id, flavor, origin, maxLimit — never credentials). args: {}",
      argSchema: compose(rejectUnknown()),
    },
    {
      name: "forge.projects.list",
      tier: "open" as const,
      doc: "List repos visible to the account. args: { account, search?, limit?, page? }",
      argSchema: compose(rejectUnknown(), accountArg, optStr("search", 200), optLimit, optPage),
    },
    {
      name: "forge.projects.get",
      tier: "open" as const,
      doc:
        "Get one repo. args: { account, repo: 'owner/name' } (subgroups allowed: 'group/sub/project'). Returns a summary.",
      argSchema: compose(rejectUnknown(), accountArg, repoArg),
    },
    {
      name: "forge.projects.search",
      tier: "open" as const,
      doc:
        "Search repos by name. args: { account, search, limit?, page? }. Note: on Forgejo the upstream " +
        "`q` matches repo names, not owners, so 'owner/name' returns nothing — use forge.projects.get for that.",
      argSchema: compose(rejectUnknown(), accountArg, str("search"), optLimit, optPage),
    },
    {
      name: "forge.issues.list",
      tier: "open" as const,
      doc:
        "List issues. args: { account, repo, state?: open|closed|all, search?, limit?, page? }. " +
        "Defaults to open issues. Pull requests are excluded (use forge.pulls.list).",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        optOneOf("state", ["open", "closed", "all"]),
        optStr("search", 200),
        optLimit,
        optPage,
      ),
    },
    {
      name: "forge.issues.get",
      tier: "open" as const,
      doc: "Get one issue. args: { account, repo, number } (per-repo short id, like GitLab iid).",
      argSchema: compose(rejectUnknown(), accountArg, repoArg, numberArg),
    },
    {
      name: "forge.issues.notes.list",
      tier: "open" as const,
      doc: "List comments on an issue. args: { account, repo, number, limit?, page? }. " +
        "Forgejo ignores paging here, so the adapter caps client-side.",
      argSchema: compose(rejectUnknown(), accountArg, repoArg, numberArg, optLimit, optPage),
    },
    {
      name: "forge.pulls.list",
      tier: "open" as const,
      doc:
        "List pull requests (merge requests on GitLab). args: { account, repo, state?: open|closed|merged|all, search?, limit?, page? }",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        optOneOf("state", ["open", "closed", "merged", "all"]),
        optStr("search", 200),
        optLimit,
        optPage,
      ),
    },
    {
      name: "forge.pulls.get",
      tier: "open" as const,
      doc: "Get one pull request. args: { account, repo, number }",
      argSchema: compose(rejectUnknown(), accountArg, repoArg, numberArg),
    },
    {
      name: "forge.pulls.changes.get",
      tier: "open" as const,
      doc:
        "Get the files/diff of a pull request. args: { account, repo, number }. Returns { files: [...], truncated }.",
      argSchema: compose(rejectUnknown(), accountArg, repoArg, numberArg),
    },
    {
      name: "forge.pulls.create",
      tier: "approval" as const,
      doc:
        "Open a pull request (merge request on GitLab). args: { account, repo, title, sourceBranch, targetBranch, body? }",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        str("title"),
        strMax("sourceBranch", 255),
        strMax("targetBranch", 255),
        optStr("body", 100000),
      ),
      precheck: (a) => {
        const r = a as { sourceBranch?: string; targetBranch?: string };
        if (r.sourceBranch !== undefined && r.sourceBranch === r.targetBranch) {
          return "sourceBranch and targetBranch are the same — that would open an empty pull request";
        }
        return null;
      },
      summarize: (a) => {
        const r = a as { sourceBranch?: string; targetBranch?: string; title?: string };
        return `open a pull request on ${
          target(a as Record<string, unknown>)
        }: '${r.title}' (${r.sourceBranch} -> ${r.targetBranch})`;
      },
    },
    {
      name: "forge.pulls.comment",
      tier: "approval" as const,
      doc: "Comment on a pull request. args: { account, repo, number, body }",
      argSchema: compose(rejectUnknown(), accountArg, repoArg, numberArg, str("body")),
      summarize: (a) =>
        `comment on pull request #${(a as { number?: number }).number} in ${
          target(a as Record<string, unknown>)
        }`,
    },
    {
      name: "forge.pulls.merge",
      tier: "approval" as const,
      doc: "Merge a pull request. args: { account, repo, number, message? }",
      argSchema: compose(rejectUnknown(), accountArg, repoArg, numberArg, optStr("message", 10000)),
      summarize: (a) =>
        `merge pull request #${(a as { number?: number }).number} in ${
          target(a as Record<string, unknown>)
        }`,
    },
    {
      name: "forge.issues.create",
      tier: "approval" as const,
      doc: "Create an issue. args: { account, repo, title, body?, labels? }",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        str("title"),
        optStr("body", 100000),
        optLabels,
      ),
      summarize: (a) => {
        const r = a as { title?: string };
        return `create an issue in ${target(a as Record<string, unknown>)}: '${r.title}'`;
      },
    },
    {
      name: "forge.issues.update",
      tier: "approval" as const,
      doc:
        "Update an issue. args: { account, repo, number, title?, body?, state?: open|closed, labels? }",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        numberArg,
        optStr("title", 500),
        optStr("body", 100000),
        optOneOf("state", ["open", "closed"]),
        optLabels,
      ),
      summarize: (a) => {
        const r = a as { number?: number; state?: string };
        const what = r.state ? `set state=${r.state}` : "edit fields";
        return `update issue #${r.number} in ${target(a as Record<string, unknown>)} (${what})`;
      },
    },
    {
      name: "forge.issues.notes.create",
      tier: "approval" as const,
      doc: "Comment on an issue. args: { account, repo, number, body }",
      argSchema: compose(rejectUnknown(), accountArg, repoArg, numberArg, str("body")),
      summarize: (a) =>
        `comment on issue #${(a as { number?: number }).number} in ${
          target(a as Record<string, unknown>)
        }`,
    },
    {
      name: "forge.repository.branches.list",
      tier: "open" as const,
      doc: "List branches. args: { account, repo, search?, limit?, page? }",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        optStr("search", 200),
        optLimit,
        optPage,
      ),
    },
    {
      name: "forge.repository.commits.list",
      tier: "open" as const,
      doc: "List commits. args: { account, repo, ref?, limit?, page? }",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        optStr("ref", 255),
        optLimit,
        optPage,
      ),
    },
    {
      name: "forge.repository.tree.list",
      tier: "open" as const,
      doc: "List a directory of the repo. args: { account, repo, path?, ref?, limit?, page? }",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        optStr("path", 1000),
        optStr("ref", 255),
        optLimit,
        optPage,
      ),
    },
    {
      name: "forge.repository.files.get",
      tier: "open" as const,
      doc:
        "Read a file. args: { account, repo, path, ref? }. Returns { path, sha, size, text, truncated, binary }; " +
        `text is null for binary files and empty for files over ${256} KiB (truncated: true).`,
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        strMax("path", 1000),
        optStr("ref", 255),
      ),
    },
    {
      name: "forge.repository.files.create",
      tier: "approval" as const,
      doc:
        "Create or update one file in a commit. args: { account, repo, path, branch, content, message }. " +
        "Updates are read-modify-write: the adapter fetches the current blob first (both upstreams demand it).",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        repoArg,
        strMax("path", 1000),
        strMax("branch", 255),
        optStr("content", 1_000_000),
        strMax("message", 2000),
      ),
      summarize: (a) => {
        const r = a as { path?: string; branch?: string; content?: string };
        return `commit '${r.path}' (${r.content?.length ?? 0} chars) to ${r.branch} in ${
          target(a as Record<string, unknown>)
        }`;
      },
    },
    {
      name: "forge.users.current",
      tier: "open" as const,
      doc: "Get the authenticated user of an account. args: { account }",
      argSchema: compose(rejectUnknown(), accountArg),
    },
    {
      name: "forge.users.get",
      tier: "open" as const,
      doc:
        "Look up one user by exact username. args: { account, username }. Returns a summary or null.",
      argSchema: compose(rejectUnknown(), accountArg, str("username")),
    },
    {
      name: "forge.users.search",
      tier: "open" as const,
      doc: "Fuzzy user search. args: { account, search, limit?, page? }",
      argSchema: compose(rejectUnknown(), accountArg, str("search"), optLimit, optPage),
    },
    {
      name: "forge.orgs.list",
      tier: "open" as const,
      doc:
        "List organisations/groups. args: { account, search?, limit?, page? }. 'orgs' is the family's neutral " +
        "name: GitLab calls them groups, Forgejo and GitHub orgs.",
      argSchema: compose(rejectUnknown(), accountArg, optStr("search", 200), optLimit, optPage),
    },
    {
      name: "forge.mutate",
      tier: "approval" as const,
      doc:
        "Generic write: POST/PUT/PATCH/DELETE any path under the account's pinned API root, e.g. " +
        "{ account, method: 'POST', path: '/projects/1/releases', body: { tag_name: 'v1' } }. " +
        "For endpoints without a curated op (releases, labels, milestones, actions, ...). " +
        "Returns raw upstream JSON; credential-bearing paths are refused before approval.",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        oneOf("method", ["POST", "PUT", "PATCH", "DELETE"]),
        strMax("path", 1000),
        apiPathArg,
        checkQueryObject,
        checkBodyObject,
      ),
      summarize: (a) => {
        const r = a as { method?: string; path?: string };
        return `${r.method} ${r.path} on ${target(a as Record<string, unknown>)}`;
      },
    },
    {
      name: "forge.api.get",
      tier: "open" as const,
      doc:
        "Raw GET under an account's pinned API root, for endpoints without a curated op (releases, labels, " +
        "milestones, actions, compare, ...). args: { account, path, query? }. Returns raw upstream JSON.",
      argSchema: compose(
        rejectUnknown(),
        accountArg,
        strMax("path", 1000),
        apiPathArg,
        checkQueryObject,
      ),
    },
  ];

  return {
    id: "forge",
    ops: ops.map((op) => ({ ...op, argSchema: compose(op.argSchema, checkShapeArgs) })),
    client: (_ctx: HostContext) => wrapClient(handlers, {}),
    validateStartup: async () => {
      // One cheap authenticated call per account: a bad token or a revoked scope is
      // reported as a degraded connector instead of surfacing on the first real op.
      for (const account of opts.accounts) {
        const port = ports.get(account.id);
        if (!port) continue;
        await port.currentUser();
        await port.validate?.();
      }
    },
  };
}

function buildPort(account: ForgeAccount): ForgePort {
  switch (account.flavor) {
    case "gitlab":
      return gitlabPort(new ForgeHttp(account));
    case "forgejo":
      return forgejoPort(new ForgeHttp(account));
    default:
      throw new Error(
        `forge account '${account.id}': flavor '${account.flavor}' has no adapter yet (gitlab, forgejo)`,
      );
  }
}

// --- argument checks -------------------------------------------------------

const accountArg = (args: unknown): string | null => {
  const v = (args as { account?: unknown }).account;
  return typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(v)
    ? null
    : "account: expected a configured account id (lowercase letters, digits, - or _)";
};

// owner may contain slashes (GitLab subgroups), so validate each segment and the shape.
const repoArg = (args: unknown): string | null => {
  const v = (args as { repo?: unknown }).repo;
  if (typeof v !== "string" || v.length === 0 || v.length > 300) {
    return "repo: expected 'owner/name' (max 300 chars)";
  }
  const parts = v.split("/");
  if (parts.length < 2) return "repo: expected 'owner/name'";
  for (const p of parts) {
    if (!/^[A-Za-z0-9._-]+$/.test(p) || p === "." || p === "..") {
      return `repo: invalid path segment '${p}'`;
    }
  }
  return null;
};

const numberArg = (args: unknown): string | null => {
  const v = (args as { number?: unknown }).number;
  return typeof v === "number" && Number.isInteger(v) && v > 0
    ? null
    : "number: expected a positive integer (per-repo id, e.g. 42)";
};

const optLimit = (args: unknown): string | null => {
  const v = (args as { limit?: unknown }).limit;
  if (v === undefined) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100
    ? null
    : "limit: expected an integer 1..100 (clamped further to the instance's page cap)";
};

const optPage = (args: unknown): string | null => {
  const v = (args as { page?: unknown }).page;
  if (v === undefined) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 1
    ? null
    : "page: expected an integer >= 1";
};

const optLabels = (args: unknown): string | null => {
  const v = (args as { labels?: unknown }).labels;
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > 30) return "labels: expected an array of up to 30 strings";
  for (const l of v) {
    if (typeof l !== "string" || l.length === 0 || l.length > 100) {
      return "labels: each must be 1..100 chars";
    }
  }
  return null;
};

// Mirror of the gitlab connector's guard: `forge.api.get` stays inside the API root.
const apiPathArg = (args: unknown): string | null => {
  const v = (args as { path?: unknown }).path;
  if (typeof v !== "string") return "path: expected string";
  if (!v.startsWith("/")) return "path: must start with '/' (relative to the account's API root)";
  if (v.includes("//") || v.includes("..") || /[\s\\?#]/.test(v)) {
    return "path: must not contain '//', '..', whitespace, backslashes, '?' or '#' (use query)";
  }
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(v)) {
    return "path: contains unsupported characters";
  }
  if (/\/(variables|access_tokens|deploy_tokens|tokens)(\/|$)/.test(v)) {
    return `path: ${v} exposes credentials; read it outside the agent if truly needed`;
  }
  return null;
};

function checkBodyObject(args: unknown): string | null {
  const body = (args as { body?: unknown }).body;
  if (body === undefined) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body: expected object";
  return null;
}

function checkQueryObject(args: unknown): string | null {
  const query = (args as { query?: unknown }).query;
  if (query === undefined) return null;
  if (!query || typeof query !== "object" || Array.isArray(query)) return "query: expected object";
  const entries = Object.entries(query as Record<string, unknown>);
  if (entries.length > 30) return `query: too many keys (${entries.length} > 30)`;
  for (const [k, v] of entries) {
    const scalar = typeof v === "string" || typeof v === "number" || typeof v === "boolean";
    if (scalar || v === null) continue;
    if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
      continue;
    }
    return `query.${k}: expected string, number, boolean or array of those`;
  }
  return null;
}

// checkShapeArgs is composed onto every op when the connector is built, so `fields`
// and `full` are validated for the whole family.
export const FORGE_SHAPE_ARGS = checkShapeArgs;

/** Exported for tests: `owner/name` splitting, including GitLab subgroups. */
export const __test = {
  parseRepoRef,
  repoRefString,
  numberArg,
  repoArg,
  optLimit,
  apiPathArg,
  optLabels,
};
