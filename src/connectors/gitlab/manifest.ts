import { compose, num, oneOf, optNum, optStr, rejectUnknown, str } from "../../harness/args.ts";
import type { Connector, HostContext } from "../../harness/types.ts";
import { checkShapeArgs, wrapClient } from "../shape.ts";
import { GitLabClient } from "./client.ts";

export function gitlabConnector(
  opts: { token: string; origin: string; apiPath: string },
): Connector {
  const client = new GitLabClient(opts);
  const conn: Connector = {
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
        name: "gitlab.issues.create",
        tier: "approval",
        doc: "Create an issue. args: { projectId, title, description? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          str("title"),
          optStr("description", 100000),
        ),
      },
      {
        name: "gitlab.issues.update",
        tier: "approval",
        doc: "Update an issue. args: { projectId, issueIid, title?, description?, state? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          num("issueIid"),
          optStr("title", 500),
          optStr("description", 100000),
          oneOf("state", ["opened", "closed"]),
        ),
      },
      {
        name: "gitlab.issues.notes.create",
        tier: "approval",
        doc: "Comment on an issue. args: { projectId, issueIid, body }",
        argSchema: compose(rejectUnknown(), str("projectId"), num("issueIid"), str("body")),
      },
      {
        name: "gitlab.mergeRequests.create",
        tier: "approval",
        doc:
          "Create a merge request. args: { projectId, sourceBranch, targetBranch, title, description? }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          str("sourceBranch"),
          str("targetBranch"),
          str("title"),
          optStr("description", 100000),
        ),
      },
      {
        name: "gitlab.mergeRequests.comment",
        tier: "approval",
        doc: "Comment on a merge request. args: { projectId, mrIid, body }",
        argSchema: compose(rejectUnknown(), str("projectId"), num("mrIid"), str("body")),
      },
      {
        name: "gitlab.repository.files.create",
        tier: "approval",
        doc:
          "Create or update a file via a single commit. args: { projectId, filePath, branch, content, commitMessage }",
        argSchema: compose(
          rejectUnknown(),
          str("projectId"),
          str("filePath"),
          str("branch"),
          str("content"),
          str("commitMessage"),
        ),
      },
      {
        name: "gitlab.projects.update",
        tier: "approval",
        doc: "Update project settings. args: { id, name?, description? }",
        argSchema: compose(
          rejectUnknown(),
          str("id"),
          optStr("name", 200),
          optStr("description", 10000),
        ),
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
    client: (_ctx: HostContext) =>
      wrapClient({
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
          return client.get(
            `/projects/${enc(r.projectId)}/repository/branches`,
            pick(a, ["search"]),
          );
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
        "issues.create": (a) => {
          const r = a as { projectId: string; title: string; description?: string };
          return client.post(`/projects/${enc(r.projectId)}/issues`, {
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
          });
        },
        "issues.update": (a) => {
          const r = a as {
            projectId: string;
            issueIid: number;
            title?: string;
            description?: string;
            state?: string;
          };
          return client.put(
            `/projects/${enc(r.projectId)}/issues/${r.issueIid}`,
            pick(a, ["title", "description", "state"]),
          );
        },
        "issues.notes.create": (a) => {
          const r = a as { projectId: string; issueIid: number; body: string };
          return client.post(`/projects/${enc(r.projectId)}/issues/${r.issueIid}/notes`, {
            body: r.body,
          });
        },
        "mergeRequests.create": (a) => {
          const r = a as {
            projectId: string;
            sourceBranch: string;
            targetBranch: string;
            title: string;
            description?: string;
          };
          return client.post(`/projects/${enc(r.projectId)}/merge_requests`, {
            source_branch: r.sourceBranch,
            target_branch: r.targetBranch,
            title: r.title,
            ...(r.description ? { description: r.description } : {}),
          });
        },
        "mergeRequests.comment": (a) => {
          const r = a as { projectId: string; mrIid: number; body: string };
          return client.post(`/projects/${enc(r.projectId)}/merge_requests/${r.mrIid}/notes`, {
            body: r.body,
          });
        },
        "repository.files.create": (a) => {
          const r = a as {
            projectId: string;
            filePath: string;
            branch: string;
            content: string;
            commitMessage: string;
          };
          return client.post(
            `/projects/${enc(r.projectId)}/repository/files/${encPath(r.filePath)}`,
            {
              branch: r.branch,
              content: r.content,
              commit_message: r.commitMessage,
            },
          );
        },
        "projects.update": (a) => {
          const r = a as { id: string };
          return client.put(`/projects/${enc(r.id)}`, pick(a, ["name", "description"]));
        },
        "users.current": () => client.get("/user"),
        "groups.list": (a) => client.get("/groups", pick(a, ["search", "perPage", "page"])),
      }, GITLAB_SHAPE),
    validateStartup: async () => {
      await client.get("/user");
    },
  };

  // Every op accepts fields/full; the shaped ones say so in their doc so
  // search()/describe() surface the option without a separate lookup.
  conn.ops = conn.ops.map((op) => {
    const short = op.name.slice("gitlab.".length);
    return {
      ...op,
      argSchema: compose(op.argSchema, checkShapeArgs),
      doc: GITLAB_SHAPE[short] ? op.doc + SHAPE_HINT : op.doc,
    };
  });
  return conn;
}

// Default projections: upstream GitLab objects are ~4KB each, which is context
// abuse for an LLM caller. Callers override with `fields: ["a", "b.c"]` or ask
// for the raw object with `full: true`.
const SHAPE_HINT = ' Returns a summary; pass fields: ["..."] or full: true for the raw object.';

const PROJECT_FIELDS = [
  "id",
  "name",
  "path_with_namespace",
  "default_branch",
  "visibility",
  "archived",
  "web_url",
  "last_activity_at",
];
const ISSUE_FIELDS = [
  "iid",
  "title",
  "state",
  "labels",
  "author.username",
  "web_url",
  "updated_at",
];
const MR_FIELDS = [
  "iid",
  "title",
  "state",
  "source_branch",
  "target_branch",
  "author.username",
  "web_url",
  "updated_at",
];

const GITLAB_SHAPE: Record<string, string[]> = {
  "projects.list": PROJECT_FIELDS,
  "projects.search": PROJECT_FIELDS,
  "projects.get": PROJECT_FIELDS,
  "issues.list": ISSUE_FIELDS,
  "issues.get": ISSUE_FIELDS,
  "issues.notes.list": ["id", "author.username", "created_at", "system"],
  "mergeRequests.list": MR_FIELDS,
  "mergeRequests.get": MR_FIELDS,
  "mergeRequests.changes.get": [
    "iid",
    "title",
    "state",
    "changes.file",
    "changes.new_file",
    "changes.deleted_file",
    "changes.renamed_file",
    "changes.too_large",
  ],
  "repository.tree.list": ["id", "name", "type", "path", "mode"],
  "repository.commits.list": [
    "id",
    "short_id",
    "title",
    "author_name",
    "authored_date",
    "committed_date",
  ],
  "repository.branches.list": ["name", "default", "protected", "merged", "commit.short_id"],
  "groups.list": ["id", "name", "full_path", "visibility", "web_url"],
  "users.current": ["id", "username", "name", "state", "web_url"],
};

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
