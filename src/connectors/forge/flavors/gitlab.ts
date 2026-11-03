import type { JsonValue } from "../../../harness/types.ts";
import { ForgeHttp } from "../client.ts";
import {
  type BranchSummary,
  type ChangedFile,
  type ChangeSet,
  type CommitSummary,
  type FileContent,
  type FileWrite,
  type ForgePort,
  type IssuePatch,
  type IssueQuery,
  type IssueSummary,
  type IssueWrite,
  type ListQuery,
  MAX_TEXT_BYTES,
  type NoteSummary,
  type OrgSummary,
  type Page,
  parseRepoRef,
  type ProjectSummary,
  type QueryObject,
  type PullQuery,
  type PullSummary,
  type PullWrite,
  type RepoRef,
  repoRefString,
  type TreeEntry,
  type UserSummary,
} from "../port.ts";

// GitLab adapter. Every mapping decision below is recorded because it is the half of
// the abstraction that cannot be inferred from the GitLab docs alone:
//  - issue/MR short ids are `iid` here but `number` elsewhere, and GitLab (unlike
//    GitHub/Forgejo) keeps separate sequences for issues and MRs, so a normalized
//    `number` is unambiguous per resource — which is why the port has separate
//    getIssue/getPull rather than one "get whatever #5 is".
//  - state is `opened`, not `open`, and updates use `state_event`, not `state`.
//  - a file update needs PUT (POST 400s when the path exists), so writeFile probes.
//  - MR changes are already in the `/changes` response (Forgejo needs `/files`).

const enc = (s: string): string => encodeURIComponent(s);
const projectPath = (ref: RepoRef): string => `/projects/${enc(repoRefString(ref))}`;

function page<T>(items: T[], pageNo: number, limit: number): Page<T> {
  return { items, page: pageNo, nextPage: items.length >= limit ? pageNo + 1 : null };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function strOrNum(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/** GitLab states: opened|closed|merged|locked. Normalized: open|closed|merged. */
export function normalizeState(raw: unknown): "open" | "closed" | "merged" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "closed") return "closed";
  if (s === "merged") return "merged";
  return "open"; // opened, locked, reopened
}

function issueStateParam(state: IssueQuery["state"] | PullQuery["state"]): string {
  if (state === "open") return "opened";
  if (state === undefined || state === "all") return "all";
  return state; // closed | merged
}

export function normalizeProject(raw: Record<string, unknown>): ProjectSummary {
  const fullName = str(raw.path_with_namespace) ?? str(raw.name) ?? "";
  const namespace = (raw.namespace ?? {}) as Record<string, unknown>;
  return {
    id: strOrNum(raw.id) || fullName,
    fullName,
    owner: str(namespace.full_path) ?? fullName.split("/").slice(0, -1).join("/"),
    name: str(raw.path) ?? str(raw.name) ?? fullName.split("/").pop() ?? "",
    defaultBranch: str(raw.default_branch),
    visibility: str(raw.visibility),
    archived: raw.archived === true,
    url: str(raw.web_url),
    updatedAt: str(raw.last_activity_at),
  };
}

export function normalizeIssue(raw: Record<string, unknown>): IssueSummary {
  const author = (raw.author ?? {}) as Record<string, unknown>;
  return {
    number: num(raw.iid) ?? num(raw.number) ?? 0,
    title: str(raw.title) ?? "",
    state: normalizeState(raw.state),
    author: str(author.username),
    labels: list(raw.labels),
    url: str(raw.web_url),
    updatedAt: str(raw.updated_at),
  };
}

export function normalizeNote(raw: Record<string, unknown>): NoteSummary {
  const author = (raw.author ?? {}) as Record<string, unknown>;
  return {
    id: strOrNum(raw.id),
    author: str(author.username),
    createdAt: str(raw.created_at),
    body: str(raw.body) ?? str(raw.note) ?? "",
  };
}

export function normalizePull(raw: Record<string, unknown>): PullSummary {
  const author = (raw.author ?? {}) as Record<string, unknown>;
  const state = normalizeState(raw.state);
  return {
    number: num(raw.iid) ?? num(raw.number) ?? 0,
    title: str(raw.title) ?? "",
    state,
    sourceBranch: str(raw.source_branch),
    targetBranch: str(raw.target_branch),
    author: str(author.username),
    draft: raw.draft === true || raw.work_in_progress === true,
    merged: state === "merged" || str(raw.merged_at) !== null,
    url: str(raw.web_url),
    updatedAt: str(raw.updated_at),
  };
}

export function normalizeCommit(raw: Record<string, unknown>): CommitSummary {
  return {
    id: str(raw.id) ?? str(raw.sha) ?? "",
    shortId: str(raw.short_id),
    title: str(raw.title) ?? str(raw.message) ?? "",
    authorName: str(raw.author_name),
    authoredAt: str(raw.authored_date) ?? str(raw.created),
  };
}

function normalizeUser(raw: Record<string, unknown>): UserSummary {
  return {
    id: strOrNum(raw.id),
    username: str(raw.username) ?? str(raw.login) ?? "",
    name: str(raw.name),
    url: str(raw.web_url),
  };
}

/** Decode GitLab's base64 file payload without pulling in a dependency. */
export function decodeFile(
  b64: string,
  size: number | null,
  sha: string | null,
  path: string,
  ref: string | null,
): FileContent {
  const cap = MAX_TEXT_BYTES;
  const overCap = size !== null && size > cap;
  let bytes: Uint8Array;
  try {
    const bin = atob(b64.replace(/\n/g, ""));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { path, ref, sha, size, text: null, truncated: false, binary: true };
  }
  const head = bytes.subarray(0, Math.min(8192, bytes.length));
  const binary = head.includes(0);
  if (binary) return { path, ref, sha, size, text: null, truncated: false, binary: true };
  const slice = overCap ? bytes.subarray(0, cap) : bytes;
  return {
    path,
    ref,
    sha,
    size,
    text: new TextDecoder().decode(slice),
    truncated: overCap,
    binary: false,
  };
}

export function gitlabPort(http: ForgeHttp): ForgePort {
  return {
    flavor: "gitlab",

    async listProjects(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get("/projects", {
        page: q.page ?? 1,
        per_page: limit,
        ...(q.search ? { search: q.search } : {}),
      })) as unknown;
      const items = Array.isArray(raw)
        ? raw.map((r) => normalizeProject(r as Record<string, unknown>))
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async getProject(ref: RepoRef) {
      return normalizeProject((await http.get(projectPath(ref))) as Record<string, unknown>);
    },

    async listIssues(ref: RepoRef, q: IssueQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get(`${projectPath(ref)}/issues`, {
        state: issueStateParam(q.state),
        page: q.page ?? 1,
        per_page: limit,
        ...(q.search ? { search: q.search } : {}),
      })) as unknown;
      const items = Array.isArray(raw)
        ? raw.map((r) => normalizeIssue(r as Record<string, unknown>))
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async getIssue(ref: RepoRef, n: number) {
      return normalizeIssue(
        (await http.get(`${projectPath(ref)}/issues/${n}`)) as Record<string, unknown>,
      );
    },

    async createIssue(ref: RepoRef, w: IssueWrite) {
      const body: Record<string, JsonValue> = { title: w.title };
      if (w.body) body.description = w.body;
      if (w.labels && w.labels.length > 0) body.labels = w.labels.join(",");
      return normalizeIssue(
        (await http.post(`${projectPath(ref)}/issues`, body)) as Record<string, unknown>,
      );
    },

    async updateIssue(ref: RepoRef, n: number, p: IssuePatch) {
      const body: Record<string, JsonValue> = {};
      if (p.title !== undefined) body.title = p.title;
      if (p.body !== undefined) body.description = p.body;
      if (p.labels !== undefined) body.labels = p.labels.join(",");
      // GitLab takes state_event ("close"/"reopen"), not the state itself.
      if (p.state === "closed") body.state_event = "close";
      if (p.state === "open") body.state_event = "reopen";
      return normalizeIssue(
        (await http.put(`${projectPath(ref)}/issues/${n}`, body)) as Record<string, unknown>,
      );
    },

    async listNotes(ref: RepoRef, n: number, q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get(`${projectPath(ref)}/issues/${n}/notes`, {
        page: q.page ?? 1,
        per_page: limit,
        sort: "asc",
      })) as unknown;
      const items = Array.isArray(raw)
        ? raw.map((r) => normalizeNote(r as Record<string, unknown>))
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async createNote(ref: RepoRef, n: number, bodyText: string) {
      return normalizeNote(
        (await http.post(`${projectPath(ref)}/issues/${n}/notes`, { body: bodyText })) as Record<
          string,
          unknown
        >,
      );
    },

    // GitLab keeps MR notes separate from issue notes; the shared index space the
    // other two flavors have does not apply here.
    async createPullNote(ref: RepoRef, n: number, bodyText: string) {
      return normalizeNote(
        (await http.post(`${projectPath(ref)}/merge_requests/${n}/notes`, {
          body: bodyText,
        })) as Record<
          string,
          unknown
        >,
      );
    },

    async listPulls(ref: RepoRef, q: PullQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get(`${projectPath(ref)}/merge_requests`, {
        state: issueStateParam(q.state),
        page: q.page ?? 1,
        per_page: limit,
        ...(q.search ? { search: q.search } : {}),
      })) as unknown;
      const items = Array.isArray(raw)
        ? raw.map((r) => normalizePull(r as Record<string, unknown>))
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async getPull(ref: RepoRef, n: number) {
      return normalizePull(
        (await http.get(`${projectPath(ref)}/merge_requests/${n}`)) as Record<string, unknown>,
      );
    },

    async getChanges(ref: RepoRef, n: number): Promise<ChangeSet> {
      const raw = (await http.get(`${projectPath(ref)}/merge_requests/${n}/changes`)) as Record<
        string,
        unknown
      >;
      const changes = Array.isArray(raw.changes) ? raw.changes : [];
      const files: ChangedFile[] = changes.map((c) => {
        const ch = c as Record<string, unknown>;
        const status = ch.new_file === true
          ? "added"
          : ch.deleted_file === true
          ? "deleted"
          : ch.renamed_file === true
          ? "renamed"
          : "modified";
        return {
          path: typeof ch.new_path === "string" ? ch.new_path : String(ch.old_path ?? ""),
          status,
          additions: null,
          deletions: null,
          patch: typeof ch.diff === "string" ? ch.diff : null,
        };
      });
      return { files, truncated: raw.overflow === true };
    },

    async createPull(ref: RepoRef, w: PullWrite) {
      const body: Record<string, JsonValue> = {
        source_branch: w.sourceBranch,
        target_branch: w.targetBranch,
        title: w.title,
      };
      if (w.body) body.description = w.body;
      return normalizePull(
        (await http.post(`${projectPath(ref)}/merge_requests`, body)) as Record<string, unknown>,
      );
    },

    async mergePull(ref: RepoRef, n: number, message?: string) {
      const body: Record<string, JsonValue> = {};
      if (message) body.merge_commit_message = message;
      return normalizePull(
        (await http.put(`${projectPath(ref)}/merge_requests/${n}/merge`, body)) as Record<
          string,
          unknown
        >,
      );
    },

    async listBranches(ref: RepoRef, q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get(`${projectPath(ref)}/repository/branches`, {
        page: q.page ?? 1,
        per_page: limit,
        ...(q.search ? { search: q.search } : {}),
      })) as unknown;
      const items: BranchSummary[] = Array.isArray(raw)
        ? raw.map((b) => {
          const br = b as Record<string, unknown>;
          const commit = (br.commit ?? {}) as Record<string, unknown>;
          return {
            name: str(br.name) ?? "",
            default: br.default === true,
            protected: br.protected === true,
            commitId: str(commit.short_id) ?? str(commit.id),
          };
        })
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async listCommits(ref: RepoRef, q: ListQuery & { ref?: string }) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get(`${projectPath(ref)}/repository/commits`, {
        page: q.page ?? 1,
        per_page: limit,
        ...(q.ref ? { ref_name: q.ref } : {}),
      })) as unknown;
      const items = Array.isArray(raw)
        ? raw.map((c) => normalizeCommit(c as Record<string, unknown>))
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async listTree(ref: RepoRef, q: ListQuery & { ref?: string; path?: string }) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get(`${projectPath(ref)}/repository/tree`, {
        page: q.page ?? 1,
        per_page: limit,
        ...(q.path ? { path: q.path } : {}),
        ...(q.ref ? { ref: q.ref } : {}),
      })) as unknown;
      const items: TreeEntry[] = Array.isArray(raw)
        ? raw.map((e) => {
          const en = e as Record<string, unknown>;
          const kind = str(en.type);
          return {
            path: str(en.path) ?? str(en.name) ?? "",
            name: str(en.name) ?? "",
            type: kind === "tree" ? "dir" : kind === "submodule" ? "submodule" : "file",
            size: num(en.size),
          };
        })
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async getFile(ref: RepoRef, q: { path: string; ref?: string }) {
      const raw = (await http.get(`${projectPath(ref)}/repository/files/${enc(q.path)}`, {
        ...(q.ref ? { ref: q.ref } : {}),
      })) as Record<string, unknown>;
      const b64 = typeof raw.content === "string" ? raw.content : "";
      const size = num(raw.size);
      const sha = str(raw.blob_id) ?? str(raw.last_commit_id);
      return decodeFile(
        b64,
        size,
        sha,
        str(raw.file_path) ?? q.path,
        str(raw.ref) ?? q.ref ?? null,
      );
    },

    async writeFile(ref: RepoRef, w: FileWrite) {
      const body: Record<string, JsonValue> = {
        branch: w.branch,
        content: w.content,
        commit_message: w.message,
        encoding: "text",
      };
      // Create vs update is not a guess: GitLab 400s a POST onto an existing path and
      // a PUT onto a missing one, so probe first and pick the verb accordingly.
      let exists = true;
      try {
        await http.get(`${projectPath(ref)}/repository/files/${enc(w.path)}`, { ref: w.branch });
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) exists = false;
        else throw err;
      }
      const res =
        (exists
          ? await http.put(`${projectPath(ref)}/repository/files/${enc(w.path)}`, body)
          : await http.post(`${projectPath(ref)}/repository/files/${enc(w.path)}`, body)) as Record<
            string,
            unknown
          >;
      return {
        path: w.path,
        branch: w.branch,
        sha: str(res.file_path) ? str(res.commit_id) : null,
      };
    },

    async searchUsers(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get("/users", {
        page: q.page ?? 1,
        per_page: limit,
        ...(q.search ? { search: q.search } : {}),
      })) as unknown;
      const items = Array.isArray(raw)
        ? raw.map((u) => normalizeUser(u as Record<string, unknown>))
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async getUser(username: string) {
      const raw = (await http.get("/users", { username })) as unknown;
      if (!Array.isArray(raw) || raw.length === 0) return null;
      return normalizeUser(raw[0] as Record<string, unknown>);
    },

    async currentUser() {
      return normalizeUser((await http.get("/user")) as Record<string, unknown>);
    },

    async listOrgs(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = (await http.get("/groups", {
        page: q.page ?? 1,
        per_page: limit,
        ...(q.search ? { search: q.search } : {}),
      })) as unknown;
      const items: OrgSummary[] = Array.isArray(raw)
        ? raw.map((g) => {
          const gr = g as Record<string, unknown>;
          return {
            id: strOrNum(gr.id),
            name: str(gr.name) ?? "",
            path: str(gr.full_path) ?? str(gr.path) ?? "",
            url: str(gr.web_url),
          };
        })
        : [];
      return page(items, q.page ?? 1, limit);
    },

    async apiGet(path: string, query?: QueryObject) {
      return await http.get(path, query);
    },

    async apiMutate(
      method: "POST" | "PUT" | "PATCH" | "DELETE",
      path: string,
      opts?: { query?: QueryObject; body?: JsonValue },
    ) {
      return await http.request(method, path, opts ?? {});
    },
  };
}

/** Exposed for tests: the adapter is built from an account, not a URL. */
export function parseRepo(raw: string): RepoRef {
  return parseRepoRef(raw);
}
