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
  type ProjectSummary,
  type PullQuery,
  type PullSummary,
  type PullWrite,
  type QueryObject,
  type RepoRef,
  repoRefString,
  type TreeEntry,
  type UserSummary,
} from "../port.ts";

// GitHub adapter. The third flavor is not "gitlab with different paths": what follows is
// the list of things that are structurally different, each handled below.
//  - pagination is a cursor in a `Link` header, so `nextPage` comes from the header, not
//    from "this page was short" (a full page is followed by another page even if the last
//    item is the last item).
//  - there is no raw path: file bytes come back only with `Accept: application/vnd.github.raw`.
//  - search is a different endpoint per resource, with its own envelope
//    ({total_count, items}) and its own, much smaller rate limit.
//  - issues and pulls share one number space, and `GET /issues` returns PRs too.
//  - `state=merged` does not exist: merged PRs are `closed` with `merged_at` set.
//  - 403 means both "insufficient scope" and "rate limited"; the headers disambiguate.

const enc = (s: string): string => encodeURIComponent(s);
const repoPath = (ref: RepoRef): string => `/repos/${enc(ref.owner)}/${enc(ref.name)}`;

/** GitHub's per-file cap in the changed-files listing is 3000; stop far earlier. */
const MAX_CHANGED_FILES = 300;

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function strOrNum(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

function stateOf(raw: unknown): "open" | "closed" | "merged" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "closed") return "closed";
  if (s === "merged") return "merged";
  return "open";
}

/** `state=merged` has no upstream filter: merged pulls are closed. */
function pullStateParam(state: PullQuery["state"]): string {
  if (state === "open") return "open";
  if (state === "all" || state === undefined) return "all";
  return "closed";
}

/** Page number from a `Link: <...page=3>; rel="next"` header, or null. */
export function nextPageFromLink(link: string | null): number | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const m = /[?&]page=(\d+)/.exec(part);
    if (m) return Number(m[1]);
  }
  return null;
}

function pageOf<T>(items: T[], pageNo: number, nextPage: number | null): Page<T> {
  return { items, page: pageNo, nextPage };
}

export function normalizeProject(raw: Record<string, unknown>): ProjectSummary {
  const owner = obj(raw.owner);
  const fullName = str(raw.full_name) ?? str(raw.name) ?? "";
  return {
    id: strOrNum(raw.id) || fullName,
    fullName,
    owner: str(owner.login) ?? fullName.split("/")[0] ?? "",
    name: str(raw.name) ?? fullName.split("/").pop() ?? "",
    defaultBranch: str(raw.default_branch),
    visibility: raw.private === true ? "private" : "public",
    archived: raw.archived === true,
    url: str(raw.html_url),
    updatedAt: str(raw.updated_at) ?? str(raw.pushed_at),
  };
}

export function normalizeIssue(raw: Record<string, unknown>): IssueSummary {
  const user = obj(raw.user);
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((l) => String(obj(l).name ?? l)).filter((l) => l !== "")
    : [];
  return {
    number: num(raw.number) ?? 0,
    title: str(raw.title) ?? "",
    state: stateOf(raw.state),
    author: str(user.login),
    labels,
    url: str(raw.html_url),
    updatedAt: str(raw.updated_at),
  };
}

export function normalizeNote(raw: Record<string, unknown>): NoteSummary {
  const user = obj(raw.user);
  return {
    id: strOrNum(raw.id),
    author: str(user.login),
    createdAt: str(raw.created_at),
    body: str(raw.body) ?? "",
  };
}

export function normalizePull(raw: Record<string, unknown>): PullSummary {
  const user = obj(raw.user);
  const head = obj(raw.head);
  const base = obj(raw.base);
  const mergedAt = str(raw.merged_at);
  return {
    number: num(raw.number) ?? 0,
    title: str(raw.title) ?? "",
    state: mergedAt !== null ? "merged" : stateOf(raw.state),
    sourceBranch: str(head.ref),
    targetBranch: str(base.ref),
    author: str(user.login),
    draft: raw.draft === true,
    merged: mergedAt !== null || raw.merged === true,
    url: str(raw.html_url),
    updatedAt: str(raw.updated_at),
  };
}

export function normalizeCommit(raw: Record<string, unknown>): CommitSummary {
  const commit = obj(raw.commit);
  const author = obj(commit.author);
  const sha = str(raw.sha) ?? "";
  return {
    id: sha,
    shortId: sha.length >= 7 ? sha.slice(0, 7) : null,
    title: (str(commit.message) ?? "").split("\n")[0],
    authorName: str(author.name),
    authoredAt: str(author.date),
  };
}

function normalizeUser(raw: Record<string, unknown>): UserSummary {
  return {
    id: strOrNum(raw.id),
    username: str(raw.login) ?? "",
    name: str(raw.name),
    url: str(raw.html_url),
  };
}

/** GitHub wants base64; btoa alone mangles non-ASCII, so encode through UTF-8 bytes. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function githubPort(http: ForgeHttp): ForgePort {
  return {
    flavor: "github",

    async listProjects(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      if (q.search) {
        // Search has its own envelope, its own relevance ordering and its own rate limit.
        const { body, headers } = await http.getMeta("/search/repositories", {
          q: q.search,
          per_page: limit,
          page: pageNo,
        });
        const items = Array.isArray(obj(body).items)
          ? (obj(body).items as JsonValue[]).map((r) => normalizeProject(obj(r)))
          : [];
        return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
      }
      const { body, headers } = await http.getMeta("/user/repos", {
        per_page: limit,
        page: pageNo,
        sort: "updated",
      });
      const items = Array.isArray(body) ? body.map((r) => normalizeProject(obj(r))) : [];
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
    },

    async getProject(ref: RepoRef) {
      return normalizeProject(obj(await http.get(repoPath(ref))));
    },

    async listIssues(ref: RepoRef, q: IssueQuery) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      const { body, headers } = await http.getMeta(`${repoPath(ref)}/issues`, {
        state: q.state === "all" || q.state === undefined
          ? "all"
          : q.state === "open"
          ? "open"
          : "closed",
        per_page: limit,
        page: pageNo,
      });
      const rows = Array.isArray(body) ? body : [];
      // PRs live in the issue list upstream and carry `pull_request`; drop them here so
      // `issues.list` means issues on every flavor.
      const items = rows
        .map((r) => obj(r))
        .filter((r) => r.pull_request === null || r.pull_request === undefined)
        .map((r) => normalizeIssue(r));
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
    },

    async getIssue(ref: RepoRef, n: number) {
      const raw = obj(await http.get(`${repoPath(ref)}/issues/${n}`));
      if (raw.pull_request !== null && raw.pull_request !== undefined) {
        throw new Error(`#${n} in ${repoRefString(ref)} is a pull request; use forge.pulls.get`);
      }
      return normalizeIssue(raw);
    },

    async createIssue(ref: RepoRef, w: IssueWrite) {
      const body: Record<string, JsonValue> = { title: w.title };
      if (w.body) body.body = w.body;
      if (w.labels && w.labels.length > 0) body.labels = w.labels;
      return normalizeIssue(obj(await http.post(`${repoPath(ref)}/issues`, body)));
    },

    async updateIssue(ref: RepoRef, n: number, p: IssuePatch) {
      const body: Record<string, JsonValue> = {};
      if (p.title !== undefined) body.title = p.title;
      if (p.body !== undefined) body.body = p.body;
      if (p.state !== undefined) body.state = p.state;
      if (p.labels !== undefined) body.labels = p.labels;
      return normalizeIssue(obj(await http.patch(`${repoPath(ref)}/issues/${n}`, body)));
    },

    async listNotes(ref: RepoRef, n: number, q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      const { body, headers } = await http.getMeta(`${repoPath(ref)}/issues/${n}/comments`, {
        per_page: limit,
        page: pageNo,
      });
      const items = Array.isArray(body) ? body.map((c) => normalizeNote(obj(c))) : [];
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
    },

    // PR comments are issue comments on GitHub (same number space).
    async createNote(ref: RepoRef, n: number, body: string) {
      return normalizeNote(obj(await http.post(`${repoPath(ref)}/issues/${n}/comments`, { body })));
    },

    async createPullNote(ref: RepoRef, n: number, body: string) {
      return normalizeNote(obj(await http.post(`${repoPath(ref)}/issues/${n}/comments`, { body })));
    },

    async listPulls(ref: RepoRef, q: PullQuery) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      const { body, headers } = await http.getMeta(`${repoPath(ref)}/pulls`, {
        state: pullStateParam(q.state),
        per_page: limit,
        page: pageNo,
      });
      let items = Array.isArray(body) ? body.map((p) => normalizePull(obj(p))) : [];
      if (q.state === "merged") items = items.filter((p) => p.merged);
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
    },

    async getPull(ref: RepoRef, n: number) {
      return normalizePull(obj(await http.get(`${repoPath(ref)}/pulls/${n}`)));
    },

    async getChanges(ref: RepoRef, n: number): Promise<ChangeSet> {
      const limit = Math.min(http.clampLimit(100), MAX_CHANGED_FILES);
      const files: ChangedFile[] = [];
      let pageNo = 1;
      let truncated = false;
      for (;;) {
        const { body, headers } = await http.getMeta(`${repoPath(ref)}/pulls/${n}/files`, {
          per_page: limit,
          page: pageNo,
        });
        const rows = Array.isArray(body) ? body.map((f) => obj(f)) : [];
        for (const row of rows) {
          if (files.length >= MAX_CHANGED_FILES) {
            truncated = true;
            break;
          }
          files.push({
            path: str(row.filename) ?? "",
            status: str(row.status),
            additions: num(row.additions),
            deletions: num(row.deletions),
            patch: str(row.patch),
          });
        }
        const next = nextPageFromLink(headers.get("link"));
        if (next === null || truncated) break;
        pageNo = next;
      }
      return { files, truncated };
    },

    async createPull(ref: RepoRef, w: PullWrite) {
      const body: Record<string, JsonValue> = {
        title: w.title,
        head: w.sourceBranch,
        base: w.targetBranch,
      };
      if (w.body) body.body = w.body;
      return normalizePull(obj(await http.post(`${repoPath(ref)}/pulls`, body)));
    },

    async mergePull(ref: RepoRef, n: number, message?: string) {
      const body: Record<string, JsonValue> = { merge_method: "merge" };
      if (message) body.commit_title = message;
      // 200 {merged:true,message} on success, 405/409 otherwise — then read the PR back
      // so the caller gets the same normalized shape as every other flavor.
      await http.put(`${repoPath(ref)}/pulls/${n}/merge`, body);
      return normalizePull(obj(await http.get(`${repoPath(ref)}/pulls/${n}`)));
    },

    async listBranches(ref: RepoRef, q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      const { body, headers } = await http.getMeta(`${repoPath(ref)}/branches`, {
        per_page: limit,
        page: pageNo,
      });
      const items: BranchSummary[] = (Array.isArray(body) ? body : []).map((b) => {
        const br = obj(b);
        const commit = obj(br.commit);
        return {
          name: str(br.name) ?? "",
          default: false, // resolved below: GitHub does not flag it on the row
          protected: br.protected === true,
          commitId: str(commit.sha),
        };
      });
      if (items.length > 0) {
        try {
          const repo = obj(await http.get(repoPath(ref)));
          const def = str(repo.default_branch);
          if (def) for (const b of items) b.default = b.name === def;
        } catch {
          // listing must not fail on a detail read
        }
      }
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
    },

    async listCommits(ref: RepoRef, q: ListQuery & { ref?: string }) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      const { body, headers } = await http.getMeta(`${repoPath(ref)}/commits`, {
        per_page: limit,
        page: pageNo,
        ...(q.ref ? { sha: q.ref } : {}),
      });
      const items = Array.isArray(body) ? body.map((c) => normalizeCommit(obj(c))) : [];
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
    },

    async listTree(ref: RepoRef, q: ListQuery & { ref?: string; path?: string }) {
      const limit = http.clampLimit(q.limit);
      const path = (q.path ?? "").replace(/^\/+/, "");
      const body = await http.get(`${repoPath(ref)}/contents/${path}`, {
        ...(q.ref ? { ref: q.ref } : {}),
      });
      const rows = Array.isArray(body) ? body.map((e) => obj(e)) : [];
      const items: TreeEntry[] = rows.slice(0, limit).map((row) => {
        const kind = str(row.type);
        return {
          path: str(row.path) ?? str(row.name) ?? "",
          name: str(row.name) ?? "",
          type: kind === "dir" ? "dir" : kind === "submodule" ? "submodule" : kind === "symlink" ? "symlink" : "file",
          size: num(row.size),
        };
      });
      return pageOf(items, q.page ?? 1, rows.length > limit ? (q.page ?? 1) + 1 : null);
    },

    async getFile(ref: RepoRef, q: { path: string; ref?: string }): Promise<FileContent> {
      const path = q.path.replace(/^\/+/, "");
      // Raw bytes need the raw media type; the JSON form would be base64 with inflation.
      const { text, bytes } = await http.getText(
        `${repoPath(ref)}/contents/${path}`,
        { ...(q.ref ? { ref: q.ref } : {}) },
        "application/vnd.github.raw",
      );
      const overCap = bytes > MAX_TEXT_BYTES;
      const head = new TextEncoder().encode(text.slice(0, 8192));
      const binary = head.includes(0);
      return {
        path,
        ref: q.ref ?? null,
        sha: null,
        size: bytes,
        text: binary ? null : overCap ? text.slice(0, MAX_TEXT_BYTES) : text,
        truncated: overCap,
        binary,
      };
    },

    async writeFile(ref: RepoRef, w: FileWrite) {
      const path = w.path.replace(/^\/+/, "");
      // Update needs the current blob sha; create must NOT send one.
      let sha: string | null = null;
      try {
        const current = await http.get(`${repoPath(ref)}/contents/${path}`, { ref: w.branch });
        sha = str(obj(current).sha);
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
      const body: Record<string, JsonValue> = {
        message: w.message,
        content: toBase64(w.content),
        branch: w.branch,
      };
      if (sha !== null) body.sha = sha;
      const res = obj(await http.put(`${repoPath(ref)}/contents/${path}`, body));
      return { path: w.path, branch: w.branch, sha: str(obj(res.content).sha) };
    },

    async searchUsers(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      const { body, headers } = await http.getMeta("/search/users", {
        q: q.search ?? "",
        per_page: limit,
        page: pageNo,
      });
      const items = Array.isArray(obj(body).items)
        ? (obj(body).items as JsonValue[]).map((u) => normalizeUser(obj(u)))
        : [];
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
    },

    async getUser(username: string) {
      try {
        return normalizeUser(obj(await http.get(`/users/${enc(username)}`)));
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },

    async currentUser() {
      return normalizeUser(obj(await http.get("/user")));
    },

    async listOrgs(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const pageNo = q.page ?? 1;
      const { body, headers } = await http.getMeta("/user/orgs", { per_page: limit, page: pageNo });
      const items: OrgSummary[] = (Array.isArray(body) ? body : []).map((o) => {
        const org = obj(o);
        return {
          id: strOrNum(org.id),
          name: str(org.login) ?? "",
          path: str(org.login) ?? "",
          url: str(org.html_url),
        };
      });
      return pageOf(items, pageNo, nextPageFromLink(headers.get("link")));
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
