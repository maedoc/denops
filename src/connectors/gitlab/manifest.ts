import { compose, num, oneOf, optNum, optStr, rejectUnknown, str } from "../../harness/args.ts";
import type { Connector, HostContext } from "../../harness/types.ts";
import { GitLabClient } from "./client.ts";

export function gitlabConnector(
  opts: { token: string; origin: string; apiPath: string },
): Connector {
  const client = new GitLabClient(opts);
  return {
    id: "gitlab",
    ops: [
      {
        name: "gitlab.projects.list",
        tier: "open",
        doc: "List projects visible to the token. args: { search?, perPage?, page?, membership? }",
        argSchema: compose(
          rejectUnknown(),
          optStr("search", 200),
          optNum("perPage"),
          optNum("page"),
          optStr("membership", 10),
        ),
      },
      {
        name: "gitlab.projects.get",
        tier: "open",
        doc: "Get one project. args: { id: string|number } (path with / allowed, e.g. 'group/sub')",
        argSchema: compose(rejectUnknown(), str("id")),
      },
      {
        name: "gitlab.projects.search",
        tier: "open",
        doc: "Search projects by name. args: { search: string, perPage?, page? }",
        argSchema: compose(rejectUnknown(), str("search"), optNum("perPage"), optNum("page")),
      },
      {
        name: "gitlab.repository.files.get",
        tier: "open",
        doc:
          "Get a file's metadata/content from the default branch. args: { projectId, filePath, ref? }",
        argSchema: compose(rejectUnknown(), str("projectId"), str("filePath"), optStr("ref", 200)),
      },
      {
        name: "gitlab.repository.tree.list",
        tier: "open",
        doc: "List repository tree. args: { projectId, path?, ref?, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          optStr("path", 1000),
          optStr("ref", 200),
          optNum("perPage"),
          optNum("page"),
        ),
      },
      {
        name: "gitlab.repository.commits.list",
        tier: "open",
        doc: "List commits. args: { projectId, ref?, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          optStr("ref", 200),
          optNum("perPage"),
          optNum("page"),
        ),
      },
      {
        name: "gitlab.repository.branches.list",
        tier: "open",
        doc: "List branches. args: { projectId, search? }",
        argSchema: compose(rejectUnknown(), str("projectId"), optStr("search", 200)),
      },
      {
        name: "gitlab.issues.list",
        tier: "open",
        doc: "List issues of a project. args: { projectId, state?, search?, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          oneOf("state", ["opened", "closed", "all"]),
          optStr("search", 200),
          optNum("perPage"),
          optNum("page"),
        ),
      },
      {
        name: "gitlab.issues.get",
        tier: "open",
        doc: "Get one issue. args: { projectId, issueIid: number }",
        argSchema: compose(rejectUnknown(), str("projectId"), num("issueIid")),
      },
      {
        name: "gitlab.issues.notes.list",
        tier: "open",
        doc:
          "List notes/comments on an issue. args: { projectId, issueIid: number, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          num("issueIid"),
          optNum("perPage"),
          optNum("page"),
        ),
      },
      {
        name: "gitlab.mergeRequests.list",
        tier: "open",
        doc: "List merge requests. args: { projectId, state?, search?, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          oneOf("state", ["opened", "closed", "merged", "all"]),
          optStr("search", 200),
          optNum("perPage"),
          optNum("page"),
        ),
      },
      {
        name: "gitlab.mergeRequests.get",
        tier: "open",
        doc: "Get one MR. args: { projectId, mrIid: number }",
        argSchema: compose(rejectUnknown(), str("projectId"), num("mrIid")),
      },
      {
        name: "gitlab.mergeRequests.changes.get",
        tier: "open",
        doc: "Get MR diff/changes. args: { projectId, mrIid: number }",
        argSchema: compose(rejectUnknown(), str("projectId"), num("mrIid")),
      },
      {
        name: "gitlab.users.current",
        tier: "open",
        doc: "Get the current authenticated user. args: {}",
        argSchema: compose(rejectUnknown()),
      },
      {
        name: "gitlab.groups.list",
        tier: "open",
        doc: "List groups. args: { search?, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          optStr("search", 200),
          optNum("perPage"),
          optNum("page"),
        ),
      },
    ],
    client: (_ctx: HostContext) => ({
      "projects.list": (a) =>
        client.get("/projects", pick(a, ["search", "perPage", "page", "membership"])),
      "projects.get": (a) => client.get(`/projects/${enc(String((a as { id: string }).id))}`),
      "projects.search": (a) => client.get("/projects", pick(a, ["search", "perPage", "page"])),
      "repository.files.get": (a) => {
        const r = a as { projectId: string; filePath: string; ref?: string };
        return client.get(
          `/projects/${enc(r.projectId)}/repository/files/${encPath(r.filePath)}`,
          r.ref ? { ref: r.ref } : undefined,
        );
      },
      "repository.tree.list": (a) => {
        const r = a as {
          projectId: string;
          path?: string;
          ref?: string;
          perPage?: number;
          page?: number;
        };
        return client.get(
          `/projects/${enc(r.projectId)}/repository/tree`,
          pick(a, ["path", "ref", "perPage", "page"]),
        );
      },
      "repository.commits.list": (a) => {
        const r = a as { projectId: string };
        return client.get(
          `/projects/${enc(r.projectId)}/repository/commits`,
          pick(a, ["ref_name", "perPage", "page", "ref"]),
        );
      },
      "repository.branches.list": (a) => {
        const r = a as { projectId: string };
        return client.get(`/projects/${enc(r.projectId)}/repository/branches`, pick(a, ["search"]));
      },
      "issues.list": (a) => {
        const r = a as { projectId: string };
        return client.get(
          `/projects/${enc(r.projectId)}/issues`,
          pick(a, ["state", "search", "perPage", "page"]),
        );
      },
      "issues.get": (a) => {
        const r = a as { projectId: string; issueIid: number };
        return client.get(`/projects/${enc(r.projectId)}/issues/${r.issueIid}`);
      },
      "issues.notes.list": (a) => {
        const r = a as { projectId: string; issueIid: number };
        return client.get(
          `/projects/${enc(r.projectId)}/issues/${r.issueIid}/notes`,
          pick(a, ["perPage", "page"]),
        );
      },
      "mergeRequests.list": (a) => {
        const r = a as { projectId: string };
        return client.get(
          `/projects/${enc(r.projectId)}/merge_requests`,
          pick(a, ["state", "search", "perPage", "page"]),
        );
      },
      "mergeRequests.get": (a) => {
        const r = a as { projectId: string; mrIid: number };
        return client.get(`/projects/${enc(r.projectId)}/merge_requests/${r.mrIid}`);
      },
      "mergeRequests.changes.get": (a) => {
        const r = a as { projectId: string; mrIid: number };
        return client.get(`/projects/${enc(r.projectId)}/merge_requests/${r.mrIid}/changes`);
      },
      "users.current": () => client.get("/user"),
      "groups.list": (a) => client.get("/groups", pick(a, ["search", "perPage", "page"])),
    }),
    validateStartup: async () => {
      await client.get("/user");
    },
  };
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
function encPath(s: string): string {
  return encodeURIComponent(s);
}
function pick(a: unknown, keys: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof a === "object" && a !== null) {
    for (const k of keys) {
      const v = (a as Record<string, unknown>)[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}
