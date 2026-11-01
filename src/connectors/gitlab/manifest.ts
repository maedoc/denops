import {
  compose,
  idArg,
  num,
  oneOf,
  optArr,
  optBool,
  optNum,
  optStr,
  rejectUnknown,
  str,
} from "../../harness/args.ts";
import type { Connector, HostContext, JsonValue } from "../../harness/types.ts";
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
        argSchema: compose(rejectUnknown(), idArg("id")),
      },
      {
        name: "gitlab.projects.search",
        tier: "open",
        doc: "Search projects by name. args: { search: string, perPage?, page? }",
        argSchema: compose(rejectUnknown(), str("search"), optNum("perPage"), optNum("page")),
      },
      {
        name: "gitlab.get",
        tier: "open",
        doc:
          "Generic read: GET any path under the GitLab API root, e.g. { path: '/projects/42/labels', query: { per_page: 20 } }. " +
          "Covers endpoints without a curated op (pipelines, releases, tags, members, labels, milestones, wiki, ...). " +
          'Returns the raw JSON; narrow with fields: ["..."] (dotted paths allowed).',
        argSchema: compose(rejectUnknown(), str("path"), checkGitlabReadPath, checkQueryObject),
      },
      {
        name: "gitlab.mutate",
        tier: "approval",
        doc:
          "Generic write: POST/PUT/DELETE any path under the GitLab API root, e.g. { method: 'PUT', path: '/projects/42/issues/7', body: { state_event: 'close' } }. " +
          "Approval tier — the run suspends until approve(). Returns the raw JSON.",
        argSchema: compose(
          rejectUnknown(),
          oneOf("method", ["POST", "PUT", "DELETE"]),
          str("path"),
          checkGitlabPath,
          checkQueryObject,
          checkBodyObject,
        ),
      },
      {
        name: "gitlab.projects.create",
        tier: "approval",
        doc:
          "Create a project. args: { name, path?, description?, visibility?, namespaceId?, initializeWithReadme? }. " +
          "Returns a project summary.",
        argSchema: compose(
          rejectUnknown(),
          str("name"),
          optStr("path", 255),
          optStr("description", 100000),
          oneOf("visibility", ["private", "internal", "public"]),
          optNum("namespaceId"),
          optBool("initializeWithReadme"),
        ),
      },
      {
        name: "gitlab.repository.files.get",
        tier: "open",
        doc:
          "Get a file's metadata/content from the default branch. args: { projectId, filePath, ref? }",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
          str("filePath"),
          optStr("ref", 200),
        ),
      },
      {
        name: "gitlab.repository.tree.list",
        tier: "open",
        doc: "List repository tree. args: { projectId, path?, ref?, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
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
          idArg("projectId"),
          optStr("ref", 200),
          optNum("perPage"),
          optNum("page"),
        ),
      },
      {
        name: "gitlab.repository.branches.list",
        tier: "open",
        doc: "List branches. args: { projectId, search? }",
        argSchema: compose(rejectUnknown(), idArg("projectId"), optStr("search", 200)),
      },
      {
        name: "gitlab.issues.list",
        tier: "open",
        doc: "List issues of a project. args: { projectId, state?, search?, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
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
        argSchema: compose(rejectUnknown(), idArg("projectId"), num("issueIid")),
      },
      {
        name: "gitlab.issues.notes.list",
        tier: "open",
        doc:
          "List notes/comments on an issue. args: { projectId, issueIid: number, perPage?, page? }",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
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
          idArg("projectId"),
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
        argSchema: compose(rejectUnknown(), idArg("projectId"), num("mrIid")),
      },
      {
        name: "gitlab.mergeRequests.changes.get",
        tier: "open",
        doc: "Get MR diff/changes. args: { projectId, mrIid: number }",
        argSchema: compose(rejectUnknown(), idArg("projectId"), num("mrIid")),
      },
      {
        name: "gitlab.issues.create",
        tier: "approval",
        doc:
          "Create an issue. args: { projectId, title, description?, assignee_ids?: number[], due_date?: 'YYYY-MM-DD', labels?: string[], milestone_id? }. " +
          "Returns an issue summary.",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
          str("title"),
          optStr("description", 100000),
          optArr(
            "assignee_ids",
            (
              v,
            ) => (typeof v === "number" && v > 0
              ? null
              : `expected positive integer, got ${typeof v}`),
          ),
          optStr("due_date", 10),
          optArr(
            "labels",
            (
              v,
            ) => (typeof v === "string" && v.length > 0 && v.length <= 100
              ? null
              : "expected non-empty string"),
          ),
          optNum("milestone_id"),
          (a) => {
            const due = (a as { due_date?: unknown }).due_date;
            if (typeof due === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
              return "due_date: expected YYYY-MM-DD";
            }
            return null;
          },
        ),
      },
      {
        name: "gitlab.issues.update",
        tier: "approval",
        doc:
          "Update an issue. args: { projectId, issueIid, title?, description?, state?, assignee_ids?: number[], due_date?: 'YYYY-MM-DD', labels?: string[], milestone_id? }. " +
          "Returns an issue summary.",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
          num("issueIid"),
          optStr("title", 500),
          optStr("description", 100000),
          oneOf("state", ["opened", "closed"]),
          optArr(
            "assignee_ids",
            (
              v,
            ) => (typeof v === "number" && v > 0
              ? null
              : `expected positive integer, got ${typeof v}`),
          ),
          optStr("due_date", 10),
          optArr(
            "labels",
            (
              v,
            ) => (typeof v === "string" && v.length > 0 && v.length <= 100
              ? null
              : "expected non-empty string"),
          ),
          optNum("milestone_id"),
          (a) => {
            const due = (a as { due_date?: unknown }).due_date;
            if (typeof due === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
              return "due_date: expected YYYY-MM-DD";
            }
            return null;
          },
        ),
      },
      {
        name: "gitlab.issues.notes.create",
        tier: "approval",
        doc: "Comment on an issue. args: { projectId, issueIid, body }",
        argSchema: compose(rejectUnknown(), idArg("projectId"), num("issueIid"), str("body")),
      },
      {
        name: "gitlab.mergeRequests.create",
        tier: "approval",
        doc:
          "Create a merge request. args: { projectId, sourceBranch, targetBranch, title, description? }",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
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
        argSchema: compose(rejectUnknown(), idArg("projectId"), num("mrIid"), str("body")),
      },
      {
        name: "gitlab.repository.files.create",
        tier: "approval",
        doc:
          "Create or update a file via a single commit. args: { projectId, filePath, branch, content, commitMessage }",
        argSchema: compose(
          rejectUnknown(),
          idArg("projectId"),
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
        name: "gitlab.users.get",
        tier: "open",
        doc:
          "Look up one user by exact username (use this for assignee_ids: users.search is fuzzy and can return near-matches). args: { username }. Returns a user summary or null.",
        argSchema: compose(rejectUnknown(), str("username")),
      },
      {
        name: "gitlab.users.search",
        tier: "open",
        doc: "Fuzzy user search by name/username (substring match, so it returns near-matches). " +
          "For assignment prefer gitlab.users.get({ username }) which is exact. args: { search, perPage?, page? }. Returns user summaries.",
        argSchema: compose(
          rejectUnknown(),
          str("search"),
          optNum("perPage"),
          optNum("page"),
        ),
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
        "get": (a) => {
          const r = a as { path: string; query?: Record<string, unknown>; fields?: unknown };
          return client.request("GET", r.path, { query: r.query });
        },
        "mutate": (a) => {
          const r = a as {
            method: "POST" | "PUT" | "DELETE";
            path: string;
            query?: Record<string, unknown>;
            body?: JsonValue;
          };
          return client.request(r.method, r.path, { query: r.query, body: r.body });
        },
        "projects.create": (a) => {
          const r = a as {
            name: string;
            path?: string;
            description?: string;
            visibility?: string;
            namespaceId?: number;
            initializeWithReadme?: boolean;
          };
          return client.post("/projects", {
            name: r.name,
            ...(r.path ? { path: r.path } : {}),
            ...(r.description ? { description: r.description } : {}),
            ...(r.visibility ? { visibility: r.visibility } : {}),
            ...(r.namespaceId !== undefined ? { namespace_id: r.namespaceId } : {}),
            ...(r.initializeWithReadme !== undefined
              ? { initialize_with_readme: r.initializeWithReadme }
              : {}),
          });
        },
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
          const r = a as { projectId: string | number; state?: string };
          return client.get(
            `/projects/${enc(String(r.projectId))}/issues`,
            {
              ...pick(a, ["search", "perPage", "page"]),
              // GitLab returns every state when `state` is omitted; an agent almost
              // always wants the open ones first, and "all" is available explicitly.
              state: String(r.state ?? "opened"),
            },
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
          const r = a as {
            projectId: string;
            title: string;
            description?: string;
            assignee_ids?: number[];
            due_date?: string;
            labels?: string[];
            milestone_id?: number;
          };
          return client.post(`/projects/${enc(r.projectId)}/issues`, {
            title: r.title,
            ...issueWriteFields(r),
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
            {
              ...pick(a, ["title", "description", "state"]),
              ...issueWriteFields(a as Record<string, unknown>),
            } as JsonValue,
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
        "users.search": (a) => client.get("/users", pick(a, ["search", "perPage", "page"])),
        "users.get": async (a) => {
          const users = await client.get("/users", {
            username: String((a as { username: string }).username),
          });
          return Array.isArray(users) ? (users[0] ?? null) : users;
        },
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
      doc: GITLAB_SHAPE[short] && !op.doc.includes("Returns") ? op.doc + SHAPE_HINT : op.doc,
    };
  });
  return conn;
}

// Default projections: upstream GitLab objects are ~4KB each, which is context
// abuse for an LLM caller. Callers override with `fields: ["a", "b.c"]` or ask
// for the raw object with `full: true`.
// List ops return arrays of summaries, get ops a single summary; saying which
// saves the caller an introspection round trip.
const SHAPE_HINT_LIST =
  ' Returns an array of summary objects; pass fields: ["..."] or full: true for the raw GitLab objects.';
const SHAPE_HINT_GET =
  ' Returns a summary object; pass fields: ["..."] or full: true for the raw GitLab object.';

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
  "projects.create": PROJECT_FIELDS,
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
  "users.search": ["id", "username", "name", "state", "web_url"],
  "users.get": ["id", "username", "name", "state", "web_url"],
};

// Paths are relative to the pinned API root: no scheme, no host, no traversal.
// Reads that would dump credentials are refused — use a curated op if one exists.
const READ_DENY =
  /\/(variables|access_tokens|deploy_tokens|secure_files|identities|personal_access_tokens)(\/|$)/;

function checkGitlabPath(args: unknown): string | null {
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string") return "path: expected string";
  if (!path.startsWith("/")) return "path: must start with '/' (relative to the API root)";
  if (path.length > 1000) return "path: too long (max 1000 chars)";
  if (path.includes("//") || path.includes("..") || /[\s\\?#]/.test(path)) {
    return "path: must not contain '//', '..', whitespace, backslashes, '?' or '#' (use query)";
  }
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*$/.test(path)) {
    return "path: contains unsupported characters";
  }
  return null;
}

// Reads of credential-bearing endpoints are refused: they would pull secrets into
// the model's context. Writes still go through gitlab.mutate, where the approval
// summary shows the path to a human before anything is executed.
function checkGitlabReadPath(args: unknown): string | null {
  const err = checkGitlabPath(args);
  if (err) return err;
  const path = (args as { path: string }).path;
  if (READ_DENY.test(path)) {
    return `path: ${path} exposes credentials; read it outside the agent if truly needed`;
  }
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

function checkBodyObject(args: unknown): string | null {
  const body = (args as { body?: unknown }).body;
  if (body === undefined) return null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body: expected object";
  return null;
}

// issueWriteFields passes the optional issue attributes through unchanged, so
// assignment/metadata is not silently dropped by the op surface.
function issueWriteFields(a: {
  description?: string;
  assignee_ids?: number[];
  due_date?: string;
  labels?: string[];
  milestone_id?: number;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (a.description) out.description = a.description;
  if (a.assignee_ids && a.assignee_ids.length > 0) out.assignee_ids = a.assignee_ids;
  if (a.due_date) out.due_date = a.due_date;
  if (a.labels && a.labels.length > 0) out.labels = a.labels.join(",");
  if (a.milestone_id !== undefined) out.milestone_id = a.milestone_id;
  return out;
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
