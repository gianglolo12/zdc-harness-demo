# GitHub Adapter — Implementation Plan

> Subagent-driven, TDD. Add a GitHub provider alongside GitLab, selected by env `GIT_PROVIDER` (default `gitlab`). Keep GitLab path intact.

**Goal:** Harness có thể target GitHub (PR thay MR, GitHub webhook, HMAC verify) để chạy demo trên repo gianglolo12/zdc-harness-demo.

**Key design:** GitHubClient expose CÙNG method surface như GitLabClient (`createDraftMR`, `commentMR`, `getMR`, `finalizeMR`, `setLabel`; `mrIid` = PR number). Pipeline (phase1/phase2/human-gate) KHÔNG đổi. Chỉ thêm: github client + github webhook classify + github verify + provider switch ở config/server/worker.

## Global Constraints
- TS strict, ESM, vitest. `npm test` xanh sau mỗi task.
- GitLab path KHÔNG được hỏng — provider mặc định vẫn `gitlab`.
- Dùng `@octokit/rest` cho GitHub API.
- Mọi logic test được bằng inject (không gọi GitHub/network thật trong test).
- Commit mỗi task (conventional).

---

### Task 1: Config — provider switch + GitHub vars
**Files:** `src/config.ts`, `src/config.test.ts`
- Thêm `GIT_PROVIDER` (`gitlab` | `github`, default `gitlab`) vào schema + `Config.gitProvider`.
- Thêm optional `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` → `Config.github?`.
- Validation có điều kiện: nếu `gitProvider==="gitlab"` → require GITLAB_TOKEN+GITLAB_URL (như cũ); nếu `"github"` → require GITHUB_TOKEN+GITHUB_OWNER+GITHUB_REPO, GITLAB_* thành optional. WEBHOOK_SECRET + REDIS_URL luôn require.
- Tests: provider=github hợp lệ; provider=github thiếu GITHUB_TOKEN → throw; provider=gitlab vẫn như cũ.

### Task 2: GitHub webhook signature verify
**Files:** `src/verify-signature.ts` (thêm hàm), `src/verify-signature.test.ts`
- Thêm `verifyGithubSignature(rawBody: string, signatureHeader: string, secret: string): boolean` — HMAC-SHA256 hex, header dạng `sha256=<hex>`, so sánh constant-time. Giữ `verifyToken` (GitLab) nguyên.
- Tests: chữ ký đúng → true; sai → false; thiếu prefix → false.

### Task 3: GitHubClient (same surface as GitLabClient)
**Files:** `src/github.ts`, `src/github.test.ts`
- Class `GitHubClient` nhận injected `octokit` (mock trong test). Methods (giữ tên giống GitLabClient để pipeline tái dùng):
  - `createDraftMR(repoRef, sourceBranch, title, body)` → `octokit.pulls.create({owner, repo, head, base:"main", title, body, draft:true})` → trả `{ iid: number }` (iid = PR number).
  - `commentMR(repoRef, prNumber, body)` → `octokit.issues.createComment({owner,repo,issue_number,body})`.
  - `getMR(repoRef, prNumber)` → `octokit.pulls.get`.
  - `finalizeMR(repoRef, prNumber)` → `octokit.pulls.update({draft:false})` hoặc strip "Draft:" title (dùng draft:false nếu API hỗ trợ; nếu không, update title bỏ prefix).
  - `setLabel(repoRef, prNumber, label)` → `octokit.issues.addLabels`.
  - Factory `fromConfig(cfg)` → `new Octokit({ auth: cfg.github.token })`; repoRef gói {owner, repo} từ config.
- Tests: vi.fn() octokit; assert createDraftMR gọi pulls.create với draft:true + trả iid; commentMR gọi issues.createComment; finalizeMR; setLabel.

### Task 4: GitHub webhook classifier
**Files:** `src/classifier-github.ts`, `src/classifier-github.test.ts`
- `classifyGithub(event: string, payload): Classified` (tái dùng type `Classified`/`JobIntent` từ classifier.ts).
  - `event==="push"`: GitHub payload `ref` (`refs/heads/...`), `commits[].message`, `commits[].added/modified/removed`. Áp CÙNG luật: feature branch (không main/master/develop) + tag `[zdc:update-<be|fe|qa> <PRD>]` + file `po/**` → `{type:"impact", target, prd, ref}`.
  - `event==="issue_comment"` AND `payload.issue.pull_request` tồn tại: parse `payload.comment.body` cho `/approve|/revise|/reject|/abort`; mrIid = `payload.issue.number`. (revise có feedback.)
  - khác → ignore.
- Tests: mirror các case của classifier.ts nhưng theo shape GitHub.

### Task 5: Server + worker provider wiring
**Files:** `src/server.ts`, `src/worker.ts`, tests tương ứng
- Server: `buildServer` nhận thêm provider info. `POST /webhook`: nếu `GIT_PROVIDER==="github"` → đọc header `x-hub-signature-256` + `x-github-event`, verify bằng `verifyGithubSignature` trên RAW body, classify bằng `classifyGithub(event, payload)`. Nếu `gitlab` → giữ path cũ (`x-gitlab-token` + `classify`). Cần raw body cho HMAC — bật Fastify rawBody (content type parser hoặc `request.rawBody`).
- Worker `main()`: chọn client theo `cfg.gitProvider` — `GitHubClient.fromConfig(cfg)` hoặc `GitLabClient.fromConfig(cfg)`. Vì cùng method surface, phần wiring deps (phase1/phase2/human-gate) dùng chung.
- Tests: server github branch → bad signature 401, valid push → enqueue; worker chọn đúng client (inject + assert). GitLab tests cũ vẫn xanh.

### Task 6: Compose env + docs + smoke
**Files:** `docker-compose.yml`, `.env.example`, `docs/deployment-guide.md`, `README.md`
- Compose: thêm `GIT_PROVIDER`, `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO` cho server+worker (GitLab vars optional khi provider=github).
- `.env.example` + deploy guide: mục "GitHub mode" (provider=github, owner/repo, webhook GitHub: Push + Issue comments, secret = WEBHOOK_SECRET, content-type json, `X-Hub-Signature-256`).
- README: ghi cách chọn provider.
- `npm test` full xanh; `npm run build` sạch.

## Self-review checklist (cuối)
- GitLab path còn nguyên (tests cũ pass)?
- GitHubClient method surface khớp những gì phase1/phase2/human-gate gọi?
- Raw body cho HMAC verify đúng?
- Config conditional validation đúng cả 2 provider?
