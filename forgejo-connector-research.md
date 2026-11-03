# forgejo.* connector on git.ins-amu.fr — research notes (2026-11-02)

## Instance

- Forgejo 16.0.4 (gitea-1.22 base), `https://git.ins-amu.fr`
- REST API at `/api/v1`, 326 endpoints (157 under `/repos`), swagger.v1.json served publicly
- Repo search is public; `/settings/api` reports paging defaults (30/page, limit max 50,
  1000/git-tree page)

## Auth

- Scoped PATs (UI: Settings > Applications > Access tokens, fine-grained scopes: read/write per
  category: repository, issue, pull_request, organization, user, admin, actions...)
- Swagger securityDefs: `Authorization: token <PAT>` (apiKey), Basic, Sudo, X-FORGEJO-OTP.
  Bearer-without-prefix is NOT the documented form (probe with bogus token: 401, as expected).
- Note for config parity: gitlab connector uses PRIVATE-TOKEN (GitLab); here it's
  `Authorization: token <PAT>` — client.ts needs its own header logic, do not copy the gitlab one.

## 1:1 op mapping (existing gitlab connector = 28 ops)

| gitlab op                 | forgejo equivalent                                                                                                                            | note                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| projects.list             | GET /repos/search?q= or /user/repos                                                                                                           | search is public; token'd = own perms                            |
| projects.get              | GET /repos/{owner}/{repo}                                                                                                                     |                                                                  |
| projects.search           | GET /repos/search?q= (also type/private filters)                                                                                              |                                                                  |
| projects.create           | POST /user/repos or POST /orgs/{org}/repos                                                                                                    | write-tier                                                       |
| projects.update           | PATCH /repos/{owner}/{repo}                                                                                                                   | write-tier                                                       |
| issues.list               | GET /repos/{owner}/{repo}/issues (state,q,labels,type,page,limit,sort)                                                                        |                                                                  |
| issues.get                | GET /repos/{owner}/{repo}/issues/{index}                                                                                                      |                                                                  |
| issues.create             | POST /repos/{owner}/{repo}/issues                                                                                                             | write-tier; labels, due_date, assignees, milestone all supported |
| issues.update             | PATCH /repos/{owner}/{repo}/issues/{index}                                                                                                    | write-tier                                                       |
| issues.notes.list         | GET /repos/{owner}/{repo}/issues/{index}/comments                                                                                             |                                                                  |
| issues.notes.create       | POST /repos/{owner}/{repo}/issues/{index}/comments                                                                                            | write-tier                                                       |
| mergeRequests.list        | GET /repos/{owner}/{repo}/pulls                                                                                                               |                                                                  |
| mergeRequests.get         | GET /repos/{owner}/{repo}/pulls/{index}                                                                                                       |                                                                  |
| mergeRequests.create      | POST /repos/{owner}/{repo}/pulls                                                                                                              | write-tier                                                       |
| mergeRequests.comment     | POST /repos/{owner}/{repo}/issues/{index}/comments                                                                                            | PRs share the issue index space — same comments API              |
| mergeRequests.changes.get | GET /repos/{owner}/{repo}/pulls/{index}/files (+/.diff .patch)                                                                                | richer than gitlab's: diff directly                              |
| repository.branches.list  | GET /repos/{owner}/repo}/branches                                                                                                             |                                                                  |
| repository.commits.list   | GET /repos/{owner}/{repo}/commits (sha, path, since...) + /git/commits/{sha}                                                                  |                                                                  |
| repository.tree.list      | GET /repos/{owner}/{repo}/git/trees/{sha}?recursive (1000/page) or /contents                                                                  |                                                                  |
| repository.files.get      | GET /repos/{owner}/{repo}/contents/{filepath}?ref — **base64 content** in JSON, or /raw/{filepath} for text                                   |                                                                  |
| repository.files.create   | POST /repos/{owner}/{repo}/contents/{filepath} (content b64, branch, message) — write-tier. No MR-from-commit; branch+commit then POST /pulls |                                                                  |
| users.search              | GET /users/search?q= (GET-only, no paging)                                                                                                    |                                                                  |
| users.get                 | GET /users/{username} (email only with admin/explicit scope)                                                                                  |                                                                  |
| users.current             | GET /user                                                                                                                                     |                                                                  |
| groups.list               | NO direct equivalent — orgs instead: GET /user/orgs or /orgs/{org}; "groups" family becomes "orgs"                                            |                                                                  |
| get (generic)             | generic client makes any GET easy; keep the pinned-origin + SSRF guard                                                                        |                                                                  |
| mutate (generic)          | generic write, approval-tier; map verbs POST/PUT/PATCH/DELETE                                                                                 |                                                                  |

## Beyond parity (cheap adds, all in the same swagger)

- PRs: merge (POST .../pulls/{index}/merge), reviews CRUD, requested reviewers, update-from
- Issues: reactions, timeline, dependencies (blocks/blocked-by), deadline, pinning
- Releases (incl. assets), milestones, labels (org + repo), compare/{basehead}
- Actions (CI): runs/jobs/logs/artifacts/workflow dispatches, variables + secrets
- Wiki pages, stars/subscription, transfer, forks
- Admin surface (34 paths) — do NOT expose; same principle as gitlab (pinned envelope)

## Differences that matter for the connector design

1. PRs and issues share one index space (unlike GitLab): MR ops can reuse issue comment paths.
2. File API returns base64 JSON (GitLab's does too, but the shape differs) — `raw` endpoint is
   simpler for text and can replace inline decoding for read ops under a byte cap.
3. Pagination: page + limit (max 50 via API setting) instead of GitLab's per_page (100). List
   helpers need the limit clamp.
4. Write model: no single-project "commit multiple files" endpoint; multi-file = contents API per
   file on the same ref, or create tree/commit pair (low-level git data endpoints exist).
5. orgs != groups: groups.list ops map to orgs; org-level labels exist but not nested subgroups.
6. token in config lives host-side (secrets.json) exactly like gitlab client.ts; header format is
   the only difference.
7. Rate: no documented per-user API rate limit on this size instance; budgets still per-run like
   gitlab connector.

## Skeleton suggestion

mirror gitlab: connectors/forgejo/{manifest,client,shape}.ts; ops ~1:1 with gitlab (28) with
"groups"→"orgs"; same tiers (open reads / approval writes); same pinned-origin + SSRF + redaction
guards from src/security. Estimate: manifest+client ~ the gitlab files as templates; most ops are
path/shape changes, the tricky bits are contents-API (b64/raw) and paging clamps.
