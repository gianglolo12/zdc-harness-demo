# Overnight Summary — 2026-06-24 (đọc sáng mai)

Chào buổi sáng. Đêm qua chạy theo goal: **project chạy được + demo workflow**. Tóm tắt kết quả.

---

## ✅ 1. Stack đã deploy & chạy trên Dokploy VPS

3 container **đều RUNNING** (project `giangnnt` / service `zdc-harness`):
- `redis-1` — running
- `server-1` — running (webhook receiver, Fastify :3000 nội bộ)
- `worker-1` — running, log: `[worker] loaded registry from /app/registry.yaml` + `[worker] started, consuming zdc-jobs queue`

→ Chứng minh: harness **build + boot được** trên VPS, GitHub→Dokploy pipeline hoạt động.

### Repo demo
GitHub (public): **github.com/gianglolo12/zdc-harness-demo** — push lên đây Dokploy tự build.

### Các lỗi đã sửa khi deploy (đều đã commit + push)
| Lỗi | Fix | Commit |
|---|---|---|
| `npm ci` fail (lockfile lệch + deps "latest") | Dockerfile dùng `npm install` | 9426d14 |
| `Bind 0.0.0.0:3000 failed: port allocated` | compose `expose` thay vì host-bind | 15be2cb |
| worker/server crash: `GITLAB_URL` Invalid (github mode) | config coi empty-string env = unset | 3d30ebf |
| worker crash: `ENOENT /control-plane/registry.yaml` | worker fallback registry bundled/empty | a2c9ca7 |

## ✅ 2. Demo workflow (chạy local, KHÔNG cần infra)

Lệnh: **`npm run demo`** (trong `zdc-harness/`). Đã chạy thành công, in trọn luồng:

```
(1) PUSH webhook [zdc:update-be PRD-001] → classifyGithub → intent {type:impact, target:be, prd:PRD-001}
(2) processJob(impact) → checkout+overlay → /auto-impact → /auto-review-solution (pass)
    → createDraftMR PR#1 → state stored
(3) issue_comment "/approve" → classifyGithub → handleCommand → enqueue phase2
    → /auto-implement → finalizeMR PR#1 (un-drafted)
(4) PR#1 finalized
(5) SUMMARY: 2 GitHub actions, 1 phase2 job, 1 memory entry written
✅ Demo complete — full pipeline exercised with zero external services
```

→ Chứng minh: **toàn bộ orchestration logic** (webhook→classify→queue→Phase1→second-opinion→draft PR→human gate→Phase2→finalize→memory) chạy đúng. Dùng stub Claude + fake GitHub nên không cần login/infra.

Chi tiết: `examples/README.md`. Code: `examples/run-demo.ts` + `examples/control-plane/` (sample PRD + agent bundle manifest).

## ⏳ 3. Để chạy workflow THẬT trên stack đã deploy (cần anh, ~15 phút)

Stack đang chạy nhưng job thật chưa chạy được vì 3 thứ cần anh/định nghĩa:

1. **Claude login** (subscription): Dokploy → service worker → **Open Terminal** → `claude` → `/login`. Credentials lưu volume `claude-auth`.
2. **Control-plane thật**: hiện worker dùng registry mẫu (trỏ GitLab demo) + CHƯA có agent bundle (`/auto-impact`, `/auto-implement`, `/auto-review-solution`). Cần populate `/control-plane` (volume) bằng repo control-plane thật: registry.yaml trỏ `be`→repo đích GitHub + thư mục `be/` chứa các command đó. **Đây là phần quyết định chất lượng — nên làm cẩn thận, không vội.**
3. **Public URL cho webhook**: server chạy nội bộ (đã bỏ host-port). Cần tạo **Domain** trong Dokploy (Domains tab → Traefik → port 3000) → lấy URL → cấu hình **GitHub webhook** trên repo đích (Push + Issue comments, secret = WEBHOOK_SECRET, `X-Hub-Signature-256`).

## Trạng thái env trên Dokploy
Đã set: `GIT_PROVIDER=github`, `GITHUB_OWNER=gianglolo12`, `GITHUB_REPO=zdc-harness-demo`, `DRY_RUN=1`, + `WEBHOOK_SECRET`/`GITHUB_TOKEN` (anh đã nhập).

## Đề xuất thứ tự sáng mai
1. Xem `npm run demo` để nắm luồng (nhanh nhất).
2. Claude `/login` trong worker terminal.
3. Tạo Domain + GitHub webhook → test push 1 commit `[zdc:update-be PRD-xxx]` vào repo đích để thấy draft PR thật (DRY_RUN=1 an toàn).
4. Khi tin tưởng → đầu tư làm **agent bundle** chất lượng (control-plane) → bỏ DRY_RUN.

## Câu hỏi mở
- Repo đích để harness tạo PR là chính `zdc-harness-demo` hay repo BE riêng? (ảnh hưởng GITHUB_REPO + webhook).
- Agent bundle (`/auto-*`) chưa có — cần 1 phiên riêng để thiết kế + eval (rủi ro chất lượng #1 đã nêu lúc brainstorm).
- Thêm 1 unit test cho config empty-string (đã sửa nhưng chưa có test khóa regression) — nên bổ sung.
