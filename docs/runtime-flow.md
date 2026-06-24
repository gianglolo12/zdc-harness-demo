# ZDC Harness — Runtime Flow (từng step thực tế)

Mô tả flow **đang chạy thật** trên Dokploy VPS (provider = GitHub). Cập nhật 2026-06-24.

## Thành phần
- **server** (Fastify, container) — nhận webhook `POST /webhook`, public qua domain sslip.io.
- **worker** (BullMQ consumer, container) — xử lý job, chạy `claude -p` trong checkout.
- **redis** (container) — BullMQ queue (`zdc-jobs`) + state store (`job:<mrIid>`, `rev:<mrIid>`).
- **agent bundle** (`examples/control-plane/` bake trong image, `CONTROL_PLANE_DIR=/app/examples/control-plane`) — `registry.yaml` (be→zdc-be-demo) + `.claude/commands/auto-{impact,review-solution,implement}.md`.
- Env: `GIT_PROVIDER=github`, `GITHUB_OWNER/REPO/TOKEN`, `WEBHOOK_SECRET`, `DRY_RUN=0`.

---

## PHASE 1 — Impact → Draft PR

**Step 1 — Trigger (git push).**
Dev push lên **feature branch** của repo đích (zdc-be-demo), commit message chứa tag `[zdc:update-be PRD-XXX]`, đổi file dưới `po/**`. GitHub bắn webhook `push` → `POST http://<domain>/webhook`.
(Hiện trigger thủ công bằng signed POST vì webhook GitHub chưa cấu hình — tương đương.)

**Step 2 — Server verify + classify.**
`server.ts` → đọc header `X-Hub-Signature-256` → `verifyGithubSignature(rawBody, sig, WEBHOOK_SECRET)` (HMAC-SHA256). Sai → 401.
→ `classifyGithub("push", payload)`: feature branch (≠ main/master/develop) + tag khớp + có file `po/` → `{type:"impact", target:"be", prd, ref}`. Khác → ignore (200 no-op).

**Step 3 — Enqueue.**
Server `enqueuer.enqueue(intent)` → BullMQ queue `zdc-jobs` (Redis). Trả `200 {"ok":true,"type":"impact"}`.

**Step 4 — Worker nhận job impact.**
`worker.processJob(intent)` → kill-switch check (`HARNESS_PAUSED`) → vào `runPhase1`.

**Step 5 — Checkout + overlay.**
`checkout`: `git clone --depth=1 --branch <ref> <source_repo>` (zdc-be-demo) vào temp dir; set remote URL kèm token + git identity (cho push sau).
`overlay`: copy `.claude/` (shared) + bundle `be/` vào checkout; append `.claude/`+`CLAUDE.md` vào `.git/info/exclude`.

**Step 6 — Memory load + /auto-impact.**
`memory.search` (FTS5) load bài học liên quan → `runClaude("/auto-impact", input=PRD ref + memory)` = `claude --dangerously-skip-permissions -p "/auto-impact"` trong checkout → Claude đọc PRD + codebase → xuất **impact analysis** (markdown).

**Step 7 — Second-opinion.**
`reviewSolution` → `claude -p "/auto-review-solution"` (stdin=solution) → JSON `{verdict,notes}`. fail → chạy lại /auto-impact kèm notes (tối đa 2 vòng). pass → tiếp.

**Step 8 — Tạo draft PR + lưu state.**
`gitlab.createDraftMR` (GitHub adapter) → `octokit.pulls.create({draft:true, head:ref, base:main})` → PR draft chứa solution. `state.putJob(mrIid, {target,prd,ref,phase:phase1,revisionCount:0})` (Redis). Log `Phase 1 complete for MR !<n>`.

→ **Kết thúc Phase 1.** Dừng chờ cổng người. ✅ (đã chứng minh live: PR#1/2/3)

---

## CỔNG NGƯỜI (comment trên PR)

**Step 9 — Dev comment.** GitHub bắn `issue_comment` webhook → server verify + `classifyGithub("issue_comment", payload)` (issue.pull_request tồn tại + body khớp `/approve|/revise|/reject|/abort`) → enqueue.

**Step 10 — Worker route → human-gate.**
`processJob` route `approve|revise|reject|abort` → `handleCommand`:
- `/revise <góp ý>` → `incRevision`; <3 → enqueue lại impact kèm feedback; ≥3 → label `needs-human` + comment, dừng.
- `/reject|/abort` → comment, dừng (không code).
- `/approve` → `getJob(mrIid)` → enqueue **phase2** job `{type:phase2, mrIid, target, prd, ref}`.

---

## PHASE 2 — Implement → Finalize PR

**Step 11 — Worker nhận job phase2 → runPhase2.**
Checkout + overlay (như Step 5) lên đúng branch head của PR.

**Step 12 — /auto-implement.**
`claude --dangerously-skip-permissions -p "/auto-implement"` (stdin=PRD/Branch/MR) → Claude: **edit source thật** (vd `src/index.js`) + viết test + `node --test` → `git add -A` (loại `.claude/`/`CLAUDE.md`) → `git commit` → `git push origin HEAD` → verify push → xuất JSON footer `{pushed, mr_iid, affects_fe, api_contract}`.
✅ (đã chứng minh: local reproduction → commit `e62cb2a` đẩy code thật lên PR#3)

**Step 13 — Finalize PR.**
`gitlab.finalizeMR` → GraphQL `markPullRequestReadyForReview` (un-draft PR). ✅ (chứng minh: PR#3 draft=false)

**Step 14 — Ghi memory + FE handoff.**
`memory.write` (bài học). Nếu `affects_fe=true` + registry có target `fe` → enqueue impact job cho fe kèm `api_contract`; không có → log skip (tolerant). Log `Phase 2 complete for MR !<n>`.

→ **Kết thúc Phase 2.** PR un-draft + có code → người review + merge.

---

## Trạng thái xác minh
- **Phase 1**: ✅ chạy live trên container (3 PR thật).
- **finalizeMR un-draft (Step 13)**: ✅ proven (PR#3 draft=false).
- **/auto-implement edit+push (Step 12)**: ✅ proven qua local reproduction (PR#3 có code `e62cb2a`); ⚠️ autonomy trong **worker container** chưa xác nhận được vì Dokploy log viewer stale — cần `docker logs` hoặc thêm instrumentation (log stdout + log enqueue phase2).

## Phụ thuộc bên ngoài
- `claude` CLI authed (subscription `/login`) trong worker container.
- GitHub token scope `repo` (tạo PR/comment/push).
- Webhook GitHub trên repo đích (hiện trigger thủ công bằng signed POST).

## Câu hỏi mở
- Container Phase 2 autonomy: cần log thật để chốt (Step 12 trong container).
- GitHub webhook tự động: chưa cấu hình (cần password sudo — user tự thêm).
