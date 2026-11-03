import type { JsonValue } from "../../harness/types.ts";

// The `forge` family exposes one flavor-neutral op surface over several code-hosting
// APIs. Everything below is the *normalized* vocabulary: curated `forge.*` ops speak
// it, and each flavor (gitlab/forgejo/github) translates to and from its own REST
// shapes. Raw upstream JSON is reachable only through `forge.api.get`, on purpose:
// a curated op that returned flavor-shaped objects would not be flavor-neutral, and
// callers that need the long tail already have an escape hatch.

export type ForgeFlavor = "gitlab" | "forgejo" | "github";

/** Where one account lives. Credentials are host-side and never in an op argument. */
export interface ForgeAccount {
  id: string;
  flavor: ForgeFlavor;
  origin: string;
  apiPath: string;
  token: string;
  /** Upper bound on page size for this flavor/instance (clamped, never trusted). */
  maxLimit: number;
}

/** `owner/name`; owner may itself contain slashes (GitLab subgroups, Forgejo orgs). */
export interface RepoRef {
  owner: string;
  name: string;
}

export type IssueState = "open" | "closed" | "merged";

export interface ProjectSummary {
  /** Upstream id as a string: GitLab int, Forgejo int, GitHub "owner/name". */
  id: string;
  fullName: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  visibility: string | null;
  archived: boolean;
  url: string | null;
  updatedAt: string | null;
}

export interface IssueSummary {
  number: number;
  title: string;
  state: IssueState;
  author: string | null;
  labels: string[];
  url: string | null;
  updatedAt: string | null;
}

export interface NoteSummary {
  id: string;
  author: string | null;
  createdAt: string | null;
  body: string;
}

export interface PullSummary {
  number: number;
  title: string;
  state: IssueState;
  sourceBranch: string | null;
  targetBranch: string | null;
  author: string | null;
  draft: boolean;
  merged: boolean;
  url: string | null;
  updatedAt: string | null;
}

export interface ChangedFile {
  path: string;
  status: string | null;
  additions: number | null;
  deletions: number | null;
  patch: string | null;
}

export interface ChangeSet {
  files: ChangedFile[];
  /** True when the flavor's response was cut (large diffs) or the file list capped. */
  truncated: boolean;
}

export interface BranchSummary {
  name: string;
  default: boolean;
  protected: boolean;
  commitId: string | null;
}

export interface CommitSummary {
  id: string;
  shortId: string | null;
  title: string;
  authorName: string | null;
  authoredAt: string | null;
}

export interface TreeEntry {
  path: string;
  name: string;
  type: "file" | "dir" | "submodule" | "symlink";
  size: number | null;
}

export interface FileContent {
  path: string;
  ref: string | null;
  sha: string | null;
  size: number | null;
  /** Decoded text, or null when the file is binary or over the read cap. */
  text: string | null;
  truncated: boolean;
  binary: boolean;
}

export interface UserSummary {
  id: string;
  username: string;
  name: string | null;
  url: string | null;
}

export interface OrgSummary {
  id: string;
  name: string;
  path: string;
  url: string | null;
}

export interface Page<T> {
  items: T[];
  page: number;
  /** Next page number, or null when this page was short (last page reached). */
  nextPage: number | null;
}

export interface ListQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export interface IssueQuery extends ListQuery {
  state?: "open" | "closed" | "all";
}

export interface IssueWrite {
  title: string;
  body?: string;
  labels?: string[];
}

export interface IssuePatch {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
}

export interface PullWrite {
  title: string;
  sourceBranch: string;
  targetBranch: string;
  body?: string;
}

export interface FileWrite {
  path: string;
  branch: string;
  content: string;
  message: string;
}

/** One adapter per flavor. Every method returns normalized values only. */
export interface ForgePort {
  readonly flavor: ForgeFlavor;
  listProjects(q: ListQuery): Promise<Page<ProjectSummary>>;
  getProject(ref: RepoRef): Promise<ProjectSummary>;
  listIssues(ref: RepoRef, q: IssueQuery): Promise<Page<IssueSummary>>;
  getIssue(ref: RepoRef, n: number): Promise<IssueSummary>;
  createIssue(ref: RepoRef, w: IssueWrite): Promise<IssueSummary>;
  updateIssue(ref: RepoRef, n: number, p: IssuePatch): Promise<IssueSummary>;
  listNotes(ref: RepoRef, n: number, q: ListQuery): Promise<Page<NoteSummary>>;
  createNote(ref: RepoRef, n: number, body: string): Promise<NoteSummary>;
  /** PR/MR comments are a separate resource on GitLab, an issue comment elsewhere. */
  createPullNote(ref: RepoRef, n: number, body: string): Promise<NoteSummary>;
  listPulls(ref: RepoRef, q: IssueQuery): Promise<Page<PullSummary>>;
  getPull(ref: RepoRef, n: number): Promise<PullSummary>;
  getChanges(ref: RepoRef, n: number): Promise<ChangeSet>;
  createPull(ref: RepoRef, w: PullWrite): Promise<PullSummary>;
  mergePull(ref: RepoRef, n: number, message?: string): Promise<PullSummary>;
  listBranches(ref: RepoRef, q: ListQuery): Promise<Page<BranchSummary>>;
  listCommits(ref: RepoRef, q: ListQuery & { ref?: string }): Promise<Page<CommitSummary>>;
  listTree(ref: RepoRef, q: ListQuery & { ref?: string; path?: string }): Promise<Page<TreeEntry>>;
  getFile(ref: RepoRef, q: { path: string; ref?: string }): Promise<FileContent>;
  writeFile(
    ref: RepoRef,
    w: FileWrite,
  ): Promise<{ path: string; branch: string; sha: string | null }>;
  searchUsers(q: ListQuery): Promise<Page<UserSummary>>;
  getUser(username: string): Promise<UserSummary | null>;
  currentUser(): Promise<UserSummary>;
  listOrgs(q: ListQuery): Promise<Page<OrgSummary>>;
  /** Raw GET under the account's pinned API root; the long-tail escape hatch. */
  apiGet(path: string, query?: Record<string, string | number | boolean>): Promise<JsonValue>;
}

/** A failure that carries the upstream status so prechecks and errors stay useful. */
export class ForgeError extends Error {
  readonly status: number;
  readonly flavor: ForgeFlavor;
  readonly hint: string | null;

  constructor(flavor: ForgeFlavor, status: number, message: string, hint: string | null = null) {
    super(message);
    this.name = "ForgeError";
    this.flavor = flavor;
    this.status = status;
    this.hint = hint;
  }
}

export function parseRepoRef(raw: string): RepoRef {
  const idx = raw.lastIndexOf("/");
  return { owner: raw.slice(0, idx), name: raw.slice(idx + 1) };
}

export function repoRefString(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}
