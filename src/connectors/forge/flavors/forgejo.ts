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
  type RepoRef,
  repoRefString,
  type TreeEntry,
  type UserSummary,
} from "../port.ts";

// Forgejo adapter (git.ins-amu.fr, 16.0.4 / gitea-1.22). Everything marked "verified" was
// probed against the live instance rather than read off the docs, because the docs are
// silent or wrong about most of it:
//  - search endpoints wrap results in {ok, data}; everything else returns bare objects.
//  - PATCH answers **201**, not 200; POST .../pulls/{n}/merge answers **200 with an empty
//    body**, so the merged PR has to be re-read.
//  - issue comments accept only `since`/`before` — no page/limit — so the adapter slices.
//  - a file update needs the current blob `sha` (422 "[SHA]: Required" without it), and
//    /contents returns base64 (1.33x inflation) while /raw returns the exact bytes.
//  - PRs share the issue number space: /issues?type=issues excludes them, and /issues/N
//    returns a PR with a `pull_request` object.
//  - `q` in /repos/search matches repo names, not owners, so "owner/name" finds nothing.

const enc = (s: string): string => encodeURIComponent(s);
const repoPath = (ref: RepoRef): string => `/repos/${enc(ref.owner)}/${enc(ref.name)}`;

/** Forgejo wraps search results: {"ok": true, "data": [...]}. */
export function unwrapData(raw: JsonValue): JsonValue[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)) {
    return (raw as { data: JsonValue[] }).data;
  }
  return [];
}

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

function page<T>(items: T[], pageNo: number, limit: number): Page<T> {
  return { items, page: pageNo, nextPage: items.length >= limit ? pageNo + 1 : null };
}

function stateOf(raw: unknown): "open" | "closed" | "merged" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "closed") return "closed";
  if (s === "merged") return "merged";
  return "open";
}

/** Forgejo has no "merged" filter: merged PRs are closed, so the flag comes from the row. */
function pullStateParam(state: IssueQuery["state"] | PullQuery["state"]): string {
  if (state === "open") return "open";
  if (state === "all" || state === undefined) return "all";
  return "closed";
}

export function normalizeProject(raw: Record<string, unknown>): ProjectSummary {
  const fullName = str(raw.full_name) ?? str(raw.name) ?? "";
  const owner = obj(raw.owner);
  return {
    id: strOrNum(raw.id) || fullName,
    fullName,
    owner: str(owner.login) ?? str(owner.username) ?? fullName.split("/")[0] ?? "",
    name: str(raw.name) ?? fullName.split("/").pop() ?? "",
    defaultBranch: str(raw.default_branch),
    visibility: raw.private === true ? "private" : "public",
    archived: raw.archived === true,
    url: str(raw.html_url),
    updatedAt: str(raw.updated_at),
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
    author: str(user.login) ?? str(user.username),
    labels,
    url: str(raw.html_url),
    updatedAt: str(raw.updated_at),
  };
}

export function normalizeNote(raw: Record<string, unknown>): NoteSummary {
  const user = obj(raw.user);
  return {
    id: strOrNum(raw.id),
    author: str(user.login) ?? str(user.username),
    createdAt: str(raw.created_at),
    body: str(raw.body) ?? "",
  };
}

/**
 * Forgejo is inconsistent about a PR's head: the list endpoint puts the branch in
 * `head.ref`, the detail endpoint puts `refs/pull/<n>/head` there and the branch in
 * `head.label` (found by diffing the two captured payloads). Prefer a real ref, fall back
 * to the label, never return the synthetic one.
 */
export function branchOf(side: Record<string, unknown>): string | null {
  const ref = str(side.ref);
  if (ref !== null && !ref.startsWith("refs/")) return ref;
  return str(side.label);
}

export function normalizePull(raw: Record<string, unknown>): PullSummary {
  const user = obj(raw.user);
  const head = obj(raw.head);
  const base = obj(raw.base);
  const mergedAt = str(raw.merged_at);
  const state = mergedAt ? "merged" : stateOf(raw.state);
  return {
    number: num(raw.number) ?? 0,
    title: str(raw.title) ?? "",
    state,
    sourceBranch: branchOf(head),
    targetBranch: branchOf(base),
    author: str(user.login) ?? str(user.username),
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
    username: str(raw.login) ?? str(raw.username) ?? "",
    name: str(raw.full_name),
    url: str(raw.html_url),
  };
}

/** UTF-8 safe base64: btoa alone mangles non-ASCII content. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Split a unified diff into per-file patches, keyed by the post-image path. */
export function splitDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = diff.split("\n");
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) out.set(current, buf.join("\n"));
    buf = [];
  };
  for (const line of lines) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      flush();
      current = m[2];
      buf.push(line);
      continue;
    }
    if (current !== null) buf.push(line);
  }
  flush();
  return out;
}

export function forgejoPort(http: ForgeHttp): ForgePort {
  /** Resolve label names to Forgejo's label ids (its API takes ids, not names). */
  const labelIds = async (ref: RepoRef, names: string[]): Promise<number[]> => {
    if (names.length === 0) return [];
    const raw = await http.get(`${repoPath(ref)}/labels`, { limit: 50 });
    const rows = unwrapData(raw).map((l) => obj(l));
    const byName = new Map<string, number>();
    for (const row of rows) {
      const name = str(row.name);
      const id = num(row.id);
      if (name !== null && id !== null) byName.set(name.toLowerCase(), id);
    }
    const ids: number[] = [];
    const missing: string[] = [];
    for (const name of names) {
      const id = byName.get(name.toLowerCase());
      if (id === undefined) missing.push(name);
      else ids.push(id);
    }
    if (missing.length > 0) {
      throw new Error(
        `unknown label(s) on ${repoRefString(ref)}: ${missing.join(", ")}; known: ${
          [...byName.keys()].sort().join(", ") || "(none)"
        }`,
      );
    }
    return ids;
  };

  return {
    flavor: "forgejo",

    async listProjects(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = await http.get("/repos/search", {
        page: q.page ?? 1,
        limit,
        ...(q.search ? { q: q.search } : {}),
      });
      const items = unwrapData(raw).map((r) => normalizeProject(obj(r)));
      return page(items, q.page ?? 1, limit);
    },

    async getProject(ref: RepoRef) {
      return normalizeProject(obj(await http.get(repoPath(ref))));
    },

    async listIssues(ref: RepoRef, q: IssueQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = await http.get(`${repoPath(ref)}/issues`, {
        state: pullStateParam(q.state),
        type: "issues",
        page: q.page ?? 1,
        limit,
        ...(q.search ? { q: q.search } : {}),
      });
      const items = unwrapData(raw).map((r) => normalizeIssue(obj(r)));
      return page(items, q.page ?? 1, limit);
    },

    async getIssue(ref: RepoRef, n: number) {
      const raw = obj(await http.get(`${repoPath(ref)}/issues/${n}`));
      // Forgejo returns a PR from the issue endpoint; say so instead of returning a
      // normalized issue that the caller will misread.
      if (raw.pull_request !== null && raw.pull_request !== undefined) {
        throw new Error(`#${n} in ${repoRefString(ref)} is a pull request; use forge.pulls.get`);
      }
      return normalizeIssue(raw);
    },

    async createIssue(ref: RepoRef, w: IssueWrite) {
      const body: Record<string, JsonValue> = { title: w.title };
      if (w.body) body.body = w.body;
      if (w.labels && w.labels.length > 0) body.labels = await labelIds(ref, w.labels);
      return normalizeIssue(obj(await http.post(`${repoPath(ref)}/issues`, body)));
    },

    async updateIssue(ref: RepoRef, n: number, p: IssuePatch) {
      const body: Record<string, JsonValue> = {};
      if (p.title !== undefined) body.title = p.title;
      if (p.body !== undefined) body.body = p.body;
      if (p.state !== undefined) body.state = p.state;
      if (p.labels !== undefined) body.labels = await labelIds(ref, p.labels);
      return normalizeIssue(obj(await http.patch(`${repoPath(ref)}/issues/${n}`, body)));
    },

    async listNotes(ref: RepoRef, n: number, q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      // No page/limit upstream (verified): ask for the whole thread, then slice. `since`
      // is the only server-side filter, and reading it back is not worth a second hop.
      const raw = await http.get(`${repoPath(ref)}/issues/${n}/comments`);
      const all = unwrapData(raw).map((c) => normalizeNote(obj(c)));
      const start = ((q.page ?? 1) - 1) * limit;
      const items = all.slice(start, start + limit);
      return {
        items,
        page: q.page ?? 1,
        nextPage: start + limit < all.length ? (q.page ?? 1) + 1 : null,
      };
    },

    async createNote(ref: RepoRef, n: number, body: string) {
      return normalizeNote(obj(await http.post(`${repoPath(ref)}/issues/${n}/comments`, { body })));
    },

    // PRs share the issue number space here, so this is the same endpoint.
    async createPullNote(ref: RepoRef, n: number, body: string) {
      return normalizeNote(obj(await http.post(`${repoPath(ref)}/issues/${n}/comments`, { body })));
    },

    async listPulls(ref: RepoRef, q: PullQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = await http.get(`${repoPath(ref)}/pulls`, {
        state: pullStateParam(q.state),
        page: q.page ?? 1,
        limit,
      });
      let items = unwrapData(raw).map((r) => normalizePull(obj(r)));
      // state=merged has no upstream equivalent: closed PRs are filtered on the flag.
      if (q.state === "merged") items = items.filter((p) => p.merged);
      return page(items, q.page ?? 1, limit);
    },

    async getPull(ref: RepoRef, n: number) {
      return normalizePull(obj(await http.get(`${repoPath(ref)}/pulls/${n}`)));
    },

    async getChanges(ref: RepoRef, n: number): Promise<ChangeSet> {
      const raw = await http.get(`${repoPath(ref)}/pulls/${n}/files`);
      const rows = unwrapData(raw).map((f) => obj(f));
      let diff: Map<string, string> = new Map();
      let truncated = false;
      try {
        const text = (await http.raw(`${repoPath(ref)}/pulls/${n}.diff`)).text;
        if (text.length > MAX_TEXT_BYTES) {
          truncated = true;
          diff = splitDiff(text.slice(0, MAX_TEXT_BYTES));
        } else {
          diff = splitDiff(text);
        }
      } catch {
        // A missing .diff is not fatal: the file list still answers "what changed".
        truncated = true;
      }
      const files: ChangedFile[] = rows.map((row) => {
        const path = str(row.filename) ?? "";
        return {
          path,
          status: str(row.status),
          additions: num(row.additions),
          deletions: num(row.deletions),
          patch: diff.get(path) ?? null,
        };
      });
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
      const body: Record<string, JsonValue> = { Do: "merge" };
      if (message) body.MergeTitleField = message;
      // Verified: 200 with an EMPTY body, so the merged PR has to be read back.
      await http.post(`${repoPath(ref)}/pulls/${n}/merge`, body);
      return normalizePull(obj(await http.get(`${repoPath(ref)}/pulls/${n}`)));
    },

    async listBranches(ref: RepoRef, q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = await http.get(`${repoPath(ref)}/branches`, { page: q.page ?? 1, limit });
      const items: BranchSummary[] = unwrapData(raw).map((b) => {
        const br = obj(b);
        const commit = obj(br.commit);
        return {
          name: str(br.name) ?? "",
          default: false,
          protected: br.protected === true,
          commitId: str(commit.id),
        };
      });
      // Forgejo does not flag the default branch on the row; resolve it once from the repo.
      if (items.length > 0 && q.page === undefined) {
        try {
          const repo = obj(await http.get(repoPath(ref)));
          const def = str(repo.default_branch);
          if (def) { for (const b of items) b.default = b.name === def; }
        } catch {
          // a missing repo detail must not fail the listing
        }
      }
      return page(items, q.page ?? 1, limit);
    },

    async listCommits(ref: RepoRef, q: ListQuery & { ref?: string }) {
      const limit = http.clampLimit(q.limit);
      const raw = await http.get(`${repoPath(ref)}/commits`, {
        page: q.page ?? 1,
        limit,
        ...(q.ref ? { sha: q.ref } : {}),
      });
      const items = unwrapData(raw).map((c) => normalizeCommit(obj(c)));
      return page(items, q.page ?? 1, limit);
    },

    async listTree(ref: RepoRef, q: ListQuery & { ref?: string; path?: string }) {
      const limit = http.clampLimit(q.limit);
      const path = (q.path ?? "").replace(/^\/+/, "");
      const raw = await http.get(`${repoPath(ref)}/contents/${path}`, {
        ...(q.ref ? { ref: q.ref } : {}),
      });
      const rows = unwrapData(raw).map((e) => obj(e));
      // /contents has no pagination (verified); a directory listing is capped here.
      const items: TreeEntry[] = rows.slice(0, limit).map((row) => {
        const kind = str(row.type);
        return {
          path: str(row.path) ?? str(row.name) ?? "",
          name: str(row.name) ?? "",
          type: kind === "dir"
            ? "dir"
            : kind === "submodule"
            ? "submodule"
            : kind === "symlink"
            ? "symlink"
            : "file",
          size: num(row.size),
        };
      });
      const nextPage = rows.length > limit ? (q.page ?? 1) + 1 : null;
      return { items, page: q.page ?? 1, nextPage };
    },

    async getFile(ref: RepoRef, q: { path: string; ref?: string }): Promise<FileContent> {
      const path = q.path.replace(/^\/+/, "");
      // /raw returns the exact bytes (verified); /contents would be base64 with 1.33x
      // inflation, and the blob sha is only needed by writeFile, which fetches it itself.
      const { text, bytes } = await http.raw(`${repoPath(ref)}/raw/${path}`, {
        ...(q.ref ? { ref: q.ref } : {}),
      });
      const overCap = bytes > MAX_TEXT_BYTES;
      const head = new TextEncoder().encode(text.slice(0, 8192));
      const binary = head.includes(0);
      return {
        path,
        ref: q.ref ?? null,
        sha: null,
        size: bytes,
        text: binary || overCap ? (binary ? null : text.slice(0, MAX_TEXT_BYTES)) : text,
        truncated: overCap,
        binary,
      };
    },

    async writeFile(ref: RepoRef, w: FileWrite) {
      const path = w.path.replace(/^\/+/, "");
      const content = toBase64(w.content);
      // Create-vs-update is decided upstream: an update without the blob sha is refused
      // with 422 "[SHA]: Required" (verified), so read the current blob first.
      let sha: string | null = null;
      try {
        const current = await http.get(`${repoPath(ref)}/contents/${path}`, { ref: w.branch });
        sha = str(obj(current).sha);
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
      if (sha !== null) {
        await http.put(`${repoPath(ref)}/contents/${path}`, {
          content,
          message: w.message,
          branch: w.branch,
          sha,
        });
        return { path: w.path, branch: w.branch, sha };
      }
      try {
        await http.post(`${repoPath(ref)}/contents/${path}`, {
          content,
          message: w.message,
          branch: w.branch,
        });
      } catch (err) {
        const msg = String((err as Error).message ?? "");
        // A branch that does not exist yet is created by passing new_branch.
        if (!/branch|ref/i.test(msg)) throw err;
        await http.post(`${repoPath(ref)}/contents/${path}`, {
          content,
          message: w.message,
          branch: w.branch,
          new_branch: w.branch,
        });
      }
      return { path: w.path, branch: w.branch, sha: null };
    },

    async searchUsers(q: ListQuery) {
      const limit = http.clampLimit(q.limit);
      const raw = await http.get("/users/search", {
        page: q.page ?? 1,
        limit,
        ...(q.search ? { q: q.search } : {}),
      });
      const items = unwrapData(raw).map((u) => normalizeUser(obj(u)));
      return page(items, q.page ?? 1, limit);
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
      const raw = await http.get("/user/orgs", { page: q.page ?? 1, limit });
      const items: OrgSummary[] = unwrapData(raw).map((o) => {
        const org = obj(o);
        return {
          id: strOrNum(org.id),
          name: str(org.full_name) ?? str(org.username) ?? "",
          path: str(org.username) ?? "",
          url: str(org.website) ?? str(org.html_url),
        };
      });
      return page(items, q.page ?? 1, limit);
    },

    async apiGet(path: string, query?: Record<string, string | number | boolean>) {
      return await http.get(path, query);
    },

    // Startup check: the page cap this account was configured with must be the instance's,
    // otherwise a caller silently gets fewer items than it asked for.
    async validate() {
      const settings = obj(await http.get("/settings/api"));
      const serverMax = num(settings.max_response_items);
      if (serverMax !== null && serverMax !== http.clampLimit(serverMax)) {
        throw new Error(
          `forge account: maxLimit ${
            http.clampLimit(serverMax)
          } is below the instance's max_response_items ${serverMax}`,
        );
      }
    },
  };
}
