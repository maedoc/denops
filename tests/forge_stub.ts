import type {
  ForgeAccount,
  ForgePort,
  IssueSummary,
  Page,
  ProjectSummary,
  PullSummary,
} from "../src/connectors/forge/port.ts";
import type { JsonValue } from "../src/harness/types.ts";

// Shared in-memory port: lets the manifest tests exercise tiers, argument checks and
// approval summaries without a network or a real flavor adapter.

function emptyPage<T>(): Page<T> {
  return { items: [], page: 1, nextPage: null };
}

export function stubPort(_account?: ForgeAccount): ForgePort {
  const project: ProjectSummary = {
    id: "1",
    fullName: "o/r",
    owner: "o",
    name: "r",
    defaultBranch: "main",
    visibility: "private",
    archived: false,
    url: null,
    updatedAt: null,
  };
  const issue: IssueSummary = {
    number: 5,
    title: "t",
    state: "open",
    author: "duke",
    labels: [],
    url: null,
    updatedAt: null,
  };
  const pull: PullSummary = {
    number: 6,
    title: "p",
    state: "open",
    sourceBranch: "f",
    targetBranch: "main",
    author: "duke",
    draft: false,
    merged: false,
    url: null,
    updatedAt: null,
  };
  return {
    flavor: "gitlab",
    listProjects: () => Promise.resolve(emptyPage<ProjectSummary>()),
    getProject: () => Promise.resolve(project),
    listIssues: () => Promise.resolve(emptyPage<IssueSummary>()),
    getIssue: () => Promise.resolve(issue),
    createIssue: () => Promise.resolve(issue),
    updateIssue: () => Promise.resolve(issue),
    listNotes: () => Promise.resolve(emptyPage()),
    createNote: () => Promise.resolve({ id: "1", author: "d", createdAt: null, body: "b" }),
    createPullNote: () => Promise.resolve({ id: "1", author: "d", createdAt: null, body: "b" }),
    listPulls: () => Promise.resolve(emptyPage<PullSummary>()),
    getPull: () => Promise.resolve(pull),
    getChanges: () => Promise.resolve({ files: [], truncated: false }),
    createPull: () => Promise.resolve(pull),
    mergePull: () => Promise.resolve({ ...pull, state: "merged", merged: true }),
    listBranches: () => Promise.resolve(emptyPage()),
    listCommits: () => Promise.resolve(emptyPage()),
    listTree: () => Promise.resolve(emptyPage()),
    getFile: () =>
      Promise.resolve({
        path: "a",
        ref: null,
        sha: null,
        size: 1,
        text: "x",
        truncated: false,
        binary: false,
      }),
    writeFile: () => Promise.resolve({ path: "a", branch: "main", sha: null }),
    searchUsers: () => Promise.resolve(emptyPage()),
    getUser: () => Promise.resolve(null),
    currentUser: () => Promise.resolve({ id: "1", username: "duke", name: null, url: null }),
    listOrgs: () => Promise.resolve(emptyPage()),
    apiGet: (path) => Promise.resolve({ path } as unknown as JsonValue),
  };
}
