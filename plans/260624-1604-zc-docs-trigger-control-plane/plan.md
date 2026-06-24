# Plan — zc-docs là nguồn trigger + control-plane (cách A: GitHub mirror)

**Ngày:** 2026-06-24 · **Trạng thái:** đang thực thi
**Mục tiêu:** PO đổi PRD trong **control-plane repo (zc-docs mirror)** → webhook → harness clone control-plane (lấy PRD + bundle role) + clone **source repo** (lấy code) → phân tích/code → PR trên source repo. Đồng thời thực thi #1 (command nằm trong bundle role) + #2 (đọc `manifest.json`).

## Quyết định thiết kế (chốt)
1. **2 mặt phẳng, runtime-clone**: harness clone control-plane repo mỗi job (không bake). Env mới `CONTROL_PLANE_REPO` (URL). Nếu rỗng → fallback `CONTROL_PLANE_DIR` (baked) như cũ (backward-compat).
2. **Overlay cả `po/` (ephemeral, KHÔNG commit) + follow-ref**: harness copy **toàn bộ** `po/` (+ `_glossary`, `_high-level`) từ control-plane clone vào checkout, thêm vào `.git/info/exclude` → agent đọc được PRD đích + mọi PRD được ref, nhưng source giữ sạch (không commit PRD). Prompt `/auto-impact` dạy: gặp `PRD-XXX` thì đọc file tương ứng trong `po/`, tra `_glossary`. → giải bài toán cross-ref bằng "cấp đủ ngữ cảnh", chưa cần agent riêng.
   - **v2 (slot mở sẵn)**: manifest có thể khai stage `prd_context` (resolver kéo transitive-closure / fetch Confluence-Jira) chạy trước impact; không khai → bỏ qua (v1).
3. **Nhánh source dẫn xuất + empty commit**: `zdc-<role>-<prd>` (vd `zdc-be-PRD-006`), tạo từ default branch source. Mở draft PR bằng **empty commit** (advance SHA → GitHub cho mở PR, source không dính file PRD). `intent.ref` (nhánh control-plane) KHÔNG dùng làm nhánh source.
4. **Manifest-driven command (#2)**: đọc `<bundle>/manifest.json` → `{impact, implement, review}`. Thiếu manifest → fallback tên mặc định (`/auto-impact`...).
5. **Command trong bundle (#1)**: `be/.claude/commands/*` override shared khi overlay (cơ chế overlay đã hỗ trợ). Chứng minh role có hành vi riêng.
6. **Privacy**: control-plane repo để **private** (chứa PRD) — harness clone bằng token. Seed bằng PRD demo, KHÔNG đẩy docs nội bộ thật lên GitHub.

## Phase A1 — Wiring + role `be` (mục tiêu chính câu hỏi user)
- [ ] Tạo GitHub repo `zdc-control-plane` (private) — seed: `registry.yaml`, `.claude/` shared, `be/` (manifest + CLAUDE.md + commands), `po/PRD-006-*.md`.
- [ ] Harness: `config.ts` thêm `CONTROL_PLANE_REPO`.
- [ ] Harness: worker clone control-plane vào temp (dùng cho registry + overlay + PRD), dọn theo job.
- [ ] Harness: `registry.ts`/overlay không đổi nhiều; thêm bước copy `po/<PRD>` vào checkout.
- [ ] Harness: derive source branch `zdc-<role>-<prd>`; Phase 1 tạo branch + commit PRD-sync + push + draft PR.
- [ ] Harness: đọc `manifest.json` → command names (fallback mặc định).
- [ ] Test vitest cho: manifest loader, branch-derive, control-plane resolver. Giữ 148 test xanh.
- [ ] Webhook GitHub chuyển sang `zdc-control-plane` (watch push). Gỡ/giữ hook cũ trên zdc-be-demo (chỉ cần issue_comment cho cổng người — PR vẫn ở source nên comment vẫn từ source repo → giữ hook issue_comment trên source).
- [ ] Deploy + demo: sửa `po/PRD-006` trong control-plane → PR tự mở trên zdc-be-demo.

> **Lưu ý webhook 2 repo**: `push` (trigger Phase 1) đến từ **control-plane**; `issue_comment` (`/approve`...) đến từ **source repo** (PR nằm đó). → cần hook trên CẢ HAI repo, cùng trỏ 1 endpoint + cùng secret.

## Phase A2 — Đa role (chứng minh #1/#2 đầy đủ)
- [ ] Tạo `zdc-fe-demo` source repo + registry `fe → zdc-fe-demo`.
- [ ] `fe/` bundle với command riêng (khác `be/`) → chứng minh role khác → agents khác.
- [ ] Demo: `[zdc:update-fe PRD-X]` → chạy bundle fe → PR trên zdc-fe-demo.

## Phase B (sau) — migrate gitlab nội bộ
- [ ] Đổi `GIT_PROVIDER`, dùng nhánh verify GitLab token + classifier GitLab đã có.
- [ ] VPS reach gitlab.gt.vng.vn (VPN/mạng nội bộ) + GitLab token.

## Rủi ro
- Mở draft PR cần branch có commit → giải bằng commit PRD-sync (QĐ #2).
- Clone control-plane mỗi job tốn thời gian → `--depth=1`, nhẹ.
- 2 webhook (push ở control-plane, comment ở source) — phải nhớ cấu hình cả hai.

## Câu hỏi mở
- Có muốn PRD-sync commit vào source (QĐ #2) hay giữ source sạch tuyệt đối (PRD chỉ nạp qua stdin)? Mặc định chọn sync (đơn giản + reuse command).
